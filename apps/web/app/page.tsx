"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { emitDomainEvent, eventForTool, type DomainEvent } from "../lib/freshness";
import { useFreshness } from "../lib/useFreshness";
import {
  askCockpit,
  getAffairesMargesIfOwner,
  getRevenusIfOwner,
  formatEuroCents,
  getKpis,
  getMe,
  getPendingAction,
  getTaxScheduleIfOwner,
  decidePendingAction,
  listConnectors,
  listPendingActions,
} from "../lib/api";
import type {
  AffaireMarginRow,
  AffairesMarges,
  CockpitKpis,
  PendingActionDetail,
  PendingActionSummary,
  RevenusSplit,
} from "../lib/api";
import { affaireWords } from "@nodaq/shared";
import { actionChipLabel, actionTypeLabel } from "../lib/labels";

/*
 * Cockpit (UI v2, maquette Figma) — the owner's view: greeting, KPI cards,
 * treasury projection chart, and the validation queue side card with 1-click
 * decisions. Every figure comes from the API; the 90-day bars interpolate the
 * SAME linear model the API projects with (avg daily net flow) — no invented
 * data. Payload details (amounts, customers) are owner-gated: non-owners get
 * type + date only.
 */

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

const CHART_BARS = 22;
const HORIZON_DAYS = 90;

/** « marge X » pour un chiffre exact, « au mieux X » pour un plafond. Le mot
 *  compte : un plafond n'est pas un résultat. */
function marginLabel(row: AffaireMarginRow): string {
  if (row.margin.kind === "marge") return `marge ${formatEuroCents(row.margin.marginCents)}`;
  if (row.margin.kind === "marge_borne_superieure") {
    return `au mieux ${formatEuroCents(row.margin.upperBoundCents)}`;
  }
  return "marge non calculable";
}

/** La cause RÉELLE du refus, ligne par ligne. Accoler « coût horaire non
 *  renseigné » à toutes les affaires sans marge était faux : un coût horaire
 *  manquant produit un PLAFOND, jamais une absence de calcul. */
function missingLabel(row: AffaireMarginRow): string {
  const missing = "missing" in row.margin ? row.margin.missing : [];
  const labels: Record<string, string> = {
    couts: "aucune dépense rattachée",
    aucune_piece_rattachee: "aucune pièce rattachée",
    heures: "heures passées non renseignées",
    cout_horaire: "coût horaire chargé non renseigné",
    pieces_ttc: "des pièces sont en TTC",
    montants_inconnus: "des pièces sans montant",
    facture_base_ttc: "facturé en TTC, devis en HT",
  };
  if (row.margin.kind === "couts_seuls") return "pas de montant devisé";
  const named = missing.map((item) => labels[item] ?? item);
  return named.length > 0 ? named.join(" · ") : "raison inconnue";
}

/** Card line for one pending action, from its (owner-gated) payload. */
function actionLine(action: PendingActionSummary, detail: PendingActionDetail | undefined) {
  const payload = detail ? asDict(detail.payload) : null;
  const invoice = asDict(payload?.invoice);
  const quote = asDict(payload?.quote);
  const reconciliation = asDict(payload?.reconciliation);
  if (invoice) {
    const risk = asDict(payload?.risk);
    const days = asNumber(risk?.daysOverdue);
    return {
      title: `Relance — Facture ${asString(invoice.number) ?? ""}`.trim(),
      meta: [
        asString(invoice.customer),
        asNumber(invoice.amountCents) !== null
          ? formatEuroCents(asNumber(invoice.amountCents) ?? 0)
          : null,
        days !== null ? `${days} j de retard` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (quote) {
    return {
      title: `Devis ${asString(quote.number) ?? ""}`.trim(),
      meta: [
        asString(quote.customer),
        asNumber(quote.amountCents) !== null
          ? formatEuroCents(asNumber(quote.amountCents) ?? 0)
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (reconciliation) {
    const entries = asNumber(reconciliation.entries);
    const total = asNumber(reconciliation.totalCents);
    return {
      title: "Rapprochement bancaire",
      meta: [
        entries !== null ? `${entries} écritures` : null,
        total !== null ? formatEuroCents(total) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return {
    title: actionTypeLabel(action.type),
    meta: `préparée le ${new Date(action.createdAt).toLocaleDateString("fr-FR")}`,
  };
}

export default function CockpitPage() {
  const [kpis, setKpis] = useState<CockpitKpis | null>(null);
  const [firstName, setFirstName] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingActionSummary[]>([]);
  const [details, setDetails] = useState<Record<string, PendingActionDetail>>({});
  const [connectorCount, setConnectorCount] = useState<number | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  // Échéancier fiscal (2.9) — owner only côté API : un 403 laisse la carte
  // muette, jamais une erreur à l'écran.
  const [taxSchedule, setTaxSchedule] = useState<{
    next: { label: string; dueDate: string } | null;
    count: number;
    plannedOutflowCents: number;
  } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  // F4 — marge par affaire. Owner-only et module-gated côté API : un 403 ou un
  // 409 laisse la carte muette, jamais une erreur à l'écran.
  const [marges, setMarges] = useState<AffairesMarges | null>(null);
  const [revenus, setRevenus] = useState<RevenusSplit | null>(null);
  // Cockpit conversationnel (2.5) : la question passe par la MÊME boucle que
  // le chat — mêmes outils, mêmes gardes de rôle.
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; tools: string[] } | null>(null);
  const [asking, setAsking] = useState(false);

  // Chargeur du cockpit : rend une PROMESSE — l'horodatage « à jour il y a X »
  // ne doit avancer qu'en cas de succès, sinon l'écran se déclare frais après
  // un refetch raté (le mensonge exact que ce ticket corrige).
  //
  // TOUT ce que le cockpit affiche passe par ici, échéancier et connecteurs
  // compris : une carte chargée une seule fois au montage resterait figée
  // pendant que l'écran s'annonce « à jour » — la même erreur, en plus discret.
  // Aucun `.catch()` non plus : un bloc qui a échoué garde ses anciennes
  // valeurs ET son ancien horodatage, ce qui est la vérité.
  const load = useCallback(async () => {
    const [kpisResult] = await Promise.all([
      getKpis(),
      // Échéancier owner-only côté API : on n'appelle QUE pour un owner, sinon
      // chaque ouverture du cockpit par un membre produirait un 403 en logs.
      getTaxScheduleIfOwner().then((schedule) => {
        if (!schedule) return;
        const upcoming = schedule.deadlines.filter((d) => d.status === "prevu");
        setTaxSchedule({
          next: upcoming[0] ? { label: upcoming[0].label, dueDate: upcoming[0].dueDate } : null,
          count: upcoming.length,
          plannedOutflowCents: schedule.plannedOutflowCents,
        });
      }),
      listConnectors().then((connectors) => {
        setConnectorCount(connectors.length);
        // Tenant de démonstration (seed démo) : signalé discrètement, jamais
        // présenté comme une vraie connexion.
        setDemoMode(connectors.some((connector) => connector.status === "demo"));
      }),
      // La marge par chantier fait partie du CHARGEUR : une carte chargée une
      // seule fois au montage resterait figée pendant que l'écran se dit
      // « à jour » — la leçon du ticket 2.21 A.
      //
      // PAS de `.catch()` : il ferait résoudre `load()` et l'écran
      // s'horodaterait « à jour » alors que cette carte a échoué. Le helper
      // rend `null` pour les cas LÉGITIMES (non-owner, module éteint) et laisse
      // les vraies pannes remonter.
      getAffairesMargesIfOwner().then(setMarges),
      getRevenusIfOwner().then(setRevenus),
      listPendingActions().then((actions) => {
        const waiting = actions.filter((a) => a.status === "pending");
        setPending(waiting);
        // Owner-gated payloads (titles, amounts). A 403 (member/accountant)
        // simply leaves the fallback lines — never an error on screen.
        void Promise.allSettled(
          waiting.slice(0, 8).map((a) => getPendingAction(a.id)),
        ).then((results) => {
          const loaded: Record<string, PendingActionDetail> = {};
          for (const result of results) {
            if (result.status === "fulfilled") loaded[result.value.id] = result.value;
          }
          setDetails(loaded);
        });
      }),
    ]);
    setKpis(kpisResult);
  }, []);

  // Le cockpit AFFICHE la trésorerie et les impayés : s'abonner au seul
  // « cockpit » laissait un rapprochement bancaire fait ailleurs sans effet
  // sur les chiffres qu'il montre.
  const freshness = useFreshness(["cockpit", "tresorerie", "impayes"], load);
  const refresh = freshness.refresh;

  // L'identité n'est pas une donnée fraîche : elle ne change pas sous nos pieds
  // et n'a donc rien à faire dans le chargeur.
  useEffect(() => {
    getMe()
      .then((session) => setFirstName(session.name?.split(" ")[0] ?? null))
      .catch(() => undefined);
  }, []);

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    setBusyId(id);
    try {
      await decidePendingAction(id, decision);
      // Le bus périme TOUTES les vues concernées (file, trésorerie, impayés,
      // marge…), pas seulement l'écran d'où part le clic. Émis APRÈS le succès
      // seulement : sur un 403 ou un 409 rien n'a été écrit, et annoncer une
      // validation ferait recharger tout le produit pour rien.
      emitDomainEvent(decision === "approve" ? "action.validee" : "action.rejetee");
    } catch {
      /* conflits (déjà traitée) et 403 : la liste rafraîchie fait foi */
      refresh();
    } finally {
      setBusyId(null);
    }
  }

  const treasury = kpis?.treasury ?? null;
  const sales = kpis?.sales ?? null;
  const salesBars = sales
    ? [
        ...sales.series.map((p) => ({ month: p.month, revenueCents: p.revenueCents, forecast: false })),
        ...sales.points.map((p) => ({ month: p.month, revenueCents: p.revenueCents, forecast: true })),
      ]
    : [];
  const salesMax = Math.max(1, ...salesBars.map((b) => b.revenueCents));
  const executed = kpis?.pendingActions.executed ?? 0;

  // Projection linéaire — exactement le modèle de l'API (flux net moyen/j).
  const balance = treasury?.currentBalanceCents ?? 0;
  const daily = treasury?.avgDailyNetFlowCents ?? 0;
  const p90 =
    treasury?.points.find((p) => p.horizonDays === HORIZON_DAYS)?.projectedBalanceCents ?? null;
  const series = Array.from({ length: CHART_BARS }, (_, i) => {
    const day = Math.round((i * HORIZON_DAYS) / (CHART_BARS - 1));
    return { day, value: balance + daily * day };
  });
  const minIndex = series.reduce((min, p, i) => (p.value < series[min]!.value ? i : min), 0);
  const minPoint = series[minIndex]!;
  const maxValue = Math.max(...series.map((p) => p.value), 1);
  const lowDate = new Date(Date.now() + minPoint.day * 86_400_000).toLocaleDateString("fr-FR", {
    day: "numeric",
    month: "long",
  });

  // Impayés relancés par l'employé (payloads owner-gated des relances).
  const dunnings = pending.filter((a) => a.type === "send_dunning");
  const lateCents = dunnings.reduce((sum, a) => {
    const invoice = asDict(asDict(details[a.id]?.payload)?.invoice);
    return sum + (asNumber(invoice?.amountCents) ?? 0);
  }, 0);
  const delta90 = p90 !== null ? p90 - balance : null;

  return (
    <>
      <div className="cockpit-header">
        <div className="hc">
          <h1 className="page-title">{firstName ? `Bonjour ${firstName}` : "Bonjour"}</h1>
          <p className="page-sub" style={{ margin: 0 }}>
            Voici votre situation financière —{" "}
            {new Date().toLocaleDateString("fr-FR", {
              weekday: "long",
              day: "numeric",
              month: "long",
              year: "numeric",
            })}
            {demoMode && " · mode démo, données fictives"}
          </p>
          {/* S'il ne peut pas rafraîchir, l'écran doit au moins DIRE qu'il est
              périmé : un cockpit qui ment est pire qu'un cockpit vide. */}
          <p className="hint" style={{ margin: "4px 0 0" }}>
            {freshness.label}
            {freshness.stale && " — données peut-être dépassées"}{" "}
            <button
              type="button"
              className="link-button"
              onClick={() => freshness.refresh()}
            >
              rafraîchir
            </button>
          </p>
        </div>
        <span className="tag-souverain">Projection · 90 jours</span>
      </div>

      {connectorCount === 0 && (
        <div className="card" style={{ marginBottom: 20 }}>
          <span className="overline">Bienvenue — dernière étape</span>
          <p className="hint" style={{ margin: "6px 0 12px" }}>
            Aucun outil connecté : reliez Qonto et Pennylane — ou <b>importez votre FEC</b> (le
            fichier que tout logiciel comptable sait exporter) pour voir vos impayés sans rien
            connecter.
          </p>
          <Link href="/connecteurs" className="btn primary">
            Connecter mes outils
          </Link>
        </div>
      )}

      <div className="card" style={{ marginBottom: 18 }}>
        <span className="overline">Posez votre question</span>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (question.trim().length < 3) return;
            setAsking(true);
            setAnswer(null);
            askCockpit(question.trim())
              .then((result) => {
                setAnswer(result);
                // Le cockpit conversationnel passe par la MÊME boucle que le
                // chat : une question peut avoir PRÉPARÉ une action. Sans ça,
                // la file se remplit sous les yeux de l'utilisateur pendant
                // que son compteur reste à l'ancien chiffre.
                //
                // NUANCE : `/cockpit/ask` ne rend que les outils APPELÉS, pas
                // leur issue (le chat, lui, filtre sur `ok`). Un outil qui
                // échoue provoquera donc un rafraîchissement inutile. Écart
                // assumé dans ce sens-là seulement : sur-invalider coûte une
                // requête, sous-invalider laisse un écran faux.
                for (const event of new Set(
                  result.tools.map(eventForTool).filter((e): e is DomainEvent => e !== null),
                )) {
                  emitDomainEvent(event);
                }
              })
              .catch(() => setAnswer({ answer: "Réponse indisponible pour l'instant.", tools: [] }))
              .finally(() => setAsking(false));
          }}
          style={{ display: "flex", gap: 8, margin: "6px 0" }}
        >
          <input
            value={question}
            maxLength={500}
            placeholder="Combien d'articles sous le seuil d'alerte ?"
            onChange={(event) => setQuestion(event.target.value)}
            style={{ flex: 1 }}
          />
          <button className="btn primary" disabled={asking}>
            {asking ? "…" : "Demander"}
          </button>
        </form>
        {answer && (
          <div>
            <p style={{ margin: "6px 0" }}>{answer.answer}</p>
            {answer.tools.length > 0 && (
              // D'OÙ vient le chiffre : les outils réellement appelés.
              <p className="hint">Sources : {answer.tools.join(", ")}</p>
            )}
          </div>
        )}
      </div>

      <div className="kpi-grid">
        <div className="card">
          <span className="overline">Solde prévisionnel à 90 j</span>
          <div className="big">{p90 !== null ? formatEuroCents(p90) : "—"}</div>
          {delta90 !== null && (
            <span className={`delta ${delta90 >= 0 ? "up" : "down"}`}>
              {delta90 >= 0 ? "▲ +" : "▼ "}
              {formatEuroCents(delta90)} vs aujourd&apos;hui
            </span>
          )}
          {p90 === null && <div className="hint">Connectez Qonto (owner) pour la projection.</div>}
        </div>
        <div className="card">
          <span className="overline">Impayés à relancer</span>
          <div className="big">{lateCents > 0 ? formatEuroCents(lateCents) : dunnings.length}</div>
          <span className={`delta ${dunnings.length > 0 ? "down" : "up"}`}>
            {dunnings.length > 0
              ? `${dunnings.length} relance${dunnings.length > 1 ? "s" : ""} préparée${dunnings.length > 1 ? "s" : ""}`
              : "Aucune relance en attente"}
          </span>
        </div>
        {taxSchedule && (
          <div className="card">
            <span className="overline">Prochaine échéance fiscale</span>
            <div className="big">
              {taxSchedule.next
                ? new Date(taxSchedule.next.dueDate).toLocaleDateString("fr-FR")
                : "—"}
            </div>
            <span className="delta up">
              {taxSchedule.next
                ? `${taxSchedule.next.label} · ${taxSchedule.count} sur 3 mois`
                : "Aucune échéance — complétez votre régime"}
            </span>
            {taxSchedule.plannedOutflowCents > 0 && (
              <div className="hint">
                {formatEuroCents(taxSchedule.plannedOutflowCents)} chiffrés par vos soins
              </div>
            )}
          </div>
        )}
        <div className="card">
          <span className="overline">Actions exécutées</span>
          <div className="big">{executed}</div>
          <span className="delta up">Après votre validation, jamais avant</span>
        </div>
        {(kpis?.stockAlerts ?? 0) > 0 && (
          <div className="card accent">
            <span className="overline">Stocks sous seuil</span>
            <div className="big">{kpis?.stockAlerts}</div>
            <span className="delta down">À réapprovisionner — voir la page Stocks</span>
          </div>
        )}
      </div>

      {/* ENCAISSÉ ≠ ACQUIS (4.2 bloc 3) — trois chiffres, jamais un seul.
          Beaucoup de patrons jugent leur santé au solde du compte : l'acompte
          reçu et le devis signé y ressemblent à du résultat, et n'en sont pas.
          Les bases sont affichées (HT / TTC) parce qu'elles ne se soustraient
          pas — leur différence vaudrait à peu près la TVA. */}
      {revenus !== null && (
        <div className="card" style={{ marginBottom: 18 }}>
          <div className="card-header">
            <div className="titles">
              <div className="title">Ce qui est gagné, vendu, encaissé</div>
              <div className="sub">
                Le solde du compte n&apos;est pas du résultat — et ces chiffres ne
                s&apos;additionnent pas entre eux.
              </div>
            </div>
          </div>
          <div className="kpi-row">
            <div className="kpi">
              <span className="overline">Acquis — travail livré</span>
              <div className="value">{formatEuroCents(revenus.acquisCents)}</div>
              <div className="ameta">HT · chantiers terminés</div>
            </div>
            <div className="kpi">
              <span className="overline">Engagé — vendu, pas livré</span>
              <div className="value">{formatEuroCents(revenus.engageCents)}</div>
              <div className="ameta">HT · accepté ou en cours</div>
            </div>
            {/* DEUX chiffres, jamais additionnés : une facture d'acompte est à
                la fois une pièce du FEC réglée et un acompte déclaré sur la
                fiche. Les sommer doublerait le montant, dans la direction
                flatteuse. Rien ne permet de les rapprocher. */}
            <div className="kpi">
              <span className="overline">Encaissé — factures réglées</span>
              {/* `null` ≠ 0 : sans FEC importé, « 0 € » se lirait « rien n'est
                  rentré » à côté d'un acquis non nul. On dit l'absence de
                  source plutôt qu'un chiffre. */}
              <div className="value">
                {revenus.encaisseFactureCents === null
                  ? "—"
                  : formatEuroCents(revenus.encaisseFactureCents)}
              </div>
              <div className="ameta">
                {revenus.encaisseFactureCents === null
                  ? "aucun FEC importé"
                  : "TTC · retenue encore détenue exclue"}
              </div>
            </div>
            <div className="kpi">
              <span className="overline">Acomptes déclarés</span>
              <div className="value">{formatEuroCents(revenus.encaisseDeclareCents)}</div>
              <div className="ameta">
                TTC · peut recouper les factures réglées — non additionné
              </div>
            </div>
          </div>
          {/* Ce qui n'est pas calculé est DIT : sans ces deux lignes, un acquis
              sous-estimé passerait pour exact. */}
          {revenus.sansDevis > 0 && (
            <p className="warn">
              {revenus.sansDevis} {affaireWords(marges?.vertical ?? null).singular}(s) sans devis :
              leur valeur n&apos;entre dans aucun de ces chiffres.
            </p>
          )}
          {revenus.ignorees > 0 && (
            <p className="warn">
              {revenus.ignorees} {affaireWords(marges?.vertical ?? null).plural} au-delà de la
              borne de lecture ne sont pas comptés.
            </p>
          )}
        </div>
      )}

      {marges !== null &&
        (marges.aSurveiller.length > 0 ||
          marges.chiffrables.length > 0 ||
          marges.sousReserve.length > 0 ||
          marges.nonChiffrables.length > 0) && (
          <div className="card" style={{ marginBottom: 18 }}>
            <div className="card-header">
              <div className="titles">
                <div className="title">
                  Marge par {affaireWords(marges.vertical).singular}
                </div>
                <div className="sub">
                  {/* Le périmètre est DIT : « 3 dans le vert » se lirait
                      sinon « tous mes chantiers ». */}
                  {affaireWords(marges.vertical).plural} en cours et acceptés — pendant que le
                  travail se fait, pas au bilan.
                </div>
              </div>
            </div>

            {marges.aSurveiller.length > 0 && (
              <>
                <span className="overline">À surveiller</span>
                <ul className="device-list">
                  {marges.aSurveiller.slice(0, 5).map((row) => (
                    <li key={row.id} className="device-row">
                      <div>
                        <Link href={`/affaires/${row.id}`}>
                          <strong>
                            {row.reference} · {row.label}
                          </strong>
                        </Link>
                        <br />
                        <span className="hint">
                          {marginLabel(row)}
                          {(row.margin.kind === "marge" ||
                            row.margin.kind === "marge_borne_superieure") &&
                            row.margin.budgetGap !== null &&
                            row.margin.budgetGap.deltaCents > 0 &&
                            ` · budget matière dépassé de ${formatEuroCents(row.margin.budgetGap.deltaCents)}`}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {marges.aSurveiller.length > 5 && (
                  <p className="hint">
                    et {marges.aSurveiller.length - 5} autre(s) — voir la page{" "}
                    {affaireWords(marges.vertical).plural}.
                  </p>
                )}
              </>
            )}

            {marges.sousReserve.length > 0 && (
              <>
                {/* Un plafond n'est PAS une marge : ces chantiers ont leur
                    propre bloc, jamais le compteur « dans le vert ». */}
                <span className="overline">Sous réserve — marge réelle inconnue</span>
                <ul className="device-list">
                  {marges.sousReserve.slice(0, 3).map((row) => (
                    <li key={row.id} className="device-row">
                      <div>
                        <Link href={`/affaires/${row.id}`}>
                          <strong>
                            {row.reference} · {row.label}
                          </strong>
                        </Link>
                        <br />
                        <span className="hint">
                          {marginLabel(row)} · {missingLabel(row)}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
                {marges.sousReserve.length > 3 && (
                  <p className="hint">et {marges.sousReserve.length - 3} autre(s).</p>
                )}
              </>
            )}

            {marges.chiffrables.length > 0 && (
              <p className="hint">
                {marges.chiffrables.length} {affaireWords(marges.vertical).singular}(s) avec une
                marge exacte et positive.
              </p>
            )}

            {/* Une affaire dont on ne sait rien n'est PAS une affaire qui va
                bien : nommée, et avec SA cause — pas une cause générique. */}
            {marges.nonChiffrables.length > 0 && (
              <>
                <span className="overline">Sans marge calculable</span>
                <ul className="device-list">
                  {marges.nonChiffrables.slice(0, 3).map((row) => (
                    <li key={row.id} className="device-row">
                      <div>
                        <Link href={`/affaires/${row.id}`}>
                          <strong>
                            {row.reference} · {row.label}
                          </strong>
                        </Link>
                        <br />
                        <span className="hint">{missingLabel(row)}</span>
                      </div>
                    </li>
                  ))}
                </ul>
                {marges.nonChiffrables.length > 3 && (
                  <p className="hint">et {marges.nonChiffrables.length - 3} autre(s).</p>
                )}
              </>
            )}

            {marges.ignorees > 0 && (
              <p className="hint">
                {marges.ignorees} {affaireWords(marges.vertical).singular}(s) ouverts de plus ne
                sont pas comptés ici — les plus anciens, donc ceux qui traînent.
              </p>
            )}
          </div>
        )}

      <div className="cockpit-cols">
        <div className="card">
          <div className="card-header">
            <div className="titles">
              <div className="title">Prévision de trésorerie</div>
              <div className="sub">
                {treasury
                  ? `Compte ${treasury.account} · solde projeté · 90 jours`
                  : "Solde bancaire projeté · 90 jours"}
              </div>
            </div>
            <span className="tag-souverain">Souverain · Mistral EU</span>
          </div>
          {treasury ? (
            <>
              <div className="chart" role="img" aria-label="Projection de trésorerie sur 90 jours">
                {series.map((point, index) => (
                  <div
                    key={point.day}
                    className={`bar ${index === 0 ? "today" : ""} ${
                      index === minIndex && minIndex !== 0 ? "low" : ""
                    }`}
                    style={{ height: `${Math.max(4, (point.value / maxValue) * 100)}%` }}
                    title={`J+${point.day} : ${formatEuroCents(Math.round(point.value))}`}
                  />
                ))}
              </div>
              <div className="xlabels">
                <span>Aujourd&apos;hui</span>
                <span>+30 j</span>
                <span>+60 j</span>
                <span>+90 j</span>
              </div>
              {minPoint.day > 0 && minPoint.value < balance && (
                <div className="annotation">
                  <span className="dot" aria-hidden />
                  <span>
                    Point bas prévu le {lowDate} : {formatEuroCents(Math.round(minPoint.value))}
                    {lateCents > 0 && " — relancer les impayés couvrirait le creux."}
                  </span>
                </div>
              )}
              <hr className="divider" />
              <div className="mini-stats">
                <div className="ms">
                  <div className="label">Solde actuel</div>
                  <div className="value">{formatEuroCents(balance)}</div>
                </div>
                <div className="ms">
                  <div className="label">Flux net moyen</div>
                  <div className="value">
                    {daily >= 0 ? "+" : ""}
                    {formatEuroCents(daily)}/j
                  </div>
                  <div className="note">observé sur {treasury.observedDays} j</div>
                </div>
                <div className="ms">
                  <div className="label">Autonomie</div>
                  <div className="value">
                    {daily < 0
                      ? `${(balance / -daily / 30).toFixed(1).replace(".", ",")} mois`
                      : "—"}
                  </div>
                  {daily >= 0 && <div className="note">▲ trésorerie stable</div>}
                </div>
              </div>
            </>
          ) : (
            <p className="empty">
              Projection indisponible — connectez Qonto (ou vous n&apos;êtes pas owner de
              l&apos;organisation).
            </p>
          )}

          {sales && sales.observedMonths > 0 && (
            <>
              {treasury && <hr className="divider" />}
              <div className="card-header">
                <div className="titles">
                  <div className="title">Prévision des ventes</div>
                  <div className="sub">
                    CA mensuel observé ({sales.observedMonths} mois) · prévision{" "}
                    {sales.points.length} mois
                  </div>
                </div>
              </div>
              <div
                className="chart"
                role="img"
                aria-label="Chiffre d'affaires mensuel et prévision des ventes"
              >
                {salesBars.map((bar) => (
                  <div
                    key={bar.month}
                    className={`bar ${bar.forecast ? "low" : ""}`}
                    style={{ height: `${Math.max(4, (bar.revenueCents / salesMax) * 100)}%` }}
                    title={`${bar.month} : ${formatEuroCents(bar.revenueCents)}${bar.forecast ? " (prévision)" : ""}`}
                  />
                ))}
              </div>
              <div className="xlabels">
                <span>{salesBars[0]?.month}</span>
                <span>prévision → {salesBars[salesBars.length - 1]?.month}</span>
              </div>
              <div className="annotation">
                <span className="dot" aria-hidden />
                <span>
                  {sales.trendCentsPerMonth >= 0 ? "Tendance +" : "Tendance −"}
                  {formatEuroCents(Math.abs(sales.trendCentsPerMonth))}/mois (
                  {sales.method === "regression-lineaire"
                    ? "régression linéaire explicable"
                    : "moyenne — historique court"}
                  )
                </span>
              </div>
            </>
          )}
        </div>

        <div className="card">
          <div className="card-header">
            <div className="titles">
              <div className="title">À valider</div>
              <div className="sub">Préparé par l&apos;employé Compta</div>
            </div>
            {pending.length > 0 && <span className="count-pill">{pending.length} en attente</span>}
          </div>
          {pending.length === 0 ? (
            <p className="empty">
              Rien à valider — demandez une relance à l&apos;
              <Link href="/chat" style={{ color: "var(--accent)" }}>
                employé Compta
              </Link>
              .
            </p>
          ) : (
            <>
              {pending.slice(0, 3).map((action) => {
                const line = actionLine(action, details[action.id]);
                return (
                  <div key={action.id} className="action-card">
                    <div className="trow">
                      <span className={`chip ${action.type}`}>{actionChipLabel(action.type)}</span>
                    </div>
                    <div className="atitle">{line.title}</div>
                    <div className="ameta">{line.meta}</div>
                    <div className="buttons">
                      <button
                        className="primary grow"
                        disabled={busyId === action.id}
                        onClick={() => void decide(action.id, "approve")}
                      >
                        Valider
                      </button>
                      <button
                        disabled={busyId === action.id}
                        onClick={() => void decide(action.id, "reject")}
                      >
                        Rejeter
                      </button>
                    </div>
                  </div>
                );
              })}
              <div className="card-foot">
                <Link href="/validation">
                  Voir les {pending.length} action{pending.length > 1 ? "s" : ""} à valider →
                </Link>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
