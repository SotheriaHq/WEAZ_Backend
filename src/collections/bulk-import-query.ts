import { ConflictException, NotFoundException } from '@nestjs/common';
import { CollectionStatus, Prisma } from '@prisma/client';

export const BULK_IMPORT_BATCH_SIZE = 25;
export const BULK_IMPORT_LEASE_SECONDS = 300;
type QueryClient = Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>;
export interface BulkImportCheckpoint {
  jobId: string;
  rowId: string;
  token: string;
}

export interface BulkProductTaxonomy {
  requestedCategoryId: string | null;
  requestedCategoryTypeId: string | null;
  collectionId: string | null;
  ownerId: string | null;
  deletedAt: Date | null;
  categoryId: string | null;
  categoryActive: boolean | null;
  categoryTypeId: string | null;
  categoryTypeActive: boolean | null;
  categoryTypeParentId: string | null;
}

/** Called after the collection lock; no taxonomy snapshot is shared across import rows. */
export async function loadBulkProductTaxonomy(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  collectionId: string | null,
  categoryId: string | null | undefined,
  categoryTypeId: string | null | undefined,
): Promise<BulkProductTaxonomy> {
  const requestedCategoryId = categoryId?.trim() || null;
  const requestedCategoryTypeId = categoryTypeId?.trim() || null;
  const rows = await tx.$queryRaw<
    Array<
      Omit<
        BulkProductTaxonomy,
        'requestedCategoryId' | 'requestedCategoryTypeId'
      >
    >
  >(Prisma.sql`
    SELECT c."_id" AS "collectionId", c."ownerId", c."deletedAt",
      category."_id" AS "categoryId", category."isActive" AS "categoryActive",
      subtype."_id" AS "categoryTypeId", subtype."isActive" AS "categoryTypeActive",
      subtype."categoryId" AS "categoryTypeParentId"
    FROM (VALUES (1)) anchor(value)
    LEFT JOIN "StoreCollection" c ON c."_id" = ${collectionId}::uuid
    LEFT JOIN "CollectionCategory" category ON category."_id" = ${requestedCategoryId}::uuid
    LEFT JOIN "CollectionCategoryType" subtype ON subtype."_id" = ${requestedCategoryTypeId}::uuid
  `);
  if (!rows[0]) throw new Error('Product taxonomy projection unavailable');
  return { ...rows[0], requestedCategoryId, requestedCategoryTypeId };
}

/** Choose the first free slug from a server-normalized base, returning one row. */
export async function loadBulkProductSlug(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  base: string,
): Promise<string> {
  // Preserve base, base-2, base-3... selection without returning every matching
  // product slug to the importer. The unique index still arbitrates insert races.
  const pattern = `${base.replace(/[\\%_]/g, '\\$&')}-%`;
  const rows = await db.$queryRaw<Array<{ slug: string }>>(Prisma.sql`
    WITH used AS MATERIALIZED (
      SELECT slug FROM "Product" WHERE slug = ${base} OR slug LIKE ${pattern}
    ), candidates AS (
      SELECT 0::numeric AS ordinal, ${base}::text AS slug
      UNION ALL SELECT 2::numeric, ${base + '-2'}::text
      UNION ALL
      SELECT substring(slug FROM ${base.length + 2}::int)::numeric + 1,
        ${base + '-'}::text || (substring(slug FROM ${base.length + 2}::int)::numeric + 1)::text
      FROM used WHERE slug ~ ${'^' + base + '-[0-9]+$'}
    )
    SELECT candidate.slug FROM candidates candidate
    LEFT JOIN used ON used.slug = candidate.slug WHERE used.slug IS NULL
    ORDER BY candidate.ordinal LIMIT 1
  `);
  if (!rows[0]?.slug) throw new Error('Product slug unavailable');
  return rows[0].slug;
}

/** Only the persisted fields consumed by canonical post-commit import work. */
export interface BulkImportProductProjection {
  id: string;
  brandId: string;
  name: string;
  tags: string[];
  isActive: boolean;
  publicationStatus: CollectionStatus;
  publishAt: Date | null;
  deletedAt: Date | null;
  archivedAt: Date | null;
  collections: Array<{ collectionId: string; orderIndex: number }>;
  latestSubmissionId: string | null;
}

/** One row per product; lateral aggregates cannot multiply memberships/submissions. */
export async function loadBulkImportProduct(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  productId: string,
): Promise<BulkImportProductProjection | null> {
  const rows = await db.$queryRaw<BulkImportProductProjection[]>(Prisma.sql`
    SELECT p."_id" AS id, p."brandId", p.name, p.tags, p."isActive",
      p."publicationStatus", p."publishAt", p."deletedAt", p."archivedAt",
      COALESCE(memberships.links, '[]'::jsonb) AS collections,
      submission."_id" AS "latestSubmissionId"
    FROM "Product" p
    LEFT JOIN LATERAL (
      SELECT jsonb_agg(jsonb_build_object('collectionId', link."collectionId", 'orderIndex', link."orderIndex")
        ORDER BY link."collectionId") AS links
      FROM "StoreCollectionProduct" link WHERE link."productId" = p."_id"
    ) memberships ON TRUE
    LEFT JOIN LATERAL (
      SELECT s."_id" FROM "ContentSubmission" s WHERE s."productId" = p."_id"
      ORDER BY s."submittedAt" DESC, s."_id" DESC LIMIT 1
    ) submission ON TRUE
    WHERE p."_id" = ${productId}::uuid
  `);
  return rows[0] ?? null;
}

export async function claimBulkImport(
  db: QueryClient,
  jobId: string,
  token: string,
) {
  const rows = await db.$queryRaw<
    Array<{ id: string; collectionId: string; ownerId: string }>
  >(Prisma.sql`
    UPDATE "CollectionBulkUploadJob" SET status = 'PROCESSING', "processingToken" = ${token}::uuid,
      "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${BULK_IMPORT_LEASE_SECONDS}),
      "completedAt" = NULL, "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "_id" = ${jobId}::uuid AND ("processingToken" IS NULL OR "leaseExpiresAt" <= (clock_timestamp() AT TIME ZONE 'UTC'))
    RETURNING "_id" AS id, "collectionId", "ownerId"
  `);
  if (rows[0]) return rows[0];
  const existing = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "_id" AS id FROM "CollectionBulkUploadJob" WHERE "_id" = ${jobId}::uuid`,
  );
  if (!existing.length)
    throw new NotFoundException('Bulk upload job not found');
  throw new ConflictException(
    'This import is already processing. Retry after its worker finishes or recovers.',
  );
}

export async function renewBulkImport(
  db: QueryClient,
  jobId: string,
  token: string,
) {
  const changed = await db.$executeRaw(Prisma.sql`
    UPDATE "CollectionBulkUploadJob" SET "leaseExpiresAt" = (clock_timestamp() AT TIME ZONE 'UTC') + make_interval(secs => ${BULK_IMPORT_LEASE_SECONDS}),
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    WHERE "_id" = ${jobId}::uuid AND "processingToken" = ${token}::uuid
      AND "leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
  `);
  if (!changed)
    throw new ConflictException(
      'Import processing lease expired. Retry to resume saved progress.',
    );
}

/** Lock the job before the row. Recheck the lease using a fresh statement after any lock wait. */
export async function lockBulkImportCheckpoint(
  tx: Prisma.TransactionClient,
  checkpoint: BulkImportCheckpoint,
) {
  const jobs = await tx.$queryRaw<
    Array<{ collectionId: string; ownerId: string }>
  >(
    Prisma.sql`SELECT "collectionId", "ownerId" FROM "CollectionBulkUploadJob" WHERE "_id" = ${checkpoint.jobId}::uuid FOR UPDATE`,
  );
  await renewBulkImport(tx, checkpoint.jobId, checkpoint.token);
  const rows = await tx.$queryRaw<
    Array<{ createdProductId: string | null; productCreatedAt: Date | null }>
  >(Prisma.sql`
    SELECT "createdProductId", "productCreatedAt" FROM "CollectionBulkUploadRow"
    WHERE "_id" = ${checkpoint.rowId}::uuid AND "jobId" = ${checkpoint.jobId}::uuid FOR UPDATE
  `);
  if (!rows[0]) throw new NotFoundException('Import row not found');
  return { ...rows[0], ...jobs[0] };
}

/** One aggregate statement; retain errors from earlier attempts and count only terminal rows. */
export async function finishBulkImport(
  db: QueryClient,
  jobId: string,
  token: string,
) {
  const rows = await db.$queryRaw<
    Array<{
      totalRows: number;
      processedRows: number;
      successRows: number;
      failedRows: number;
      status: string;
      errors: unknown;
    }>
  >(Prisma.sql`
    WITH counts AS (
      SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success,
        COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
        COUNT(*) FILTER (WHERE status IN ('SUCCESS', 'FAILED', 'SKIPPED'))::int AS processed,
        COALESCE(jsonb_agg(jsonb_build_object('row', "rowIndex", 'field', 'row', 'message', "errorMessage") ORDER BY "rowIndex") FILTER (WHERE status = 'FAILED'), '[]'::jsonb) AS errors
      FROM "CollectionBulkUploadRow" WHERE "jobId" = ${jobId}::uuid
    )
    UPDATE "CollectionBulkUploadJob" j SET "totalRows" = c.total, "processedRows" = c.processed,
      "successRows" = c.success, "failedRows" = c.failed, "errorSummary" = c.errors,
      status = (CASE WHEN c.processed < c.total THEN 'PENDING' WHEN c.failed = 0 THEN 'COMPLETED' WHEN c.success > 0 THEN 'PARTIAL' ELSE 'FAILED' END)::"BulkUploadStatus",
      "processingToken" = NULL, "leaseExpiresAt" = NULL, "completedAt" = CASE WHEN c.processed = c.total THEN (clock_timestamp() AT TIME ZONE 'UTC') ELSE NULL END,
      "updatedAt" = (clock_timestamp() AT TIME ZONE 'UTC')
    FROM counts c WHERE j."_id" = ${jobId}::uuid AND j."processingToken" = ${token}::uuid
      AND j."leaseExpiresAt" > (clock_timestamp() AT TIME ZONE 'UTC')
    RETURNING j."totalRows", j."processedRows", j."successRows", j."failedRows", j.status::text, j."errorSummary" AS errors
  `);
  if (!rows[0])
    throw new ConflictException(
      'Import lease changed before completion. Retry to resume saved progress.',
    );
  return { jobId, ...rows[0], status: rows[0].status.toLowerCase() };
}
