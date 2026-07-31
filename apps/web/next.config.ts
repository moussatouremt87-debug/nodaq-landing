import type { NextConfig } from "next";

/*
 * The web app NEVER talks to Python services or the DB: everything goes
 * through the API (CLAUDE.md). Same-origin proxy so better-auth cookies work
 * without CORS: /api/auth/* (auth) and the business prefixes actually
 * consumed by the UI are rewritten to the API, whose URL stays server-side
 * (never shipped to the client bundle). Internal API routes (/health, /notes)
 * are deliberately NOT exposed.
 */
const API_URL = process.env.API_URL ?? "http://localhost:8080";

const BUSINESS_PREFIXES = [
  "me",
  "cockpit",
  "pending-actions",
  "employees",
  "connectors",
  "classeur",
  "devis",
  "factures",
  "echeancier",
  "rapports",
  "prospects",
  "prospection",
  "stocks",
  "push",
  "ops",
  "immobilisations",
  "rh",
  "reglementaire",
  "avis",
  "rgpd",
  "modules",
];

// Webhooks (2.13) : SEULS les sous-chemins de GESTION (owner) passent par le
// proxy front. La route de RÉCEPTION `/webhooks/:provider/:id` est publique et
// reste exposée par l'API seule — la proxifier lui donnerait une seconde
// surface, qui contournerait tout garde posé devant l'API.
const WEBHOOK_ADMIN_PATHS = ["webhooks/endpoints", "webhooks/events"];

const nextConfig: NextConfig = {
  // Slim container image for Scaleway Serverless Containers (ticket 0.4).
  output: "standalone",
  async rewrites() {
    return [
      { source: "/api/auth/:path*", destination: `${API_URL}/api/auth/:path*` },
      ...BUSINESS_PREFIXES.map((prefix) => ({
        source: `/backend/${prefix}/:path*`,
        destination: `${API_URL}/${prefix}/:path*`,
      })),
      ...BUSINESS_PREFIXES.map((prefix) => ({
        source: `/backend/${prefix}`,
        destination: `${API_URL}/${prefix}`,
      })),
      ...WEBHOOK_ADMIN_PATHS.flatMap((path) => [
        { source: `/backend/${path}`, destination: `${API_URL}/${path}` },
        { source: `/backend/${path}/:rest*`, destination: `${API_URL}/${path}/:rest*` },
      ]),
    ];
  },
  async redirects() {
    // Canonique : l'endpoint Scaleway natif reste vivant mais n'est plus dans
    // trustedOrigins quand un domaine custom est actif — un signet sur
    // l'ancienne URL donnerait une app à l'auth cassée (403). La cible est
    // FIGÉE AU BUILD via CANONICAL_HOST (workflow) : sans elle, aucune
    // redirection — indispensable tant que le domaine custom n'existe pas.
    const canonicalHost = process.env.CANONICAL_HOST;
    if (!canonicalHost) return [];
    return [
      {
        source: "/:path*",
        has: [{ type: "host", value: "(?<scw>.*\\.scw\\.cloud)" }],
        destination: `https://${canonicalHost}/:path*`,
        permanent: false,
      },
    ];
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          // The 1-click validation queue must never be frameable (clickjacking).
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          // Domaine custom (Certificate Transparency rend l'hôte découvrable) :
          // HTTPS forcé, et une app derrière login n'a rien à faire dans un
          // index de recherche.
          { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
        ],
      },
    ];
  },
};

export default nextConfig;
