/**
 * Shared HTTP helper for SaaS connector clients: JSON fetch with a small retry
 * on transient failures (429 / 5xx). Errors carry the HTTP status and path
 * only — NEVER a response body, which may contain customer data.
 */
export async function fetchJson(
  url: string,
  init: RequestInit,
  {
    retries = 1,
    backoffMs = 200,
    timeoutMs = 15_000,
  }: { retries?: number; backoffMs?: number; timeoutMs?: number } = {},
): Promise<unknown> {
  let lastStatus = 0;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // Timeout: a hung upstream must not keep a credentials-bearing request
    // in flight forever.
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    if (response.ok) {
      return response.json();
    }
    await response.body?.cancel();
    lastStatus = response.status;
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt === retries) break;
    await new Promise((resolve) => setTimeout(resolve, backoffMs * (attempt + 1)));
  }
  const path = new URL(url).pathname;
  throw new Error(`connector HTTP ${lastStatus} on ${path}`);
}
