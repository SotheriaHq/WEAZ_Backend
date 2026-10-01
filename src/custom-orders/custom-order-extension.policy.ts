/**
 * What a brand may ask a shopper for, and what the shopper can lose.
 *
 * The rules live here rather than inline in the service because four callers
 * need the same answer: the brand endpoint that raises a request, the buyer
 * endpoint that answers one, the brand endpoint that answers a counter, and the
 * cron that expires requests nobody answered. The old cap ("one extension
 * request per order, ever") lived in a single `if` inside `createExtensionRequest`
 * and counted every row, so a request the shopper ignored permanently burned the
 * brand's only chance to ask.
 *
 * The budget is in DAYS GRANTED, not in requests. Two requests of three days is
 * still six days the shopper never signed up for, so both are capped: how often
 * they can be asked, and how much time they can be asked for in total.
 */
import { BadRequestException } from '@nestjs/common';

export const EXTENSION_POLICY = {
  /** How many times a shopper may be asked to grant time on one order. */
  maxApprovedExtensions: 2,
  /** The most one request may ask for. */
  maxDaysPerRequest: 3,
  /** The most an order may be extended by in total. */
  maxTotalDays: 6,
  /** How long a shopper has to answer before the request expires. */
  buyerResponseWindowMs: 24 * 60 * 60 * 1000,
  /**
   * How long before the production deadline the brand is nudged to either
   * deliver or ask for time. Two nudges, because the first one is easy to miss.
   */
  brandDeadlineWarningHours: [24, 12] as const,
} as const;

export type ExtensionBudgetState = {
  approvedExtensionCount: number;
  totalExtensionDaysGranted: number;
  /** Extensions still available to ask for. */
  remainingExtensions: number;
  /** Days still available to grant, after the per-request cap is applied. */
  remainingDays: number;
  /** The largest number of days a new request may ask for. 0 means none. */
  maxRequestableDays: number;
  exhausted: boolean;
};

type BudgetSource = {
  approvedExtensionCount?: number | null;
  totalExtensionDaysGranted?: number | null;
};

const asCount = (value: number | null | undefined) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
};

export function readExtensionBudget(order: BudgetSource): ExtensionBudgetState {
  const approvedExtensionCount = asCount(order.approvedExtensionCount);
  const totalExtensionDaysGranted = asCount(order.totalExtensionDaysGranted);
  const remainingExtensions = Math.max(
    0,
    EXTENSION_POLICY.maxApprovedExtensions - approvedExtensionCount,
  );
  const remainingDays = Math.max(
    0,
    EXTENSION_POLICY.maxTotalDays - totalExtensionDaysGranted,
  );
  const maxRequestableDays =
    remainingExtensions > 0
      ? Math.min(EXTENSION_POLICY.maxDaysPerRequest, remainingDays)
      : 0;

  return {
    approvedExtensionCount,
    totalExtensionDaysGranted,
    remainingExtensions,
    remainingDays,
    maxRequestableDays,
    exhausted: maxRequestableDays <= 0,
  };
}

/**
 * A shopper who paid to jump the queue cannot be asked to wait.
 *
 * The rush fee is a promise sold separately from the order, so there is no
 * honest version of "we charged you for speed and now need longer". Blocking the
 * request outright is the only rule that keeps the fee meaningful — the
 * alternative is a partial refund negotiation on every late rush order.
 */
export function isRushOrder(order: {
  rushSelected?: boolean | null;
  rushFeeSnapshot?: unknown;
}): boolean {
  if (order.rushSelected === true) return true;
  const fee = Number(order.rushFeeSnapshot ?? 0);
  return Number.isFinite(fee) && fee > 0;
}

/** Statuses that leave a request waiting on somebody — at most one at a time. */
export const OUTSTANDING_EXTENSION_STATUSES = ['OPEN', 'COUNTERED'] as const;

export type ExtensionRequestLike = {
  id: string;
  buyerResponseStatus: string;
  appliedExtraDays?: number | null;
  requestedExtraDays?: number | null;
};

export function findOutstandingRequest<T extends ExtensionRequestLike>(
  requests: readonly T[],
): T | null {
  return (
    requests.find((request) =>
      (OUTSTANDING_EXTENSION_STATUSES as readonly string[]).includes(
        request.buyerResponseStatus,
      ),
    ) ?? null
  );
}

/**
 * Everything that must be true before a brand may ask for more time.
 *
 * Throws with a stable `CUSTOM_ORDER_EXTENSION_*` code so both clients can map
 * the refusal to copy a brand can act on, rather than showing a raw sentence.
 */
export function assertExtensionRequestAllowed(params: {
  order: BudgetSource & { rushSelected?: boolean | null; rushFeeSnapshot?: unknown };
  requests: readonly ExtensionRequestLike[];
  requestedExtraDays: number;
}): { budget: ExtensionBudgetState; sequence: number } {
  const { order, requests, requestedExtraDays } = params;

  if (isRushOrder(order)) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_BLOCKED_BY_RUSH_FEE');
  }

  if (findOutstandingRequest(requests)) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_ALREADY_OUTSTANDING');
  }

  const budget = readExtensionBudget(order);
  if (budget.remainingExtensions <= 0) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_LIMIT_REACHED');
  }
  if (budget.remainingDays <= 0) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_DAY_BUDGET_EXHAUSTED');
  }
  if (requestedExtraDays > budget.maxRequestableDays) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_EXCEEDS_REMAINING_DAYS');
  }

  return {
    budget,
    // A label for the UI, not the budget counter: only approved requests count.
    sequence: budget.approvedExtensionCount + 1,
  };
}

/**
 * Whether a number of days may still be GRANTED on this order.
 *
 * Re-checked at acceptance because the request may have sat open while another
 * one was granted, and re-checked for counters because a shopper's counter is a
 * different number from the one that was validated when the request was raised.
 */
export function assertExtensionGrantAllowed(params: {
  order: BudgetSource & { rushSelected?: boolean | null; rushFeeSnapshot?: unknown };
  days: number;
}): void {
  const { order, days } = params;

  if (isRushOrder(order)) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_BLOCKED_BY_RUSH_FEE');
  }
  if (!Number.isFinite(days) || days < 1) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_INVALID_DAYS');
  }

  const budget = readExtensionBudget(order);
  if (budget.remainingExtensions <= 0) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_LIMIT_REACHED');
  }
  if (days > EXTENSION_POLICY.maxDaysPerRequest) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_EXCEEDS_PER_REQUEST_LIMIT');
  }
  if (days > budget.remainingDays) {
    throw new BadRequestException('CUSTOM_ORDER_EXTENSION_EXCEEDS_REMAINING_DAYS');
  }
}

/**
 * The deadline for the shopper's answer.
 *
 * Whichever comes first: the standard response window, or the moment the thing
 * being extended was due anyway. A request to extend a deadline that has already
 * passed still gets a floor of one hour, so it is answerable rather than born
 * expired.
 */
export function resolveRespondByAt(params: {
  now: Date;
  dueAt?: Date | null;
}): Date {
  const { now, dueAt } = params;
  const window = new Date(now.getTime() + EXTENSION_POLICY.buyerResponseWindowMs);
  if (!dueAt) return window;
  const floor = new Date(now.getTime() + 60 * 60 * 1000);
  const earliest = dueAt.getTime() < window.getTime() ? dueAt : window;
  return earliest.getTime() < floor.getTime() ? floor : earliest;
}

/** Which promise a request is buying time against, for deadlines and voiding. */
export function resolveExtensionTargetDate(
  order: {
    promisedProductionAt?: Date | null;
    promisedDeliveryAt?: Date | null;
  },
  targetType: string,
): Date | null {
  if (targetType === 'DELIVERY') return order.promisedDeliveryAt ?? null;
  return order.promisedProductionAt ?? order.promisedDeliveryAt ?? null;
}
