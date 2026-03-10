import { BrandVerificationStatus, UserStatus } from '@prisma/client';

export const VERIFIED_BADGE_EXPLANATION_PATH = '/help/verified-badge';

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
