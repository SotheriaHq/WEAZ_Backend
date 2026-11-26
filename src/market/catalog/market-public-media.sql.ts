import { Prisma } from '@prisma/client';
import { eligibleProductSql } from '../eligibility/market-eligibility';
import { marketPlan } from './market-read-plans';

/** A product's captured cover or gallery file, at its captured asset version. */
export interface MarketMediaCover {
  readonly fileId: string;
  readonly assetVersion: number;
  readonly productId: string;
}
/** A brand owner's profile logo; `brandId` also requires that store to be open. */
export interface MarketMediaLogo {
  readonly fileId: string;
  readonly ownerId: string;
  readonly brandId?: string;
}
export interface MarketMediaCandidates {
  readonly asOf: Date;
  readonly covers: readonly MarketMediaCover[];
  readonly logos: readonly MarketMediaLogo[];
  /** Files whose parent authority is proven entirely by the guard rows. */
  readonly guardedFileIds: readonly string[];
  /** Server-owned parent revalidation, evaluated in the same snapshot. */
  readonly guard: Prisma.Sql | null;
  /** The guard's text does not depend on user filters, so its plan is reused. */
  readonly reusablePlan?: boolean;
}
export interface MarketMediaFileRow {
  readonly id: string;
  readonly s3Key: string;
  readonly assetVersion: number;
  /** Products that currently prove this exact file version, and its owners. */
  readonly productIds: readonly string[];
  readonly ownerIds: readonly string[];
}
export interface MarketMediaVariantRow {
  readonly fileUploadId: string;
  readonly s3Key: string;
  readonly variantKind: string;
  readonly format: string;
}
export interface MarketMediaAuthorityRow {
  readonly guard: readonly unknown[];
  readonly files: readonly MarketMediaFileRow[];
  readonly variants: readonly MarketMediaVariantRow[];
}

/**
 * Parent revalidation, current files and their variants in one statement, so
 * all three share one snapshot and cost one round trip. A file row names every
 * product and owner that proves it: the caller grants a file only for a parent
 * that the guard also returned, never because some other row uses that file.
 * Lists travel as single parameters, so the text does not grow with the page.
 */
export function marketMediaAuthoritySql(
  input: MarketMediaCandidates,
  maxFiles: number,
): Prisma.Sql {
  const ids = [
    ...new Set([
      ...input.covers.map((cover) => cover.fileId),
      ...input.logos.map((logo) => logo.fileId),
      ...input.guardedFileIds,
    ]),
  ];
  const covers = input.covers.length
    ? Prisma.sql`SELECT cover."fileId",cover."assetVersion",cover."productId"
        FROM jsonb_to_recordset(${JSON.stringify(input.covers.map(({ fileId, assetVersion, productId }) => ({ fileId, assetVersion, productId })))}::jsonb) AS cover("fileId" uuid,"assetVersion" int,"productId" uuid)
        JOIN "ProductMedia" media ON media."productId"=cover."productId" AND media."fileUploadId"=cover."fileId" AND media."reviewStatus"='APPROVED'
        JOIN "Product" p ON p."_id"=cover."productId"
        WHERE (${eligibleProductSql(input.asOf, 'p')})`
    : Prisma.sql`SELECT NULL::uuid AS "fileId",NULL::int AS "assetVersion",NULL::uuid AS "productId" WHERE false`;
  const ownerIds = input.logos.length
    ? Prisma.sql`ARRAY(SELECT DISTINCT logo."ownerId"::text
        FROM jsonb_to_recordset(${JSON.stringify(input.logos.map(({ fileId, ownerId, brandId }) => ({ fileId, ownerId, brandId: brandId ?? null })))}::jsonb) AS logo("fileId" uuid,"ownerId" uuid,"brandId" uuid)
        JOIN "UserProfile" profile ON profile."profileImageId"=logo."fileId" AND profile."userId"=logo."ownerId"
        JOIN "User" owner ON owner."_id"=logo."ownerId" AND owner.status='ACTIVE'
        WHERE logo."fileId"=file."_id" AND file."userId"=logo."ownerId" AND file."fileType"='PROFILE_IMAGE'
          AND (logo."brandId" IS NULL OR EXISTS(SELECT 1 FROM "Brand" brand WHERE brand."_id"=logo."brandId" AND brand."ownerId"=logo."ownerId" AND brand."isStoreOpen")))`
    : Prisma.sql`ARRAY[]::text[]`;
  const sql = Prisma.sql`WITH guard AS MATERIALIZED (${input.guard ?? Prisma.sql`SELECT NULL::text AS id WHERE false`}),
    covers AS MATERIALIZED (${covers}),
    files AS MATERIALIZED (SELECT file."_id" AS id,file."s3Key",file."assetVersion",
        ARRAY(SELECT DISTINCT cover."productId"::text FROM covers cover WHERE cover."fileId"=file."_id" AND cover."assetVersion"=file."assetVersion") AS "productIds",
        ${ownerIds} AS "ownerIds"
      FROM "FileUpload" file
      WHERE file."_id"=ANY(${ids}::uuid[])
        AND file."processingStatus"='READY' AND file."originalDeletedAt" IS NULL
        AND file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
      LIMIT ${maxFiles})
    SELECT COALESCE((SELECT jsonb_agg(to_jsonb(guard)) FROM guard),'[]'::jsonb) AS guard,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('id',files.id,'s3Key',files."s3Key",'assetVersion',files."assetVersion",'productIds',files."productIds",'ownerIds',files."ownerIds")) FROM files),'[]'::jsonb) AS files,
      COALESCE((SELECT jsonb_agg(jsonb_build_object('fileUploadId',variant."fileUploadId",'s3Key',variant."s3Key",'variantKind',variant."variantKind",'format',variant.format)
        ORDER BY variant."fileUploadId",variant."variantKind",CASE variant.format::text WHEN 'WEBP' THEN 0 WHEN 'AVIF' THEN 1 WHEN 'JPEG' THEN 2 ELSE 3 END,variant."_id")
        FROM files JOIN "FileVariant" variant ON variant."fileUploadId"=files.id AND variant."assetVersion"=files."assetVersion"
        WHERE variant."variantKind" IN ('CARD','AVATAR','BANNER')),'[]'::jsonb) AS variants`;
  return input.reusablePlan ? marketPlan('media', sql) : sql;
}
