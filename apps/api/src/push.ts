import { z } from "zod";
import { prisma, withTenant } from "@nodaq/db";
import { buildToolset } from "@nodaq/agent-runtime";
import { endOfLifeAssets } from "@nodaq/shared";
import type { RegistryAsset } from "@nodaq/shared";
import type { ToolsetContext } from "@nodaq/agent-runtime";

/*
 * Web Push notifications (ticket 2.17). Non-negotiable design decisions:
 *
 * 1. The payload NEVER carries business data. Delivery transits the browser
 *    vendors' push services (Google FCM, Apple) — even encrypted, we minimize:
 *    type + counter + allowlisted deep-link, nothing else. The guard is
 *    STRUCTURAL: PushPayload is a closed (.strict()) schema, built only by
 *    buildPushPayload(category, count), and re-validated at the send gate. A
 *    customer name or an amount cannot enter a payload without changing this
 *    file — which is exactly what the review must catch.
 * 2. Anti-spam grouping: events accumulate per (tenant, user, category) in
 *    push_dispatch_states; one notification per window with a counter, and NO
 *    re-notification until the user opened the target queue (lastSeenAt).
 * 3. Opt-in per device, preferences per category (push_subscriptions).
 *    A device only exists after an explicit browser-level opt-in.
 *
 * Dispatch runs on a periodic in-process sweep backed by Postgres — no Redis
 * is provisioned anywhere (local, CI, staging) so BullMQ would be dead code.
 * The sender is injectable and the sweep is a plain function: swapping to
 * BullMQ delayed jobs later will not touch callers.
 */

export const PUSH_CATEGORIES = ["actions", "alerts", "support"] as const;
export type PushCategory = (typeof PUSH_CATEGORIES)[number];
export const PushCategorySchema = z.enum(PUSH_CATEGORIES);

/** Grouping window per category — urgent/support alerts go out on the next sweep. */
export const PUSH_WINDOW_MS: Record<PushCategory, number> = {
  actions: 15 * 60_000,
  alerts: 0,
  // Ticket support P1 (2.18) : immédiat, même canal d'opt-in que les alertes.
  support: 0,
};

/**
 * The ONLY payload that can leave for a push service. Closed schema: type,
 * counter, deep-link from an allowlist. Never a name, an amount, an IBAN —
 * the notification is a doorbell, the data shows in the app after auth.
 */
export const PushPayload = z
  .object({
    type: z.enum(["actions_en_attente", "alerte_urgente", "support_p1"]),
    count: z.number().int().min(1).max(9_999),
    deepLink: z.enum(["/validation", "/", "/connecteurs", "/ops/support"]),
  })
  .strict();
export type PushPayload = z.infer<typeof PushPayload>;

const CATEGORY_PAYLOADS: Record<PushCategory, Pick<PushPayload, "type" | "deepLink">> = {
  actions: { type: "actions_en_attente", deepLink: "/validation" },
  alerts: { type: "alerte_urgente", deepLink: "/" },
  support: { type: "support_p1", deepLink: "/ops/support" },
};

export function buildPushPayload(category: PushCategory, count: number): PushPayload {
  const base = CATEGORY_PAYLOADS[category];
  // Clamp : un compteur hors norme (rafale extrême) ne doit jamais faire
  // échouer l'envoi — le schéma clos reste la garde, pas le plafond.
  return PushPayload.parse({
    type: base.type,
    deepLink: base.deepLink,
    count: Math.max(1, Math.min(count, 9_999)),
  });
}

/**
 * Anti-SSRF (audit 2.17) : l'endpoint de subscription est une URL fournie
 * par le client vers laquelle le SERVEUR émettra des requêtes — elle est
 * contrainte aux services push des navigateurs (https + allowlist d'hôtes),
 * jamais un hôte arbitraire, jamais une IP interne.
 */
const PUSH_ENDPOINT_HOSTS = [
  { exact: "fcm.googleapis.com" }, // Chrome / Edge (FCM)
  { suffix: ".push.services.mozilla.com" }, // Firefox
  { suffix: ".push.apple.com" }, // Safari
  { suffix: ".notify.windows.com" }, // Edge legacy (WNS)
];

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_ENDPOINT_HOSTS.some((rule) =>
    "exact" in rule && rule.exact ? host === rule.exact : host.endsWith(rule.suffix as string),
  );
}

/** Plafond d'appareils par utilisateur (anti-amplification, audit 2.17). */
export const MAX_PUSH_DEVICES_PER_USER = 10;

export interface PushEndpoint {
  endpoint: string;
  p256dh: string;
  auth: string;
}
/** "gone" = the push service says the subscription is dead (404/410). */
export type PushSendResult = "ok" | "gone" | "failed";
export type PushSender = (target: PushEndpoint, payload: PushPayload) => Promise<PushSendResult>;

/**
 * Real sender (web-push, VAPID). Returns null when the VAPID keys are not
 * provisioned — the feature then degrades cleanly: routes answer 503, the
 * sweep never starts, nothing else changes.
 */
export function createWebPushSender(env: NodeJS.ProcessEnv = process.env): PushSender | null {
  const publicKey = env.PUSH_VAPID_PUBLIC_KEY;
  const privateKey = env.PUSH_VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const subject = env.PUSH_VAPID_SUBJECT ?? "mailto:contact@nodaq.fr";
  return async (target, payload) => {
    const webPush = (await import("web-push")).default;
    try {
      await webPush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        // Last gate: whatever the caller did, only a valid closed payload
        // can be serialized towards the push service.
        JSON.stringify(PushPayload.parse(payload)),
        { vapidDetails: { subject, publicKey, privateKey }, TTL: 3_600 },
      );
      return "ok";
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      return status === 404 || status === 410 ? "gone" : "failed";
    }
  };
}

/** OWNER user ids of a tenant (membership = auth plane, not RLS-scoped). */
export async function tenantOwnerIds(tenantId: string): Promise<string[]> {
  const rows = await prisma.membership.findMany({
    where: { tenantId, role: "owner" },
    select: { userId: true },
  });
  return rows.map((row) => row.userId);
}

/**
 * Records push-worthy events. `mode: "increment"` for discrete events (one
 * more pending action); `mode: "set"` for condition checks re-evaluated
 * periodically (3 late invoices is a STATE, re-checking it hourly must not
 * inflate the counter to 72).
 */
export async function recordPushEvent(
  tenantId: string,
  userIds: string[],
  category: PushCategory,
  count = 1,
  options: { now?: Date; mode?: "increment" | "set" } = {},
): Promise<void> {
  const now = options.now ?? new Date();
  const mode = options.mode ?? "increment";
  if (userIds.length === 0 || count <= 0) return;
  await withTenant(tenantId, async (tx) => {
    for (const userId of userIds) {
      const existing = await tx.pushDispatchState.findUnique({
        where: { tenantId_userId_category: { tenantId, userId, category } },
      });
      if (!existing) {
        await tx.pushDispatchState.create({
          data: { tenantId, userId, category, pendingCount: count, windowStartedAt: now },
        });
      } else {
        await tx.pushDispatchState.update({
          where: { id: existing.id },
          data: {
            pendingCount: mode === "set" ? count : { increment: count },
            // A window only (re)starts when the batch was empty.
            ...(existing.pendingCount === 0 ? { windowStartedAt: now } : {}),
          },
        });
      }
    }
  });
}

/**
 * The user opened the target queue: current events are seen, the counter
 * resets, and re-notification is unlocked for FUTURE events.
 */
export async function markPushSeen(
  tenantId: string,
  userId: string,
  category: PushCategory,
  now = new Date(),
): Promise<void> {
  await withTenant(tenantId, (tx) =>
    tx.pushDispatchState.updateMany({
      where: { userId, category },
      data: { lastSeenAt: now, pendingCount: 0, windowStartedAt: null },
    }),
  );
}

/**
 * Sends what is due for ONE tenant. Reads under withTenant; network sends
 * happen OUTSIDE any DB transaction. Dead endpoints (410/404) are deleted;
 * transient failures leave the state untouched (retried next sweep).
 */
export async function flushTenantPushWindows(
  tenantId: string,
  sender: PushSender,
  now = new Date(),
): Promise<number> {
  const due = await withTenant(tenantId, async (tx) => {
    const states = await tx.pushDispatchState.findMany({
      where: { pendingCount: { gt: 0 }, windowStartedAt: { not: null } },
    });
    return states.filter((state) => {
      const category = PushCategorySchema.safeParse(state.category);
      if (!category.success || !state.windowStartedAt) return false;
      if (now.getTime() - state.windowStartedAt.getTime() < PUSH_WINDOW_MS[category.data]) {
        return false;
      }
      // Already notified and the queue was never opened since: stay silent.
      if (state.lastSentAt && !(state.lastSeenAt && state.lastSeenAt >= state.lastSentAt)) {
        return false;
      }
      return true;
    });
  });

  let sent = 0;
  for (const state of due) {
    const category = state.category as PushCategory;
    const subscriptions = await withTenant(tenantId, (tx) =>
      tx.pushSubscription.findMany({
        where: {
          userId: state.userId,
          // "support" (P1 opérateur) suit l'opt-in « alertes urgentes ».
          ...(category === "actions" ? { actionsEnabled: true } : { alertsEnabled: true }),
        },
      }),
    );
    if (subscriptions.length === 0) {
      // Nobody to notify: drop the batch instead of hoarding a stale counter
      // that would burst at the next opt-in (the app UI remains the truth).
      await withTenant(tenantId, (tx) =>
        tx.pushDispatchState.updateMany({
          where: { id: state.id },
          data: { pendingCount: 0, windowStartedAt: null },
        }),
      );
      continue;
    }
    const payload = buildPushPayload(category, state.pendingCount);
    let delivered = false;
    for (const subscription of subscriptions) {
      const result = await sender(
        { endpoint: subscription.endpoint, p256dh: subscription.p256dh, auth: subscription.auth },
        payload,
      );
      if (result === "gone") {
        await withTenant(tenantId, (tx) =>
          tx.pushSubscription.deleteMany({ where: { id: subscription.id } }),
        );
      } else if (result === "ok") {
        delivered = true;
        await withTenant(tenantId, (tx) =>
          tx.pushSubscription.updateMany({
            where: { id: subscription.id },
            data: { lastUsedAt: now },
          }),
        );
      }
    }
    if (delivered) {
      sent += 1;
      await withTenant(tenantId, (tx) =>
        tx.pushDispatchState.updateMany({
          where: { id: state.id },
          data: { pendingCount: 0, windowStartedAt: null, lastSentAt: now },
        }),
      );
    }
  }
  return sent;
}

/** Sweeps every tenant (tenant list = auth plane; per-tenant data under RLS). */
export async function flushPushWindows(
  sender: PushSender,
  now = new Date(),
  onError: (name: string) => void = () => undefined,
): Promise<number> {
  const tenants = await prisma.tenant.findMany({ select: { id: true } });
  let sent = 0;
  for (const tenant of tenants) {
    try {
      sent += await flushTenantPushWindows(tenant.id, sender, now);
    } catch (error) {
      // One broken tenant must never stall the others' notifications — but
      // never silently: the error NAME (nothing else) reaches the logs.
      onError(error instanceof Error ? error.name : "Error");
    }
  }
  return sent;
}

/**
 * Hygiène de rétention (audit 2.17) : les appareils d'un utilisateur qui a
 * perdu sa membership ne doivent pas rester rattachés au tenant — purge des
 * subscriptions et états orphelins.
 */
export async function cleanTenantPushOrphans(tenantId: string): Promise<void> {
  const members = await prisma.membership.findMany({
    where: { tenantId },
    select: { userId: true },
  });
  const memberIds = members.map((member) => member.userId);
  await withTenant(tenantId, async (tx) => {
    await tx.pushSubscription.deleteMany({ where: { userId: { notIn: memberIds } } });
    await tx.pushDispatchState.deleteMany({ where: { userId: { notIn: memberIds } } });
  });
}

/** Critical lateness threshold (days past deadline) for the urgent alert. */
export const CRITICAL_LATE_DAYS = 30;

/**
 * Hourly condition checks (urgent alerts, OWNER recipients): projected
 * treasury dip below zero at 30 days, and invoices critically late. Uses the
 * SAME tenant-bound owner toolset as the cockpit — sovereign chain included.
 * Only tenants with at least one alert-enabled subscription are checked (no
 * external API calls for nobody).
 */
export async function checkTenantUrgentAlerts(
  tenantId: string,
  agentContext: Partial<Omit<ToolsetContext, "tenantId">>,
  now = new Date(),
): Promise<number> {
  // Les alertes ne visent que les OWNERS : un appareil d'un simple membre ne
  // doit pas déclencher des appels fournisseurs horaires pour personne.
  const owners = await tenantOwnerIds(tenantId);
  if (owners.length === 0) return 0;
  const hasAlertDevice = await withTenant(tenantId, (tx) =>
    tx.pushSubscription.findFirst({
      where: { alertsEnabled: true, userId: { in: owners } },
      select: { id: true },
    }),
  );
  if (!hasAlertDevice) return 0;

  let alerts = 0;
  const toolset = await buildToolset({ ...agentContext, tenantId, role: "owner" });
  try {
    try {
      const treasury = JSON.parse(await toolset.execute("compute_treasury_forecast", {})) as {
        points?: { horizonDays: number; projectedBalanceCents: number }[];
      };
      const at30d = treasury.points?.find((point) => point.horizonDays === 30);
      if (at30d && at30d.projectedBalanceCents < 0) alerts += 1;
    } catch {
      // No bank connector / provider down: no treasury alert, keep checking.
    }
    try {
      const invoices = JSON.parse(
        await toolset.execute("pennylane_get_invoices", { limit: 100 }),
      ) as { items?: { status?: string | null; deadline?: string | null }[] };
      const cutoff = now.getTime() - CRITICAL_LATE_DAYS * 86_400_000;
      const critical = (invoices.items ?? []).filter(
        (invoice) =>
          invoice.status === "late" &&
          invoice.deadline &&
          !Number.isNaN(Date.parse(invoice.deadline)) &&
          Date.parse(invoice.deadline) < cutoff,
      ).length;
      if (critical > 0) alerts += critical;
    } catch {
      // No invoicing connector: nothing to alert on.
    }
    try {
      // Fin de vie d'immobilisation (2.19) : >= 80 % amorti -> alerte owner.
      // Payload minimal comme toujours — jamais le nom de l'asset.
      const rows = await withTenant(tenantId, (tx) =>
        tx.fixedAsset.findMany({ where: { status: "ACTIF" } }),
      );
      const models: RegistryAsset[] = rows.map((row) => ({
        id: row.id,
        label: row.label,
        baseCents: Number(row.baseCents),
        inServiceDate: row.inServiceDate,
        durationMonths: row.durationMonths,
        method: row.method === "DEGRESSIF" ? "DEGRESSIF" : "LINEAIRE",
        renewalCostCents: row.renewalCostCents === null ? null : Number(row.renewalCostCents),
        status: row.status,
      }));
      alerts += endOfLifeAssets(models, now).length;
    } catch {
      // Registre vide ou indisponible : pas d'alerte immobilisations.
    }
  } finally {
    await toolset.close().catch(() => undefined);
  }

  if (alerts > 0) {
    // "set": a re-checked CONDITION must not inflate the counter hour after hour.
    await recordPushEvent(tenantId, owners, "alerts", alerts, { now, mode: "set" });
  }
  return alerts;
}

export interface PushSweepOptions {
  sender: PushSender;
  agentContext?: Partial<Omit<ToolsetContext, "tenantId">>;
  /** Flush cadence (default 60 s). */
  intervalMs?: number;
  /** Condition-check cadence (default 60 min). */
  alertsEveryMs?: number;
  /** Receives the error NAME only (never content) — plugged on the app log. */
  onError?: (name: string) => void;
}

/**
 * In-process scheduler: flush due windows every minute, re-evaluate urgent
 * conditions (and purge orphaned devices) hourly. Timers are unref'd — they
 * never hold the process open — and every rejection is CAUGHT: an optional
 * feature must never take the API down via unhandledRejection.
 */
export function startPushSweep(options: PushSweepOptions): () => void {
  const intervalMs = options.intervalMs ?? 60_000;
  const alertsEveryMs = options.alertsEveryMs ?? 60 * 60_000;
  const onError = options.onError ?? (() => undefined);
  let running = false;
  let lastAlertsCheck = 0;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      if (now.getTime() - lastAlertsCheck >= alertsEveryMs) {
        lastAlertsCheck = now.getTime();
        const tenants = await prisma.tenant.findMany({ select: { id: true } });
        for (const tenant of tenants) {
          await cleanTenantPushOrphans(tenant.id).catch((error: unknown) =>
            onError(error instanceof Error ? error.name : "Error"),
          );
          await checkTenantUrgentAlerts(tenant.id, options.agentContext ?? {}, now).catch(
            (error: unknown) => onError(error instanceof Error ? error.name : "Error"),
          );
        }
      }
      await flushPushWindows(options.sender, now, onError);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((error: unknown) =>
      onError(error instanceof Error ? error.name : "Error"),
    );
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
