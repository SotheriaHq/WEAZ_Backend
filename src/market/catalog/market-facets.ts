import { Prisma } from '@prisma/client';
import {
  marketFacetQueries,
  marketFacetStatementSql,
  MarketFacetsInput,
  MARKET_FACET_LIMITS,
} from './market-facets.sql';

export interface MarketFacetOption {
  readonly value: string;
  readonly label: string;
  readonly count: number;
  readonly disabled: boolean;
  readonly categoryId?: string;
}
export interface MarketFacetTruncation {
  readonly limit: number;
  readonly returned: number;
  readonly available: number;
}
export interface MarketFacetsResponse {
  categories?: MarketFacetOption[];
  categoryTypes?: MarketFacetOption[];
  brands?: MarketFacetOption[];
  tags?: MarketFacetOption[];
  colors?: MarketFacetOption[];
  sizes?: MarketFacetOption[];
  audience?: MarketFacetOption[];
  fulfilment?: MarketFacetOption[];
  onSale?: MarketFacetOption[];
  inStockOnly?: MarketFacetOption[];
  dimensions?: Record<
    string,
    { name: string; isMulti: boolean; values: MarketFacetOption[] }
  >;
  sizeSupport?: { customFitAnySize: true; customFitCount: number };
  price?: {
    currency: 'NGN';
    min: number;
    max: number;
    count: number;
    percentiles: { p30: number; p60: number; p85: number };
    bands: Array<{ min: number; max: number; count: number }>;
  };
  truncation?: Record<string, MarketFacetTruncation>;
}

interface FacetRow {
  key: string;
  value: string;
  label: string;
  count: string;
  selected: boolean;
  categoryId: string | null;
  name: string | null;
  isMulti: boolean | null;
  available: string;
  limit: number;
  keysAvailable?: string;
}
interface PriceRow {
  count: string;
  min: string | null;
  max: string | null;
  percentiles: number[] | null;
  bandMin: string | null;
  bandMax: string | null;
  bandCount: string;
}
const fields = {
  category: 'categories',
  type: 'categoryTypes',
  brand: 'brands',
  tag: 'tags',
  color: 'colors',
  size: 'sizes',
  audience: 'audience',
  fulfilment: 'fulfilment',
  onSale: 'onSale',
  inStockOnly: 'inStockOnly',
} as const;

function count(value: string): number {
  if (typeof value !== 'string' || !/^\d+$/.test(value))
    throw new RangeError('Invalid catalogue facet count');
  const result = Number(value);
  if (!Number.isSafeInteger(result))
    throw new RangeError('Catalogue facet count exceeds safe range');
  return result;
}
function amount(value: string | number | null): number {
  if (
    value === null ||
    (typeof value === 'string' && !/^\d+(?:\.\d+)?$/.test(value))
  )
    throw new RangeError('Invalid catalogue facet amount');
  const result = Number(value);
  if (!Number.isFinite(result) || result < 0 || result > 99999999.99)
    throw new RangeError('Invalid catalogue facet amount');
  return result;
}
function percentile(value: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new RangeError('Invalid catalogue price percentile');
  // PostgreSQL percentile_cont interpolates in float8; serialize money at the
  // catalogue's two-decimal precision rather than leaking binary artefacts.
  return amount(new Prisma.Decimal(value).toDecimalPlaces(2).toFixed(2));
}

/** The caller owns the transaction, dictionary validation and captured clock.
 * Failures propagate; an unavailable database never masquerades as zero data. */
export async function readMarketFacets(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  input: MarketFacetsInput,
): Promise<MarketFacetsResponse> {
  const response: MarketFacetsResponse = {};
  const queries = marketFacetQueries(input);
  const byKey = new Map<string, FacetRow[]>();
  let prices: PriceRow[] = [];
  // Grouped SQL scans stay independent, but only one database/network round
  // trip is needed. Limits remain inside each facet query before aggregation.
  const groups = await tx.$queryRaw<
    Array<{ group: number; rows: FacetRow[] | PriceRow[] }>
  >(
    marketFacetStatementSql(
      input,
      queries.map(
        (query, index) =>
          Prisma.sql`SELECT ${index}::int AS "group",COALESCE(jsonb_agg(to_jsonb(facet_row)),'[]'::jsonb) AS rows FROM (${query}) facet_row`,
      ),
    ),
  );
  if (
    groups.length !== queries.length ||
    new Set(groups.map((group) => group.group)).size !== queries.length ||
    groups.some(
      (group) =>
        !Number.isInteger(group.group) ||
        group.group < 0 ||
        group.group >= queries.length ||
        !Array.isArray(group.rows),
    )
  )
    throw new RangeError('Incomplete catalogue facets');
  for (const group of groups) {
    if (group.group === 6) prices = group.rows as PriceRow[];
    else {
      const rows = group.rows as FacetRow[];
      for (const row of rows) {
        const list = byKey.get(row.key) ?? [];
        list.push(row);
        byKey.set(row.key, list);
      }
    }
  }
  let dimensionsAvailable = 0;
  for (const [key, rows] of byKey) {
    if (key === 'sizeCustomFit') {
      const customFitCount = count(rows[0].count);
      if (customFitCount)
        response.sizeSupport = { customFitAnySize: true, customFitCount };
      continue;
    }
    const options = rows.map((row) => ({
      value: row.value,
      label: row.label,
      count: count(row.count),
      disabled: count(row.count) === 0,
      ...(row.categoryId ? { categoryId: row.categoryId } : {}),
    }));
    // Defensive guard also keeps a whole-zero mocked/corrupt group out of JSON.
    if (!options.some((option) => option.count > 0)) continue;
    if (key.startsWith('dim.')) {
      const slug = key.slice(4);
      if (
        !/^[a-z0-9][a-z0-9-]{0,79}$/.test(slug) ||
        !rows[0].name ||
        typeof rows[0].isMulti !== 'boolean'
      )
        throw new RangeError('Invalid catalogue facet dimension');
      response.dimensions ??= Object.create(null) as NonNullable<
        MarketFacetsResponse['dimensions']
      >;
      response.dimensions[slug] = {
        name: rows[0].name,
        isMulti: rows[0].isMulti,
        values: options,
      };
      dimensionsAvailable = Math.max(
        dimensionsAvailable,
        count(rows[0].keysAvailable ?? '0'),
      );
    } else if (Object.prototype.hasOwnProperty.call(fields, key)) {
      response[fields[key as keyof typeof fields]] = options;
    } else throw new RangeError('Invalid catalogue facet key');
    const available = count(rows[0].available);
    if (available > rows.length) {
      response.truncation ??= Object.create(null) as NonNullable<
        MarketFacetsResponse['truncation']
      >;
      response.truncation[key] = {
        limit: rows[0].limit,
        returned: rows.length,
        available,
      };
    }
  }
  const dimensionsReturned = Object.keys(response.dimensions ?? {}).length;
  if (dimensionsAvailable > dimensionsReturned) {
    response.truncation ??= Object.create(null) as NonNullable<
      MarketFacetsResponse['truncation']
    >;
    response.truncation.dimensions = {
      limit: MARKET_FACET_LIMITS.dimensions,
      returned: dimensionsReturned,
      available: dimensionsAvailable,
    };
  }
  if (prices.length && count(prices[0].count) > 0) {
    const first = prices[0];
    if (!Array.isArray(first.percentiles) || first.percentiles.length !== 3)
      throw new RangeError('Invalid catalogue price percentiles');
    response.price = {
      currency: 'NGN',
      min: amount(first.min),
      max: amount(first.max),
      count: count(first.count),
      percentiles: {
        p30: percentile(first.percentiles[0]),
        p60: percentile(first.percentiles[1]),
        p85: percentile(first.percentiles[2]),
      },
      bands: prices
        .filter((row) => count(row.bandCount) > 0)
        .map((row) => ({
          min: amount(row.bandMin),
          max: amount(row.bandMax),
          count: count(row.bandCount),
        })),
    };
  }
  return response;
}

export type { MarketFacetsInput } from './market-facets.sql';
