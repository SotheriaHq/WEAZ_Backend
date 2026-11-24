import { ContentMediaViewSlot, Prisma } from '@prisma/client';
import { ServiceUnavailableException } from '@nestjs/common';
import { CapturedMarketCard } from './market-catalog-cards';
import { MarketOrderedRow } from './market-ordered-reader';
import {
  eligibleProductSql,
  isEligibleProduct,
  usableProductImage,
} from '../eligibility/market-eligibility';
import { resolveProductPrice } from '../../common/pricing/product-price';
import { trimSql } from '../../common/utils/sql-text-normalization';

type Product = CapturedMarketCard['product'];
type File = CapturedMarketCard['file'];
interface RawCard {
  product: Omit<
    Product,
    | 'price'
    | 'salePrice'
    | 'createdAt'
    | 'updatedAt'
    | 'firstPublishedAt'
    | 'publishAt'
    | 'saleStartAt'
    | 'saleEndAt'
    | 'deletedAt'
    | 'archivedAt'
    | 'brand'
  > & {
    price: string;
    salePrice: string | null;
    createdAt: string;
    updatedAt: string;
    firstPublishedAt: string | null;
    publishAt: string | null;
    saleStartAt: string | null;
    saleEndAt: string | null;
    deletedAt: string | null;
    archivedAt: string | null;
    brand: Omit<Product['brand'], 'createdAt'> & { createdAt: string };
  };
  logoFileId: string | null;
  tags: string[];
  matchingFileId: string | null;
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const utc = (field: Prisma.Sql, timestamptz = false) =>
  Prisma.sql`CASE WHEN ${field} IS NULL THEN NULL ELSE to_char(${timestamptz ? Prisma.sql`${field} AT TIME ZONE 'UTC'` : field},'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END`;

/** One physical data statement for <=61 cards. Lateral aggregates are confined
 * to those IDs; no Prisma relation fanout or whole-catalog card materialization. */
export function marketCatalogCardBatchSql(input: {
  rows: readonly MarketOrderedRow[];
  asOf: Date;
}): Prisma.Sql {
  if (
    !input.rows.length ||
    input.rows.length > 61 ||
    !Number.isFinite(input.asOf.getTime()) ||
    input.rows.some((row) => !uuid.test(row.id))
  )
    throw new RangeError('Invalid catalogue hydration budget');
  const cover = Prisma.sql`COALESCE(NULLIF(${trimSql(Prisma.sql`p.thumbnail`)},''),(SELECT ${trimSql(Prisma.sql`image.value`)} FROM unnest(p.images) WITH ORDINALITY image(value,position) WHERE length(${trimSql(Prisma.sql`image.value`)})>0 ORDER BY image.position LIMIT 1))`;
  const fileJson = Prisma.sql`jsonb_build_object('id',file."_id",'s3Url',file."s3Url",'width',file.width,'height',file.height,'assetVersion',file."assetVersion")`;
  return Prisma.sql`SELECT jsonb_build_object(
    'id',p."_id",'name',p.name,'description',p.description,'slug',p.slug,'brandId',p."brandId",
    'isActive',p."isActive",'publicationStatus',p."publicationStatus",'deletedAt',${utc(Prisma.sql`p."deletedAt"`)},'archivedAt',${utc(Prisma.sql`p."archivedAt"`)},'publishAt',${utc(Prisma.sql`p."publishAt"`)},
    'price',p.price::text,'salePrice',p."salePrice"::text,'saleStartAt',${utc(Prisma.sql`p."saleStartAt"`)},'saleEndAt',${utc(Prisma.sql`p."saleEndAt"`)},'currency',p.currency,
    'thumbnail',p.thumbnail,'images',p.images,'totalStock',p."totalStock",'customOrderEnabled',p."customOrderEnabled",'standardCheckoutEnabled',p."standardCheckoutEnabled",
    'firstPublishedAt',${utc(Prisma.sql`p."firstPublishedAt"`, true)},'viewsCount',p."viewsCount",'threadsCount',p."likesCount",'createdAt',${utc(Prisma.sql`p."createdAt"`)},'updatedAt',${utc(Prisma.sql`p."updatedAt"`)},
    'brand',jsonb_build_object('id',b."_id",'name',b.name,'logo',b.logo,'isStoreOpen',b."isStoreOpen",'createdAt',${utc(Prisma.sql`b."createdAt"`)},'owner',jsonb_build_object('id',owner."_id",'status',owner.status)),
    'category',CASE WHEN category."_id" IS NULL THEN NULL ELSE jsonb_build_object('id',category."_id",'name',category.name,'slug',category.slug,'isActive',category."isActive") END,
    'collections',COALESCE(membership.items,'[]'::jsonb),'media',COALESCE(media.items,'[]'::jsonb)) AS product,
    logo."_id"::text AS "logoFileId",COALESCE(tags.values,ARRAY[]::text[]) AS tags,media."matchingFileId"
    FROM "Product" p JOIN "Brand" b ON b."_id"=p."brandId" JOIN "User" owner ON owner."_id"=b."ownerId"
    LEFT JOIN "CollectionCategory" category ON category."_id"=p."categoryId"
    LEFT JOIN LATERAL (SELECT jsonb_build_array(jsonb_build_object('collection',jsonb_build_object('status',c.status,'visibility',c.visibility,'isAvailableInStore',c."isAvailableInStore",'deletedAt',NULL))) AS items
      FROM "StoreCollectionProduct" link JOIN "StoreCollection" c ON c."_id"=link."collectionId" WHERE link."productId"=p."_id" AND c.status='PUBLISHED' AND c."isAvailableInStore" AND c."deletedAt" IS NULL ORDER BY c."_id" LIMIT 1) membership ON true
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('file',selected.file) ORDER BY selected.position,selected.id) AS items,
      (array_agg(selected."fileId" ORDER BY selected.position,selected.id) FILTER(WHERE selected.matches))[1]::text AS "matchingFileId"
      FROM (SELECT media."_id" AS id,media."orderIndex" AS position,file."_id" AS "fileId",${fileJson} AS file,
        char_length(${cover})<=4096 AND (${trimSql(Prisma.sql`file."s3Url"`)}=${cover} OR EXISTS(SELECT 1 FROM "FileVariant" v WHERE v."fileUploadId"=file."_id" AND v."assetVersion"=file."assetVersion" AND v."s3Url"=${cover})) AS matches
        FROM "ProductMedia" media JOIN "FileUpload" file ON file."_id"=media."fileUploadId"
        WHERE media."productId"=p."_id" AND media."reviewStatus"='APPROVED' AND file."processingStatus"='READY' AND file."originalDeletedAt" IS NULL
          AND file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
        ORDER BY media."orderIndex",media."_id" LIMIT ${Object.values(ContentMediaViewSlot).length}) selected) media ON true
    LEFT JOIN LATERAL (SELECT file."_id" FROM "FileUpload" file JOIN "UserProfile" profile ON profile."profileImageId"=file."_id" AND profile."userId"=b."ownerId"
      WHERE file."userId"=b."ownerId" AND file."fileType"='PROFILE_IMAGE' AND file."processingStatus"='READY' AND file."originalDeletedAt" IS NULL AND file."s3Url"=${trimSql(Prisma.sql`b.logo`)} ORDER BY file."_id" LIMIT 1) logo ON true
    LEFT JOIN LATERAL (SELECT array_agg(tag."normalizedName" ORDER BY tag."normalizedName",tag."_id") AS values FROM (
      SELECT tag."normalizedName",tag."_id" FROM "TagBinding" binding JOIN "Tag" tag ON tag."_id"=binding."tagId"
      WHERE binding."entityType"='PRODUCT' AND binding."entityId"=p."_id" AND tag.status='APPROVED' AND NOT tag."isBanned" AND tag."aliasOfTagId" IS NULL ORDER BY tag."normalizedName",tag."_id" LIMIT 25) tag) tags ON true
    WHERE p."_id" IN (${Prisma.join(input.rows.map((row) => Prisma.sql`${row.id}::uuid`))}) AND ${eligibleProductSql(input.asOf)} AND p.currency='NGN' AND p.price<'Infinity'::numeric LIMIT 61`;
}

const date = (value: string | null) =>
  value === null ? null : new Date(value);
export async function captureMarketCatalogCardsBatched(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: { rows: readonly MarketOrderedRow[]; asOf: Date },
): Promise<CapturedMarketCard[]> {
  if (input.rows.length > 61 || !Number.isFinite(input.asOf.getTime()))
    throw new RangeError('Invalid catalogue hydration budget');
  if (!input.rows.length) return [];
  const raw = await tx.$queryRaw<RawCard[]>(marketCatalogCardBatchSql(input));
  const byId = new Map(raw.map((row) => [row.product.id, row]));
  return input.rows.flatMap((ordered) => {
    const row = byId.get(ordered.id);
    if (!row || !row.matchingFileId) return [];
    const product: Product = {
      ...row.product,
      price: new Prisma.Decimal(row.product.price),
      salePrice:
        row.product.salePrice === null
          ? null
          : new Prisma.Decimal(row.product.salePrice),
      createdAt: new Date(row.product.createdAt),
      updatedAt: new Date(row.product.updatedAt),
      firstPublishedAt: date(row.product.firstPublishedAt),
      publishAt: date(row.product.publishAt),
      saleStartAt: date(row.product.saleStartAt),
      saleEndAt: date(row.product.saleEndAt),
      deletedAt: date(row.product.deletedAt),
      archivedAt: date(row.product.archivedAt),
      brand: {
        ...row.product.brand,
        createdAt: new Date(row.product.brand.createdAt),
      },
    };
    if (!isEligibleProduct(product, input.asOf) || !usableProductImage(product))
      return [];
    const file: File | undefined = product.media.find(
      (media) => media.file.id === row.matchingFileId,
    )?.file;
    if (!file) return [];
    const price = resolveProductPrice(product, input.asOf);
    if (!price || price.effectivePrice.lte(0)) return [];
    if (ordered.amount && !ordered.amount.equals(price.effectivePrice))
      throw new ServiceUnavailableException({
        code: 'CATALOGUE_PRICE_CONTEXT_CHANGED',
        message: 'Prices updated. Refresh this list.',
      });
    const instant = input.asOf.getTime();
    return [
      Object.freeze({
        product,
        file,
        logoFileId: row.logoFileId,
        tags: Object.freeze([...row.tags]),
        get asOf() {
          return new Date(instant);
        },
      }),
    ];
  });
}
