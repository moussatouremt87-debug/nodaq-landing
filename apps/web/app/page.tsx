"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import {
  askCockpit,
  formatEuroCents,
  getKpis,
  getMe,
  getPendingAction,
  getTaxScheduleIfOwner,
  decidePendingAction,
  listConnectors,
  listPendingActions,
} from "../lib/api";
import type { CockpitKpis, PendingActionDetail, PendingActionSummary } from "../lib/api";
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
  // Cockpit conversationnel (2.5) : la question passe par la MÊME boucle que
  // le chat — mêmes outils, mêmes gardes de rôle.
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState<{ answer: string; tools: string[] } | null>(null);
  const [asking, setAsking] = useState(false);

  const refresh = useCallback(() => {
    getKpis().then(setKpis).catch(() => undefined);
    listPendingActions()
      .then((actions) => {
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
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    refresh();
    getMe()
      .then((session) => setFirstName(session.name?.split(" ")[0] ?? null))
      .catch(() => undefined);
    // Échéancier owner-only côté API : on n'appelle QUE pour un owner, sinon
    // chaque ouverture du cockpit par un membre produirait un 403 en logs.
    getTaxScheduleIfOwner()
      .then((schedule) => {
        if (!schedule) return;
        const upcoming = schedule.deadlines.filter((d) => d.status === "prevu");
        setTaxSchedule({
          next: upcoming[0] ? { label: upcoming[0].label, dueDate: upcoming[0].dueDate } : null,
          count: upcoming.length,
          plannedOutflowCents: schedule.plannedOutflowCents,
        });
      })
      .catch(() => undefined);
    listConnectors()
      .then((connectors) => {
        setConnectorCount(connectors.length);
        // Tenant de démonstration (seed démo) : signalé discrètement, jamais
        // présenté comme une vraie connexion.
        setDemoMode(connectors.some((connector) => connector.status === "demo"));
      })
      .catch(() => undefined);
  }, [refresh]);

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    setBusyId(id);
    try {
      await decidePendingAction(id, decision);
    } catch {
      /* conflits (déjà traitée) et 403 : la liste rafraîchie fait foi */
    } finally {
      setBusyId(null);
      refresh();
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
              .then(setAnswer)
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
