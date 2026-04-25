export const TAG_ENTITY_TYPE = {
  COLLECTION: 'COLLECTION',
  PRODUCT: 'PRODUCT',
  BRAND: 'BRAND',
  USER_BRAND: 'USER_BRAND',
} as const;

export type TagEntityTypeValue =
  (typeof TAG_ENTITY_TYPE)[keyof typeof TAG_ENTITY_TYPE];
