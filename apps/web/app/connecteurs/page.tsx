"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { ApiError, connectConnector, disconnectConnector, listConnectors } from "../../lib/api";
import type { ConnectorSummary } from "../../lib/api";

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

  return (
    <div className={connected ? "card accent" : "card"} style={{ maxWidth: 430 }}>
      <span className="overline">
        {spec.title} — {connected ? "connecté" : "non connecté"}
      </span>
      <p className="hint" style={{ margin: "4px 0 14px" }}>
        {spec.purpose}
      </p>
      {connected ? (
        <>
          <p className="hint">
            Depuis le {new Date(connected.createdAt).toLocaleDateString("fr-FR")}. Ressaisissez des
            identifiants pour les faire tourner.
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
      </div>
    </>
  );
}
