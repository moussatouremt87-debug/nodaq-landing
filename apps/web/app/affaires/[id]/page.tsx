"use client";

import Link from "next/link";
import { useCallback, useState } from "react";
import { useParams } from "next/navigation";
import {
  ApiError,
  archiveAffaire,
  formatEuroCents,
  getAffaire,
  removeImputation,
} from "../../../lib/api";
import type { AffaireDetail, AffaireMarge } from "../../../lib/api";
import { emitDomainEvent } from "../../../lib/freshness";
import { useFreshness } from "../../../lib/useFreshness";
import { affaireWords } from "@nodaq/shared";

/*
 * Fiche d'une affaire (ticket 4.1) — la réponse à « est-ce que CE chantier me
 * rapporte de l'argent, pendant qu'il est encore en cours ».
 *
 * Le bloc coûts/marge se rend sur le `kind` de l'union discriminée : il est
 * IMPOSSIBLE d'afficher une marge qui n'a pas été calculée, parce que le champ
 * n'existe pas dans ce cas-là. C'est le seul garde-fou qui résiste à un écran
 * écrit vite.
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

const TARGET_LABELS: Record<string, string> = {
  classeur_document: "Document du classeur",
  transaction_bancaire: "Transaction bancaire",
  facture: "Facture",
  charge: "Charge",
};

/** Ce qui manque, en français — jamais un code brut à l'écran. */
const MISSING_LABELS: Record<string, string> = {
  couts: "aucune dépense rattachée",
  heures: "heures passées non renseignées",
  cout_horaire: "coût horaire chargé non renseigné",
  pieces_ttc: "des pièces sont en TTC (non converties)",
  montants_inconnus: "des pièces sont sans montant",
};

function MissingList({ missing }: { missing: readonly string[] }) {
  if (missing.length === 0) return null;
  return (
    <ul className="hint" style={{ margin: "6px 0 0", paddingLeft: 18 }}>
      {missing.map((item) => (
        <li key={item}>{MISSING_LABELS[item] ?? item}</li>
      ))}
    </ul>
  );
}

function CostLines({ marge }: { marge: AffaireMarge }) {
  return (
    <ul className="hint" style={{ margin: "8px 0 0", paddingLeft: 18 }}>
      <li>Matière : {formatEuroCents(marge.materialCents)}</li>
      <li>Sous-traitance : {formatEuroCents(marge.subcontractCents)}</li>
      {marge.kind === "marge" && <li>Main-d&apos;oeuvre : {formatEuroCents(marge.labourCents)}</li>}
      {marge.ttcOnlyCount > 0 && (
        <li>
          {marge.ttcOnlyCount} pièce(s) en TTC ({formatEuroCents(marge.ttcOnlyCents)}) — non
          converties en HT faute du taux réel, donc hors du coût ci-dessus.
        </li>
      )}
      {marge.unknownAmountCount > 0 && (
        <li>{marge.unknownAmountCount} pièce(s) sans montant connu.</li>
      )}
      {marge.depositsCents > 0 && (
        <li>
          Acomptes encaissés : {formatEuroCents(marge.depositsCents)} — de la trésorerie, jamais de
          la marge acquise.
        </li>
      )}
    </ul>
  );
}

function MargeBlock({ detail }: { detail: AffaireDetail }) {
  if (detail.marge === null) {
    return (
      <div className="card">
        <span className="overline">Coûts &amp; marge</span>
        <p className="hint">{detail.margeRefus ?? "réservé au dirigeant"}</p>
      </div>
    );
  }
  const marge = detail.marge;
  return (
    <div className="card">
      <span className="overline">Coûts &amp; marge</span>
      {marge.kind === "donnees_insuffisantes" && (
        <>
          <p className="warn" style={{ margin: "6px 0" }}>
            Données insuffisantes
          </p>
          {/* Afficher « 100 % de marge » ici serait exact et mortel. */}
          <p className="hint">
            Rien n&apos;est encore rattaché : une marge calculée maintenant vaudrait le devis
            entier, ce qui serait vrai et faux à la fois.
          </p>
          <MissingList missing={marge.missing} />
        </>
      )}

      {marge.kind === "couts_seuls" && (
        <>
          <p className="hint">
            Pas de montant devisé : les coûts sont connus, la marge ne l&apos;est pas.
          </p>
          <CostLines marge={marge} />
          <MissingList missing={marge.missing} />
        </>
      )}

      {marge.kind === "marge_borne_superieure" && (
        <>
          <p style={{ margin: "6px 0", fontWeight: 600 }}>
            Marge au mieux {formatEuroCents(marge.upperBoundCents)}
          </p>
          <p className="hint">
            Un coût manque : la marge réelle ne peut être QUE plus basse. C&apos;est un plafond,
            pas un résultat.
          </p>
          <CostLines marge={marge} />
          <MissingList missing={marge.missing} />
          {!detail.hourlyCostKnown && (
            <p className="hint">
              Renseignez le coût horaire chargé dans les réglages pour obtenir une marge exacte.
            </p>
          )}
          <p className="hint">
            Reste à facturer : {formatEuroCents(marge.remainingToInvoiceCents)}
            {marge.retentionCents > 0 &&
              ` · retenue de garantie ${formatEuroCents(marge.retentionCents)} (exclue)`}
          </p>
        </>
      )}

      {marge.kind === "marge" && (
        <>
          <p style={{ margin: "6px 0", fontWeight: 600 }}>
            Marge {formatEuroCents(marge.marginCents)}
            {marge.marginBps !== null && ` (${(marge.marginBps / 100).toFixed(1)} %)`}
          </p>
          <CostLines marge={marge} />
          <p className="hint">
            Coût total : {formatEuroCents(marge.totalCostCents)} · Reste à facturer :{" "}
            {formatEuroCents(marge.remainingToInvoiceCents)}
            {marge.retentionCents > 0 && (
              <>
                {" "}
                · retenue de garantie {formatEuroCents(marge.retentionCents)} —{" "}
                <strong>exclue</strong> du reste à facturer (due, pas encore exigible)
              </>
            )}
          </p>
          {marge.budgetGap && (
            <p className="hint">
              Écart budget matière : {formatEuroCents(marge.budgetGap.deltaCents)} (
              {(marge.budgetGap.deltaBps / 100).toFixed(1)} %)
            </p>
          )}
        </>
      )}
    </div>
  );
}

export default function AffairePage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const [detail, setDetail] = useState<AffaireDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setDetail(await getAffaire(id));
  }, [id]);

  const freshness = useFreshness(["affaires"], load);
  const words = affaireWords(detail?.vertical ?? null);

  async function detach(imputationId: string): Promise<void> {
    setNotice(null);
    try {
      await removeImputation(id, imputationId);
      freshness.refresh();
      emitDomainEvent("affaire.imputee");
      setNotice("Pièce détachée — la trace du rattachement est conservée.");
    } catch {
      setNotice("Détachement impossible.");
    }
  }

  async function archive(): Promise<void> {
    if (!window.confirm(`Archiver ${words.definite} ? Les pièces rattachées sont conservées.`)) {
      return;
    }
    setNotice(null);
    try {
      await archiveAffaire(id);
      freshness.refresh();
      emitDomainEvent("affaire.modifiee");
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 403
          ? "archivage réservé au dirigeant"
          : "archivage impossible",
      );
    }
  }

  if (detail === null) return <p className="hint">Chargement…</p>;
  const affaire = detail.affaire;

  return (
    <>
      <p className="hint">
        <Link href="/affaires">← {words.plural}</Link>
      </p>
      <h1 className="page-title">
        {affaire.reference} · {affaire.label}
      </h1>
      <p className="page-sub">
        {affaire.clientName ?? "Client non renseigné"} ·{" "}
        {STATUS_LABELS[affaire.status] ?? affaire.status}
        {affaire.startDate && ` · démarré le ${affaire.startDate}`}
      </p>
      <p className="hint">
        {freshness.label} ·{" "}
        <button className="link-button" onClick={freshness.refresh}>
          rafraîchir
        </button>
      </p>
      {notice && <p className="hint">{notice}</p>}

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 360px", minWidth: 300 }}>
          <MargeBlock detail={detail} />
        </div>

        <div style={{ flex: "1 1 360px", minWidth: 300 }}>
          <div className="card">
            <span className="overline">Pièces rattachées ({detail.imputations.length})</span>
            {detail.imputations.length === 0 ? (
              <p className="hint">
                Aucune pièce. Rattachez une dépense depuis le classeur ou une transaction.
              </p>
            ) : (
              <ul className="device-list">
                {detail.imputations.map((imputation) => (
                  <li key={imputation.id} className="device-row">
                    <div>
                      <strong>{TARGET_LABELS[imputation.targetType] ?? imputation.targetType}</strong>
                      <br />
                      <span className="hint">
                        {imputation.amountCents === null
                          ? detail.amountsVisible
                            ? "montant inconnu"
                            : "réservé au dirigeant"
                          : `${formatEuroCents(imputation.amountCents)} ${imputation.amountBasis?.toUpperCase() ?? ""}`}
                        {imputation.subcontract && " · sous-traitance"}
                        {imputation.source === "AUTO" && " · suggestion non confirmée"}
                      </span>
                    </div>
                    <button className="danger" onClick={() => void detach(imputation.id)}>
                      Retirer
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {affaire.status !== "ARCHIVEE" && detail.amountsVisible && (
            <div className="card" style={{ marginTop: 14 }}>
              <span className="overline">Clôture</span>
              <p className="hint">
                {/* Il n'y a pas de suppression : des pièces comptables sont
                    rattachées, et les perdre serait irréversible. */}
                Une {words.singular} ne se supprime pas — elle s&apos;archive. Les pièces
                rattachées restent en place.
              </p>
              <button className="danger" onClick={() => void archive()}>
                Archiver
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
