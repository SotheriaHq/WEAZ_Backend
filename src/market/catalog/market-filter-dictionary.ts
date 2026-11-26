import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';

/** Use the request's transaction so validation and products see one dictionary. */
export async function validateMarketDimensions(
  tx: Pick<Prisma.TransactionClient, 'filterDimension'>,
  filters: CanonicalMarketFilters,
): Promise<void> {
  return validateMarketDimensionLayers(tx, [filters]);
}

export async function validateMarketDimensionLayers(
  tx: Pick<Prisma.TransactionClient, 'filterDimension'>,
  layers: readonly CanonicalMarketFilters[],
): Promise<void> {
  if (!Array.isArray(layers) || !layers.length || layers.length > 4)
    throw new RangeError('Invalid catalogue dimension scope');
  const entries: Array<[string, readonly string[]]> = layers.flatMap(
    (filters: CanonicalMarketFilters) =>
      Object.entries(filters.dimensions ?? {}),
  );
  if (!entries.length) return;
  const dimensions = await tx.filterDimension.findMany({
    where: {
      slug: { in: [...new Set(entries.map(([slug]) => slug))] },
      isActive: true,
      appliesTo: { has: 'PRODUCT' },
    },
    select: {
      slug: true,
      isMulti: true,
      values: {
        where: {
          isActive: true,
          slug: {
            in: [...new Set(entries.flatMap(([, values]) => [...values]))],
          },
        },
        select: { slug: true },
      },
    },
  });
  const bySlug = new Map(
    dimensions.map((dimension) => [dimension.slug, dimension]),
  );
  for (const [slug, selected] of entries) {
    const dimension = bySlug.get(slug);
    if (
      !dimension ||
      (!dimension.isMulti && selected.length > 1) ||
      selected.some(
        (value) => !dimension.values.some((row) => row.slug === value),
      )
    ) {
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message:
          'Select active product style details and their allowed values.',
      });
    }
  }
}
