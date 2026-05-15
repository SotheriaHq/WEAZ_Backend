export const CATALOG_ENTITY_TYPES = ['DESIGN', 'PRODUCT', 'COLLECTION'] as const;

export type CatalogEntityType = (typeof CATALOG_ENTITY_TYPES)[number];

export const DOMAIN_DISPLAY_LABELS: Record<CatalogEntityType, string> = {
  DESIGN: 'Design',
  PRODUCT: 'Product',
  COLLECTION: 'Collection',
};

export const DOMAIN_OWNERSHIP_SUMMARY: Record<CatalogEntityType, string[]> = {
  DESIGN: [
    'Creative fashion listing or style concept',
    'Owns media, title, description, category, tags, sizing, fit, age group, visibility, and design custom-order configuration',
    'May later be used to create products and may belong to collections',
  ],
  PRODUCT: [
    'Sellable inventory item',
    'Owns exact price, stock, SKU, variants, options, store availability, and checkout readiness',
    'May reference a design and may belong to collections',
  ],
  COLLECTION: [
    'Grouping/container',
    'Owns title, description, cover, visibility, grouped design IDs, grouped product IDs, and item ordering',
    'Must not own design creation fields or product inventory fields',
  ],
};

export function isCatalogEntityType(value: unknown): value is CatalogEntityType {
  return typeof value === 'string' && CATALOG_ENTITY_TYPES.includes(value as CatalogEntityType);
}
