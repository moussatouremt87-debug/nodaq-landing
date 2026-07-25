/**
 * Base-URL resolution for connector clients. Overrides (env or options) exist
 * for TESTS ONLY: in production the official https endpoint is mandatory —
 * a hijacked env var must not be able to redirect credential-bearing requests
 * to a third-party host (RGPD audit finding 1.2).
 */
export function resolveBaseUrl(
  official: string,
  override: string | undefined,
  envName: string,
): string {
  const candidate = override ?? process.env[envName];
  if (!candidate) return official;
  if (process.env.NODE_ENV === "production" && candidate !== official) {
    throw new Error(`${envName} override is forbidden in production`);
  }
  return candidate;
}
