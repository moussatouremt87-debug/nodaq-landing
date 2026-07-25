import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization } from "better-auth/plugins/organization";
import { createAccessControl } from "better-auth/plugins/access";
import { defaultStatements, memberAc, ownerAc } from "better-auth/plugins/organization/access";
import { prisma } from "@nodaq/db";

const AUTH_SECRET = process.env.AUTH_SECRET ?? "dev-secret-change-me";
const AUTH_BASE_URL = process.env.AUTH_BASE_URL ?? "http://localhost:8080";

if (process.env.NODE_ENV === "production" && AUTH_SECRET === "dev-secret-change-me") {
  throw new Error("AUTH_SECRET must be set in production (Secret Manager, ticket 0.3)");
}

/**
 * Organization access control. Roles: owner | member | accountant.
 * `accountant` (expert-comptable) gets member-level permissions: delegated,
 * multi-tenant, read/work access — but no org administration.
 */
const ac = createAccessControl(defaultStatements);
const roles = {
  owner: ac.newRole(ownerAc.statements),
  member: ac.newRole(memberAc.statements),
  accountant: ac.newRole(memberAc.statements),
};

/**
 * better-auth + organization plugin: organization = Tenant, member = Membership
 * (mapped onto the existing Prisma models — `organizationId` lives in `tenantId`).
 * The session carries `activeOrganizationId`, which is THE tenant source for all
 * business routes (see resolveTenant in app.ts).
 * Postgres generates ids (`generateId: false`); tables are accessed with the
 * non-superuser `app_user` client (auth-plane tables carry no RLS).
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
  plugins: [
    organization({
      ac,
      roles,
      creatorRole: "owner",
      schema: {
        organization: { modelName: "tenant" },
        member: { modelName: "membership", fields: { organizationId: "tenantId" } },
        invitation: { modelName: "invitation", fields: { organizationId: "tenantId" } },
      },
    }),
  ],
  databaseHooks: {
    session: {
      create: {
        // Auto-select the user's first organization at sign-in so single-tenant
        // users (the common case) never have to call organization/set-active.
        before: async (session) => {
          const membership = await prisma.membership.findFirst({
            where: { userId: session.userId },
            orderBy: { createdAt: "asc" },
            select: { tenantId: true },
          });
          return { data: { ...session, activeOrganizationId: membership?.tenantId ?? null } };
        },
      },
    },
  },
});
