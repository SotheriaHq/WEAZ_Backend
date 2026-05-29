import {
  CATALOG_ENTITY_TYPES,
  type CatalogEntityType,
  isCatalogEntityType,
} from './catalog-domain';

export const CATALOG_TARGET_TYPES = CATALOG_ENTITY_TYPES;

export type CatalogTargetType = CatalogEntityType;

export type LegacyCatalogTargetType =
  | 'COLLECTION'
  | 'COLLECTION_MEDIA'
  | 'PRODUCT';

export interface CatalogTargetInput {
  targetType?: unknown;
  entityType?: unknown;
  targetId?: unknown;
  designId?: unknown;
  productId?: unknown;
  collectionId?: unknown;
  legacyCollectionId?: unknown;
  mediaId?: unknown;
}

export interface NormalizedCatalogTarget {
  targetType: CatalogTargetType;
  targetId: string;
  designId?: string;
  productId?: string;
  collectionId?: string;
  legacyCollectionId?: string;
}

export interface LegacyCatalogTarget {
  targetType: LegacyCatalogTargetType;
  targetId: string;
  legacyCollectionId?: string;
}

const normalizeId = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const normalizeType = (value: unknown): CatalogTargetType | null => {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return isCatalogEntityType(normalized) ? normalized : null;
};

export function isCatalogTargetType(
  value: unknown,
): value is CatalogTargetType {
  return isCatalogEntityType(value);
}

export function normalizeCatalogTarget(
  input: CatalogTargetInput,
): NormalizedCatalogTarget | null {
  const targetType =
    normalizeType(input.targetType) ?? normalizeType(input.entityType);

  if (targetType === 'DESIGN') {
    const designId =
      normalizeId(input.designId) ??
      normalizeId(input.targetId) ??
      normalizeId(input.legacyCollectionId) ??
      normalizeId(input.collectionId);
    if (!designId) return null;
    const legacyCollectionId =
      normalizeId(input.legacyCollectionId) ??
      normalizeId(input.collectionId) ??
      designId;
    return {
      targetType,
      targetId: designId,
      designId,
      legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  if (targetType === 'PRODUCT') {
    const productId =
      normalizeId(input.productId) ?? normalizeId(input.targetId);
    if (!productId) return null;
    return { targetType, targetId: productId, productId };
  }

  if (targetType === 'COLLECTION') {
    const collectionId =
      normalizeId(input.collectionId) ?? normalizeId(input.targetId);
    if (!collectionId) return null;
    return { targetType, targetId: collectionId, collectionId };
  }

  const designId = normalizeId(input.designId);
  if (designId) {
    const legacyCollectionId =
      normalizeId(input.legacyCollectionId) ??
      normalizeId(input.collectionId) ??
      designId;
    return {
      targetType: 'DESIGN',
      targetId: designId,
      designId,
      legacyCollectionId,
      collectionId: legacyCollectionId,
    };
  }

  const productId = normalizeId(input.productId);
  if (productId) {
    return { targetType: 'PRODUCT', targetId: productId, productId };
  }

  const collectionId = normalizeId(input.collectionId);
  if (collectionId) {
    return { targetType: 'COLLECTION', targetId: collectionId, collectionId };
  }

  return null;
}

export function mapCatalogTargetToLegacyTarget(
  target: NormalizedCatalogTarget,
): LegacyCatalogTarget {
  if (target.targetType === 'DESIGN') {
    return {
      targetType: 'COLLECTION',
      targetId: target.legacyCollectionId ?? target.designId ?? target.targetId,
      legacyCollectionId: target.legacyCollectionId ?? target.targetId,
    };
  }

  if (target.targetType === 'PRODUCT') {
    return {
      targetType: 'PRODUCT',
      targetId: target.productId ?? target.targetId,
    };
  }

  return {
    targetType: 'COLLECTION',
    targetId: target.collectionId ?? target.targetId,
  };
}

export function resolveCatalogTargetFromLegacy(input: {
  targetType?: unknown;
  targetId?: unknown;
  entityType?: unknown;
  collectionId?: unknown;
  legacyCollectionId?: unknown;
}): NormalizedCatalogTarget | null {
  const entityType = normalizeType(input.entityType);
  if (entityType) {
    return normalizeCatalogTarget({
      targetType: entityType,
      targetId: input.targetId,
      collectionId: input.collectionId,
      legacyCollectionId: input.legacyCollectionId,
    });
  }

  const legacyType =
    typeof input.targetType === 'string'
      ? input.targetType.trim().toUpperCase()
      : null;
  const targetId = normalizeId(input.targetId);
  if (!targetId) return null;

  if (legacyType === 'PRODUCT') {
    return normalizeCatalogTarget({ targetType: 'PRODUCT', targetId });
  }

  if (legacyType === 'COLLECTION') {
    return normalizeCatalogTarget({ targetType: 'COLLECTION', targetId });
  }

  return null;
}
