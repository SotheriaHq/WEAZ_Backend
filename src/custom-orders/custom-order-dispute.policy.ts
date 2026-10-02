/**
 * When a shopper may dispute, and what a dispute about a LATE order needs.
 *
 * The dispute machinery was built for a garment that arrived and is wrong:
 * photographs, the 72-hour inspection window, a fit tolerance to argue about.
 * A late order has none of those things — there is nothing to photograph,
 * because nothing has been delivered — and the evidence validator rejected the
 * submission outright. So an order could be a fortnight overdue and the only
 * dispute the system would accept was one about an item the shopper did not
 * have.
 *
 * Two classes, then. DELIVERY-class keeps every rule it has. DELAY-class takes
 * no photographs, opens while the order is still in production, and only once
 * the promise it is complaining about has actually been missed.
 */
import { BadRequestException } from '@nestjs/common';
import { CustomOrderIssueType, CustomOrderStatus } from '@prisma/client';

export const DISPUTE_POLICY = {
  /**
   * How long after a missed production date the shopper may escalate.
   *
   * A dispute raised the hour a date slips is one both sides regret: makers run
   * late by an afternoon all the time and usually say so. The grace is the
   * window in which the right control is "nudge your maker", not "dispute".
   */
  productionGraceHours: 24,
  /**
   * Nothing for delivery. A promised delivery date that passes with no garment
   * is not a matter of interpretation.
   */
  deliveryGraceHours: 0,
  /** After a resolution, how long before the same order can be disputed again. */
  reDisputeCooldownHours: 48,
} as const;

/** Reasons that describe an absence rather than an object. No photo exists. */
export const DELAY_CLASS_ISSUE_TYPES: ReadonlySet<CustomOrderIssueType> = new Set([
  CustomOrderIssueType.UNREASONABLE_DELAY,
  CustomOrderIssueType.NON_DELIVERY,
]);

export function isDelayClassIssue(issueType: CustomOrderIssueType): boolean {
  return DELAY_CLASS_ISSUE_TYPES.has(issueType);
}

/** Statuses in which the garment has not reached the shopper yet. */
const PRE_DELIVERY_STATUSES: ReadonlySet<CustomOrderStatus> = new Set([
  CustomOrderStatus.ACCEPTED,
  CustomOrderStatus.IN_PRODUCTION,
  CustomOrderStatus.READY_FOR_DISPATCH,
  CustomOrderStatus.IN_TRANSIT,
]);

export type DelayEligibility = {
  /** True once the shopper may raise a delay dispute. */
  eligible: boolean;
  /** Which promise was missed, for the copy and the dispute record. */
  basis: 'PRODUCTION' | 'DELIVERY' | null;
  /** When the control becomes available. Null when it already is, or never. */
  availableAt: Date | null;
  /** Why not, as a stable code the clients can map to copy. */
  reason:
    | 'ELIGIBLE'
    | 'NOT_LATE_YET'
    | 'WITHIN_GRACE'
    | 'NO_PROMISE_RECORDED'
    | 'NOT_A_LIVE_ORDER'
    | 'ALREADY_DISPUTED';
};

const hoursToMs = (hours: number) => hours * 60 * 60 * 1000;

/**
 * Whether a late order can be escalated yet, and if not, when.
 *
 * Delivery is checked before production: once the delivery promise is blown,
 * how production went stopped being the question.
 */
export function resolveDelayEligibility(params: {
  status: CustomOrderStatus;
  promisedProductionAt?: Date | null;
  promisedDeliveryAt?: Date | null;
  currentProgressStage?: string | null;
  hasOpenDispute: boolean;
  now?: Date;
}): DelayEligibility {
  const now = params.now ?? new Date();

  if (params.hasOpenDispute) {
    return { eligible: false, basis: null, availableAt: null, reason: 'ALREADY_DISPUTED' };
  }
  if (!PRE_DELIVERY_STATUSES.has(params.status)) {
    return { eligible: false, basis: null, availableAt: null, reason: 'NOT_A_LIVE_ORDER' };
  }

  const deliveryDue = params.promisedDeliveryAt
    ? new Date(
        params.promisedDeliveryAt.getTime() +
          hoursToMs(DISPUTE_POLICY.deliveryGraceHours),
      )
    : null;
  if (deliveryDue && now.getTime() >= deliveryDue.getTime()) {
    return { eligible: true, basis: 'DELIVERY', availableAt: null, reason: 'ELIGIBLE' };
  }

  const productionDue = params.promisedProductionAt
    ? new Date(
        params.promisedProductionAt.getTime() +
          hoursToMs(DISPUTE_POLICY.productionGraceHours),
      )
    : null;
  if (productionDue) {
    // Reaching the dispatch stage means production finished, late or not —
    // there is nothing left to escalate about production itself.
    const productionDone =
      params.status === CustomOrderStatus.READY_FOR_DISPATCH ||
      params.status === CustomOrderStatus.IN_TRANSIT;
    if (!productionDone && now.getTime() >= productionDue.getTime()) {
      return { eligible: true, basis: 'PRODUCTION', availableAt: null, reason: 'ELIGIBLE' };
    }
    if (!productionDone && params.promisedProductionAt && now >= params.promisedProductionAt) {
      return {
        eligible: false,
        basis: 'PRODUCTION',
        availableAt: productionDue,
        reason: 'WITHIN_GRACE',
      };
    }
  }

  if (!deliveryDue && !productionDue) {
    return {
      eligible: false,
      basis: null,
      availableAt: null,
      reason: 'NO_PROMISE_RECORDED',
    };
  }

  return {
    eligible: false,
    basis: null,
    availableAt: deliveryDue ?? productionDue,
    reason: 'NOT_LATE_YET',
  };
}

/**
 * Evidence rules, by class.
 *
 * A delivery complaint still needs a photograph — it is the only thing that
 * makes "the sleeve is short" adjudicable. A delay complaint needs none, and
 * demanding one is how the whole category ended up unreportable.
 */
export function assertDisputeEvidence(params: {
  issueType: CustomOrderIssueType;
  photoCount: number;
}): void {
  if (isDelayClassIssue(params.issueType)) return;
  if (params.photoCount === 0) {
    throw new BadRequestException('Dispute evidence must include at least one photo');
  }
}

/**
 * A dispute remedy must not become a back door around the extension budget.
 *
 * A brand that can settle a dispute by promising a new date has unlimited extra
 * time: two approved extensions of three days each is the cap, and "I'll have it
 * by the 30th, sorry" in a dispute response would walk straight past it. So a
 * dispute response may describe a plan, and may NOT move a promise date. More
 * time goes through the extension flow, consumes the budget, and needs the
 * shopper's explicit consent — which is the entire point of that flow.
 */
export const DISPUTE_RESPONSE_CANNOT_MOVE_DATES = true as const;

/** Statuses in which a dispute is still somebody's job. */
export const OPEN_DISPUTE_STATUSES = [
  'OPEN',
  'BRAND_RESPONDED',
  'ADMIN_REVIEW',
] as const;
