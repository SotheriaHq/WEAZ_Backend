import { Prisma, type PrismaClient } from '@prisma/client';

export type FeaturedSummary = {
  id: string;
  entityName: string;
  entityThumbnail: string | null;
  entityPrice: { price: string; salePrice: string | null; currency: string } | null;
  viewsDelta: number | null;
  threadsDelta: number | null;
};

/** Hydrate only the already-authorized page; LEFT JOINs retain deleted targets. */
export async function loadFeaturedSummaries(
  prisma: Pick<PrismaClient, '$queryRaw'>,
  items: readonly { id: string; entityType: string; entityId: string }[],
): Promise<Map<string, FeaturedSummary>> {
  const unique = [...new Map(items.map((item) => [item.id, item])).values()];
  const result = new Map<string, FeaturedSummary>();
  for (let offset = 0; offset < unique.length; offset += 500) {
    const rows = await prisma.$queryRaw<FeaturedSummary[]>(Prisma.sql`
      SELECT featured."_id" AS id,
        CASE featured."entityType"
          WHEN 'PRODUCT' THEN COALESCE(product.name, 'Deleted product')
          WHEN 'DESIGN' THEN COALESCE(design.title, 'Deleted design')
          ELSE 'Unknown' END AS "entityName",
        CASE featured."entityType"
          WHEN 'PRODUCT' THEN COALESCE(NULLIF(product.thumbnail, ''), product.images[1])
          WHEN 'DESIGN' THEN cover_file."s3Url" END AS "entityThumbnail",
        CASE WHEN product."_id" IS NOT NULL THEN json_build_object(
          'price', product.price::text, 'salePrice', product."salePrice"::text,
          'currency', product.currency) END AS "entityPrice",
        COALESCE(product."viewsCount", design."viewsCount") AS "viewsDelta",
        COALESCE(product."likesCount", design."likesCount") AS "threadsDelta"
      FROM unnest(
        ${unique.slice(offset, offset + 500).map((item) => item.id)}::uuid[],
        ${unique.slice(offset, offset + 500).map((item) => item.entityType)}::text[],
        ${unique.slice(offset, offset + 500).map((item) => item.entityId)}::uuid[]
      ) AS featured("_id", "entityType", "entityId")
      LEFT JOIN "Product" product ON featured."entityType" = 'PRODUCT'
        AND product."_id" = featured."entityId"
      LEFT JOIN "Collection" design ON featured."entityType" = 'DESIGN'
        AND design."_id" = featured."entityId"
      LEFT JOIN "CollectionMedia" cover ON cover."_id" = design."coverMediaId"
      LEFT JOIN "FileUpload" cover_file ON cover_file."_id" = cover."fileUploadId"
    `);
    for (const row of rows) {
      // Prisma Decimal.toString() does not retain insignificant trailing zeroes.
      if (row.entityPrice) {
        row.entityPrice.price = new Prisma.Decimal(row.entityPrice.price).toString();
        if (row.entityPrice.salePrice !== null) {
          row.entityPrice.salePrice = new Prisma.Decimal(row.entityPrice.salePrice).toString();
        }
      }
      result.set(row.id, row);
    }
  }
  return result;
}
