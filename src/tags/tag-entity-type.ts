export const TAG_ENTITY_TYPE = {
  /** A design (Collection table). */
  COLLECTION: 'COLLECTION',
  PRODUCT: 'PRODUCT',
  BRAND: 'BRAND',
  USER_BRAND: 'USER_BRAND',
  /** A store collection (StoreCollection table); never typed as a design. */
  STORE_COLLECTION: 'STORE_COLLECTION',
} as const;

export type TagEntityTypeValue =
  (typeof TAG_ENTITY_TYPE)[keyof typeof TAG_ENTITY_TYPE];
