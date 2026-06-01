import {
  ContentReportReasonCode,
  ContentMediaViewSlot,
  ContentReviewReasonCode,
} from '@prisma/client';

export const REQUIRED_CONTENT_MEDIA_VIEW_SLOTS: ContentMediaViewSlot[] = [
  ContentMediaViewSlot.FRONT,
  ContentMediaViewSlot.BACK,
  ContentMediaViewSlot.LEFT_SIDE,
  ContentMediaViewSlot.RIGHT_SIDE,
];

export const CONTENT_MEDIA_ORDER_SLOTS: ContentMediaViewSlot[] = [
  ContentMediaViewSlot.FRONT,
  ContentMediaViewSlot.BACK,
  ContentMediaViewSlot.LEFT_SIDE,
  ContentMediaViewSlot.RIGHT_SIDE,
  ContentMediaViewSlot.DETAIL,
  ContentMediaViewSlot.ON_MODEL,
];

export const CONTENT_REVIEW_REASON_LABELS: Record<
  ContentReviewReasonCode,
  string
> = {
  [ContentReviewReasonCode.POOR_IMAGE_QUALITY]: 'Poor image quality',
  [ContentReviewReasonCode.MISSING_REQUIRED_VIEW]: 'Missing required view',
  [ContentReviewReasonCode.DUPLICATE_ANGLE]: 'Duplicate angle uploaded',
  [ContentReviewReasonCode.MODEL_FABRIC_MISMATCH]:
    'Media does not match product/design details',
  [ContentReviewReasonCode.PROHIBITED_CONTENT]: 'Offensive or unsafe content',
  [ContentReviewReasonCode.AI_OR_MANIPULATED_IMAGE_SUSPECTED]:
    'Product or design is not clearly shown',
  [ContentReviewReasonCode.WRONG_CATEGORY_OR_METADATA_MISMATCH]:
    'Incomplete or misleading product/design information',
  [ContentReviewReasonCode.UNSAFE_OR_FALSE_CLAIM]:
    'Product or design is not clearly shown',
  [ContentReviewReasonCode.INTELLECTUAL_PROPERTY_OR_BRAND_MISUSE]:
    'Possible stolen or copyrighted image',
  [ContentReviewReasonCode.NOT_A_PRODUCT_OR_DESIGN_LISTING]:
    'Wrong or unrelated image',
  [ContentReviewReasonCode.OTHER]: 'Other',
};

export const CONTENT_REPORT_REASON_LABELS: Record<
  ContentReportReasonCode,
  string
> = {
  [ContentReportReasonCode.WRONG_OR_UNRELATED_IMAGE]:
    'Wrong or unrelated image',
  [ContentReportReasonCode.MISLEADING_MEDIA]: 'Misleading product/design media',
  [ContentReportReasonCode.STOLEN_OR_COPYRIGHTED_IMAGE]:
    'Stolen or copyrighted image',
  [ContentReportReasonCode.OFFENSIVE_OR_UNSAFE_MEDIA]:
    'Offensive or unsafe media',
  [ContentReportReasonCode.FAKE_OR_SCAM_LISTING]: 'Fake or scam listing',
  [ContentReportReasonCode.DETAILS_DO_NOT_MATCH_MEDIA]:
    'Product details do not match media',
  [ContentReportReasonCode.OTHER]: 'Other',
};

export const HIGH_SEVERITY_CONTENT_REPORT_REASONS: ContentReportReasonCode[] = [
  ContentReportReasonCode.STOLEN_OR_COPYRIGHTED_IMAGE,
  ContentReportReasonCode.OFFENSIVE_OR_UNSAFE_MEDIA,
  ContentReportReasonCode.FAKE_OR_SCAM_LISTING,
];
