"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  classeurPhotoUrl,
  correctClasseurDocument,
  deleteClasseurDocument,
  getClasseurCandidates,
  getClasseurMemory,
  listClasseurDocuments,
  matchClasseurDocument,
  uploadClasseurDocument,
} from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import type {
  ClasseurCorrection,
  ClasseurDocument,
  ClasseurMemory,
  MatchCandidate,
} from "../../lib/api";
import { useViewRefresh } from "../../lib/useFreshness";

/*
 * Classeur documentaire photo (ticket 2.16) : on photographie un reçu ou une
 * facture, le tier souverain extrait les champs, on corrige si besoin (chaque
 * correction nourrit le futur apprentissage), l'owner rapproche avec la
 * banque. La photo est servie par une route authentifiée — jamais en JSON.
 */

const DOC_TYPE_LABELS: Record<string, string> = {
  facture_fournisseur: "Facture fournisseur",
  recu: "Reçu",
  note_de_frais: "Note de frais",
  autre: "Autre",
};

const STATUS_LABELS: Record<string, string> = {
  a_verifier: "À vérifier",
  verifie: "Vérifié",
  rapproche: "Rapproché",
};

function euro(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return "—";
  return new Intl.NumberFormat("fr-FR", { style: "currency", currency: "EUR" }).format(amount);
}

function monthOf(document: ClasseurDocument): string {
  const date = document.extraction?.docDate ?? document.createdAt;
  const parsed = new Date(date);
  if (Number.isNaN(parsed.getTime())) return "Sans date";
  const label = parsed.toLocaleDateString("fr-FR", { month: "long", year: "numeric" });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

interface FormState {
  docType: string;
  supplierName: string;
  pieceNumber: string;
  docDate: string;
  totalInclTax: string;
}

function formFrom(document: ClasseurDocument): FormState {
  return {
    docType: document.docType,
    supplierName: document.extraction?.supplierName ?? "",
    pieceNumber: document.extraction?.pieceNumber ?? "",
    docDate: document.extraction?.docDate ?? "",
    totalInclTax:
      document.extraction?.totalInclTax !== null && document.extraction?.totalInclTax !== undefined
        ? String(document.extraction.totalInclTax)
        : "",
  };
}

export default function ClasseurPage() {
  const [documents, setDocuments] = useState<ClasseurDocument[]>([]);
  // Boucle d'apprentissage (2.16b) : ce que le classeur a retenu de VOTRE
  // entreprise, avec le nombre de corrections qui le fondent.
  const [memory, setMemory] = useState<ClasseurMemory | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [candidates, setCandidates] = useState<MatchCandidate[] | null>(null);
  const [bankAvailable, setBankAvailable] = useState<boolean | null>(null);
  const [isOwner, setIsOwner] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);

  const selected = documents.find((d) => d.id === selectedId) ?? null;

  const refresh = useCallback(() => {
    getClasseurMemory()
      .then(setMemory)
      .catch(() => undefined);
    listClasseurDocuments()
      .then(setDocuments)
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);
  // Le classeur suit aussi ce que les AUTRES écrans écrivent.
  useViewRefresh(["classeur"], refresh);

  function select(document: ClasseurDocument): void {
    setSelectedId(document.id);
    selectedRef.current = document.id;
    setForm(formFrom(document));
    setCandidates(null);
    setNotice(null);
    getClasseurCandidates(document.id)
      .then((result) => {
        if (selectedRef.current !== document.id) return;
        setBankAvailable(result.reason !== "no-bank");
        setCandidates(result.candidates);
      })
      .catch((error) => {
        if (selectedRef.current !== document.id) return;
        if (error instanceof ApiError && error.status === 403) setIsOwner(false);
        setCandidates([]);
      });
  }

  function patchLocal(updated: ClasseurDocument): void {
    setDocuments((prev) => prev.map((d) => (d.id === updated.id ? updated : d)));
    if (selectedRef.current === updated.id) setForm(formFrom(updated));
  }

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await uploadClasseurDocument(await file.arrayBuffer(), file.name);
      setNotice(
        outcome.alreadyImported
          ? "Document déjà classé (même empreinte) — rien à refaire."
          : outcome.document.extraction
            ? "Document classé — champs extraits par le modèle souverain, vérifiez-les."
            : "Document classé — extraction indisponible, saisissez les champs.",
      );
      refresh();
      select(outcome.document);
      // Une pièce de plus au classeur : le cockpit la compte, cet écran n'est
      // pas le seul concerné.
      emitDomainEvent("document.ajoute");
    } catch (error) {
      if (error instanceof ApiError && error.status === 415) {
        setNotice("Format non pris en charge : photo JPEG, PNG ou WebP.");
      } else if (error instanceof ApiError && error.status === 413) {
        setNotice("Photo trop volumineuse (8 Mo maximum).");
      } else {
        setNotice("Échec de l'envoi.");
      }
    } finally {
      setBusy(false);
    }
  }

  async function save(): Promise<void> {
    if (!selected || !form) return;
    setBusy(true);
    setNotice(null);
    try {
      const fields: ClasseurCorrection = {
        docType: form.docType,
        supplierName: form.supplierName || null,
        pieceNumber: form.pieceNumber || null,
        docDate: /^\d{4}-\d{2}-\d{2}$/.test(form.docDate) ? form.docDate : null,
        totalInclTax: form.totalInclTax === "" ? null : Number(form.totalInclTax.replace(",", ".")),
      };
      if (fields.totalInclTax !== null && Number.isNaN(fields.totalInclTax)) {
        setNotice("Montant TTC invalide.");
        return;
      }
      patchLocal(await correctClasseurDocument(selected.id, fields));
      emitDomainEvent("document.modifie");
      setNotice("Corrections enregistrées — elles nourrissent l'apprentissage.");
    } catch {
      setNotice("Échec de l'enregistrement.");
    } finally {
      setBusy(false);
    }
  }

  async function match(transactionId: string | null): Promise<void> {
    if (!selected) return;
    setBusy(true);
    try {
      patchLocal(await matchClasseurDocument(selected.id, transactionId));
      // Rapprocher (ou détacher) change ce que la trésorerie considère justifié.
      emitDomainEvent("document.rattache");
      setNotice(transactionId ? "Document rapproché de la transaction." : "Rapprochement retiré.");
    } catch {
      setNotice("Échec du rapprochement.");
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    if (!selected) return;
    if (!window.confirm("Supprimer définitivement ce document (photo comprise) ?")) return;
    setBusy(true);
    try {
      await deleteClasseurDocument(selected.id);
      setSelectedId(null);
      selectedRef.current = null;
      setForm(null);
      refresh();
      // Supprimer une pièce RAPPROCHÉE défait aussi le rapprochement bancaire.
      emitDomainEvent("document.modifie");
      setNotice("Document supprimé.");
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.status === 403
          ? "Suppression réservée au rôle owner."
          : "Échec de la suppression.",
      );
    } finally {
      setBusy(false);
    }
  }

  const groups = documents.reduce<Map<string, ClasseurDocument[]>>((acc, document) => {
    const key = monthOf(document);
    acc.set(key, [...(acc.get(key) ?? []), document]);
    return acc;
  }, new Map());

  return (
    <>
      <h1 className="page-title">Classeur</h1>
      <p className="page-sub">
        Photographiez vos reçus et factures : l&apos;IA souveraine extrait les champs, vous vérifiez,
        l&apos;owner rapproche avec la banque. Chaque correction améliore les prochaines extractions.
      </p>

      <div className="card" style={{ maxWidth: 430, marginBottom: 18 }}>
        <span className="overline">Ajouter un document</span>
        <p className="hint" style={{ margin: "4px 0 10px" }}>
          Photo JPEG, PNG ou WebP — 8 Mo max. Le fichier transite en TLS et reste dans votre
          espace souverain (France) — jamais ailleurs.
        </p>
        <label>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (file) void upload(file);
            }}
          />
        </label>
        {busy && <p className="hint">Analyse en cours…</p>}
        {notice && <p className="error-line">{notice}</p>}
      </div>

      {memory && memory.suppliers.length > 0 && (
        <div className="card" style={{ maxWidth: 430, marginBottom: 18 }}>
          <span className="overline">Ce que le classeur a appris</span>
          <p className="hint" style={{ margin: "4px 0 10px" }}>
            Déduit de vos corrections — il faut au moins {memory.minEvidence} corrections
            concordantes pour qu&apos;une règle s&apos;applique, et un désaccord la gèle.
          </p>
          <ul className="hint" style={{ margin: 0, paddingLeft: 18 }}>
            {memory.suppliers
              .filter(
                (supplier) => supplier.fields.length > 0 || supplier.conflicts.length > 0,
              )
              .slice(0, 8)
              .map((supplier) => (
              <li key={supplier.key}>
                <b>{supplier.displayName}</b>
                {supplier.fields.length > 0 && (
                  <>
                    {" — "}
                    {supplier.fields
                      .map((field) => `${field.field} : ${field.value} (${field.evidence})`)
                      .join(", ")}
                  </>
                )}
                {supplier.conflicts.length > 0 && (
                  <> · à trancher : {supplier.conflicts.join(", ")}</>
                )}
                </li>
              ))}
          </ul>
        </div>
      )}

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 340px", minWidth: 300 }}>
          {documents.length === 0 && (
            <p className="hint">Aucun document — photographiez votre premier reçu ci-dessus.</p>
          )}
          {[...groups.entries()].map(([month, docs]) => (
            <section key={month} style={{ marginBottom: 14 }}>
              <span className="overline">{month}</span>
              {docs.map((document) => (
                <button
                  key={document.id}
                  type="button"
                  className={document.id === selectedId ? "card accent" : "card"}
                  onClick={() => select(document)}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    width: "100%",
                    textAlign: "left",
                    marginTop: 8,
                    cursor: "pointer",
                  }}
                >
                  <img
                    src={classeurPhotoUrl(document.id)}
                    alt=""
                    width={44}
                    height={44}
                    style={{ objectFit: "cover", borderRadius: 8, flexShrink: 0 }}
                  />
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <strong style={{ display: "block" }}>
                      {document.extraction?.supplierName ?? document.fileName ?? "Document"}
                    </strong>
                    <span className="hint">
                      {DOC_TYPE_LABELS[document.docType] ?? document.docType} ·{" "}
                      {euro(document.extraction?.totalInclTax)}
                    </span>
                  </span>
                  <span className="hint">{STATUS_LABELS[document.status] ?? document.status}</span>
                </button>
              ))}
            </section>
          ))}
        </div>

        {selected && form && (
          <div className="card" style={{ flex: "1 1 360px", minWidth: 320 }}>
            <span className="overline">
              {DOC_TYPE_LABELS[selected.docType] ?? selected.docType} —{" "}
              {STATUS_LABELS[selected.status] ?? selected.status}
            </span>
            <img
              src={classeurPhotoUrl(selected.id)}
              alt="Document"
              style={{ width: "100%", maxHeight: 260, objectFit: "contain", margin: "10px 0", borderRadius: 10 }}
            />
            {selected.learned && selected.learned.length > 0 && (
              <div className="hint" style={{ margin: "8px 0" }}>
                {selected.learned.map((entry) => (
                  <div key={`${entry.field}-${entry.kind}`}>
                    {entry.kind === "comble" ? (
                      <>
                        <b>{entry.field}</b> pré-rempli d&apos;après vos {entry.evidence}{" "}
                        corrections sur ce fournisseur — vérifiez.
                      </>
                    ) : (
                      <>
                        <b>{entry.field}</b> : lu « {entry.modelValue} », mais vos{" "}
                        {entry.evidence} corrections disent « {entry.value} ». À trancher.
                      </>
                    )}
                  </div>
                ))}
              </div>
            )}
            <label>
              <span className="overline">Type</span>
              <select
                value={form.docType}
                onChange={(e) => setForm({ ...form, docType: e.target.value })}
              >
                {Object.entries(DOC_TYPE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span className="overline">Fournisseur</span>
              <input
                value={form.supplierName}
                onChange={(e) => setForm({ ...form, supplierName: e.target.value })}
              />
            </label>
            <label>
              <span className="overline">N° de pièce</span>
              <input
                value={form.pieceNumber}
                onChange={(e) => setForm({ ...form, pieceNumber: e.target.value })}
              />
            </label>
            <label>
              <span className="overline">Date (AAAA-MM-JJ)</span>
              <input
                value={form.docDate}
                onChange={(e) => setForm({ ...form, docDate: e.target.value })}
                placeholder="2026-06-10"
              />
            </label>
            <label>
              <span className="overline">Montant TTC (€)</span>
              <input
                value={form.totalInclTax}
                onChange={(e) => setForm({ ...form, totalInclTax: e.target.value })}
                inputMode="decimal"
              />
            </label>
            <div style={{ display: "flex", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
              <button className="primary" disabled={busy} onClick={() => void save()}>
                Enregistrer
              </button>
              <button className="danger" disabled={busy} onClick={() => void remove()}>
                Supprimer
              </button>
            </div>

            {isOwner && (
              <div style={{ marginTop: 16 }}>
                <span className="overline">Rapprochement bancaire</span>
                {selected.matchedTransactionId ? (
                  <p className="hint">
                    Rapproché de la transaction {selected.matchedTransactionId}.{" "}
                    <button className="danger" disabled={busy} onClick={() => void match(null)}>
                      Détacher
                    </button>
                  </p>
                ) : bankAvailable === false ? (
                  <p className="hint">
                    Aucune banque connectée — reliez Qonto dans les connecteurs pour rapprocher.
                  </p>
                ) : candidates === null ? (
                  <p className="hint">Recherche de transactions…</p>
                ) : candidates.length === 0 ? (
                  <p className="hint">
                    Aucune transaction au même montant. Vérifiez le montant TTC puis ré-ouvrez le
                    document.
                  </p>
                ) : (
                  candidates.map((candidate) => (
                    <div
                      key={candidate.transactionId}
                      style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 8 }}
                    >
                      <span style={{ flex: 1, minWidth: 0 }} className="hint">
                        {candidate.label ?? candidate.transactionId} ·{" "}
                        {euro(candidate.amountCents / 100)}
                        {candidate.settledAt
                          ? ` · ${new Date(candidate.settledAt).toLocaleDateString("fr-FR")}`
                          : ""}
                        {candidate.score >= 2 ? " · date proche" : ""}
                      </span>
                      <button
                        className="primary"
                        disabled={busy}
                        onClick={() => void match(candidate.transactionId)}
                      >
                        Rapprocher
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
