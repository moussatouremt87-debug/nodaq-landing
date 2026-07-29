import { z } from "zod";
import { resolveBaseUrl } from "./baseurl.js";
import { fetchJson } from "./http.js";

/*
 * Qonto read-only client (blueprint §5.6, MVP priority — bank data feeds the
 * treasury forecast). Auth header is `organizationSlug:secretKey`. Zod objects
 * strip unknown fields (data minimization).
 */

export const QontoCredentials = z.object({
  organizationSlug: z.string().min(1),
  secretKey: z.string().min(1),
});
export type QontoCredentials = z.infer<typeof QontoCredentials>;

const BankAccount = z.object({
  slug: z.string(),
  iban: z.string().nullish(),
  currency: z.string().nullish(),
  balance_cents: z.number().nullish(),
  authorized_balance_cents: z.number().nullish(),
});
export type BankAccount = z.infer<typeof BankAccount>;

const Organization = z.object({
  organization: z.object({
    slug: z.string(),
    bank_accounts: z.array(BankAccount).default([]),
  }),
});

const Transaction = z.object({
  transaction_id: z.string().nullish(),
  id: z.string().nullish(),
  amount_cents: z.number().nullish(),
  currency: z.string().nullish(),
  side: z.string().nullish(),
  operation_type: z.string().nullish(),
  settled_at: z.string().nullish(),
  label: z.string().nullish(),
});
export type Transaction = z.infer<typeof Transaction>;

const TransactionList = z.object({
  transactions: z.array(Transaction).default([]),
  meta: z.object({ current_page: z.number().nullish(), total_pages: z.number().nullish() }).nullish(),
});

export interface QontoTransactionsOptions {
  iban?: string;
  /** Contrat `BankClient` : Qonto filtre par IBAN, le slug est ignoré ici
   * (Bridge, lui, route par slug — l'IBAN y est souvent absent). */
  accountSlug?: string;
  page?: number;
  perPage?: number;
}

export class QontoClient {
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: QontoCredentials,
    baseUrl?: string,
  ) {
    this.baseUrl = resolveBaseUrl("https://thirdparty.qonto.com/v2", baseUrl, "QONTO_BASE_URL");
  }

  private headers(): Record<string, string> {
    return {
      authorization: `${this.credentials.organizationSlug}:${this.credentials.secretKey}`,
      accept: "application/json",
    };
  }

  async getOrganization() {
    const body = await fetchJson(`${this.baseUrl}/organization`, { headers: this.headers() });
    return Organization.parse(body);
  }

  async listTransactions({ iban, page = 1, perPage = 25 }: QontoTransactionsOptions = {}) {
    const url = new URL(`${this.baseUrl}/transactions`);
    if (iban) url.searchParams.set("iban", iban);
    url.searchParams.set("current_page", String(page));
    url.searchParams.set("per_page", String(perPage));
    const body = await fetchJson(url.toString(), { headers: this.headers() });
    return TransactionList.parse(body);
  }
}
