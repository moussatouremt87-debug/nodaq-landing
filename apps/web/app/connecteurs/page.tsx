"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  FecInvalidError,
  connectConnector,
  disconnectConnector,
  formatEuroCents,
  getFecStatus,
  importFec,
  listConnectors,
} from "../../lib/api";
import type { ConnectorSummary, FecImportReport, FecStatus } from "../../lib/api";

/*
 * Connector onboarding (ticket 1.8). The credentials travel ONE way: entered
 * here, POSTed to the API (tested against the provider, then vaulted) — never
 * read back, never displayed. The forms always render empty.
 */

interface ConnectorSpec {
  type: "qonto" | "pennylane";
  title: string;
  purpose: string;
  fields: { name: string; label: string; secret: boolean }[];
}

const CONNECTORS: ConnectorSpec[] = [
  {
    type: "qonto",
    title: "Qonto",
    purpose: "Banque — solde et transactions pour la prévision de trésorerie.",
    fields: [
      { name: "organizationSlug", label: "Identifiant d'organisation (slug)", secret: false },
      { name: "secretKey", label: "Clé secrète API", secret: true },
    ],
  },
  {
    type: "pennylane",
    title: "Pennylane",
    purpose: "Facturation — factures clients pour les relances de l'employé Compta.",
    fields: [{ name: "apiKey", label: "Clé API", secret: true }],
  },
];

function ConnectorCard({
  spec,
  connected,
  onChanged,
}: {
  spec: ConnectorSpec;
  connected: ConnectorSummary | undefined;
  onChanged: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      await connectConnector(spec.type, values);
      setNotice("Connecté — identifiants vérifiés et stockés dans le coffre.");
      onChanged();
    } catch (error) {
      if (error instanceof ApiError && error.status === 422) {
        setNotice("Le test de connexion a échoué : vérifiez les identifiants.");
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice("Réservé au rôle owner.");
      } else {
        setNotice("Échec de l'enregistrement.");
      }
    } finally {
      // One-way, success OR failure: the form never keeps what was typed.
      setValues({});
      setBusy(false);
    }
  }

  async function disconnect(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await disconnectConnector(spec.type);
      setNotice("Déconnecté — identifiants supprimés du coffre.");
      onChanged();
    } catch {
      setNotice("Échec de la déconnexion.");
    } finally {
      setBusy(false);
    }
  }

  // Statut « demo » (tenant de démonstration) : données fictives — jamais
  // présenté comme une vraie connexion bancaire.
  const isDemo = connected?.status === "demo";

  return (
    <div className={connected ? "card accent" : "card"} style={{ maxWidth: 430 }}>
      <span className="overline">
        {spec.title} — {connected ? (isDemo ? "démo" : "connecté") : "non connecté"}
      </span>
      <p className="hint" style={{ margin: "4px 0 14px" }}>
        {spec.purpose}
      </p>
      {connected ? (
        <>
          <p className="hint">
            {isDemo
              ? "Données fictives de démonstration — aucune connexion réelle. Saisissez de vrais identifiants pour l'activer."
              : `Depuis le ${new Date(connected.createdAt).toLocaleDateString("fr-FR")}. Ressaisissez des identifiants pour les faire tourner.`}
          </p>
          <button className="danger" disabled={busy} onClick={() => void disconnect()}>
            Déconnecter
          </button>
        </>
      ) : null}
      <form onSubmit={(e) => void submit(e)} style={{ marginTop: 12 }}>
        {spec.fields.map((field) => (
          <label key={field.name}>
            <span className="overline">{field.label}</span>
            <input
              type={field.secret ? "password" : "text"}
              value={values[field.name] ?? ""}
              onChange={(e) => setValues((prev) => ({ ...prev, [field.name]: e.target.value }))}
              required
              autoComplete="off"
            />
          </label>
        ))}
        <button className="primary" type="submit" disabled={busy}>
          {connected ? "Remplacer les identifiants" : "Connecter"}
        </button>
      </form>
      {notice && <p className="error-line">{notice}</p>}
    </div>
  );
}

/*
 * Import FEC (ticket 2.14) : le « connecteur fichier » universel — le FEC que
 * tout logiciel comptable français sait exporter (art. A47 A-1 du LPF). Le
 * fichier part en un clic, seuls des COMPTEURS reviennent (jamais une ligne
 * du journal). Owner uniquement.
 */
function FecCard({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<FecStatus | null>(null);
  const [report, setReport] = useState<FecImportReport | null>(null);
  const [issues, setIssues] = useState<{ line: number; message: string }[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    getFecStatus()
      .then(setStatus)
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  async function purge(): Promise<void> {
    if (!window.confirm("Supprimer toutes les données dérivées du FEC importé ?")) return;
    setBusy(true);
    setNotice(null);
    setReport(null);
    try {
      const response = await fetch("/backend/connectors/fec", { method: "DELETE" });
      if (!response.ok && response.status !== 404) {
        throw new ApiError(response.status, `HTTP ${response.status}`);
      }
      setStatus({ imported: false, lastImport: null });
      setNotice("Données importées supprimées.");
      onChanged();
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

  async function upload(file: File): Promise<void> {
    setBusy(true);
    setNotice(null);
    setIssues(null);
    setReport(null);
    try {
      const outcome = await importFec(await file.arrayBuffer(), file.name);
      setReport(outcome);
      setNotice(
        outcome.alreadyImported
          ? "Fichier déjà importé — données inchangées (idempotence par empreinte)."
          : null,
      );
      refresh();
      onChanged();
    } catch (error) {
      if (error instanceof FecInvalidError) {
        setIssues(error.issues.slice(0, 5));
        setNotice("FEC invalide — rien n'a été importé.");
      } else if (error instanceof ApiError && error.status === 403) {
        setNotice("Import réservé au rôle owner.");
      } else if (error instanceof ApiError && error.status === 413) {
        setNotice("Fichier trop volumineux (50 Mo maximum).");
      } else {
        setNotice("Échec de l'import.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card" style={{ maxWidth: 430 }}>
      <span className="overline">
        Import FEC — {status?.imported ? "importé" : "aucun import"}
      </span>
      <p className="hint" style={{ margin: "4px 0 14px" }}>
        Le fichier des écritures comptables que tout logiciel sait exporter : vos impayés réels
        dans le cockpit, sans rien connecter.
      </p>
      {status?.lastImport && (
        <>
          <p className="hint">
            Dernier import{status.lastImport.fileName ? ` (${status.lastImport.fileName})` : ""} le{" "}
            {new Date(status.lastImport.importedAt).toLocaleDateString("fr-FR")} —{" "}
            {status.lastImport.entryCount} écritures, {status.lastImport.invoiceCount} factures,{" "}
            {status.lastImport.overdueCount} impayé{status.lastImport.overdueCount > 1 ? "s" : ""}.
            Ré-importer remplace ces données.
          </p>
          <button
            className="danger"
            disabled={busy}
            onClick={() => void purge()}
            style={{ marginBottom: 6 }}
          >
            Supprimer les données importées
          </button>
        </>
      )}
      <label style={{ marginTop: 12 }}>
        <span className="overline">Fichier FEC (.txt — tabulation ou « | », 50 Mo max)</span>
        <input
          type="file"
          accept=".txt,.csv,.fec,text/plain"
          disabled={busy}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) void upload(file);
          }}
        />
      </label>
      {busy && <p className="hint">Analyse en cours…</p>}
      {report && !report.alreadyImported && (
        <p className="hint">
          ✅ {report.entryCount} écritures analysées — {report.customerCount} clients,{" "}
          {report.invoiceCount} factures, dont {report.overdueCount} impayé
          {report.overdueCount > 1 ? "s" : ""} ({formatEuroCents(report.overdueCents)}).
          {report.warnings.length > 0 && ` ${report.warnings.length} avertissement(s).`}
        </p>
      )}
      {issues && issues.length > 0 && (
        <ul className="hint" style={{ paddingLeft: 18 }}>
          {issues.map((issue, index) => (
            <li key={index}>
              ligne {issue.line} : {issue.message}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="error-line">{notice}</p>}
    </div>
  );
}

export default function ConnecteursPage() {
  const [connectors, setConnectors] = useState<ConnectorSummary[]>([]);

  const refresh = useCallback(() => {
    listConnectors()
      .then(setConnectors)
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  return (
    <>
      <h1 className="page-title">Connecteurs</h1>
      <p className="page-sub">
        Reliez vos outils : vos identifiants sont vérifiés puis stockés dans le coffre souverain
        (chiffré en production) — ils ne sont jamais réaffichés.
      </p>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
        {CONNECTORS.map((spec) => (
          <ConnectorCard
            key={spec.type}
            spec={spec}
            connected={connectors.find((c) => c.type === spec.type)}
            onChanged={refresh}
          />
        ))}
        <FecCard onChanged={refresh} />
      </div>
    </>
  );
}
