import { Prisma, type PrismaClient } from '@prisma/client';
import {
  eligibleDesignWhere,
  eligibleProductWhere,
  usableProductImage,
} from 'src/market/eligibility/market-eligibility';
import type { FeaturedSummary } from './featured-summary.util';

/** Public fields and their visibility predicate are read in the same query. */
export async function loadPublicFeaturedSummaries(
  prisma: Pick<PrismaClient, '$transaction'>,
  items: readonly { id: string; entityType: string; entityId: string }[],
): Promise<Map<string, FeaturedSummary>> {
  const productIds = items
    .filter((item) => item.entityType === 'PRODUCT')
    .map((item) => item.entityId);
  const designIds = items
    .filter((item) => item.entityType === 'DESIGN')
    .map((item) => item.entityId);
  const file = {
    processingStatus: 'READY' as const,
    originalDeletedAt: null,
    s3Url: { not: '' },
  };
  // The parent and nested media reads share one snapshot even when Prisma
  // loads relations with separate statements. A later edit cannot attach new
  // private media to a previously authorized parent snapshot.
  return prisma.$transaction(
    async (tx) => {
      const products = productIds.length
        ? await tx.product.findMany({
            where: eligibleProductWhere(new Date(), [
              { id: { in: productIds } },
            ]),
            select: {
              id: true,
              name: true,
              thumbnail: true,
              images: true,
              price: true,
              salePrice: true,
              currency: true,
              viewsCount: true,
              threadsCount: true,
            },
          })
        : [];
      const designs = designIds.length
        ? await tx.collection.findMany({
            where: { ...eligibleDesignWhere(), id: { in: designIds } },
            select: {
              id: true,
              title: true,
              viewsCount: true,
              threadsCount: true,
              coverMedia: {
                select: {
                  file: {
                    select: {
                      s3Url: true,
                      processingStatus: true,
                      originalDeletedAt: true,
                    },
                  },
                },
              },
              medias: {
                where: { file },
                orderBy: { orderIndex: 'asc' },
                take: 1,
                select: { file: { select: { s3Url: true } } },
              },
            },
          })
        : [];
      const productMap = new Map(
        products.map((product) => [product.id, product] as const),
      );
      const designMap = new Map(
        designs.map((design) => [design.id, design] as const),
      );
      const result = new Map<string, FeaturedSummary>();
      for (const item of items) {
        const product =
          item.entityType === 'PRODUCT'
            ? productMap.get(item.entityId)
            : undefined;
        const design =
          item.entityType === 'DESIGN'
            ? designMap.get(item.entityId)
            : undefined;
        const cover = design?.coverMedia?.file;
        const thumbnail = product
          ? usableProductImage(product)
          : cover?.processingStatus === 'READY' &&
              cover.originalDeletedAt === null &&
              cover.s3Url?.trim()
            ? cover.s3Url
            : (design?.medias[0]?.file?.s3Url ?? null);
        if ((!product && !design) || !thumbnail?.trim()) continue;
        result.set(item.id, {
          id: item.id,
          entityName: product?.name ?? design?.title ?? 'Untitled design',
          entityThumbnail: thumbnail,
          entityPrice: product
            ? {
                price: new Prisma.Decimal(product.price).toString(),
                salePrice: product.salePrice?.toString() ?? null,
                currency: product.currency,
              }
            : null,
          viewsDelta: product?.viewsCount ?? design?.viewsCount ?? null,
          threadsDelta: product?.threadsCount ?? design?.threadsCount ?? null,
        });
      }
      return result;
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}
