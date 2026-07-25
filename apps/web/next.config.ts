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

const BUSINESS_PREFIXES = ["me", "cockpit", "pending-actions", "employees", "connectors"];

const nextConfig: NextConfig = {
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
        ],
      },
    ];
  },
};

export default nextConfig;
