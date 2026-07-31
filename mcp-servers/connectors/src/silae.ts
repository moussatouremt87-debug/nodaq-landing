import { z } from "zod";
import { resolveBaseUrl } from "./baseurl.js";
import { fetchJson } from "./http.js";

/*
 * Silae (RH/paie) read-only client — ticket 3.10. L'API publique Silae passe
 * en réalité par un agrément partenaire (intégrations SOAP / middlewares
 * spécifiques par cabinet) : il n'existe pas d'API REST publique documentée
 * accessible directement. Ce client V1 cible donc une interface REST
 * SIMPLIFIÉE, exposée par un middleware partenaire (agrégateur d'accès Silae),
 * base URL configurable — À VÉRIFIER/AJUSTER contre le contrat réel du
 * partenaire choisi avant mise en prod (cf. `resolveBaseUrl`, comme Bridge).
 *
 * - Auth : `Authorization: Bearer <apiKey>` + en-tête `X-Dossier-Id` (le
 *   dossier de paie Silae du tenant — un cabinet peut gérer plusieurs
 *   dossiers, jamais un accès "tous dossiers").
 * - Lecture SEULE : aucun outil d'écriture (paie/absences saisies dans
 *   Silae, jamais depuis NODAQ en V1).
 * - Zod TOLÉRANT par élément (safeParse) sur les listes : une ligne
 *   malformée est ignorée, jamais une exception qui ferait échouer toute la
 *   page (paie = donnée sensible mais aussi peu fiable côté export).
 * - Zod strip les champs inconnus par défaut (data minimization) : seuls les
 *   champs utiles aux outils métier traversent la frontière.
 */

export const SilaeCredentials = z
  .object({
    apiKey: z.string().min(8).max(200),
    dossierId: z.string().min(1).max(50),
  })
  .strict();
export type SilaeCredentials = z.infer<typeof SilaeCredentials>;

// Bornes de longueur sur TOUTE donnée fournisseur (audit 3.10) : un id
// surdimensionné entrerait sinon dans un index unique btree côté sync.
const SilaeEmployee = z.object({
  id: z.string().min(1).max(100),
  first_name: z.string().max(200).nullish(),
  last_name: z.string().max(200).nullish(),
  weekly_hours: z.number().nullish(),
  active: z.boolean().nullish(),
});
export type SilaeEmployee = z.infer<typeof SilaeEmployee>;

const SilaeAbsence = z.object({
  id: z.string().min(1).max(100),
  employee_id: z.string().min(1).max(100),
  type: z.string().max(100).nullish(),
  /** Format YYYY-MM-DD (pas de composante horaire côté Silae). */
  start_date: z.string().max(30),
  end_date: z.string().max(30),
});
export type SilaeAbsence = z.infer<typeof SilaeAbsence>;

const ListResponse = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    // Tolérant PAR ÉLÉMENT : une ligne malformée est ignorée (safeParse),
    // jamais une exception qui invalide toute la page.
    items: z
      .array(z.unknown())
      .default([])
      .transform((rawItems) =>
        rawItems.flatMap((raw) => {
          const parsed = item.safeParse(raw);
          return parsed.success ? [parsed.data as z.infer<T>] : [];
        }),
      ),
    next_cursor: z.string().nullish(),
  });

export interface SilaeListOptions {
  limit?: number;
  cursor?: string;
}

export interface SilaeAbsencesOptions extends SilaeListOptions {
  /** Bornes YYYY-MM-DD (déjà validées côté outil MCP). */
  from?: string;
  to?: string;
}

export class SilaeClient {
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: SilaeCredentials,
    baseUrl?: string,
  ) {
    this.baseUrl = resolveBaseUrl("https://api.silae.example", baseUrl, "SILAE_BASE_URL");
    // Le défaut est un PLACEHOLDER (TLD réservé) tant que le middleware
    // partenaire n'est pas contracté : en production, on refuse d'émettre la
    // moindre requête porteuse d'identifiants vers cette destination — échec
    // explicite plutôt qu'un connecteur silencieusement mort (audit 3.10).
    if (process.env.NODE_ENV === "production" && this.baseUrl === "https://api.silae.example") {
      throw new Error("silae partner base URL not configured");
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.credentials.apiKey}`,
      "x-dossier-id": this.credentials.dossierId,
      accept: "application/json",
    };
  }

  async listEmployees({ limit = 25, cursor }: SilaeListOptions = {}) {
    const url = new URL(`${this.baseUrl}/employees`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    const body = await fetchJson(url.toString(), { headers: this.headers() });
    return ListResponse(SilaeEmployee).parse(body);
  }

  async listAbsences({ from, to, limit = 25, cursor }: SilaeAbsencesOptions = {}) {
    const url = new URL(`${this.baseUrl}/absences`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    if (from) url.searchParams.set("from", from);
    if (to) url.searchParams.set("to", to);
    const body = await fetchJson(url.toString(), { headers: this.headers() });
    return ListResponse(SilaeAbsence).parse(body);
  }

  /**
   * Validation d'identifiants pour l'onboarding : liste une seule page de
   * salariés (même rôle que `BridgeClient.testConnection` / le flux
   * `defaultWritableProvider` d'onboarding) — la réponse est JETÉE, seule
   * l'absence d'erreur HTTP prouve que la clé/dossier sont valides.
   */
  async testConnection(): Promise<void> {
    await this.listEmployees({ limit: 1 });
  }
}
