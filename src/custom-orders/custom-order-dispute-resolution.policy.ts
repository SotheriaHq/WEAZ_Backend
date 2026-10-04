/**
 * Who owns a dispute, what they may do with it, and what a resolution costs.
 *
 * Three rules shape everything here, and each one came from a real failure.
 *
 * 1. OWNERSHIP IS NAMED. `assignedAdminId` existed on the model and nothing ever
 *    wrote it, so every dispute the platform raised — a rejected extension, a
 *    reported delay, a delivery complaint — sat in the queue belonging to
 *    nobody. A dispute without an owner is a dispute without an answer, and the
 *    shopper waiting on it has no one to chase.
 *
 * 2. OWNERSHIP CANNOT BE DROPPED, ONLY HANDED OVER. A free "release" turns a
 *    hard case into a hot potato: the admin who looked at it, understood it and
 *    found it difficult is exactly the one with the context, and letting them
 *    put it back anonymously loses that and restarts the clock. So leaving
 *    means naming a successor and getting a SuperAdmin to agree.
 *
 * 3. AN ADMIN BROKERS BEFORE THEY RULE. The interesting outcome of a delay
 *    dispute is usually not a verdict but an agreement — the shopper who
 *    rejected two extra days will often take three if someone explains why.
 *    So a resolution that moves a date or moves money is PROPOSED to the party
 *    it binds and applied only once they accept. Admin can still decide alone
 *    where no one's consent is implicated.
 *
 * The budget rule is load-bearing: a mediated extension is still an extension.
 * `DISPUTE_RESPONSE_CANNOT_MOVE_DATES` exists because a brand that can promise
 * a new date inside a dispute response has unlimited time. Routing the mediated
 * case through the same budget keeps that closed — including the rush bar,
 * which is absolute.
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CustomOrderDisputeResolution,
  CustomOrderDisputeStatus,
  CustomOrderIssueType,
  DisputeConsentParty,
} from '@prisma/client';

import { EXTENSION_POLICY } from './custom-order-extension.policy';

export const DISPUTE_CLAIM_POLICY = {
  /**
   * How long a new dispute may sit unclaimed before a SuperAdmin is told.
   *
   * Five hours. Long enough that a team working a queue is not pinged for
   * something they were always going to pick up; short enough that a shopper
   * with an overdue order is not waiting a working day for a human to exist.
   */
  claimWithinHours: 5,
  /** How often to re-escalate while it STAYS unclaimed. Silence is not consent. */
  escalationRepeatHours: 4,
  /**
   * How long a party has to answer a proposed resolution.
   *
   * Matches the extension flow's own buyer window, because for a mediated
   * extension it is literally the same decision being put a second time.
   */
  consentWithinHours: 48,
  /**
   * A claimed dispute that has not moved in this long is reported too. Claiming
   * is not the same as handling, and an owner who has gone quiet is the failure
   * mode a claim requirement otherwise hides.
   */
  staleClaimHours: 48,
} as const;

/** Statuses in which a dispute is still somebody's job. */
export const ACTIVE_DISPUTE_STATUSES: ReadonlySet<CustomOrderDisputeStatus> =
  new Set([
    CustomOrderDisputeStatus.OPEN,
    CustomOrderDisputeStatus.BRAND_RESPONDED,
    CustomOrderDisputeStatus.ADMIN_REVIEW,
    CustomOrderDisputeStatus.AWAITING_PARTY_CONSENT,
  ]);

/** Reasons that describe an absence rather than a defective object. */
const DELAY_CLASS: ReadonlySet<CustomOrderIssueType> = new Set([
  CustomOrderIssueType.UNREASONABLE_DELAY,
  CustomOrderIssueType.NON_DELIVERY,
]);

/**
 * Whose agreement each resolution needs.
 *
 * The test is not "who is affected" but "whose rights does this give away".
 * A refund costs the brand money they have not earned, and the platform may
 * impose that — brands accept it at onboarding and it is what the debt ledger
 * is for. Extra TIME, by contrast, is the shopper's to give: it is the exact
 * thing they already refused, and overriding that would make the rejection
 * meaningless and the whole extension flow theatre.
 */
const CONSENT_REQUIRED: Partial<
  Record<CustomOrderDisputeResolution, DisputeConsentParty>
> = {
  [CustomOrderDisputeResolution.MEDIATED_EXTENSION]: DisputeConsentParty.BUYER,
  [CustomOrderDisputeResolution.REMAKE]: DisputeConsentParty.BOTH,
};

export function consentPartyFor(
  resolution: CustomOrderDisputeResolution,
): DisputeConsentParty | null {
  return CONSENT_REQUIRED[resolution] ?? null;
}

/** Resolutions that move money, so they sit behind their own permission. */
export const MONEY_MOVING_RESOLUTIONS: ReadonlySet<CustomOrderDisputeResolution> =
  new Set([
    CustomOrderDisputeResolution.FULL_REFUND,
    CustomOrderDisputeResolution.PARTIAL_REFUND,
    CustomOrderDisputeResolution.CANCEL_AND_REFUND,
  ]);

export interface ResolutionOption {
  resolution: CustomOrderDisputeResolution;
  label: string;
  /** Null when the admin may simply decide it. */
  consentFrom: DisputeConsentParty | null;
  movesMoney: boolean;
  /** Present when the option is offered but currently unusable, and why. */
  blockedReason?: string;
}

export interface ResolutionContext {
  reasonType: CustomOrderIssueType;
  /** From `readExtensionBudget` — what the order has left. */
  approvedExtensionCount: number;
  totalExtensionDaysGranted: number;
  /** Rush orders never get more time, in a dispute or out of one. */
  isRushOrder: boolean;
  /** Already delivered: a delay remedy is no longer the question. */
  hasBeenDelivered: boolean;
}

/**
 * What this particular dispute can actually end in.
 *
 * Returned as a list with reasons rather than a filtered set, so the console can
 * show an admin WHY the obvious remedy is unavailable — "no extension days
 * left", "shopper paid a rush fee" — instead of silently omitting it and
 * leaving them to guess.
 */
export function resolutionOptionsFor(
  context: ResolutionContext,
): ResolutionOption[] {
  const options: ResolutionOption[] = [];
  const isDelay = DELAY_CLASS.has(context.reasonType);

  const describe = (
    resolution: CustomOrderDisputeResolution,
    label: string,
    blockedReason?: string,
  ): ResolutionOption => ({
    resolution,
    label,
    consentFrom: consentPartyFor(resolution),
    movesMoney: MONEY_MOVING_RESOLUTIONS.has(resolution),
    ...(blockedReason ? { blockedReason } : {}),
  });

  if (isDelay) {
    // The mediated extension, and every reason it might not be on the table.
    let blocked: string | undefined;
    if (context.isRushOrder) {
      blocked =
        'This shopper paid a rush fee. Rush orders are never extended, including by agreement.';
    } else if (context.hasBeenDelivered) {
      blocked = 'The order has already been delivered, so more time resolves nothing.';
    } else if (
      context.approvedExtensionCount >= EXTENSION_POLICY.maxApprovedExtensions
    ) {
      blocked = `This order has already used its ${EXTENSION_POLICY.maxApprovedExtensions} approved extensions.`;
    } else if (
      context.totalExtensionDaysGranted >= EXTENSION_POLICY.maxTotalDays
    ) {
      blocked = `This order has used all ${EXTENSION_POLICY.maxTotalDays} days of extension it is allowed.`;
    }
    options.push(
      describe(
        CustomOrderDisputeResolution.MEDIATED_EXTENSION,
        'Shopper agrees to more time',
        blocked,
      ),
    );
  }

  options.push(
    describe(CustomOrderDisputeResolution.CANCEL_AND_REFUND, 'Cancel the order and refund in full'),
    describe(CustomOrderDisputeResolution.PARTIAL_REFUND, 'Compensate the shopper, order continues'),
  );

  if (!isDelay) {
    options.push(describe(CustomOrderDisputeResolution.REMAKE, 'Brand remakes the piece'));
  }

  options.push(
    describe(
      CustomOrderDisputeResolution.UPHOLD_BRAND,
      isDelay ? 'Delay was reasonable — order continues' : 'No fault found — order continues',
    ),
    describe(CustomOrderDisputeResolution.NO_ACTION, 'Close with no action'),
  );

  return options;
}

/** The remaining extension days a mediated extension may use. */
export function remainingExtensionDays(context: ResolutionContext): number {
  return Math.max(
    0,
    Math.min(
      EXTENSION_POLICY.maxDaysPerRequest,
      EXTENSION_POLICY.maxTotalDays - context.totalExtensionDaysGranted,
    ),
  );
}

export function assertResolutionAllowed(params: {
  resolution: CustomOrderDisputeResolution;
  context: ResolutionContext;
  extraDays?: number | null;
  refundAmount?: number | null;
}): void {
  const option = resolutionOptionsFor(params.context).find(
    (entry) => entry.resolution === params.resolution,
  );
  if (!option) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_RESOLUTION_NOT_AVAILABLE');
  }
  if (option.blockedReason) {
    throw new BadRequestException({
      code: 'CUSTOM_ORDER_DISPUTE_RESOLUTION_BLOCKED',
      message: option.blockedReason,
    });
  }

  if (params.resolution === CustomOrderDisputeResolution.MEDIATED_EXTENSION) {
    const days = params.extraDays ?? 0;
    if (!Number.isInteger(days) || days <= 0) {
      throw new BadRequestException('CUSTOM_ORDER_EXTENSION_INVALID_DAYS');
    }
    const allowance = remainingExtensionDays(params.context);
    if (days > allowance) {
      throw new BadRequestException({
        code: 'CUSTOM_ORDER_EXTENSION_EXCEEDS_REMAINING_DAYS',
        message: `At most ${allowance} more day(s) can be agreed on this order.`,
      });
    }
  }

  if (params.resolution === CustomOrderDisputeResolution.PARTIAL_REFUND) {
    const amount = params.refundAmount ?? 0;
    if (!(amount > 0)) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_REFUND_AMOUNT_REQUIRED');
    }
  }
}

/* ── Ownership ──────────────────────────────────────────────────────────── */

export interface DisputeOwnershipState {
  status: CustomOrderDisputeStatus;
  claimedByAdminId: string | null;
  handoverToAdminId: string | null;
  handoverRequestedAt: Date | null;
}

export function assertClaimAllowed(
  dispute: DisputeOwnershipState,
  adminId: string,
): void {
  if (!ACTIVE_DISPUTE_STATUSES.has(dispute.status)) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_NOT_ACTIVE');
  }
  if (dispute.claimedByAdminId === adminId) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_ALREADY_YOURS');
  }
  if (dispute.claimedByAdminId) {
    // Taking work off a colleague is a different act with a different
    // permission. Two admins racing for the same row resolve here, not in a
    // silent overwrite — the conditional update in the service is what makes
    // the race safe; this is what makes it legible.
    throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_CLAIMED_BY_ANOTHER_ADMIN');
  }
}

export function assertHandoverRequestAllowed(
  dispute: DisputeOwnershipState,
  adminId: string,
  successorAdminId: string,
): void {
  if (dispute.claimedByAdminId !== adminId) {
    throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_NOT_YOURS');
  }
  if (successorAdminId === adminId) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_HANDOVER_TO_SELF');
  }
  if (dispute.handoverRequestedAt && !dispute.handoverToAdminId) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_HANDOVER_ALREADY_PENDING');
  }
  if (!ACTIVE_DISPUTE_STATUSES.has(dispute.status)) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_NOT_ACTIVE');
  }
}

export function assertHandoverDecisionAllowed(
  dispute: DisputeOwnershipState,
  approverAdminId: string,
): void {
  if (!dispute.handoverRequestedAt || !dispute.handoverToAdminId) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_NO_PENDING_HANDOVER');
  }
  // The admin asking to be let go cannot be the one who agrees to it.
  if (dispute.claimedByAdminId === approverAdminId) {
    throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_HANDOVER_SELF_APPROVAL');
  }
}

/** Only the admin holding the dispute may act on its substance. */
export function assertOwnedBy(
  dispute: DisputeOwnershipState,
  adminId: string,
): void {
  if (!dispute.claimedByAdminId) {
    throw new BadRequestException('CUSTOM_ORDER_DISPUTE_UNCLAIMED');
  }
  if (dispute.claimedByAdminId !== adminId) {
    throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_NOT_YOURS');
  }
}

/** When a newly opened dispute must be claimed by. */
export function resolveClaimDueAt(openedAt: Date): Date {
  return new Date(
    openedAt.getTime() + DISPUTE_CLAIM_POLICY.claimWithinHours * 60 * 60 * 1000,
  );
}

/** When a party must answer a proposal by. */
export function resolveConsentDueAt(proposedAt: Date): Date {
  return new Date(
    proposedAt.getTime() +
      DISPUTE_CLAIM_POLICY.consentWithinHours * 60 * 60 * 1000,
  );
}

/**
 * Has this party's answer completed the proposal?
 *
 * `BOTH` means both, and a single decline is enough to end it — there is no
 * partial agreement to apply, and waiting for the second answer after the first
 * has said no just delays telling everyone.
 */
export function evaluateConsent(params: {
  consentBy: DisputeConsentParty;
  buyerConsentAt: Date | null;
  buyerDeclinedAt: Date | null;
  brandConsentAt: Date | null;
  brandDeclinedAt: Date | null;
}): 'ACCEPTED' | 'DECLINED' | 'PENDING' {
  const { consentBy } = params;
  const buyerNeeded =
    consentBy === DisputeConsentParty.BUYER || consentBy === DisputeConsentParty.BOTH;
  const brandNeeded =
    consentBy === DisputeConsentParty.BRAND || consentBy === DisputeConsentParty.BOTH;

  if (buyerNeeded && params.buyerDeclinedAt) return 'DECLINED';
  if (brandNeeded && params.brandDeclinedAt) return 'DECLINED';

  const buyerSettled = !buyerNeeded || Boolean(params.buyerConsentAt);
  const brandSettled = !brandNeeded || Boolean(params.brandConsentAt);

  return buyerSettled && brandSettled ? 'ACCEPTED' : 'PENDING';
}
