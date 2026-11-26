import { BadRequestException } from '@nestjs/common';
import { CanonicalMarketFilters, parseMarketFilters } from './market-filters';
import {
  MARKET_CURSOR_MAX_LENGTH,
  MARKET_SORTS,
  MarketSort,
} from './market-cursor';

export interface MarketCatalogRequest {
  readonly filters: CanonicalMarketFilters;
  readonly sort?: Exclude<MarketSort, 'relevance'>;
  readonly limit: number;
  readonly cursor?: string;
  readonly includeFacets: boolean;
}
const controls = new Set(['sort', 'limit', 'cursor', 'includeFacets']);
function invalid(
  code: 'INVALID_FILTER' | 'INVALID_CURSOR' | 'UNSUPPORTED_SORT',
  message: string,
): never {
  throw new BadRequestException({ code, message });
}

/** Validate the entire boundary; never strip unknown keys before filter parsing. */
export function parseMarketCatalogRequest(
  query: URLSearchParams,
): MarketCatalogRequest {
  if (query.toString().length > 16384)
    invalid('INVALID_FILTER', 'The catalogue request is too large.');
  const filters = new URLSearchParams();
  const options = new Map<string, string>();
  for (const [key, value] of query) {
    if (!controls.has(key)) {
      filters.append(key, value);
      continue;
    }
    if (options.has(key))
      invalid('INVALID_FILTER', 'Do not repeat catalogue controls.');
    options.set(key, value);
  }
  const sort = options.get('sort');
  if (
    sort !== undefined &&
    (sort === 'relevance' || !MARKET_SORTS.includes(sort as MarketSort))
  )
    invalid('UNSUPPORTED_SORT', 'Choose an available catalogue sort.');
  const limit = options.get('limit');
  if (
    limit !== undefined &&
    (!/^[1-9][0-9]?$/.test(limit) || Number(limit) > 60)
  )
    invalid('INVALID_FILTER', 'Request between 1 and 60 catalogue items.');
  const cursor = options.get('cursor');
  if (
    cursor !== undefined &&
    (!cursor ||
      cursor.length > MARKET_CURSOR_MAX_LENGTH ||
      !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(cursor))
  )
    invalid('INVALID_CURSOR', 'Refresh this list to continue.');
  const includeFacets = options.get('includeFacets');
  if (
    includeFacets !== undefined &&
    includeFacets !== '0' &&
    includeFacets !== '1'
  )
    invalid('INVALID_FILTER', 'Use a valid includeFacets toggle.');
  return Object.freeze({
    filters: parseMarketFilters(filters),
    ...(sort === undefined
      ? {}
      : { sort: sort as Exclude<MarketSort, 'relevance'> }),
    limit: limit === undefined ? 20 : Number(limit),
    ...(cursor === undefined ? {} : { cursor }),
    includeFacets: includeFacets === '1',
  });
}
