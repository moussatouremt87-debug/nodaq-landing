"use client";

import { useCallback, useRef, useState } from "react";
import { resolvePendingActionGroups } from "@nodaq/shared";
import { emitDomainEvent } from "../../lib/freshness";
import { useFreshness } from "../../lib/useFreshness";
import {
  ApiError,
  decidePendingAction,
  formatEuroCents,
  getModules,
  getPendingAction,
  listAffaires,
  listPendingActions,
  setPendingActionAffaire,
  updatePendingActionDraft,
} from "../../lib/api";
import type { Affaire, PendingActionDetail, PendingActionSummary } from "../../lib/api";
import { actionChipLabel, actionStatusLabel, actionTypeLabel, timeAgo } from "../../lib/labels";

/*
 * File de validation (UI v2, maquette Figma) — master-detail. The agent
 * PREPARES; only a human decides here. Selecting an action loads its
 * owner-gated payload: the human READS the draft (email preview), can rework
 * it (Modifier -> Enregistrer, PR #29 API), then validates — the single,
 * idempotent execution point (double click = 409, never a double send).
 */

type Dict = Record<string, unknown>;
const asDict = (value: unknown): Dict | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : null;
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asNumber = (value: unknown): number | null => (typeof value === "number" ? value : null);

/*
 * Les onglets viennent du CATALOGUE (F6), plus d'une liste écrite ici.
 *
 * La liste en dur avait cessé d'être vraie : cinq types d'action sur dix
 * n'avaient aucun onglet et n'existaient que dans « Toutes », introuvables dès
 * que la file dépassait un écran ; et un onglet « Avis » subsistait alors que
 * son module est hors socle depuis le pivot.
 *
 * Le registre gouverne les ONGLETS, jamais les actions : une action dont le
 * module a été éteint garde son onglet, et l'écran dit pourquoi.
 */

/** Titre + méta d'une action pour la liste (payload owner-gated si chargé). */
function actionLine(action: PendingActionSummary, detail: PendingActionDetail | undefined) {
  const payload = detail ? asDict(detail.payload) : null;
  const invoice = asDict(payload?.invoice);
  const quote = asDict(payload?.quote);
  const reconciliation = asDict(payload?.reconciliation);
  if (invoice) {
    const days = asNumber(asDict(payload?.risk)?.daysOverdue);
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
    const lines = Array.isArray(quote.lines) ? quote.lines.length : null;
    return {
      title: `Devis ${asString(quote.number) ?? ""}`.trim(),
      meta: [
        asString(quote.customer),
        asNumber(quote.amountCents) !== null
          ? formatEuroCents(asNumber(quote.amountCents) ?? 0)
          : null,
        // Provenance : une proposition tirée d'un e-mail vient d'un TIERS,
        // et l'owner doit le savoir AVANT d'approuver (2.7).
        asString(payload?.source) === "email" ? "issu d'un e-mail reçu" : null,
        lines !== null ? `${lines} ligne(s)` : null,
        asString(quote.label),
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
        entries !== null ? `${entries} écritures à rapprocher` : null,
        total !== null ? formatEuroCents(total) : null,
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (action.type === "record_review_reply" && payload) {
    const review = asDict(payload.review);
    return {
      title: "Réponse à un avis client",
      meta: [
        review && asNumber(review.rating) !== null ? `note ${asNumber(review.rating)}/5` : null,
        review ? asString(review.source) : null,
        "publication manuelle après validation",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  // Relance prospect (2.12) : l'owner doit voir QUI est relancé et que rien
  // ne part — approuver consigne le contact, l'envoi reste manuel.
  if (action.type === "record_prospect_contact" && payload) {
    const prospect = asDict(payload.prospect);
    return {
      title: "Relance prospect",
      meta: [
        prospect ? asString(prospect.stage) : null,
        "aucun envoi : le message se copie après validation",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  // Facturation électronique (2.4) : ce que l'owner approuve part sur le
  // réseau national — le résumé dit QUOI, pour QUEL montant, sans détour.
  if (action.type === "submit_einvoice" && payload) {
    const invoice = asDict(payload.invoice);
    return {
      title: `Dépôt de la facture ${asString(invoice?.number) ?? "?"}`,
      meta: [
        asNumber(payload.grossCents) !== null
          ? `${formatEuroCents(asNumber(payload.grossCents) ?? 0)} TTC`
          : null,
        asString(payload.profile),
        "dépôt irréversible sur la plateforme",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (action.type === "report_einvoice_transactions" && payload) {
    return {
      title: `E-reporting ${asString(payload.periodStart) ?? "?"} → ${asString(payload.periodEnd) ?? "?"}`,
      meta: [
        asNumber(payload.transactionCount) !== null
          ? `${asNumber(payload.transactionCount)} transaction(s)`
          : null,
        asNumber(payload.totalCents) !== null
          ? `${formatEuroCents(asNumber(payload.totalCents) ?? 0)} déclarés`
          : null,
        "agrégats seulement",
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  if (action.type === "create_fixed_asset" && payload) {
    return {
      title: `Immobilisation — ${asString(payload.label) ?? "?"}`,
      meta: [
        asString(payload.category),
        asNumber(payload.baseCents) !== null
          ? formatEuroCents(asNumber(payload.baseCents) ?? 0)
          : null,
        asNumber(payload.durationMonths) !== null
          ? `${Math.round((asNumber(payload.durationMonths) ?? 0) / 12)} ans`
          : null,
        asString(payload.source),
      ]
        .filter(Boolean)
        .join(" · "),
    };
  }
  return { title: actionTypeLabel(action.type), meta: "" };
}

/** Détail d'une proposition de devis tirée d'un e-mail (2.7). L'owner valide
 * un contenu produit à partir du message d'un INCONNU : il doit voir la
 * provenance, les lignes, ce qui n'a pas été reconnu, et que rien n'est
 * chiffré. Sans cela, la validation 1 clic est aveugle. */
function QuoteProposalDetail({ payload }: { payload: Dict }) {
  const quote = asDict(payload.quote);
  const lines = Array.isArray(quote?.lines) ? (quote.lines as unknown[]) : [];
  const unmatched = asNumber(quote?.unmatchedCount) ?? 0;
  return (
    <div>
      {asString(payload.label) && <p className="warn">{asString(payload.label)}</p>}
      {asString(payload.source) === "email" && (
        <p className="hint">
          Demande reçue par e-mail{asString(payload.from) ? ` de ${asString(payload.from)}` : ""} —
          contenu écrit par un tiers, à relire.
        </p>
      )}
      {asString(quote?.deadline) && (
        <p className="hint">Échéance souhaitée : {asString(quote?.deadline)}</p>
      )}
      <ul className="hint">
        {lines.map((raw, index) => {
          const line = asDict(raw);
          const confidence = asString(line?.confidence);
          return (
            <li key={`${asString(line?.label) ?? "ligne"}-${index}`}>
              {asNumber(line?.quantity) !== null ? `${asNumber(line?.quantity)} × ` : ""}
              {asString(line?.label) ?? "—"}
              {confidence === "aucune" ? (
                <b> · article non reconnu</b>
              ) : (
                <> · {asString(line?.itemName)}{confidence === "probable" ? " (à confirmer)" : ""}</>
              )}
              {" · prix à fixer"}
            </li>
          );
        })}
      </ul>
      {unmatched > 0 && (
        <p className="warn">{unmatched} ligne(s) sans article connu — à compléter.</p>
      )}
      {quote?.catalogTruncated === true && (
        <p className="warn">
          Référentiel lu partiellement : une ligne peut être « non reconnue » à tort.
        </p>
      )}
    </div>
  );
}

/** Détail lisible d'une proposition d'immobilisation (2.19) : l'owner doit
 * VOIR base, durée, méthode et surtout les incohérences signalées avant
 * d'approuver — sinon la validation 1 clic est aveugle. */
function FixedAssetProposal({ payload }: { payload: Dict }) {
  const warnings = Array.isArray(payload.warnings)
    ? payload.warnings.filter((w): w is string => typeof w === "string")
    : [];
  return (
    <div>
      <p>
        <strong>{asString(payload.label) ?? "?"}</strong> — {asString(payload.category)} ·{" "}
        {formatEuroCents(asNumber(payload.baseCents) ?? 0)} ·{" "}
        {Math.round((asNumber(payload.durationMonths) ?? 0) / 12)} ans ({asString(payload.method)})
      </p>
      <p className="muted">
        Mise en service : {asString(payload.inServiceDate) ?? "?"} · source :{" "}
        {asString(payload.source) ?? "?"}
        {asNumber(payload.priorDepreciationCents) ? (
          <> · amortissements repris : {formatEuroCents(asNumber(payload.priorDepreciationCents) ?? 0)}</>
        ) : null}
      </p>
      {warnings.map((warning) => (
        <p key={warning} className="warn">
          ⚠ {warning}
        </p>
      ))}
      <p className="muted">
        Catégorie ou durée à ajuster ? Rejetez, puis saisissez manuellement dans la page
        Immobilisations.
      </p>
    </div>
  );
}

/** Objet d'e-mail dérivé des faits (le brouillon est le corps). */
function subjectFor(payload: Dict | null): string | null {
  const invoice = asDict(payload?.invoice);
  if (invoice) {
    const number = asString(invoice.number);
    return number ? `Relance — facture n°${number.replace(/^#/, "")} échue` : "Relance de facture";
  }
  const quote = asDict(payload?.quote);
  if (quote) {
    return [`Devis ${asString(quote.number) ?? ""}`.trim(), asString(quote.customer)]
      .filter(Boolean)
      .join(" — ");
  }
  return null;
}

export default function ValidationPage() {
  const [actions, setActions] = useState<PendingActionSummary[]>([]);
  const [details, setDetails] = useState<Record<string, PendingActionDetail>>({});
  const [tab, setTab] = useState<string>("all");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Modules ÉTEINTS (registre 3.11) et chantiers ouverts, pour les onglets et
  // le rattachement. FAIL-OPEN : en erreur, on n'éteint aucun onglet — masquer
  // par accident vaut moins qu'afficher un onglet de trop.
  const [inactiveModules, setInactiveModules] = useState<string[]>([]);
  const [affaires, setAffaires] = useState<Affaire[]>([]);

  // Détail SÉLECTIONNÉ. La ref miroir empêche une réponse tardive d'une
  // sélection précédente d'écraser la ligne courante (aucune fuite de
  // brouillon confidentiel d'une action vers une autre).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const [detail, setDetail] = useState<PendingActionDetail | null>(null);
  const [detailNotice, setDetailNotice] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [savedDraft, setSavedDraft] = useState("");
  const [saving, setSaving] = useState(false);

  // Chargeur : rend une PROMESSE (l'horodatage n'avance qu'au succès).
  const load = useCallback(async () => {
    await listPendingActions()
      .then((list) => {
        setActions(list);
        void Promise.allSettled(
          list
            .filter((a) => a.status === "pending")
            .slice(0, 12)
            .map((a) => getPendingAction(a.id)),
        ).then((results) => {
          const loaded: Record<string, PendingActionDetail> = {};
          for (const result of results) {
            if (result.status === "fulfilled") loaded[result.value.id] = result.value;
          }
          setDetails(loaded);
        });
      })
      .catch((error: unknown) => {
        setNotice("Impossible de charger la file.");
        throw error;
      });
  }, []);

  // Registre et chantiers : indépendants de la file, et leur échec ne doit pas
  // empêcher de valider quoi que ce soit.
  const loadContext = useCallback(() => {
    getModules()
      .then((state) =>
        setInactiveModules(state.modules.filter((m) => !m.active).map((m) => m.id)),
      )
      .catch(() => setInactiveModules([]));
    listAffaires()
      .then((list) => setAffaires(list.affaires))
      .catch(() => setAffaires([]));
  }, []);

  const freshness = useFreshness(["validation"], load);
  const refresh = freshness.refresh;

  // La nav et la liste des chantiers vieillissent elles aussi : basculer un
  // module ou créer une affaire doit se voir ici sans rechargement.
  useFreshness(["nav", "affaires"], async () => loadContext());

  const clearSelection = useCallback(() => {
    selectedRef.current = null;
    setSelectedId(null);
    setDetail(null);
    setDetailNotice(null);
    setEditing(false);
    setDraft("");
    setSavedDraft("");
  }, []);

  async function select(id: string): Promise<void> {
    // Quitter un brouillon modifié non enregistré = choix conscient.
    if (selectedId !== null && draft !== savedDraft) {
      const discard = window.confirm(
        "Brouillon modifié non enregistré — changer d'action et perdre la modification ?",
      );
      if (!discard) return;
    }
    if (selectedId === id) return;
    clearSelection();
    selectedRef.current = id;
    setSelectedId(id);
    try {
      const loaded = await getPendingAction(id);
      if (selectedRef.current !== id) return; // réponse tardive : sélection changée
      setDetail(loaded);
      const text = asString(asDict(loaded.payload)?.draft) ?? "";
      setDraft(text);
      setSavedDraft(text);
    } catch (error) {
      if (selectedRef.current !== id) return;
      setDetailNotice(
        error instanceof ApiError && error.status === 403
          ? "Aperçu réservé au rôle owner."
          : "Impossible de charger l'aperçu.",
      );
    }
  }

  async function saveDraft(id: string): Promise<void> {
    setSaving(true);
    setDetailNotice(null);
    try {
      const updated = await updatePendingActionDraft(id, draft);
      setSavedDraft(updated.draft);
      setDraft(updated.draft);
      setEditing(false);
      // Le texte qui partira a changé : un autre écran ouvert sur la même
      // action ne doit pas garder l'ancien sous les yeux.
      emitDomainEvent("action.preparee");
      setDetailNotice("Brouillon enregistré — c'est ce texte qui partira à la validation.");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setDetailNotice("Action déjà décidée — le brouillon n'est plus modifiable.");
        refresh();
      } else if (error instanceof ApiError && error.status === 403) {
        setDetailNotice("Modification réservée au rôle owner.");
      } else {
        setDetailNotice("Échec de l'enregistrement du brouillon.");
      }
    } finally {
      setSaving(false);
    }
  }

  async function attachAffaire(id: string, affaireId: string | null): Promise<void> {
    setDetailNotice(null);
    try {
      await setPendingActionAffaire(id, affaireId);
      // Le rattachement se lit sur la carte ET sur la fiche du chantier :
      // deux vues que cette écriture vient de périmer.
      emitDomainEvent("action.preparee");
      refresh();
    } catch (error) {
      setDetailNotice(
        error instanceof ApiError && error.status === 403
          ? "Rattachement réservé au rôle owner."
          : error instanceof ApiError && error.status === 409
            ? "Action déjà décidée — son chantier n'est plus modifiable."
            : "Échec du rattachement au chantier.",
      );
    }
  }

  async function decide(id: string, decision: "approve" | "reject"): Promise<void> {
    setBusyId(id);
    setNotice(null);
    try {
      const outcome = await decidePendingAction(id, decision);
      setNotice(
        decision === "approve"
          ? outcome.status === "executed"
            ? "Action validée et exécutée."
            : "Action validée — l'exécution a échoué, voir le détail."
          : "Action rejetée, rien n'a été exécuté.",
      );
      clearSelection();
      // Le bus périme aussi le cockpit et les agrégats dérivés : la file n'est
      // pas le seul écran que cette validation vient de rendre faux.
      emitDomainEvent(decision === "approve" ? "action.validee" : "action.rejetee");
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        setNotice("Déjà traitée (aucune double exécution).");
        refresh();
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice("Réservé au rôle owner.");
      } else {
        setNotice("Échec de la décision.");
      }
    } finally {
      setBusyId(null);
    }
  }

  const waiting = actions.filter((a) => a.status === "pending");
  const done = actions.filter((a) => a.status !== "pending");
  const groups = resolvePendingActionGroups(
    waiting.map((a) => a.type),
    inactiveModules,
  );
  const activeGroup = groups.find((group) => group.id === tab) ?? null;
  // « Autres » (types hors catalogue) : tout ce qu'aucun groupe ne réclame.
  const catalogued = new Set(groups.flatMap((group) => group.types));
  const visible =
    activeGroup === null
      ? waiting
      : activeGroup.id === "autres"
        ? waiting.filter((a) => !catalogued.has(a.type))
        : waiting.filter((a) => activeGroup.types.includes(a.type));

  const detailPayload = detail ? asDict(detail.payload) : null;
  const hasDraft = asString(detailPayload?.draft) !== null;
  const dirty = draft !== savedDraft;
  const selectedSummary = waiting.find((a) => a.id === selectedId) ?? null;
  const selectedLine = selectedSummary ? actionLine(selectedSummary, detail ?? undefined) : null;
  const subject = subjectFor(detailPayload);
  const invoice = asDict(detailPayload?.invoice);
  const quote = asDict(detailPayload?.quote);
  const reconciliation = asDict(detailPayload?.reconciliation);
  const daysOverdue = asNumber(asDict(detailPayload?.risk)?.daysOverdue);

  return (
    <>
      <h1 className="page-title">
        {waiting.length} action{waiting.length > 1 ? "s" : ""} à valider
      </h1>
      <p className="page-sub">
        Préparées par vos employés virtuels. Relisez, puis validez en un clic — rien n&apos;est
        envoyé sans vous.
      </p>

      {notice && <p className="error-line">{notice}</p>}

      <div className="tabs">
        <button className={tab === "all" ? "active" : ""} onClick={() => setTab("all")}>
          Toutes <span className="c">{waiting.length}</span>
        </button>
        {groups.map((group) => (
          <button
            key={group.id}
            className={tab === group.id ? "active" : ""}
            onClick={() => setTab(group.id)}
            // Un module éteint qui garde des actions : l'onglet reste, et il
            // s'explique. Sans ça, la présence d'actions d'un module absent de
            // la navigation passe pour un bug.
            title={
              group.moduleOff
                ? "Module désactivé — ces décisions restent dues et restent validables."
                : undefined
            }
          >
            {group.label}
            {group.moduleOff && " ·  éteint"} <span className="c">{group.count}</span>
          </button>
        ))}
      </div>

      {activeGroup?.moduleOff && (
        <p className="hint">
          Le module « {activeGroup.label} » est désactivé : sa page a disparu de la navigation,
          mais ces décisions étaient déjà engagées — elles restent à prendre.
        </p>
      )}

      <div className="validation-cols">
        <div>
          {visible.length === 0 ? (
            <p className="empty">Rien à valider.</p>
          ) : (
            visible.map((action) => {
              const line = actionLine(action, details[action.id]);
              return (
                <button
                  key={action.id}
                  className={`action-card ${selectedId === action.id ? "selected" : ""}`}
                  onClick={() => void select(action.id)}
                >
                  <div className="trow">
                    <span className={`chip ${action.type}`}>{actionChipLabel(action.type)}</span>
                    <span className="when">{timeAgo(action.createdAt)}</span>
                  </div>
                  <div className="atitle">{line.title}</div>
                  {line.meta && <div className="ameta">{line.meta}</div>}
                  {/* Le chantier, sur la carte : c'est la question que le
                      patron se pose en premier devant une relance. */}
                  {action.affaire && (
                    <div className="ameta">
                      {action.affaire.reference} — {action.affaire.label}
                    </div>
                  )}
                </button>
              );
            })
          )}

          {done.length > 0 && (
            <>
              <h2 className="overline" style={{ margin: "26px 0 10px", display: "block" }}>
                Historique
              </h2>
              <table className="ledger">
                <tbody>
                  {done.slice(0, 8).map((action) => (
                    <tr key={action.id}>
                      <td>{actionTypeLabel(action.type)}</td>
                      <td>
                        <span className={`badge ${action.status}`}>
                          {actionStatusLabel(action.status)}
                        </span>
                      </td>
                      <td style={{ color: "var(--ink-faint)", fontSize: 12 }}>
                        {action.validatedAt
                          ? new Date(action.validatedAt).toLocaleString("fr-FR")
                          : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </div>

        <div className="detail-panel">
          {selectedId === null ? (
            <div className="card">
              <p className="empty" style={{ padding: "40px 0", textAlign: "center" }}>
                Sélectionnez une action pour relire son contenu avant de décider.
              </p>
            </div>
          ) : (
            <div className="card">
              <div className="card-header">
                <div className="titles">
                  <div className="title">Aperçu — {selectedLine?.title ?? "…"}</div>
                </div>
                {hasDraft && (
                  <span className="tag-souverain">Souverain · rédigé par Mistral EU</span>
                )}
              </div>

              {detailNotice && <p className="hint">{detailNotice}</p>}
              {!detail && !detailNotice && <p className="hint">Chargement…</p>}

              {/* Rattachement au chantier (F6) — FACULTATIF, et réversible.
                  Une action de frais généraux n'a pas de chantier : « Aucun »
                  est une réponse, pas un oubli à corriger. */}
              {detail && (
                <div className="meta" style={{ marginBottom: 10 }}>
                  <span className="overline">Chantier concerné</span>
                  <select
                    value={selectedSummary?.affaireId ?? ""}
                    aria-label="Chantier concerné"
                    onChange={(event) =>
                      void attachAffaire(selectedId, event.target.value || null)
                    }
                  >
                    <option value="">Aucun — frais généraux</option>
                    {/* Le chantier RATTACHÉ figure toujours, même absent de la
                        liste — une affaire archivée n'apparaît plus dans
                        /affaires, mais archiver ne détache rien. Sans cette
                        option, la carte de gauche affichait le chantier
                        pendant que le sélecteur se rendait vide. */}
                    {selectedSummary?.affaire &&
                      selectedSummary.affaireId !== null &&
                      !affaires.some((a) => a.id === selectedSummary.affaireId) && (
                        <option value={selectedSummary.affaireId}>
                          {selectedSummary.affaire.reference} — {selectedSummary.affaire.label}
                          {selectedSummary.affaire.status === "ARCHIVEE" && " (archivée)"}
                        </option>
                      )}
                    {affaires.map((affaire) => (
                      <option key={affaire.id} value={affaire.id}>
                        {affaire.reference} — {affaire.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {detailPayload && selectedSummary?.type === "create_fixed_asset" && (
                <FixedAssetProposal payload={detailPayload} />
              )}
              {detailPayload && selectedSummary?.type === "create_quote" && (
                <QuoteProposalDetail payload={detailPayload} />
              )}
              {detailPayload &&
                selectedSummary?.type !== "create_fixed_asset" &&
                selectedSummary?.type !== "create_quote" && (
                <>
                  <div className="meta-row">
                    {invoice && (
                      <>
                        <div className="meta">
                          <span className="overline">Destinataire</span>
                          <div className="value">{asString(invoice.customer) ?? "—"}</div>
                        </div>
                        <div className="meta">
                          <span className="overline">Montant dû</span>
                          <div className="value">
                            {asNumber(invoice.amountCents) !== null
                              ? formatEuroCents(asNumber(invoice.amountCents) ?? 0)
                              : "—"}
                          </div>
                        </div>
                        {(asNumber(invoice.retainedCents) ?? 0) > 0 && (
                          // US-8 : la retenue de garantie est due mais pas
                          // exigible. Le montant réclamé l'exclut — le dire
                          // AVANT la validation, sinon l'écart entre la
                          // facture et la relance passe pour une erreur.
                          <div className="meta">
                            <span className="overline">Retenue de garantie (non réclamée)</span>
                            <div className="value">
                              {formatEuroCents(asNumber(invoice.retainedCents) ?? 0)}
                              {asNumber(invoice.totalCents) !== null && (
                                <span className="hint">
                                  {" "}
                                  sur {formatEuroCents(asNumber(invoice.totalCents) ?? 0)} facturés
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        <div className="meta">
                          <span className="overline">Échéance</span>
                          <div className="value">
                            {daysOverdue !== null ? `Dépassée de ${daysOverdue} j` : "—"}
                          </div>
                        </div>
                      </>
                    )}
                    {quote && (
                      <>
                        <div className="meta">
                          <span className="overline">Client</span>
                          <div className="value">{asString(quote.customer) ?? "—"}</div>
                        </div>
                        <div className="meta">
                          <span className="overline">Montant</span>
                          <div className="value">
                            {asNumber(quote.amountCents) !== null
                              ? formatEuroCents(asNumber(quote.amountCents) ?? 0)
                              : "—"}
                          </div>
                        </div>
                        <div className="meta">
                          <span className="overline">Objet</span>
                          <div className="value">{asString(quote.label) ?? "—"}</div>
                        </div>
                      </>
                    )}
                    {reconciliation && (
                      <>
                        <div className="meta">
                          <span className="overline">Écritures</span>
                          <div className="value">{asNumber(reconciliation.entries) ?? "—"}</div>
                        </div>
                        <div className="meta">
                          <span className="overline">Total</span>
                          <div className="value">
                            {asNumber(reconciliation.totalCents) !== null
                              ? formatEuroCents(asNumber(reconciliation.totalCents) ?? 0)
                              : "—"}
                          </div>
                        </div>
                        <div className="meta" />
                      </>
                    )}
                  </div>

                  {hasDraft ? (
                    <div className="email-preview">
                      {subject && (
                        <>
                          <span className="overline">Objet</span>
                          <div className="subj">{subject}</div>
                        </>
                      )}
                      {editing ? (
                        <textarea
                          value={draft}
                          rows={10}
                          onChange={(event) => setDraft(event.target.value)}
                          aria-label="Brouillon modifiable"
                        />
                      ) : (
                        <div className="body">{draft}</div>
                      )}
                    </div>
                  ) : reconciliation ? (
                    <div className="email-preview">
                      <span className="overline">Écritures à rapprocher</span>
                      <div className="body" style={{ borderTop: "none", paddingTop: 8 }}>
                        {(Array.isArray(reconciliation.items) ? reconciliation.items : []).map(
                          (item, index) => {
                            const entry = asDict(item);
                            return (
                              <div
                                key={index}
                                style={{ display: "flex", justifyContent: "space-between" }}
                              >
                                <span>{asString(entry?.label) ?? "—"}</span>
                                <span className="figure">
                                  {asNumber(entry?.amountCents) !== null
                                    ? formatEuroCents(asNumber(entry?.amountCents) ?? 0)
                                    : ""}
                                </span>
                              </div>
                            );
                          },
                        )}
                      </div>
                    </div>
                  ) : null}

                  <div className="reassure">
                    <svg width="13" height="13" viewBox="0 0 13 13" fill="none" aria-hidden>
                      <rect x="1" y="1" width="11" height="11" rx="3" stroke="currentColor" strokeWidth="1.5" />
                      <path d="m4 6.7 1.8 1.8L9.2 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Vous validez — l&apos;employé virtuel n&apos;envoie jamais seul.
                  </div>

                  <div className="action-bar">
                    <button
                      className="primary grow"
                      disabled={busyId === selectedId || (editing && dirty)}
                      title={
                        editing && dirty ? "Enregistrez d'abord votre brouillon modifié." : undefined
                      }
                      onClick={() => void decide(selectedId, "approve")}
                    >
                      Valider et envoyer
                    </button>
                    {hasDraft &&
                      (editing ? (
                        <button
                          disabled={!dirty || saving || draft.trim().length === 0}
                          onClick={() => void saveDraft(selectedId)}
                        >
                          {saving ? "Enregistrement…" : "Enregistrer"}
                        </button>
                      ) : (
                        <button onClick={() => setEditing(true)}>Modifier</button>
                      ))}
                    <button
                      className="danger"
                      disabled={busyId === selectedId}
                      onClick={() => void decide(selectedId, "reject")}
                    >
                      Rejeter
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
