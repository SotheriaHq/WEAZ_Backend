import {
  CustomOrderStatus,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';

/**
 * Sticky "needs admin attention" helpers shared by the ops cron (set), buyer
 * lifecycle paths (set on dispute/issue), and admin service (clear on action).
 *
 * Design notes:
 * - Set is idempotent (`adminAttentionRequiredAt: null` guard).
 * - Re-flag is blocked for N hours after a clear (cooldown) so hourly crons
 *   don't silently re-raise after an admin already acted.
 * - Terminal / anonymized orders are never flagged and are excluded from the
 *   dashboard count so completed history cannot inflate the badge.
 */

/** Statuses where the attention flag is meaningless (order is done or abandoned). */
export const TERMINAL_CUSTOM_ORDER_STATUSES: CustomOrderStatus[] = [
  CustomOrderStatus.COMPLETED,
  CustomOrderStatus.CLOSED,
  CustomOrderStatus.CANCELLED_BY_BUYER_PRE_ACCEPTANCE,
  CustomOrderStatus.REJECTED_BY_BRAND,
  CustomOrderStatus.REFUND_IN_PROGRESS,
];

export type AdminAttentionReason =
  | 'STALE_OPERATIONAL_STATUS'
  | 'BRAND_ACCEPTANCE_TIMEOUT'
  | 'STALE_STAGE'
  | 'PAYOUT_RELEASE_ELIGIBLE'
  | 'DISPUTE_OPENED'
  | 'ISSUE_REPORTED'
  | 'FLAG_RISK'
  | string;

/** Minimal Prisma surface so callers can pass either PrismaService or a tx client. */
export type AttentionPrisma = {
  customOrder: {
    updateMany: (
      args: Prisma.CustomOrderUpdateManyArgs,
    ) => Promise<Prisma.BatchPayload>;
  };
};

const DEFAULT_COOLDOWN_HOURS = 6;

export function resolveAttentionCooldownHours(
  envValue: string | undefined = process.env.CUSTOM_ORDER_ATTENTION_COOLDOWN_HOURS,
): number {
  const parsed = Number(envValue);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return DEFAULT_COOLDOWN_HOURS;
  }
  return Math.min(parsed, 168); // cap at 7 days
}

/**
 * Prisma `where` for "actively needs admin attention" — used by the dashboard
 * count, the admin list `attention=1` filter, and list attention totals.
 */
export function adminAttentionActiveWhere(
  extra: Prisma.CustomOrderWhereInput = {},
): Prisma.CustomOrderWhereInput {
  return {
    ...extra,
    adminAttentionRequiredAt: { not: null },
    anonymizedAt: null,
    status: { notIn: TERMINAL_CUSTOM_ORDER_STATUSES },
  };
}

/**
 * Set the sticky attention flag when currently unset (and past cooldown).
 * Returns true when a row was actually updated.
 */
export async function markAdminAttention(
  prisma: AttentionPrisma,
  customOrderId: string,
  reason: AdminAttentionReason,
  options?: {
    cooldownHours?: number;
    onError?: (message: string) => void;
  },
): Promise<boolean> {
  const cooldownHours =
    options?.cooldownHours ?? resolveAttentionCooldownHours();
  const cooldownCutoff = new Date(
    Date.now() - cooldownHours * 60 * 60 * 1000,
  );

  try {
    const result = await prisma.customOrder.updateMany({
      where: {
        id: customOrderId,
        adminAttentionRequiredAt: null,
        anonymizedAt: null,
        status: { notIn: TERMINAL_CUSTOM_ORDER_STATUSES },
        // Cooldown: do not re-flag until N hours after the last clear.
        // Never-cleared rows (clearedAt null) always pass.
        OR: [
          { adminAttentionClearedAt: null },
          { adminAttentionClearedAt: { lt: cooldownCutoff } },
        ],
      },
      data: {
        adminAttentionRequiredAt: new Date(),
        adminAttentionReason: reason,
        adminAttentionClearedAt: null,
        adminAttentionClearedById: null,
      },
    });
    return result.count > 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    options?.onError?.(
      `Failed to set admin-attention flag for custom order ${customOrderId}: ${message}`,
    );
    return false;
  }
}

/**
 * Clear the sticky flag after a concrete admin action (or a self-resolving
 * lifecycle transition). Idempotent; records who cleared for audit.
 */
export async function clearAdminAttention(
  prisma: AttentionPrisma,
  customOrderId: string,
  adminUserId?: string | null,
  options?: { onError?: (message: string) => void },
): Promise<boolean> {
  try {
    const result = await prisma.customOrder.updateMany({
      where: {
        id: customOrderId,
        adminAttentionRequiredAt: { not: null },
      },
      data: {
        adminAttentionRequiredAt: null,
        adminAttentionClearedAt: new Date(),
        adminAttentionClearedById: adminUserId ?? null,
      },
    });
    return result.count > 0;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    options?.onError?.(
      `Failed to clear admin-attention flag for custom order ${customOrderId}: ${message}`,
    );
    return false;
  }
}

/**
 * Clear attention on many orders at once (e.g. bulk payout release).
 */
export async function clearAdminAttentionMany(
  prisma: AttentionPrisma,
  customOrderIds: string[],
  adminUserId?: string | null,
  options?: { onError?: (message: string) => void },
): Promise<number> {
  const unique = Array.from(new Set(customOrderIds.filter(Boolean)));
  if (unique.length === 0) {
    return 0;
  }
  try {
    const result = await prisma.customOrder.updateMany({
      where: {
        id: { in: unique },
        adminAttentionRequiredAt: { not: null },
      },
      data: {
        adminAttentionRequiredAt: null,
        adminAttentionClearedAt: new Date(),
        adminAttentionClearedById: adminUserId ?? null,
      },
    });
    return result.count;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    options?.onError?.(
      `Failed to bulk-clear admin-attention flags: ${message}`,
    );
    return 0;
  }
}

/**
 * Batch-set attention on many orders (cron fan-out). Same guards as single-row
 * mark (cooldown, terminal, anonymized, currently-unset).
 */
export async function markAdminAttentionMany(
  prisma: AttentionPrisma,
  customOrderIds: string[],
  reason: AdminAttentionReason,
  options?: {
    cooldownHours?: number;
    onError?: (message: string) => void;
  },
): Promise<number> {
  const unique = Array.from(new Set(customOrderIds.filter(Boolean)));
  if (unique.length === 0) {
    return 0;
  }
  const cooldownHours =
    options?.cooldownHours ?? resolveAttentionCooldownHours();
  const cooldownCutoff = new Date(
    Date.now() - cooldownHours * 60 * 60 * 1000,
  );
  try {
    const result = await prisma.customOrder.updateMany({
      where: {
        id: { in: unique },
        adminAttentionRequiredAt: null,
        anonymizedAt: null,
        status: { notIn: TERMINAL_CUSTOM_ORDER_STATUSES },
        OR: [
          { adminAttentionClearedAt: null },
          { adminAttentionClearedAt: { lt: cooldownCutoff } },
        ],
      },
      data: {
        adminAttentionRequiredAt: new Date(),
        adminAttentionReason: reason,
        adminAttentionClearedAt: null,
        adminAttentionClearedById: null,
      },
    });
    return result.count;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    options?.onError?.(
      `Failed to bulk-set admin-attention flags: ${message}`,
    );
    return 0;
  }
}

/** Process-local cache for active admin user ids (cron + buyer fan-out). */
let activeAdminIdsCache: { ids: string[]; expiresAt: number } | null = null;
const DEFAULT_ADMIN_IDS_TTL_MS = 60_000;

type AdminLookupPrisma = {
  user: {
    findMany: (args: {
      where: unknown;
      select: { id: true };
      take: number;
    }) => Promise<Array<{ id: string }>>;
  };
};

/**
 * Cached active Admin/SuperAdmin ids. Avoids a user-table scan on every
 * dispute/issue and every cron path within the same process tick window.
 */
export async function getCachedActiveAdminIds(
  prisma: AdminLookupPrisma,
  options?: { ttlMs?: number; take?: number },
): Promise<string[]> {
  const ttlMs = options?.ttlMs ?? DEFAULT_ADMIN_IDS_TTL_MS;
  const now = Date.now();
  if (activeAdminIdsCache && activeAdminIdsCache.expiresAt > now) {
    return activeAdminIdsCache.ids;
  }

  const admins = await prisma.user.findMany({
    where: {
      role: { in: [Role.Admin, Role.SuperAdmin] },
      status: UserStatus.ACTIVE,
    },
    select: { id: true },
    take: options?.take ?? 50,
  });
  const ids = admins.map((admin) => admin.id);
  activeAdminIdsCache = { ids, expiresAt: now + ttlMs };
  return ids;
}

/** Test/helpers: drop the in-process admin-id cache. */
export function clearActiveAdminIdsCache() {
  activeAdminIdsCache = null;
}

/**
 * Bounded-concurrency pool for cron notification fan-out (avoids serial
 * await of 200 orders while still not opening 200 connections at once).
 */
export async function mapPool<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) {
    return;
  }
  const limit = Math.max(1, Math.min(concurrency, items.length));
  let nextIndex = 0;

  const runWorker = async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  };

  await Promise.all(Array.from({ length: limit }, () => runWorker()));
}
