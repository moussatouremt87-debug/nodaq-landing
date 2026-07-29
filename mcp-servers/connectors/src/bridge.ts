import { z } from "zod";
import { resolveBaseUrl } from "./baseurl.js";
import { fetchJson } from "./http.js";

/*
 * Bridge (bridgeapi.io) read-only client — agrégateur bancaire DSP2 français
 * couvrant l'ensemble des banques FR (ticket 2.15). Spécification encodée ici
 * d'après connaissance d'entraînement (API v3) : la documentation officielle
 * (docs.bridgeapi.io) est INACCESSIBLE depuis cet environnement via le proxy
 * sortant — à vérifier/ajuster contre la doc réelle avant mise en prod. D'où
 * TOUT (base URL, version d'API) est surchargeable par variable d'env.
 *
 * - Auth applicative : en-têtes `Client-Id` / `Client-Secret` (identifiants de
 *   l'app Bridge du tenant) + `Bridge-Version` (contrat figé par date).
 * - Auth utilisateur : `POST /aggregation/authorization/token` avec
 *   `{ user_uuid }` -> `{ access_token }`, à passer en Bearer sur les appels
 *   `aggregation/*`. Le token est mis en cache d'instance (renouvelé si absent
 *   — pas de gestion d'expiration V1, le prochain 401 forcera une nouvelle
 *   instance côté registre).
 * - Le `userUuid` est l'utilisateur Bridge DÉJÀ relié à sa banque via le flux
 *   hébergé "Bridge Connect" (Connect Webview) — ce flux d'onboarding
 *   (redirection, callback, création du user Bridge) arrive dans un ticket
 *   ultérieur ; ce client suppose la liaison déjà faite et se contente de
 *   lire les données agrégées.
 * - Zod strip les champs inconnus par défaut (data minimization) : seuls les
 *   champs utiles aux outils métier traversent la frontière.
 */

const BRIDGE_API_VERSION = process.env.BRIDGE_API_VERSION ?? "2025-01-15";

export const BridgeCredentials = z.object({
  clientId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** Utilisateur Bridge déjà relié à sa banque (flux Connect hébergé — cf. commentaire de tête). */
  userUuid: z.string().min(1),
});
export type BridgeCredentials = z.infer<typeof BridgeCredentials>;

const TokenResponse = z.object({
  access_token: z.string(),
});

const BridgeAccount = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullish(),
  /** Bridge renvoie des euros décimaux (pas des centimes, contrairement à Qonto). */
  balance: z.number().nullish(),
  currency_code: z.string().nullish(),
  iban: z.string().nullish(),
});

const AccountsResponse = z.object({
  resources: z.array(BridgeAccount).default([]),
});

const BridgeTransaction = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  clean_description: z.string().nullish(),
  provider_description: z.string().nullish(),
  /** Convention Bridge : négatif = dépense, positif = encaissement. */
  amount: z.number(),
  currency_code: z.string().nullish(),
  date: z.string().nullish(),
  booking_date: z.string().nullish(),
});

const TransactionsResponse = z.object({
  resources: z.array(BridgeTransaction).default([]),
});

export interface BridgeTransactionsOptions {
  /** Accepté pour compatibilité d'interface (contrat `BankClient`) — Bridge
   * filtre par `account_id`, pas par IBAN ; ignoré en V1 (une seule page,
   * tous comptes confondus). */
  iban?: string;
  page?: number;
  perPage?: number;
}

/** Bridge renvoie parfois une date seule (AAAA-MM-JJ) : normalisée en ISO UTC minuit. */
function toIsoDateTime(value: string | null | undefined): string | null {
  if (!value) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
}

export class BridgeClient {
  private readonly baseUrl: string;
  private accessToken: string | undefined;

  constructor(
    private readonly credentials: BridgeCredentials,
    baseUrl?: string,
  ) {
    this.baseUrl = resolveBaseUrl("https://api.bridgeapi.io/v3", baseUrl, "BRIDGE_BASE_URL");
  }

  private appHeaders(): Record<string, string> {
    return {
      "Client-Id": this.credentials.clientId,
      "Client-Secret": this.credentials.clientSecret,
      "Bridge-Version": BRIDGE_API_VERSION,
      accept: "application/json",
    };
  }

  private async getToken(): Promise<string> {
    if (this.accessToken) return this.accessToken;
    const body = await fetchJson(`${this.baseUrl}/aggregation/authorization/token`, {
      method: "POST",
      headers: { ...this.appHeaders(), "content-type": "application/json" },
      body: JSON.stringify({ user_uuid: this.credentials.userUuid }),
    });
    const { access_token } = TokenResponse.parse(body);
    this.accessToken = access_token;
    return access_token;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getToken();
    return { ...this.appHeaders(), authorization: `Bearer ${token}` };
  }

  async getOrganization() {
    const body = await fetchJson(`${this.baseUrl}/aggregation/accounts`, {
      headers: await this.authHeaders(),
    });
    const { resources } = AccountsResponse.parse(body);
    return {
      organization: {
        slug: `bridge-${this.credentials.userUuid.slice(0, 8)}`,
        bank_accounts: resources.map((account) => {
          const balanceCents = account.balance == null ? null : Math.round(account.balance * 100);
          return {
            slug: account.id,
            iban: account.iban ?? null,
            currency: account.currency_code ?? null,
            balance_cents: balanceCents,
            authorized_balance_cents: balanceCents,
          };
        }),
      },
    };
  }

  async listTransactions({ perPage = 25 }: BridgeTransactionsOptions = {}) {
    // Pagination V1 : une seule page de `perPage` éléments — Bridge pagine par
    // curseur (`after`), pas encore branché ici.
    const url = new URL(`${this.baseUrl}/aggregation/transactions`);
    url.searchParams.set("limit", String(perPage));
    const body = await fetchJson(url.toString(), { headers: await this.authHeaders() });
    const { resources } = TransactionsResponse.parse(body);
    return {
      transactions: resources.map((tx) => ({
        transaction_id: tx.id,
        id: tx.id,
        amount_cents: Math.round(Math.abs(tx.amount) * 100),
        currency: tx.currency_code ?? null,
        side: tx.amount < 0 ? "debit" : "credit",
        operation_type: null,
        settled_at: toIsoDateTime(tx.booking_date ?? tx.date),
        label: tx.clean_description ?? tx.provider_description ?? null,
      })),
      meta: { current_page: 1, total_pages: 1 },
    };
  }

  /**
   * Validation d'identifiants pour l'onboarding : obtient un token puis liste
   * les comptes. Toute erreur (fetchJson) ne porte que le statut HTTP et le
   * chemin — jamais un identifiant ni le contenu d'une réponse.
   */
  async testConnection(): Promise<void> {
    await this.getOrganization();
  }
}
