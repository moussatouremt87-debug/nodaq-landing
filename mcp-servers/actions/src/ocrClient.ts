import { z } from "zod";

/**
 * Client for the INTERNAL services/ocr extraction endpoint. The service does
 * pure text extraction — every model call stays on this (TS) side, through
 * packages/llm.route(). Errors carry HTTP statuses only, never content.
 */

const ExtractResponse = z.object({
  text: z.string(),
  pages: z.number().int(),
});
export type ExtractResponse = z.infer<typeof ExtractResponse>;

export interface OcrClientOptions {
  baseUrl?: string;
  token?: string;
}

function ocrConfig(options: OcrClientOptions): { baseUrl: string; token: string } {
  const baseUrl = options.baseUrl ?? process.env.OCR_SERVICE_URL ?? "http://localhost:8101";
  const token = options.token ?? process.env.OCR_INTERNAL_TOKEN;
  if (!token) {
    throw new Error("OCR_INTERNAL_TOKEN must be set (internal service token)");
  }
  return { baseUrl, token };
}

export async function extractInvoiceText(
  tenantId: string,
  filename: string,
  contentBase64: string,
  options: OcrClientOptions = {},
): Promise<ExtractResponse> {
  const { baseUrl, token } = ocrConfig(options);
  const response = await fetch(`${baseUrl}/extract`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ tenantId, filename, contentBase64 }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`OCR service failed: HTTP ${response.status}`);
  }
  return ExtractResponse.parse(await response.json());
}
