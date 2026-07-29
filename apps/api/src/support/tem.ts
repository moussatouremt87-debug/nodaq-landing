/*
 * Envoi des réponses support via Scaleway TEM (fr-par) — UNIQUEMENT depuis la
 * route de validation opérateur (rien ne part sans validation, décision n°1
 * du ticket 2.18). Secrets absents => envoi indisponible (503), le reste du
 * canal (ingestion, triage, brouillons) fonctionne.
 */

export interface SupportMailer {
  send(args: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<void>;
}

/** En-tête/sujet : jamais de CR/LF (injection d'en-têtes), longueur bornée. */
function headerSafe(value: string, max: number): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, max);
}

export function createTemMailer(env: NodeJS.ProcessEnv = process.env): SupportMailer | null {
  // Clé IAM DÉDIÉE à TEM (audit 2.18) : jamais la clé maîtresse du coffre.
  const secretKey = env.SUPPORT_TEM_SECRET_KEY;
  const projectId = env.SCW_DEFAULT_PROJECT_ID;
  const fromEmail = env.SUPPORT_FROM_EMAIL;
  if (!secretKey || !projectId || !fromEmail) return null;
  const region = env.SCW_TEM_REGION ?? "fr-par";
  const baseUrl = `https://api.scaleway.com/transactional-email/v1alpha1/regions/${region}/emails`;
  return {
    async send({ to, subject, text, inReplyTo }) {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "x-auth-token": secretKey, "content-type": "application/json" },
        body: JSON.stringify({
          project_id: projectId,
          from: { email: fromEmail, name: "Support NODAQ" },
          to: [{ email: to }],
          subject: headerSafe(subject, 300),
          text,
          // Fil conservé — l'In-Reply-To vient de l'expéditeur : format strict
          // ou rien (jamais un en-tête libre vers le fournisseur).
          ...(inReplyTo && /^<[\x21-\x7e]{1,200}>$/.test(inReplyTo)
            ? { additional_headers: [{ key: "In-Reply-To", value: inReplyTo }] }
            : {}),
        }),
      });
      if (!response.ok) {
        // Jamais le corps de l'erreur fournisseur (il peut refléter le
        // contenu) — le statut suffit au diagnostic.
        throw new Error(`TEM send failed (HTTP ${response.status})`);
      }
    },
  };
}
