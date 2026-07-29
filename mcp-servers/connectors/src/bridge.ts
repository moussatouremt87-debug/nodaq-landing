import { createHash } from "node:crypto";
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

/** Lu à l'APPEL (pas à l'import) : compatible avec injectSecrets() au boot. */
function bridgeApiVersion(): string {
  return process.env.BRIDGE_API_VERSION ?? "2025-01-15";
}

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
  /** Filtre par IBAN (contrat `BankClient`) : résolu en `account_id` Bridge. */
  iban?: string;
  /** Filtre par slug de compte (= id Bridge) — toujours présent, contrairement à l'IBAN. */
  accountSlug?: string;
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
  private tokenPromise: Promise<string> | undefined;

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
      "Bridge-Version": bridgeApiVersion(),
      accept: "application/json",
    };
  }

  private getToken(): Promise<string> {
    // Verrou de concurrence : deux appels parallèles partagent la MÊME
    // promesse de token (jamais deux demandes simultanées).
    this.tokenPromise ??= (async () => {
      const body = await fetchJson(`${this.baseUrl}/aggregation/authorization/token`, {
        method: "POST",
        headers: { ...this.appHeaders(), "content-type": "application/json" },
        body: JSON.stringify({ user_uuid: this.credentials.userUuid }),
      });
      return TokenResponse.parse(body).access_token;
    })();
    return this.tokenPromise;
  }

  /** GET authentifié utilisateur, avec UN rejeu sur 401 (token expiré). */
  private async authorizedJson(url: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const token = await this.getToken().catch((error: unknown) => {
        this.tokenPromise = undefined; // une demande de token ratée ne se fige pas
        throw error;
      });
      try {
        return await fetchJson(url, {
          headers: { ...this.appHeaders(), authorization: `Bearer ${token}` },
        });
      } catch (error) {
        const expired = error instanceof Error && / 401 /.test(error.message);
        if (!expired || attempt >= 1) throw error;
        this.tokenPromise = undefined; // token invalidé : un seul rejeu
      }
    }
  }

  async getOrganization() {
    const { resources } = AccountsResponse.parse(
      await this.authorizedJson(`${this.baseUrl}/aggregation/accounts`),
    );
    return {
      organization: {
        // Jamais un fragment du userUuid (identifiant du coffre) vers le
        // contexte modèle : empreinte hashée, stable et opaque.
        slug: `bridge-${createHash("sha256").update(this.credentials.userUuid).digest("hex").slice(0, 8)}`,
        bank_accounts: resources.map((account) => ({
          slug: account.id,
          iban: account.iban ?? null,
          currency: account.currency_code ?? null,
          balance_cents: account.balance == null ? null : Math.round(account.balance * 100),
          // Bridge ne distingue pas le solde autorisé : null plutôt qu'une
          // copie silencieuse du solde comptable (découvert invisible sinon).
          authorized_balance_cents: null,
        })),
      },
    };
  }

  async listTransactions({ iban, accountSlug, page = 1, perPage = 25 }: BridgeTransactionsOptions = {}) {
    // Pagination V1 : une seule page (curseur Bridge non branché). meta annonce
    // total_pages: 1 ; toute page > 1 est donc VIDE, jamais une re-livraison
    // qui ferait croire à l'agent qu'il découvre de nouvelles données.
    if (page > 1) {
      return { transactions: [], meta: { current_page: page, total_pages: 1 } };
    }
    // Confidentialité : un user Bridge agrège potentiellement PLUSIEURS
    // banques/comptes (perso, épargne...). On scope TOUJOURS sur un compte :
    // celui demandé (slug ou IBAN), sinon le premier — jamais « tous ».
    const { organization } = await this.getOrganization();
    const account =
      accountSlug || iban
        ? organization.bank_accounts.find(
            (candidate) =>
              (accountSlug !== undefined && candidate.slug === accountSlug) ||
              (iban !== undefined && candidate.iban === iban),
          )
        : organization.bank_accounts[0];
    if (!account) throw new Error("unknown bank account");

    const url = new URL(`${this.baseUrl}/aggregation/transactions`);
    url.searchParams.set("account_id", account.slug);
    url.searchParams.set("limit", String(perPage));
    const { resources } = TransactionsResponse.parse(await this.authorizedJson(url.toString()));
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
