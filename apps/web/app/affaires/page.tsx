"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, createAffaire, formatEuroCents, listAffaires } from "../../lib/api";
import type { AffaireList } from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import { useFreshness } from "../../lib/useFreshness";
import { affaireWords } from "@nodaq/shared";

/*
 * Liste des affaires (ticket 4.1) — le pivot du produit.
 *
 * Style registre financier : montants en chiffres tabulaires alignés à droite,
 * pour qu'ils se comparent d'un coup d'oeil sans être lus un par un.
 *
 * LE MOT affiché (chantier / mission / affaire) vient du vertical, jamais du
 * code : `affaireWords(vertical)`. Écrire « chantier » en dur ici, c'est le
 * payer à chaque occurrence le jour du pack traiteur.
 */

const STATUS_LABELS: Record<string, string> = {
  PROSPECT: "Prospect",
  DEVIS_ENVOYE: "Devis envoyé",
  ACCEPTEE: "Acceptée",
  EN_COURS: "En cours",
  TERMINEE: "Terminée",
  PERDUE: "Perdue",
  ARCHIVEE: "Archivée",
};

const FILTERS = ["EN_COURS", "DEVIS_ENVOYE", "ACCEPTEE", "TERMINEE", "PROSPECT", "PERDUE"] as const;

export default function AffairesPage() {
  const [state, setState] = useState<AffaireList | null>(null);
  const [statut, setStatut] = useState<string>("");
  const [archived, setArchived] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [label, setLabel] = useState("");
  const [clientName, setClientName] = useState("");
  const [quoted, setQuoted] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setState(
      await listAffaires({
        ...(statut ? { statut } : {}),
        ...(archived ? { inclureArchivees: true } : {}),
      }),
    );
  }, [statut, archived]);

  const freshness = useFreshness(["affaires"], load);
  const words = affaireWords(state?.vertical ?? null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (label.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const amount = quoted.trim().replace(",", ".");
      const parsed = amount === "" ? null : Math.round(Number(amount) * 100);
      if (parsed !== null && !Number.isFinite(parsed)) {
        setError("montant illisible");
        return;
      }
      await createAffaire({
        label: label.trim(),
        ...(clientName.trim() ? { clientName: clientName.trim() } : {}),
        ...(parsed !== null ? { quotedAmountCents: parsed } : {}),
      });
      setLabel("");
      setClientName("");
      setQuoted("");
      freshness.refresh();
      emitDomainEvent("affaire.modifiee");
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 403
          ? "création réservée au dirigeant"
          : "création impossible",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1 className="page-title">{words.plural.charAt(0).toUpperCase() + words.plural.slice(1)}</h1>
      <p className="page-sub">
        Chaque pièce — photo, dépense, facture — peut se rattacher à {words.indefinite}. Rien n&apos;y
        oblige : une dépense de frais généraux n&apos;appartient à aucun {words.singular}.
      </p>

      {state?.amountsVisible && (
        <div className="card" style={{ maxWidth: 520, marginBottom: 18 }}>
          <span className="overline">{words.newLabel}</span>
          <form onSubmit={(event) => void submit(event)} className="form-grid">
            <label>
              <span className="overline">Libellé</span>
              <input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Rénovation salle de bain"
                required
              />
            </label>
            <label>
              <span className="overline">Client (facultatif)</span>
              <input value={clientName} onChange={(e) => setClientName(e.target.value)} />
            </label>
            <label>
              <span className="overline">Montant devisé HT (€, facultatif)</span>
              <input value={quoted} onChange={(e) => setQuoted(e.target.value)} inputMode="decimal" />
            </label>
            <button className="primary" type="submit" disabled={busy}>
              Créer
            </button>
          </form>
          {error && <p className="warn">{error}</p>}
        </div>
      )}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        <button className={statut === "" ? "primary" : ""} onClick={() => setStatut("")}>
          Tous
        </button>
        {FILTERS.map((value) => (
          <button
            key={value}
            className={statut === value ? "primary" : ""}
            onClick={() => setStatut(value)}
          >
            {STATUS_LABELS[value]}
          </button>
        ))}
        <button className={archived ? "primary" : ""} onClick={() => setArchived((v) => !v)}>
          {/* Archivées = rangées, pas supprimées : on peut toujours les rouvrir. */}
          Voir les archivées
        </button>
      </div>

      <p className="hint">
        {freshness.label}
        {freshness.stale && " — vérifiez"} ·{" "}
        <button className="link-button" onClick={freshness.refresh}>
          rafraîchir
        </button>
      </p>

      {state === null ? (
        <p className="hint">Chargement…</p>
      ) : state.affaires.length === 0 ? (
        <p className="hint">
          Aucun{words.singular === "affaire" ? "e" : ""} {words.singular} pour ce filtre.
        </p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>Réf.</th>
              <th>Libellé</th>
              <th>Client</th>
              <th>Statut</th>
              <th style={{ textAlign: "right" }}>Devisé HT</th>
            </tr>
          </thead>
          <tbody>
            {state.affaires.map((affaire) => (
              <tr key={affaire.id}>
                <td style={{ fontVariantNumeric: "tabular-nums" }}>{affaire.reference}</td>
                <td>
                  <Link href={`/affaires/${affaire.id}`}>{affaire.label}</Link>
                </td>
                <td>{affaire.clientName ?? "—"}</td>
                <td>{STATUS_LABELS[affaire.status] ?? affaire.status}</td>
                <td style={{ textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                  {/* Un tiret ne doit jamais se lire « zéro euro » : sans droit
                      d'accès aux montants, on le DIT plutôt que d'afficher 0. */}
                  {!state.amountsVisible
                    ? "réservé au dirigeant"
                    : affaire.quotedAmountCents === null
                      ? "pas de devis"
                      : formatEuroCents(affaire.quotedAmountCents)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
