export const REVIEW_ERRORS = {
  NOT_ELIGIBLE: 'REVIEW_NOT_ELIGIBLE',
  ALREADY_EXISTS: 'REVIEW_ALREADY_EXISTS',
  BLOCKED_BY_DISPUTE: 'REVIEW_BLOCKED_BY_DISPUTE',
  MEDIA_OWNERSHIP_INVALID: 'REVIEW_MEDIA_OWNERSHIP_INVALID',
  MEDIA_TYPE_INVALID: 'REVIEW_MEDIA_TYPE_INVALID',
  NOT_FOUND: 'REVIEW_NOT_FOUND',
  FORBIDDEN: 'REVIEW_FORBIDDEN',
  ALREADY_VOTED: 'REVIEW_ALREADY_VOTED_HELPFUL',
  REPORT_EXISTS: 'REVIEW_REPORT_ALREADY_EXISTS',
  FEATURE_DISABLED: 'REVIEW_FEATURE_DISABLED',
} as const;

export const REVIEW_FEATURE_FLAGS = {
  READ: 'reviews.v1.read',
  WRITE: 'reviews.v1.write',
  BRAND_REPLIES: 'reviews.v1.brand-replies',
  ADMIN_MODERATION: 'reviews.v1.admin-moderation',
  REMINDERS: 'reviews.v1.reminders',
  CAPTURE: 'reviews.capture.enabled',
  PROMPT_AFTER_COMPLETION: 'reviews.prompt.afterCompletion.enabled',
  PUBLIC_PRODUCT: 'reviews.publicDisplay.product.enabled',
  PUBLIC_COLLECTION: 'reviews.publicDisplay.collection.enabled',
  PUBLIC_DESIGN: 'reviews.publicDisplay.design.enabled',
  PUBLIC_BRAND: 'reviews.publicDisplay.brand.enabled',
  MODERATION_REQUIRED: 'reviews.moderation.required',
} as const;

export const REVIEW_CONFIG_KEYS = {
  EDIT_WINDOW_HOURS: 'reviews.editWindowHours',
} as const;
