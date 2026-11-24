import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { MarketSectionItemDto } from '../dto/market-section.dto';
import { parseMarketCatalogRequest } from './market-catalog-request';
import type { MarketLegacySellingOptions } from './market-catalog.service';

export type LegacyMarketRoute =
  | Readonly<{ kind: 'legacy' }>
  | Readonly<{
      kind: 'catalogue';
      query: URLSearchParams;
      collectionId?: string;
    }>;

const scalarKeys = new Set([
  'page',
  'limit',
  'cursor',
  'collectionId',
  'category',
  'gender',
  'minPrice',
  'maxPrice',
  'onSale',
  'isOnSale',
  'isFeatured',
  'sortBy',
  'sort',
  'q',
  'search',
]);
const lists = { sizes: 'size', colors: 'color', tags: 'tag' } as const;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isLegacyMarketCursor = (value: string): boolean =>
  uuid.test(value) || /^\d+$/.test(value);
const invalid = (
  message = 'Review the Market filters and try again.',
): never => {
  throw new BadRequestException({ code: 'INVALID_FILTER', message });
};

/** One-release translation only. Unsupported V1 features remain on V1; signed
 * catalogue cursors never cross to a different reader or authority context. */
export function parseLegacyMarketRoute(
  raw: URLSearchParams,
): LegacyMarketRoute {
  if (raw.toString().length > 16384)
    invalid('The Market request is too large.');
  for (const [key, value] of raw) {
    const list = key.endsWith('[]') ? key.slice(0, -2) : key;
    if (
      !scalarKeys.has(key) &&
      !Object.prototype.hasOwnProperty.call(lists, list)
    )
      invalid();
    if (/[\u0000-\u001f\u007f\ufffd]/u.test(value)) invalid();
    if (scalarKeys.has(key) && raw.getAll(key).length > 1)
      invalid('Do not repeat Market controls.');
  }
  for (const pair of [
    ['sort', 'sortBy'],
    ['onSale', 'isOnSale'],
    ['q', 'search'],
  ] as const)
    if (raw.has(pair[0]) && raw.has(pair[1]))
      invalid('Use one spelling for each Market control.');
  for (const key of Object.keys(lists)) {
    if (raw.has(key) && raw.has(`${key}[]`))
      invalid('Use one encoding for each Market list.');
    if (raw.getAll(key).length > 1)
      invalid('Use brackets to repeat Market list values.');
  }
  const cursor = raw.get('cursor');
  const legacyCursor = Boolean(cursor && isLegacyMarketCursor(cursor));
  const canonicalCursor = Boolean(cursor && !legacyCursor);
  const unsigned = (key: string, fallback: number) => {
    const value = raw.get(key);
    if (value === null) return fallback;
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
      invalid();
    return Number(value);
  };
  const page = unsigned('page', 1),
    limit = unsigned('limit', 40);
  const collectionId = raw.get('collectionId') ?? undefined;
  if (collectionId !== undefined && !uuid.test(collectionId))
    invalid('Select a valid collection.');
  const legacyText = ['category', 'q', 'search'].some((key) =>
    Boolean(raw.get(key)?.trim()),
  );
  for (const key of ['category', 'q', 'search'])
    if ((raw.get(key)?.length ?? 0) > 120) invalid();
  const legacyOnly =
    legacyCursor ||
    legacyText ||
    raw.has('isFeatured') ||
    page > 1 ||
    limit > 60;
  if (legacyOnly && canonicalCursor)
    invalid('Refresh this list before changing its pagination or search mode.');
  const query = new URLSearchParams({
    limit: String(Math.min(60, limit)),
    sort: raw.get('sortBy') ?? raw.get('sort') ?? 'newest',
  });
  if (cursor !== null && !legacyCursor) query.set('cursor', cursor);
  for (const [legacy, canonical] of Object.entries(lists)) {
    if (raw.has(legacy)) query.set(canonical, raw.get(legacy)!);
    for (const value of raw.getAll(`${legacy}[]`))
      query.append(`${canonical}[]`, value);
  }
  const gender = raw.get('gender');
  if (gender !== null) {
    const audiences: Record<string, string> = {
      MALE: 'MEN',
      FEMALE: 'WOMEN',
      EVERYBODY: 'UNISEX',
    };
    const audience = audiences[gender.toUpperCase()];
    if (!audience) invalid();
    query.set('audience', audience);
  }
  for (const [legacy, canonical] of [
    ['minPrice', 'price.min'],
    ['maxPrice', 'price.max'],
  ] as const)
    if (raw.has(legacy)) query.set(canonical, raw.get(legacy)!);
  const onSale = raw.get('onSale') ?? raw.get('isOnSale');
  if (onSale !== null) {
    const value = onSale.trim().toLowerCase();
    if (!['true', 'false', '1', '0', 'yes', 'no'].includes(value)) invalid();
    query.set('onSale', ['true', '1', 'yes'].includes(value) ? '1' : '0');
  }
  const featured = raw.get('isFeatured');
  if (
    featured !== null &&
    !['true', 'false', '1', '0', 'yes', 'no'].includes(
      featured.trim().toLowerCase(),
    )
  )
    invalid();
  parseMarketCatalogRequest(query);
  if (legacyOnly) return Object.freeze({ kind: 'legacy' });
  return Object.freeze({
    kind: 'catalogue',
    query,
    ...(collectionId ? { collectionId: collectionId.toLowerCase() } : {}),
  });
}

export type LegacyMarketSellingOptions = MarketLegacySellingOptions;
export interface LegacyMarketCataloguePage {
  readonly items: readonly MarketSectionItemDto[];
  readonly pagination: {
    readonly limit: number;
    readonly hasNextPage: boolean;
    readonly nextCursor: string | null;
    readonly reanchored?: boolean;
  };
  readonly total?: number;
  readonly legacyOptions?: ReadonlyMap<string, LegacyMarketSellingOptions>;
  readonly availableSorts?: readonly string[];
  readonly appliedFilters?: unknown;
  readonly sort?: unknown;
  readonly meta?: unknown;
}

/** Explicit mapping, never a spread of private Product/Brand records. */
export function mapLegacyMarketPage(page: LegacyMarketCataloguePage) {
  if (
    !Number.isSafeInteger(page.total) ||
    page.total! < 0 ||
    !page.legacyOptions ||
    page.total! < page.items.length
  )
    throw new ServiceUnavailableException({
      code: 'CATALOGUE_FACADE_UNAVAILABLE',
      message: 'The Market is updating. Please try again shortly.',
    });
  const items = page.items.map((item) => {
    const options = page.legacyOptions!.get(item.id);
    if (
      item.entityType !== 'PRODUCT' ||
      !options ||
      !options.gallery?.length ||
      !item.price ||
      !item.availability ||
      !item.media?.url
    )
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_FACADE_UNAVAILABLE',
        message: 'The Market is updating. Please try again shortly.',
      });
    const media = options.gallery.map((gallery) => ({
      url: gallery.url,
      fileId: gallery.fileId,
      type: 'image',
      width: gallery.width,
      height: gallery.height,
      aspectRatio: gallery.aspectRatio,
      isPrimary: gallery.fileId === item.media!.fileId,
    }));
    return {
      id: item.id,
      entityType: 'PRODUCT',
      name: item.title,
      description: item.description,
      brandId: item.brand?.id ?? null,
      brandName: item.brand?.name ?? null,
      brandLogo: item.brand?.logoUrl ?? null,
      brand: item.brand
        ? {
            id: item.brand.id,
            name: item.brand.name,
            brandName: item.brand.name,
            logo: item.brand.logoUrl,
            logoUrl: item.brand.logoUrl,
          }
        : null,
      price: item.price.amount,
      salePrice: item.price.saleAmount,
      effectivePrice: item.price.effectiveAmount,
      currency: item.price.currency,
      thumbnail: item.media.url,
      coverImage: item.media.url,
      coverImageId: item.media.fileId ?? null,
      images: media.map((image) => image.url),
      media,
      mediaIds: media.map((image) => image.fileId),
      totalStock: item.availability.totalStock,
      stock: item.availability.totalStock,
      customOrderEnabled: item.availability.customOrderEnabled,
      standardCheckoutEnabled: item.availability.standardCheckoutEnabled,
      sizes: [...options.sizes],
      colors: [...options.colors],
      variants: options.variants.map((variant) => ({
        id: variant.id,
        size: variant.size,
        color: variant.color,
        stock: variant.stock,
        price: variant.price === null ? null : Number(variant.price),
        sku: variant.sku,
        colorHex: variant.colorHex,
      })),
      ...(options.sizeStock === undefined
        ? {}
        : { sizeStock: options.sizeStock }),
      category: item.category,
      categoryId: item.category?.id ?? null,
      categoryName: item.category?.name ?? null,
      categorySlug: item.category?.slug ?? null,
      categoryType: options.categoryType ?? null,
      categoryTypeId: options.categoryType?.id ?? null,
      subCategoryId: options.categoryType?.id ?? null,
      slug: options.slug ?? null,
      gender: options.gender,
      isFeatured: options.isFeatured,
      saleStartAt: options.saleStartAt ?? null,
      saleEndAt: options.saleEndAt ?? null,
      isOnSale: item.availability.isOnSale,
      filters: options.filters ?? [],
      filterValueIds: (options.filters ?? []).map((filter) => filter.valueId),
      filterSelection: (options.filters ?? []).reduce<Record<string, string[]>>(
        (selection, filter) => {
          (selection[filter.dimensionId] ??= []).push(filter.valueId);
          return selection;
        },
        {},
      ),
      tags: [...item.tags],
      viewsCount: item.stats.views,
      threadsCount: item.stats.threads,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
    };
  });
  return {
    items,
    total: page.total!,
    page: 1,
    limit: page.pagination.limit,
    totalPages: Math.ceil(page.total! / page.pagination.limit),
    hasNextPage: page.pagination.hasNextPage,
    nextCursor: page.pagination.nextCursor,
    pagination: page.pagination,
    availableSorts: page.availableSorts,
    appliedFilters: page.appliedFilters,
    sort: page.sort,
    meta: page.meta,
  };
}
