/**
 * Rules for the subscription custom-order queue.
 * Amounts are integer kobo so the split cannot drift by a fraction of a naira.
 */

export const QUEUE_WAIT_MS = 42 * 24 * 60 * 60 * 1000;
export const RETAIN_CLOSE_MS = 12 * 60 * 60 * 1000;
export const RETAIN_OPEN_MS = 48 * 60 * 60 * 1000;
export const MASS_CANCEL_LIMIT = 5;
export const SYSTEM_CHARGE_RATE_BPS = 1000;
export const JUMP_FEE_RATE_BPS = 2000;
export const JUMP_FEE_PLATFORM_KEEP_BPS = 1000;

export type TierKey = 'THREAD' | 'ASO_OKE' | 'ARU' | 'IGWE';
export type OrderLane = 'PENDING' | 'UP_NEXT' | 'ACTIVE' | 'IN_DELIVERY' | 'TERMINAL';

export type TierCapacity = {
  key: TierKey;
  name: string;
  monthlyPriceNgn: number;
  maxActive: number | null;
  maxInDelivery: number | null;
  maxUpNext: 1;
  queueJumpAllowed: boolean;
};

export const SUBSCRIPTION_TIERS: readonly TierCapacity[] = [
  { key: 'THREAD', name: 'Thread', monthlyPriceNgn: 10_000, maxActive: 2, maxInDelivery: 2, maxUpNext: 1, queueJumpAllowed: false },
  { key: 'ASO_OKE', name: 'Aso-oke', monthlyPriceNgn: 15_000, maxActive: 3, maxInDelivery: 4, maxUpNext: 1, queueJumpAllowed: false },
  { key: 'ARU', name: 'Aru', monthlyPriceNgn: 30_000, maxActive: 4, maxInDelivery: 5, maxUpNext: 1, queueJumpAllowed: true },
  { key: 'IGWE', name: 'Igwe', monthlyPriceNgn: 50_000, maxActive: 6, maxInDelivery: 5, maxUpNext: 1, queueJumpAllowed: true },
];

const TIER_BY_KEY = new Map(SUBSCRIPTION_TIERS.map((tier) => [tier.key, tier]));

export function tierCapacity(key: TierKey): TierCapacity {
  const tier = TIER_BY_KEY.get(key);
  if (!tier) {
    throw new Error(`Unknown subscription tier ${key}`);
  }
  return tier;
}

/**
 * Brand override wins. Otherwise the tier cap plus the live campaign delta.
 * The result is never negative. Delivery is not changed by the campaign.
 */
export function effectiveActiveCap(input: {
  tier: TierKey;
  brandOverride: number | null;
  campaignDelta: number;
}): number {
  if (input.brandOverride !== null) {
    return Math.max(0, input.brandOverride);
  }
  const base = tierCapacity(input.tier).maxActive;
  return base === null ? Infinity : Math.max(0, base + input.campaignDelta);
}

export type QueueAdmission = {
  lane: 'ACTIVE' | 'UP_NEXT' | 'PENDING';
  queueExpiresAt: Date | null;
};

/**
 * A free Active seat goes to the order already Up Next, not to a new arrival.
 * A new arrival becomes Up Next only when that seat is empty.
 * An Active seat with nobody waiting starts production immediately.
 */
export function decideQueueAdmission(input: {
  activeCount: number;
  upNextCount: number;
  activeCap: number;
  pendingCount?: number;
  now: Date;
}): QueueAdmission {
  const expiresAt = new Date(input.now.getTime() + QUEUE_WAIT_MS);
  if (input.upNextCount > 0 || (input.pendingCount ?? 0) > 0) {
    return { lane: 'PENDING', queueExpiresAt: expiresAt };
  }
  if (input.activeCount < input.activeCap) {
    return { lane: 'ACTIVE', queueExpiresAt: null };
  }
  return { lane: 'UP_NEXT', queueExpiresAt: expiresAt };
}

export function nextQueuePosition(currentMax: number | null): number {
  return (currentMax ?? 0) + 1;
}

export function isQueueHold(lane: OrderLane): boolean {
  return lane === 'PENDING' || lane === 'UP_NEXT';
}

/** Shopper pays 20% of the garment price. The platform keeps 10% of that fee. */
export function splitJumpFee(garmentPriceKobo: number): {
  feeKobo: number;
  platformKobo: number;
  brandKobo: number;
} {
  const price = Math.max(0, Math.round(garmentPriceKobo));
  const feeKobo = Math.round((price * JUMP_FEE_RATE_BPS) / 10_000);
  const platformKobo = Math.round((feeKobo * JUMP_FEE_PLATFORM_KEEP_BPS) / 10_000);
  return {
    feeKobo,
    platformKobo,
    brandKobo: feeKobo - platformKobo,
  };
}

/**
 * Every pre-active cancellation withholds actual VAT and 10% of each of the
 * garment subtotal and jump fee. Delivery is refundable in full.
 */
export function preActiveRefund(input: {
  captureKobo: number;
  garmentSubtotalKobo: number;
  vatKobo: number;
  deliveryKobo: number;
  jumpFeeKobo: number;
}): { withheldKobo: number; refundKobo: number; systemChargeKobo: number; jumpChargeKobo: number; vatKobo: number } {
  for (const amount of Object.values(input)) {
    if (!Number.isSafeInteger(amount) || amount < 0) throw new Error('Invalid captured money components');
  }
  const capture = input.captureKobo;
  const vat = input.vatKobo;
  if (capture !== input.garmentSubtotalKobo + vat + input.deliveryKobo + input.jumpFeeKobo) {
    throw new Error('Captured money does not match its component snapshot');
  }
  const systemChargeKobo = Math.round(input.garmentSubtotalKobo / 10);
  const jumpChargeKobo = Math.round(input.jumpFeeKobo / 10);
  const withheldKobo = vat + systemChargeKobo + jumpChargeKobo;
  return {
    withheldKobo,
    refundKobo: capture - withheldKobo,
    systemChargeKobo,
    jumpChargeKobo,
    vatKobo: vat,
  };
}

export function canRetainPosition(input: {
  now: Date;
  queueExpiresAt: Date;
  retainCount: number;
}): boolean {
  if (input.retainCount > 0) return false;
  const remaining = input.queueExpiresAt.getTime() - input.now.getTime();
  return remaining >= RETAIN_CLOSE_MS && remaining <= RETAIN_OPEN_MS;
}

export function retainedExpiry(now: Date): Date {
  return new Date(now.getTime() + QUEUE_WAIT_MS);
}

/** Candidates arrive in FIFO order. Held orders never participate in promotion. */
export function selectQueueCandidate<T extends { queuePriority: number; adminPromotionHeld?: boolean }>(rows: T[], priorityStreak: number): T | undefined {
  const eligible = rows.filter(row => !row.adminPromotionHeld);
  const ordinary = eligible.find(row => row.queuePriority === 0);
  if (ordinary && priorityStreak >= 2) return ordinary;
  return eligible.find(row => row.queuePriority > 0) ?? ordinary;
}

export function massCancelNeedsAttention(cancelledCount: number): boolean {
  return cancelledCount > MASS_CANCEL_LIMIT;
}

/** Warning copy. Placement is still allowed. Pending stays unlimited. */
export function openOrderWarning(openCount: number, brandName: string): string | null {
  if (openCount <= 0) return null;
  const noun = openCount === 1 ? 'open custom order' : 'open custom orders';
  return `You already have ${openCount} ${noun} with ${brandName}. This new order joins the back of their queue.`;
}
