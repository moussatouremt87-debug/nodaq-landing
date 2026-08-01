import { z } from "zod";
import { resolveBaseUrl } from "./baseurl.js";
import { fetchJson } from "./http.js";

/*
 * Pennylane read-only client (blueprint §5.6, MVP priority). External API v2,
 * Bearer API key per tenant (resolved from the vault by the registry — this
 * client never sees a credentials REFERENCE, only the resolved key, in memory).
 * Zod objects STRIP unknown fields on purpose (data minimization): only the
 * fields business tools need cross this boundary.
 */

export const PennylaneCredentials = z.object({
  apiKey: z.string().min(1),
});
export type PennylaneCredentials = z.infer<typeof PennylaneCredentials>;

const CustomerInvoice = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  invoice_number: z.string().nullish(),
  amount: z.union([z.string(), z.number()]).nullish(),
  /** Part NON EXIGIBLE du montant — retenue de garantie (compte 4117, US-8).
   * Absente de l'API Pennylane : seul le connecteur fichier FEC la renseigne,
   * et l'absence vaut 0 (aucun changement pour les autres facturiers). */
  retained_amount: z.union([z.string(), z.number()]).nullish(),
  currency: z.string().nullish(),
  date: z.string().nullish(),
  deadline: z.string().nullish(),
  status: z.string().nullish(),
  /** Référence client (3.4) — alimente churn/upsell ; absente = non attribuée.
   * `.catch(null)` : une forme inattendue côté fournisseur dégrade en « non
   * attribuée » au lieu de faire échouer la page entière (et avec elle tous
   * les outils qui listent les factures). */
  customer: z
    .object({
      id: z.union([z.string(), z.number()]).transform(String),
      name: z.string().nullish(),
    })
    .nullish()
    .catch(null),
});
export type CustomerInvoice = z.infer<typeof CustomerInvoice>;

const Customer = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  name: z.string().nullish(),
  emails: z.array(z.string()).nullish(),
});
export type Customer = z.infer<typeof Customer>;

const ListResponse = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    items: z.array(item).default([]),
    next_cursor: z.string().nullish(),
  });

export interface PennylaneListOptions {
  limit?: number;
  cursor?: string;
}

export class PennylaneClient {
  private readonly baseUrl: string;

  constructor(
    private readonly credentials: PennylaneCredentials,
    baseUrl?: string,
  ) {
    this.baseUrl = resolveBaseUrl(
      "https://app.pennylane.com/api/external/v2",
      baseUrl,
      "PENNYLANE_BASE_URL",
    );
  }

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.credentials.apiKey}`,
      accept: "application/json",
    };
  }

  private listUrl(path: string, { limit = 25, cursor }: PennylaneListOptions): string {
    const url = new URL(`${this.baseUrl}${path}`);
    url.searchParams.set("limit", String(limit));
    if (cursor) url.searchParams.set("cursor", cursor);
    return url.toString();
  }

  async listCustomerInvoices(options: PennylaneListOptions = {}) {
    const body = await fetchJson(this.listUrl("/customer_invoices", options), {
      headers: this.headers(),
    });
    return ListResponse(CustomerInvoice).parse(body);
  }

  async listCustomers(options: PennylaneListOptions = {}) {
    const body = await fetchJson(this.listUrl("/customers", options), {
      headers: this.headers(),
    });
    return ListResponse(Customer).parse(body);
  }
}
