import { z } from "zod";
import { resolveBaseUrl } from "./baseurl.js";
import { fetchJson } from "./http.js";

/*
 * PDP client (ticket 2.4) — the certified platform an invoice is deposited
 * on. NO operator is hard-coded: the reform lets each company pick its own
 * platform, their APIs differ, and betting on one would be a bad bet for the
 * product. So this is a NARROW abstract contract (deposit, read status) with
 * a configurable base URL — the same shape as `getBankClient()` for banks.
 *
 * The wire format below is a reasonable REST shape; the adapter for a given
 * operator adjusts it. What must NOT move is the contract: deposit returns a
 * platform reference, statuses come back through the webhook socket (2.13).
 */

export const PdpCredentials = z
  .object({
    apiKey: z.string().min(8).max(200),
    /** Identifier of the issuing company at the platform. */
    accountId: z.string().min(1).max(100),
  })
  .strict();
export type PdpCredentials = z.infer<typeof PdpCredentials>;

const DepositResponse = z.object({
  /** Platform-side identifier of the deposit — our reconciliation key. */
  id: z.string().min(1).max(200),
  status: z.string().max(100).nullish(),
});

const StatusResponse = z.object({
  id: z.string().min(1).max(200),
  status: z.string().max(100),
  updated_at: z.string().max(40).nullish(),
});

export interface PdpDeposit {
  reference: string;
  status: string | null;
}

/** What any PDP adapter must provide — deliberately minimal. */
export interface PdpClient {
  /** Deposits a Factur-X document. Returns the platform reference. */
  deposit(input: {
    invoiceNumber: string;
    documentBase64: string;
    profile: string;
  }): Promise<PdpDeposit>;
  /** Reads a deposit status (fallback when a webhook was missed). */
  getStatus(reference: string): Promise<{ status: string; updatedAt: string | null }>;
  /** Transmits e-reporting aggregates (B2C / out-of-scope transactions). */
  reportTransactions(input: {
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    vatCents: number;
    transactionCount: number;
  }): Promise<PdpDeposit>;
  testConnection(): Promise<void>;
}

export class HttpPdpClient implements PdpClient {
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: PdpCredentials,
    baseUrl?: string,
  ) {
    this.baseUrl = resolveBaseUrl("https://api.pdp.example", baseUrl, "PDP_BASE_URL");
    // Même garde que Silae : en production, on refuse d'émettre une facture
    // vers une destination placeholder (TLD réservé, non contractée).
    if (process.env.NODE_ENV === "production" && this.baseUrl === "https://api.pdp.example") {
      throw new Error("pdp base URL not configured");
    }
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.credentials.apiKey}`,
      "x-account-id": this.credentials.accountId,
      accept: "application/json",
      "content-type": "application/json",
    };
  }

  async deposit(input: {
    invoiceNumber: string;
    documentBase64: string;
    profile: string;
  }): Promise<PdpDeposit> {
    const body = await fetchJson(`${this.baseUrl}/invoices`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        account_id: this.credentials.accountId,
        invoice_number: input.invoiceNumber,
        profile: input.profile,
        format: "facturx",
        document: input.documentBase64,
      }),
    });
    const parsed = DepositResponse.parse(body);
    return { reference: parsed.id, status: parsed.status ?? null };
  }

  async getStatus(reference: string): Promise<{ status: string; updatedAt: string | null }> {
    const body = await fetchJson(
      `${this.baseUrl}/invoices/${encodeURIComponent(reference)}/status`,
      { headers: this.headers() },
    );
    const parsed = StatusResponse.parse(body);
    return { status: parsed.status, updatedAt: parsed.updated_at ?? null };
  }

  async reportTransactions(input: {
    periodStart: string;
    periodEnd: string;
    totalCents: number;
    vatCents: number;
    transactionCount: number;
  }): Promise<PdpDeposit> {
    const body = await fetchJson(`${this.baseUrl}/ereporting`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        account_id: this.credentials.accountId,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        // Agrégats SEULEMENT : l'e-reporting transmet des totaux de
        // transactions, jamais le détail nominatif des clients.
        total_amount: (input.totalCents / 100).toFixed(2),
        vat_amount: (input.vatCents / 100).toFixed(2),
        transaction_count: input.transactionCount,
      }),
    });
    const parsed = DepositResponse.parse(body);
    return { reference: parsed.id, status: parsed.status ?? null };
  }

  /** Credential check before vaulting — the response is DISCARDED. */
  async testConnection(): Promise<void> {
    await fetchJson(`${this.baseUrl}/account`, { headers: this.headers() });
  }
}
