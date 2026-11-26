import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';
import { marketProductFiltersSql } from './market-filter.sql';

const fields = {
  audience: 'audience',
  category: 'categoryIds',
  type: 'categoryTypeIds',
  brand: 'brandIds',
  tag: 'tags',
  color: 'colors',
  size: 'sizes',
  price: 'price',
  onSale: 'onSale',
  fulfilment: 'fulfilment',
  inStockOnly: 'inStockOnly',
} as const;
export type MarketFacetKey = keyof typeof fields | `dim.${string}`;

/** Standard disjunctive faceting removes only this selected facet's key. */
export function filtersForMarketFacet(
  filters: CanonicalMarketFilters,
  facet: MarketFacetKey,
): CanonicalMarketFilters {
  const result = { ...filters };
  if (Object.prototype.hasOwnProperty.call(fields, facet)) {
    delete result[fields[facet as keyof typeof fields]];
  } else if (/^dim\.[a-z0-9][a-z0-9-]{0,79}$/.test(facet)) {
    const dimension = facet.slice(4);
    const remaining = Object.entries(filters.dimensions ?? {}).filter(
      ([key]) => key !== dimension,
    );
    if (remaining.length)
      result.dimensions = Object.freeze(Object.fromEntries(remaining));
    else delete result.dimensions;
  } else {
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: 'Choose a supported catalogue facet.',
    });
  }
  return Object.freeze(result);
}

/** A section's server-owned constraints survive the user's disjunctive count. */
export function marketFacetProductSql(
  filters: CanonicalMarketFilters,
  facet: MarketFacetKey,
  now: Date,
  fixedFilters: CanonicalMarketFilters = {},
): Prisma.Sql {
  return marketProductFiltersSql(
    [filtersForMarketFacet(filters, facet), fixedFilters],
    now,
  );
}
