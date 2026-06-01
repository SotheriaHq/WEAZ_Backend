import {
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
  [ContentReviewReasonCode.DUPLICATE_ANGLE]: 'Duplicate angle',
  [ContentReviewReasonCode.MODEL_FABRIC_MISMATCH]:
    'Model or fabric mismatch',
  [ContentReviewReasonCode.PROHIBITED_CONTENT]: 'Prohibited content',
  [ContentReviewReasonCode.AI_OR_MANIPULATED_IMAGE_SUSPECTED]:
    'AI or manipulated image suspected',
  [ContentReviewReasonCode.WRONG_CATEGORY_OR_METADATA_MISMATCH]:
    'Wrong category or metadata mismatch',
  [ContentReviewReasonCode.UNSAFE_OR_FALSE_CLAIM]:
    'Unsafe or false product claim',
  [ContentReviewReasonCode.INTELLECTUAL_PROPERTY_OR_BRAND_MISUSE]:
    'Intellectual property or brand misuse',
  [ContentReviewReasonCode.NOT_A_PRODUCT_OR_DESIGN_LISTING]:
    'Not a product or design listing',
  [ContentReviewReasonCode.OTHER]: 'Other',
};
