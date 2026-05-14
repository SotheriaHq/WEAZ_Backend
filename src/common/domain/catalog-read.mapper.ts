import type { CatalogEntityType } from './catalog-domain';
import { isCatalogEntityType } from './catalog-domain';

const SOURCE_TYPE_TO_ENTITY_TYPE: Record<string, CatalogEntityType> = {
  DESIGN: 'DESIGN',
  COLLECTION_MEDIA: 'DESIGN',
  PRODUCT: 'PRODUCT',
  STORE_PRODUCT: 'PRODUCT',
  COLLECTION: 'COLLECTION',
  STORE_COLLECTION: 'COLLECTION',
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function normalizeKey(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized.length > 0 ? normalized : null;
}

function hasProductSignals(record: Record<string, unknown>): boolean {
  return Boolean(
    record.sku ||
      record.totalStock !== undefined ||
      record.stock !== undefined ||
      record.variants !== undefined ||
      record.price !== undefined ||
      record.collectionIds !== undefined,
  );
}

function hasCollectionSignals(record: Record<string, unknown>): boolean {
  const count = asRecord(record._count);
  return Boolean(
    record.isAvailableInStore === true ||
      record.isSystemGenerated !== undefined ||
      count.products !== undefined ||
      (Array.isArray(record.products) && record.medias === undefined),
  );
}

function hasDesignSignals(record: Record<string, unknown>): boolean {
  return Boolean(
    record.designId ||
      record.legacyCollectionId ||
      record.coverMediaId ||
      record.customOrderEnabled !== undefined ||
      record.fitPreference !== undefined ||
      record.targetAgeGroup !== undefined ||
      Array.isArray(record.medias),
  );
}

export function resolveCatalogEntityType(
  value: unknown,
  fallback?: CatalogEntityType | null,
): CatalogEntityType | null {
  const record = asRecord(value);

  const explicit = normalizeKey(record.entityType);
  if (isCatalogEntityType(explicit)) {
    return explicit;
  }

  const sourceType = normalizeKey(record.sourceType);
  if (sourceType && SOURCE_TYPE_TO_ENTITY_TYPE[sourceType]) {
    return SOURCE_TYPE_TO_ENTITY_TYPE[sourceType];
  }

  const domain = normalizeKey(record.domain);
  if (domain === 'DESIGN') return 'DESIGN';
  if (domain === 'STORE') return 'COLLECTION';

  const lowerType = typeof record.type === 'string' ? record.type.trim().toLowerCase() : '';
  if (lowerType === 'design') return 'DESIGN';
  if (lowerType === 'product') return 'PRODUCT';
  if (lowerType === 'collection') return 'COLLECTION';

  if (hasProductSignals(record)) return 'PRODUCT';
  if (hasCollectionSignals(record)) return 'COLLECTION';
  if (hasDesignSignals(record)) return 'DESIGN';

  return fallback ?? null;
}

export function withCatalogEntityType<T extends Record<string, unknown>>(
  item: T,
  fallback?: CatalogEntityType | null,
): T & { entityType?: CatalogEntityType } {
  const entityType = resolveCatalogEntityType(item, fallback);
  return entityType ? { ...item, entityType } : item;
}
