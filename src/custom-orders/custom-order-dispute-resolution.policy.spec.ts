import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  CustomOrderDisputeResolution,
  CustomOrderDisputeStatus,
  CustomOrderIssueType,
  DisputeConsentParty,
} from '@prisma/client';

import {
  assertClaimAllowed,
  assertHandoverDecisionAllowed,
  assertHandoverRequestAllowed,
  assertOwnedBy,
  assertResolutionAllowed,
  consentPartyFor,
  evaluateConsent,
  remainingExtensionDays,
  resolutionOptionsFor,
  type ResolutionContext,
} from './custom-order-dispute-resolution.policy';

const ADMIN_A = 'admin-a';
const ADMIN_B = 'admin-b';
const SUPER = 'super-admin';

function context(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    reasonType: CustomOrderIssueType.UNREASONABLE_DELAY,
    approvedExtensionCount: 0,
    totalExtensionDaysGranted: 0,
    isRushOrder: false,
    hasBeenDelivered: false,
    ...overrides,
  };
}

function ownership(overrides: Partial<Parameters<typeof assertClaimAllowed>[0]> = {}) {
  return {
    status: CustomOrderDisputeStatus.OPEN,
    claimedByAdminId: null,
    handoverToAdminId: null,
    handoverRequestedAt: null,
    ...overrides,
  };
}

describe('resolution options', () => {
  it('offers a mediated extension on a delay dispute', () => {
    const options = resolutionOptionsFor(context());
    const mediated = options.find(
      (o) => o.resolution === CustomOrderDisputeResolution.MEDIATED_EXTENSION,
    );

    expect(mediated).toBeDefined();
    expect(mediated!.blockedReason).toBeUndefined();
    // It is the shopper's to give — they already refused once.
    expect(mediated!.consentFrom).toBe(DisputeConsentParty.BUYER);
  });

  it('never offers more time on a rush order, even by agreement', () => {
    const options = resolutionOptionsFor(context({ isRushOrder: true }));
    const mediated = options.find(
      (o) => o.resolution === CustomOrderDisputeResolution.MEDIATED_EXTENSION,
    )!;

    expect(mediated.blockedReason).toMatch(/rush/i);
    expect(() =>
      assertResolutionAllowed({
        resolution: CustomOrderDisputeResolution.MEDIATED_EXTENSION,
        context: context({ isRushOrder: true }),
        extraDays: 2,
      }),
    ).toThrow(BadRequestException);
  });

  it('blocks a mediated extension once the budget is spent', () => {
    const spent = context({ approvedExtensionCount: 2, totalExtensionDaysGranted: 6 });
    const mediated = resolutionOptionsFor(spent).find(
      (o) => o.resolution === CustomOrderDisputeResolution.MEDIATED_EXTENSION,
    )!;

    expect(mediated.blockedReason).toBeTruthy();
  });

  /**
   * The dispute path must not become an unlimited-time back door — the same
   * rule `DISPUTE_RESPONSE_CANNOT_MOVE_DATES` states for brand responses.
   */
  it('caps agreed days at what is left of the order budget', () => {
    const partlySpent = context({ totalExtensionDaysGranted: 5 });
    expect(remainingExtensionDays(partlySpent)).toBe(1);

    expect(() =>
      assertResolutionAllowed({
        resolution: CustomOrderDisputeResolution.MEDIATED_EXTENSION,
        context: partlySpent,
        extraDays: 3,
      }),
    ).toThrow(BadRequestException);

    expect(() =>
      assertResolutionAllowed({
        resolution: CustomOrderDisputeResolution.MEDIATED_EXTENSION,
        context: partlySpent,
        extraDays: 1,
      }),
    ).not.toThrow();
  });

  it('does not offer more time on a delivery-class complaint', () => {
    const options = resolutionOptionsFor(
      context({ reasonType: CustomOrderIssueType.MATERIAL_DEFECT }),
    );
    expect(
      options.some(
        (o) => o.resolution === CustomOrderDisputeResolution.MEDIATED_EXTENSION,
      ),
    ).toBe(false);
    // But a remake is exactly the remedy for a garment that arrived wrong.
    expect(
      options.some((o) => o.resolution === CustomOrderDisputeResolution.REMAKE),
    ).toBe(true);
  });

  it('requires an amount for a partial refund', () => {
    expect(() =>
      assertResolutionAllowed({
        resolution: CustomOrderDisputeResolution.PARTIAL_REFUND,
        context: context(),
      }),
    ).toThrow(BadRequestException);
  });

  /**
   * A refund costs the brand money they have not earned, which the platform is
   * entitled to impose. Extra time is the shopper's to give. The split matters:
   * it is why one is a proposal and the other is a decision.
   */
  it('imposes refunds but proposes agreements', () => {
    expect(consentPartyFor(CustomOrderDisputeResolution.FULL_REFUND)).toBeNull();
    expect(consentPartyFor(CustomOrderDisputeResolution.CANCEL_AND_REFUND)).toBeNull();
    expect(consentPartyFor(CustomOrderDisputeResolution.UPHOLD_BRAND)).toBeNull();
    expect(consentPartyFor(CustomOrderDisputeResolution.MEDIATED_EXTENSION)).toBe(
      DisputeConsentParty.BUYER,
    );
    expect(consentPartyFor(CustomOrderDisputeResolution.REMAKE)).toBe(
      DisputeConsentParty.BOTH,
    );
  });
});

describe('ownership', () => {
  it('lets an unclaimed dispute be claimed', () => {
    expect(() => assertClaimAllowed(ownership(), ADMIN_A)).not.toThrow();
  });

  it('refuses to take a dispute off another admin', () => {
    expect(() =>
      assertClaimAllowed(ownership({ claimedByAdminId: ADMIN_B }), ADMIN_A),
    ).toThrow(ForbiddenException);
  });

  it('refuses to claim a settled dispute', () => {
    expect(() =>
      assertClaimAllowed(
        ownership({ status: CustomOrderDisputeStatus.RESOLVED }),
        ADMIN_A,
      ),
    ).toThrow(BadRequestException);
  });

  it('only lets the holder act on the substance', () => {
    expect(() =>
      assertOwnedBy(ownership({ claimedByAdminId: ADMIN_A }), ADMIN_B),
    ).toThrow(ForbiddenException);
    expect(() => assertOwnedBy(ownership(), ADMIN_A)).toThrow(BadRequestException);
    expect(() =>
      assertOwnedBy(ownership({ claimedByAdminId: ADMIN_A }), ADMIN_A),
    ).not.toThrow();
  });

  /** Ownership can be handed on; it cannot be put down. */
  it('requires the requester to hold the dispute and to name someone else', () => {
    const held = ownership({ claimedByAdminId: ADMIN_A });

    expect(() => assertHandoverRequestAllowed(held, ADMIN_B, ADMIN_A)).toThrow(
      ForbiddenException,
    );
    expect(() => assertHandoverRequestAllowed(held, ADMIN_A, ADMIN_A)).toThrow(
      BadRequestException,
    );
    expect(() => assertHandoverRequestAllowed(held, ADMIN_A, ADMIN_B)).not.toThrow();
  });

  it('will not let the departing admin approve their own handover', () => {
    const pending = ownership({
      claimedByAdminId: ADMIN_A,
      handoverToAdminId: ADMIN_B,
      handoverRequestedAt: new Date(),
    });

    expect(() => assertHandoverDecisionAllowed(pending, ADMIN_A)).toThrow(
      ForbiddenException,
    );
    expect(() => assertHandoverDecisionAllowed(pending, SUPER)).not.toThrow();
  });

  it('rejects a handover decision when none was requested', () => {
    expect(() =>
      assertHandoverDecisionAllowed(ownership({ claimedByAdminId: ADMIN_A }), SUPER),
    ).toThrow(BadRequestException);
  });
});

describe('consent', () => {
  const base = {
    buyerConsentAt: null,
    buyerDeclinedAt: null,
    brandConsentAt: null,
    brandDeclinedAt: null,
  };

  it('waits for the party the proposal binds', () => {
    expect(
      evaluateConsent({ ...base, consentBy: DisputeConsentParty.BUYER }),
    ).toBe('PENDING');
    expect(
      evaluateConsent({
        ...base,
        consentBy: DisputeConsentParty.BUYER,
        buyerConsentAt: new Date(),
      }),
    ).toBe('ACCEPTED');
  });

  it('ignores the party it does not bind', () => {
    // A brand agreeing does not settle a proposal that only the buyer can accept.
    expect(
      evaluateConsent({
        ...base,
        consentBy: DisputeConsentParty.BUYER,
        brandConsentAt: new Date(),
      }),
    ).toBe('PENDING');
  });

  it('needs both when the remedy binds both', () => {
    expect(
      evaluateConsent({
        ...base,
        consentBy: DisputeConsentParty.BOTH,
        buyerConsentAt: new Date(),
      }),
    ).toBe('PENDING');
    expect(
      evaluateConsent({
        ...base,
        consentBy: DisputeConsentParty.BOTH,
        buyerConsentAt: new Date(),
        brandConsentAt: new Date(),
      }),
    ).toBe('ACCEPTED');
  });

  /** One refusal ends it — there is no partial agreement worth applying. */
  it('ends on the first decline without waiting for the other party', () => {
    expect(
      evaluateConsent({
        ...base,
        consentBy: DisputeConsentParty.BOTH,
        brandDeclinedAt: new Date(),
      }),
    ).toBe('DECLINED');
  });
});
