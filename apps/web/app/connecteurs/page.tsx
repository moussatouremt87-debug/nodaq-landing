"use client";

import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import {
  ApiError,
  FecInvalidError,
  connectConnector,
  createWebhookEndpoint,
  deleteWebhookEndpoint,
  disconnectConnector,
  formatEuroCents,
  getFecStatus,
  importFec,
  listConnectors,
  listWebhookEndpoints,
  listWebhookEvents,
} from "../../lib/api";
import { emitDomainEvent } from "../../lib/freshness";
import type {
  ConnectorSummary,
  FecImportReport,
  FecStatus,
  WebhookEndpoint,
  WebhookEvent,
} from "../../lib/api";
import { useViewRefresh } from "../../lib/useFreshness";

/*
 * Connector onboarding (ticket 1.8). The credentials travel ONE way: entered
 * here, POSTed to the API (tested against the provider, then vaulted) — never
 * read back, never displayed. The forms always render empty.
 */

interface ConnectorSpec {
  type: "qonto" | "pennylane" | "bridge" | "silae" | "pdp";
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
    type: "bridge",
    title: "Bridge — toutes banques",
    purpose:
      "Agrégateur DSP2 : soldes et transactions de toutes les banques françaises. Utilisé automatiquement si Qonto n'est pas connecté.",
    fields: [
      { name: "clientId", label: "Client ID", secret: false },
      { name: "clientSecret", label: "Client Secret", secret: true },
      { name: "userUuid", label: "UUID utilisateur Bridge (banque reliée)", secret: false },
    ],
  },
  {
    type: "pennylane",
    title: "Pennylane",
    purpose: "Facturation — factures clients pour les relances de l'employé Compta.",
    fields: [{ name: "apiKey", label: "Clé API", secret: true }],
  },
  {
    type: "pdp",
    title: "Plateforme de dématérialisation (PDP)",
    purpose:
      "Facturation électronique : dépôt des factures et e-reporting sur la plateforme agréée que vous avez choisie. Chaque dépôt reste validé à la main depuis la file de validation.",
    fields: [
      { name: "apiKey", label: "Clé API de la plateforme", secret: true },
      { name: "accountId", label: "Identifiant de compte émetteur", secret: false },
    ],
  },
  {
    type: "silae",
    title: "Silae — paie & RH",
    purpose:
      "SIRH/paie : salariés et absences pour les plannings RH (accès via votre gestionnaire de paie partenaire Silae). La synchronisation se lance depuis la page Équipe & plannings.",
    fields: [
      { name: "apiKey", label: "Clé API partenaire", secret: true },
      { name: "dossierId", label: "Numéro de dossier paie", secret: false },
    ],
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
      emitDomainEvent("connecteur.modifie");
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
      emitDomainEvent("connecteur.modifie");
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
  useViewRefresh(["connecteurs"], refresh);

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
      setStatus({
        imported: false,
        lastImport: null,
        retention: { totalCents: 0, releaseDateKnown: false, inProgress: false },
      });
      setNotice("Données importées supprimées.");
      // Purge, pas import : même portée de vues, autre intention. Un nom
      // d'événement qui ment finit par tromper celui qui lit la config.
      emitDomainEvent("fec.purge");
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
      emitDomainEvent("fec.importe");
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
          {status.retention.inProgress && (
            // US-8 : dite À PART des impayés, et jamais dans le même compteur.
            // Une retenue muette laisse croire que ces 5 % sont perdus — ou
            // pousse à les réclamer à la main. Le total est le SOLDE du compte
            // 4117 : une retenue déjà libérée n'y figure plus, quelle que soit
            // la pièce sous laquelle la libération a été comptabilisée.
            // Le MONTANT est owner-only ; le fait, lui, se dit à tout membre.
            <p className="hint">
              {status.retention.totalCents === null
                ? "Des retenues de garantie sont en cours"
                : `Dont ${formatEuroCents(status.retention.totalCents)} de retenue de garantie en cours`}
              {" "}: due, mais pas exigible — jamais comptée en impayé ni relancée.
              {!status.retention.releaseDateKnown &&
                " La date de levée des réserves est contractuelle : elle n'est pas dans le FEC."}
            </p>
          )}
          {status.lastImport.warnings.length > 0 && (
            // Les limites de la dérivation restent affichées après le premier
            // rechargement : une retenue non rattachable reste comptée en
            // impayé, et ce fait ne doit pas s'évaporer avec le rapport
            // d'import.
            <ul className="hint" style={{ paddingLeft: 18 }}>
              {status.lastImport.warnings.slice(0, 5).map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
              {status.lastImport.warnings.length > 5 && (
                <li>…et {status.lastImport.warnings.length - 5} autre(s).</li>
              )}
            </ul>
          )}
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
        </p>
      )}
      {report && !report.alreadyImported && report.warnings.length > 0 && (
        // Les avertissements sont des COMPTEURS (jamais une ligne du journal —
        // donnée confidentielle 2.14), et ils portent les limites de la
        // dérivation : une retenue non rattachable, par exemple, reste comptée
        // en impayé. Un simple « 3 avertissement(s) » laisserait cette limite
        // invisible juste là où elle change le chiffre affiché.
        <ul className="hint" style={{ paddingLeft: 18 }}>
          {report.warnings.slice(0, 5).map((warning, index) => (
            <li key={index}>{warning}</li>
          ))}
          {report.warnings.length > 5 && <li>…et {report.warnings.length - 5} autre(s).</li>}
        </ul>
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
  useViewRefresh(["connecteurs"], refresh);

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
      <WebhooksCard />
    </>
  );
}

/*
 * Webhooks entrants (2.13) — l'URL et le secret à recopier chez le
 * fournisseur (PDP, Bridge…). Le secret n'est affiché QU'UNE fois, à la
 * création : ni l'API ni la base ne peuvent le rejouer ensuite.
 */
function WebhooksCard() {
  const [endpoints, setEndpoints] = useState<WebhookEndpoint[]>([]);
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [provider, setProvider] = useState("pdp");
  const [created, setCreated] = useState<{ url: string; secret: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  const refresh = useCallback(() => {
    listWebhookEndpoints()
      .then(setEndpoints)
      .catch((error: unknown) => {
        if (error instanceof ApiError && error.status === 403) setForbidden(true);
      });
    listWebhookEvents()
      .then(setEvents)
      .catch(() => undefined);
  }, []);

  useEffect(refresh, [refresh]);

  if (forbidden) return null;

  async function create(): Promise<void> {
    setNotice(null);
    try {
      const endpoint = await createWebhookEndpoint(provider);
      setCreated({ url: endpoint.url, secret: endpoint.secret });
      refresh();
      emitDomainEvent("connecteur.modifie");
    } catch {
      setNotice("Création impossible.");
    }
  }

  async function revoke(target: string): Promise<void> {
    if (!window.confirm(`Révoquer l'endpoint ${target} ? Les livraisons seront refusées.`)) return;
    setNotice(null);
    try {
      await deleteWebhookEndpoint(target);
      setCreated(null);
      refresh();
      emitDomainEvent("connecteur.modifie");
    } catch {
      setNotice("Révocation impossible.");
    }
  }

  return (
    <div className="card" style={{ marginTop: 24, maxWidth: 880 }}>
      <span className="overline">Webhooks entrants</span>
      <p className="hint" style={{ margin: "4px 0 14px" }}>
        Recevez les notifications de vos fournisseurs (plateforme de facturation, banque). Chaque
        livraison doit être signée : NODAQ refuse tout ce qui n&apos;est pas prouvé.
      </p>
      <div className="form-grid">
        <select value={provider} onChange={(e) => setProvider(e.target.value)}>
          {["pdp", "bridge", "pennylane", "qonto", "test"].map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button className="primary" onClick={() => void create()}>
          Créer / renouveler
        </button>
      </div>
      {created && (
        <p className="hint">
          <strong>URL :</strong> <code>{created.url}</code>
          <br />
          <strong>Secret (affiché une seule fois) :</strong> <code>{created.secret}</code>
          <br />
          En-tête de signature : <code>X-Nodaq-Signature: t=&lt;unix&gt;,v1=&lt;hmac-sha256&gt;</code> —
          recopiez ce secret chez le fournisseur maintenant : il ne sera plus jamais affiché.
        </p>
      )}
      <ul className="device-list">
        {endpoints.map((endpoint) => (
          <li key={endpoint.id} className="device-row">
            <div>
              <strong>{endpoint.provider}</strong>{" "}
              <span className="muted">
                /webhooks/{endpoint.provider}/{endpoint.id}
                {!endpoint.active && " · inactif"}
              </span>
            </div>
            <button onClick={() => void revoke(endpoint.provider)}>Révoquer</button>
          </li>
        ))}
      </ul>
      {events.length > 0 && (
        <>
          <span className="overline">Dernières réceptions</span>
          <ul className="device-list">
            {events.slice(0, 10).map((event) => (
              <li key={event.id} className="device-row">
                <div>
                  <strong>{event.eventType || event.provider}</strong>{" "}
                  <span className="muted">
                    {event.status} · {new Date(event.receivedAt).toLocaleString("fr-FR")}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {notice && <p className="error-line">{notice}</p>}
    </div>
  );
}
