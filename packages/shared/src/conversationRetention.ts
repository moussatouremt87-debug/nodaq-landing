/*
 * Rétention des transcriptions d'agent (RGPD art. 5.1.e) — RÈGLE PURE.
 *
 * CE QUE CONTIENT UNE TRANSCRIPTION. `agent_conversations.messages` porte le
 * fil COMPLET : le message de l'utilisateur, les réponses de l'assistant, et
 * surtout le **résultat brut de chaque outil MCP appelé**. Un `analyze_margin`
 * y dépose des noms de chantiers et des montants ; un `list_overdue_invoices`
 * y dépose des noms de clients et ce qu'ils doivent ; une recherche de
 * prospection y dépose des coordonnées. C'est la donnée la plus concentrée du
 * produit, dans sa forme la moins structurée.
 *
 * CE QUI REND LE CAS TRANCHÉ. Un transcript n'a qu'une finalité : permettre
 * de REPRENDRE la conversation. Or l'identifiant de conversation ne vit que
 * dans un `useRef` de l'écran de chat — il n'est persisté nulle part, aucune
 * route ne liste les conversations, aucun écran n'en affiche l'historique. Un
 * simple rechargement de page rend donc le transcript **définitivement
 * inatteignable** : plus personne, jamais, ne pourra le lire par le produit.
 *
 * Une donnée que personne ne peut plus lire et que rien n'efface n'est pas un
 * historique : c'est un dépôt. L'article 5.1.e ne demande pas autre chose que
 * de lui donner un terme.
 */

/** Bump à chaque changement de règle. Une règle qui bouge doit se voir en diff. */
export const CONVERSATION_RETENTION_VERSION = "2026-08-05";

/**
 * Au-delà, la transcription est SUPPRIMÉE.
 *
 * Délibérément généreux au regard de l'usage réel : la reprise meurt avec
 * l'onglet, donc la fenêtre utile se compte en heures. Trente jours laissent
 * la marge d'un poste laissé allumé, d'un congé, d'une reprise tardive — sans
 * qu'aucune décision de conservation ne repose sur une supposition.
 *
 * Le bon réglage se verra le jour où le produit offrira un historique : la
 * fenêtre deviendra alors un vrai choix produit, pas une borne de sécurité.
 */
export const CONVERSATION_RETENTION_DAYS = 30;

/**
 * SUPPRIMÉE, pas réduite — et c'est l'inverse du choix fait sur la file de
 * validation.
 *
 * Une `pending_action` garde sa ligne parce qu'elle porte la trace d'une
 * DÉCISION humaine : qui a approuvé quoi, et quand. Une transcription ne porte
 * aucune décision — les actions qu'elle a préparées vivent dans la file, avec
 * leur propre trace, et la métadonnée d'exécution (outils appelés, latence,
 * issue) est déjà tracée hors base. Garder une ligne vidée n'apporterait donc
 * qu'un compteur, c'est-à-dire une donnée sans finalité : exactement ce que
 * l'article 5.1.e interdit.
 */

/**
 * L'INSTANT avant lequel une transcription est dormante. PURE.
 *
 * Une seule forme, parce qu'il n'y a qu'un seul consommateur : le balayage
 * supprime en SQL (`updated_at < seuil`), et une deuxième expression de la
 * même règle en TypeScript aurait divergé — la première version le faisait
 * déjà, en désaccord sur la borne exacte. Une règle « versionnée datée » qui
 * s'exécute à deux endroits n'est pas une règle, c'est deux règles.
 *
 * L'ÂGE SE COMPTE SUR LA DERNIÈRE ACTIVITÉ, jamais sur la création : le
 * runtime réécrit la ligne à chaque tour — et la touche aussi à la REPRISE,
 * sans quoi une conversation dormante rouverte à l'instant restait éligible
 * pendant tout le tour, c'est-à-dire supprimable sous les doigts de
 * l'utilisateur.
 *
 * La borne est STRICTE : à exactement l'horizon, la ligne est gardée. Une
 * suppression ne se décide pas sur une égalité de milliseconde.
 */
export function conversationCutoff(
  now: Date,
  retentionDays: number = CONVERSATION_RETENTION_DAYS,
): Date {
  return new Date(now.getTime() - retentionDays * 86_400_000);
}
