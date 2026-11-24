import { Prisma, ContentMediaViewSlot } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { UploadService } from '../../upload/upload.service';
import { resolveProductPrice } from '../../common/pricing/product-price';
import { MarketSectionItemDto } from '../dto/market-section.dto';
import {
  eligibleProductWhere,
  isEligibleProduct,
  usableProductImage,
  PRODUCT_ELIGIBILITY_FIELDS,
  PRODUCT_ELIGIBILITY_BRAND_FIELDS,
} from '../eligibility/market-eligibility';
import { MarketOrderedRow } from './market-ordered-reader';

/** Catalogue page capture: up to 60 cards plus one look-ahead row. */
export const MARKET_CARD_CAPTURE_DEFAULT = 61;
/** Hard ceiling for one capture (the Market page: 8 rails x (12 + 2 reserve)). */
export const MARKET_CARD_CAPTURE_MAX = 112;

export const MARKET_CATALOG_CARD_SELECT = {
  ...PRODUCT_ELIGIBILITY_FIELDS,
  collections: {
    where: {
      collection: {
        status: 'PUBLISHED',
        isAvailableInStore: true,
        deletedAt: null,
      },
    },
    take: 1,
    select: {
      collection: {
        select: {
          status: true,
          visibility: true,
          isAvailableInStore: true,
          deletedAt: true,
        },
      },
    },
  },
  id: true,
  name: true,
  description: true,
  slug: true,
  salePrice: true,
  saleStartAt: true,
  saleEndAt: true,
  currency: true,
  standardCheckoutEnabled: true,
  brandId: true,
  firstPublishedAt: true,
  viewsCount: true,
  threadsCount: true,
  createdAt: true,
  updatedAt: true,
  brand: {
    select: {
      ...PRODUCT_ELIGIBILITY_BRAND_FIELDS,
      id: true,
      name: true,
      logo: true,
      createdAt: true,
      owner: { select: { id: true, status: true } },
    },
  },
  category: { select: { id: true, slug: true, name: true, isActive: true } },
  media: {
    where: {
      reviewStatus: 'APPROVED',
      file: {
        processingStatus: 'READY',
        originalDeletedAt: null,
        mimeType: {
          in: [
            'image/jpeg',
            'image/png',
            'image/webp',
            'image/avif',
            'image/gif',
          ],
        },
      },
    },
    orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
    take: Object.values(ContentMediaViewSlot).length,
    select: {
      file: {
        select: {
          id: true,
          s3Url: true,
          width: true,
          height: true,
          assetVersion: true,
        },
      },
    },
  },
} satisfies Prisma.ProductSelect;
type Product = Prisma.ProductGetPayload<{
  select: typeof MARKET_CATALOG_CARD_SELECT;
}>;
type CaptureTx = Pick<
  Prisma.TransactionClient,
  'product' | 'fileUpload' | '$queryRaw'
>;
export interface CapturedMarketCard {
  readonly product: Product;
  readonly file: Product['media'][number]['file'];
  readonly logoFileId: string | null;
  readonly tags: readonly string[];
  readonly asOf: Date;
}

/** Capture only server-ordered IDs; data and pricing share the reader's MVCC/time. */
export async function captureMarketCatalogCards(
  tx: CaptureTx,
  input: {
    readonly rows: readonly MarketOrderedRow[];
    readonly asOf: Date;
  },
): Promise<CapturedMarketCard[]> {
  const limit = MARKET_CARD_CAPTURE_DEFAULT;
  if (input.rows.length > limit || !Number.isFinite(input.asOf.getTime()))
    throw new RangeError('Invalid catalogue hydration budget');
  if (!input.rows.length) return [];
  const products = await tx.product.findMany({
    where: eligibleProductWhere(input.asOf, [
      { id: { in: input.rows.map((row) => row.id) } },
      { currency: 'NGN' },
    ]),
    select: MARKET_CATALOG_CARD_SELECT,
    take: limit,
  });
  const tags = products.length
    ? await tx.$queryRaw<
        Array<{ entityId: string; normalizedName: string }>
      >(Prisma.sql`
    SELECT "entityId","normalizedName" FROM (
      SELECT binding."entityId",tag."normalizedName",row_number() OVER(PARTITION BY binding."entityId" ORDER BY tag."normalizedName",tag."_id") AS position
      FROM "TagBinding" binding JOIN "Tag" tag ON tag."_id"=binding."tagId"
      WHERE binding."entityType"='PRODUCT' AND binding."entityId" IN (${Prisma.join(products.map((product) => Prisma.sql`${product.id}::uuid`))})
        AND tag.status='APPROVED' AND NOT tag."isBanned" AND tag."aliasOfTagId" IS NULL
    ) approved WHERE position<=25 ORDER BY "entityId",position`)
    : [];
  const logos = products
    .filter((product) => product.brand.logo?.trim())
    .map((product) => ({
      s3Url: product.brand.logo!.trim(),
      userId: product.brand.owner.id,
      userProfileImages: { some: { userId: product.brand.owner.id } },
    }));
  const logoFiles = logos.length
    ? await tx.fileUpload.findMany({
        where: {
          OR: logos,
          fileType: 'PROFILE_IMAGE',
          processingStatus: 'READY',
          originalDeletedAt: null,
        },
        select: { id: true, s3Url: true, userId: true },
        take: limit,
      })
    : [];
  const byId = new Map(products.map((product) => [product.id, product]));
  const coverUrls = [
    ...new Set(
      products
        .map((product) => usableProductImage(product))
        .filter((url): url is string => !!url && url.length <= 4096),
    ),
  ];
  const mediaIds = [
    ...new Set(
      products.flatMap((product) =>
        product.media.map((media) => media.file.id),
      ),
    ),
  ];
  const matchingVariants =
    mediaIds.length && coverUrls.length
      ? await tx.$queryRaw<
          Array<{ fileUploadId: string; s3Url: string }>
        >(Prisma.sql`
    SELECT DISTINCT variant."fileUploadId",variant."s3Url" FROM "FileVariant" variant
    JOIN "FileUpload" file ON file."_id"=variant."fileUploadId" AND file."assetVersion"=variant."assetVersion"
    WHERE variant."fileUploadId" IN (${Prisma.join(mediaIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND variant."s3Url" IN (${Prisma.join(coverUrls)})`)
      : [];
  const variantCovers = new Set(
    matchingVariants.map(
      (variant) => `${variant.fileUploadId}:${variant.s3Url.trim()}`,
    ),
  );
  const tagsById = new Map<string, string[]>();
  for (const binding of tags) {
    const values = tagsById.get(binding.entityId) ?? [];
    if (values.length < 25) values.push(binding.normalizedName);
    tagsById.set(binding.entityId, values);
  }
  const result: CapturedMarketCard[] = [];
  for (const row of input.rows) {
    const product = byId.get(row.id);
    if (!product || !isEligibleProduct(product, input.asOf)) continue;
    const raw = usableProductImage(product);
    const file =
      raw && raw.length <= 4096
        ? product.media.find(
            (media) =>
              media.file.s3Url.trim() === raw ||
              variantCovers.has(`${media.file.id}:${raw}`),
          )?.file
        : undefined;
    if (!file) continue;
    const price = resolveProductPrice(product, input.asOf);
    if (!price || price.effectivePrice.lte(0)) continue;
    if (row.amount && !price.effectivePrice.equals(row.amount))
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_PRICE_CONTEXT_CHANGED',
        message: 'Prices updated. Refresh this list.',
      });
    const capturedInstant = input.asOf.getTime();
    result.push(
      Object.freeze({
        product,
        file,
        tags: tagsById.get(product.id) ?? [],
        get asOf() {
          return new Date(capturedInstant);
        },
        logoFileId:
          logoFiles.find(
            (logo) =>
              logo.userId === product.brand.owner.id &&
              logo.s3Url.trim() === product.brand.logo?.trim(),
          )?.id ?? null,
      }),
    );
  }
  return result;
}

/** Signing happens outside the database transaction and always uses public gates. */
export async function hydrateMarketCatalogCards(
  captured: readonly CapturedMarketCard[],
  uploads: Pick<
    UploadService,
    'getBatchPublicSignedUrls' | 'getBatchVariantDisplayUrls'
  >,
): Promise<MarketSectionItemDto[]> {
  if (captured.length > MARKET_CARD_CAPTURE_MAX)
    throw new RangeError('Invalid catalogue signing budget');
  const ids = [
    ...new Set(
      captured.flatMap((card) => [
        card.file.id,
        ...(card.logoFileId ? [card.logoFileId] : []),
      ]),
    ),
  ];
  if (!ids.length) return [];
  const originals = await uploads.getBatchPublicSignedUrls(ids);
  // Variant signing inherits public authorization; never send it unvouched IDs.
  const variants = await uploads.getBatchVariantDisplayUrls(
    [...originals.keys()],
    'CARD',
  );
  const items: MarketSectionItemDto[] = [];
  for (const card of captured) {
    const { product, file, asOf } = card;
    const url = variants.get(file.id) ?? originals.get(file.id);
    if (!url) continue;
    const pricing = resolveProductPrice(product, asOf)!;
    const width = file.width && file.width > 0 ? file.width : null;
    const height = file.height && file.height > 0 ? file.height : null;
    items.push({
      id: product.id,
      sourceId: product.id,
      sourceType: 'PRODUCT',
      entityType: 'PRODUCT',
      title: product.name,
      subtitle: product.brand.name,
      description: product.description,
      brand: {
        id: product.brand.id,
        name: product.brand.name,
        logoUrl: card.logoFileId
          ? (originals.get(card.logoFileId) ?? null)
          : null,
        createdAt: product.brand.createdAt.toISOString(),
        isNew:
          asOf.getTime() - product.brand.createdAt.getTime() <= 180 * 86400000,
      },
      media: {
        url,
        thumbnailUrl: url,
        fileId: file.id,
        type: 'IMAGE',
        alt: product.name,
        width,
        height,
        aspectRatio: width && height ? width / height : null,
      },
      price: {
        amount: pricing.price.toNumber(),
        saleAmount: pricing.isOnSale ? pricing.effectivePrice.toNumber() : null,
        effectiveAmount: pricing.effectivePrice.toNumber(),
        currency: 'NGN',
      },
      priceRange: null,
      availability: {
        totalStock: product.totalStock,
        customOrderEnabled: product.customOrderEnabled,
        standardCheckoutEnabled: product.standardCheckoutEnabled,
        isOnSale: pricing.isOnSale,
      },
      category: product.category?.isActive
        ? {
            id: product.category.id,
            slug: product.category.slug,
            name: product.category.name,
          }
        : null,
      tags: [...card.tags],
      stats: {
        views: product.viewsCount,
        threads: product.threadsCount,
        products: null,
      },
      target: {
        type: 'PRODUCT',
        id: product.id,
        key: product.slug ?? product.id,
        route: product.slug
          ? `/market-place/products/${encodeURIComponent(product.slug)}`
          : `/market-place?productId=${product.id}`,
      },
      createdAt: product.createdAt.toISOString(),
      updatedAt: product.updatedAt.toISOString(),
    });
  }
  return items;
}
