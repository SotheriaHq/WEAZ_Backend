import { Prisma, type PrismaClient } from '@prisma/client';

export type DisplayVariantRow = { fileUploadId: string; s3Key: string; s3Url: string; format: string };

/** Access is checked by the original-file caller; only the active asset version is hydrated. */
export async function loadActiveDisplayVariants(prisma: Pick<PrismaClient, '$queryRaw'>, ids: readonly string[], kind: string): Promise<DisplayVariantRow[]> {
  const unique = [...new Set(ids)];
  const rows: DisplayVariantRow[] = [];
  for (let offset = 0; offset < unique.length; offset += 500) {
    rows.push(...await prisma.$queryRaw<DisplayVariantRow[]>(Prisma.sql`
      SELECT variant."fileUploadId", variant."s3Key", variant."s3Url", variant.format
      FROM unnest(${unique.slice(offset, offset + 500)}::uuid[]) requested(id)
      JOIN "FileUpload" file ON file."_id"=requested.id
      JOIN "FileVariant" variant ON variant."fileUploadId"=file."_id" AND variant."assetVersion"=file."assetVersion"
      WHERE variant."variantKind"=${kind}::"ImageVariantKind"
    `));
  }
  return rows;
}
