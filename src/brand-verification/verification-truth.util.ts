import { BrandVerificationStatus, UserStatus } from '@prisma/client';

export const VERIFIED_BADGE_EXPLANATION_PATH = '/help/verified-badge';

/**
 * Machine-readable code clients can key off to specialise the "brand not
 * verified" state (e.g. a follow/notify CTA) instead of a generic block.
 */
export const BRAND_NOT_VERIFIED_CODE = 'BRAND_NOT_VERIFIED';

/**
 * Shopper-facing message shown when a buyer tries to bag/checkout an item from
 * a brand that has NOT completed the store-verification process. Only brands
 * with an APPROVED verification may receive orders (product rule).
 *
 * Kept SHORT deliberately. This arrives as a modal over a feed the shopper is
 * mid-scroll in, and the previous three-sentence version apologised, restated
 * the two things they cannot do, and then explained the policy — none of which
 * they can act on, because the missing step is the brand's, not theirs. One line
 * that names the cause is the whole useful content.
 */
export const BRAND_ORDER_VERIFICATION_MESSAGE =
  'Orders are off — this brand is not verified yet.';

/**
 * Brand-facing nudge fired (deduped) when a shopper is turned away from a
 * store because it isn't verified — the highest-intent moment to encourage the
 * owner to finish verification.
 */
export const BRAND_ORDER_VERIFICATION_NUDGE_MESSAGE =
  'A shopper just tried to order from your store, but orders are locked until you complete store verification. Verify now to start taking orders.';

/**
 * The single source of truth for "can this brand receive orders?". Gated purely
 * on the store-verification outcome (APPROVED), independent of `isStoreOpen`
 * which callers continue to check separately for the store-closed state.
 */
export const isBrandStoreVerified = (
  verificationStatus?: BrandVerificationStatus | null,
): boolean => verificationStatus === BrandVerificationStatus.APPROVED;

type BrandVerificationTruthInput = {
  verificationStatus?: BrandVerificationStatus | null;
  isStoreOpen?: boolean | null;
  ownerStatus?: UserStatus | string | null;
  ownerDeactivatedAt?: Date | null;
};

export type BrandVerificationTruth = {
  isVerifiedBrand: boolean;
  verificationBadgeVisible: boolean;
  verificationStatus: BrandVerificationStatus;
  verifiedExplanationUrl: string | null;
};

export const getBrandVerificationTruth = (
  input: BrandVerificationTruthInput,
): BrandVerificationTruth => {
  const verificationStatus =
    input.verificationStatus ?? BrandVerificationStatus.NOT_SUBMITTED;
  const ownerIsActive = input.ownerStatus === UserStatus.ACTIVE;
  const verificationBadgeVisible =
    verificationStatus === BrandVerificationStatus.APPROVED &&
    Boolean(input.isStoreOpen) &&
    ownerIsActive &&
    !input.ownerDeactivatedAt;

  return {
    isVerifiedBrand: verificationBadgeVisible,
    verificationBadgeVisible,
    verificationStatus,
    verifiedExplanationUrl: VERIFIED_BADGE_EXPLANATION_PATH,
  };
};
