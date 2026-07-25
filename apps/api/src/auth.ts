import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { prisma } from "@nodaq/db";

const AUTH_SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me";
const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "http://localhost:8080";

if (process.env.NODE_ENV === "production" && AUTH_SECRET === "dev-secret-change-me") {
  throw new Error("AUTH_SECRET doit être défini en production (Secret Manager, ticket 0.3)");
}

/**
 * better-auth (ticket 0.2) : email + mot de passe, sessions en base (table `sessions`).
 * Les ids sont générés par Postgres (uuid) — `generateId: false`.
 * Utilise le client applicatif `app_user` : les tables d'auth ne sont pas soumises
 * à la RLS (plan auth), les tables métier restent scellées par withTenant.
 */
export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  secret: AUTH_SECRET,
  baseURL: AUTH_BASE_URL,
  emailAndPassword: {
    enabled: true,
  },
  advanced: {
    database: {
      generateId: false,
    },
  },
});
