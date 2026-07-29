/*
 * Envoi des réponses support via Scaleway TEM (fr-par) — UNIQUEMENT depuis la
 * route de validation opérateur (rien ne part sans validation, décision n°1
 * du ticket 2.18). Secrets absents => envoi indisponible (503), le reste du
 * canal (ingestion, triage, brouillons) fonctionne.
 */

export interface SupportMailer {
  send(args: { to: string; subject: string; text: string; inReplyTo?: string }): Promise<void>;
}

export function createTemMailer(env: NodeJS.ProcessEnv = process.env): SupportMailer | null {
  const secretKey = env.SCW_SECRET_KEY;
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
          subject,
          text,
          // Fil de conversation conservé côté client mail.
          ...(inReplyTo
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
