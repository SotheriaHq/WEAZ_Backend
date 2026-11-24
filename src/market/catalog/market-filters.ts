import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TAG_CONFIG } from '../../common/utils/tag-validator';

export type MarketAudience = 'MEN' | 'WOMEN' | 'UNISEX';
export type MarketFulfilment = 'READY_TO_WEAR' | 'MADE_TO_ORDER' | 'ANY';

export interface CanonicalMarketFilters {
  readonly audience?: readonly MarketAudience[];
  readonly categoryIds?: readonly string[];
  readonly categoryTypeIds?: readonly string[];
  readonly brandIds?: readonly string[];
  readonly tags?: readonly string[];
  readonly dimensions?: Readonly<Record<string, readonly string[]>>;
  readonly colors?: readonly string[];
  readonly sizes?: readonly string[];
  readonly price?: Readonly<{ min?: number; max?: number }>;
  readonly onSale?: boolean;
  readonly fulfilment?: MarketFulfilment;
  readonly inStockOnly?: boolean;
}

export const MARKET_FILTER_LIMITS = {
  valuesPerKey: 8,
  valuesTotal: 24,
  keys: 32,
  encodedBytes: 8192,
  tokenCharacters: 120,
} as const;

const listFields = {
  audience: 'audience',
  category: 'categoryIds',
  type: 'categoryTypeIds',
  brand: 'brandIds',
  tag: 'tags',
  color: 'colors',
  size: 'sizes',
} as const;
const scalarKeys = new Set([
  'price.min',
  'price.max',
  'onSale',
  'fulfilment',
  'inStockOnly',
]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const slug = /^[a-z0-9][a-z0-9-]{0,79}$/;
const own = (value: object, key: string) =>
  Object.prototype.hasOwnProperty.call(value, key);

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalid(
  message = 'Review the selected filter values and try again.',
): never {
  throw new BadRequestException({ code: 'INVALID_FILTER', message });
}

function token(raw: string): string {
  if (/[\u0000-\u001f\u007f\ufffd]/u.test(raw)) invalid();
  const value = raw.normalize('NFKC').trim();
  if (!value || [...value].length > MARKET_FILTER_LIMITS.tokenCharacters)
    invalid();
  return value;
}

function listToken(kind: string, raw: string): string {
  const value = token(raw);
  if (kind === 'category' || kind === 'type' || kind === 'brand') {
    const id = value.toLowerCase();
    if (!uuid.test(id))
      invalid('Select valid category, garment-type and brand identifiers.');
    return id;
  }
  if (kind === 'audience') {
    const audience = value.toUpperCase();
    if (!['MEN', 'WOMEN', 'UNISEX'].includes(audience)) invalid();
    return audience;
  }
  if (kind === 'tag') {
    const name = value.replace(/^#+/, '').toLowerCase().replace(/\s+/g, '-');
    if (
      name.length < TAG_CONFIG.MIN_LENGTH ||
      name.length > TAG_CONFIG.MAX_LENGTH ||
      !TAG_CONFIG.REGEX.test(name)
    )
      invalid('Select a valid canonical tag.');
    return name;
  }
  if (kind === 'dimension') {
    const name = value.toLowerCase();
    if (!slug.test(name)) invalid('Select valid dimension values.');
    return name;
  }
  // Size labels retain their stored case. Unicode colour folding is performed
  // by the database on both operands, avoiding JS/database locale differences.
  return kind === 'color' && /^[\x00-\x7f]+$/.test(value)
    ? value.toLowerCase()
    : value;
}

function money(raw: string): number {
  if (!/^-?\d{1,8}(?:\.\d{1,2})?$/.test(raw))
    invalid('Use a valid nonnegative NGN price with at most two decimals.');
  const amount = new Prisma.Decimal(raw);
  if (!amount.isFinite() || amount.lt(0) || amount.gt('99999999.99')) invalid();
  return amount.eq(0) ? 0 : amount.toNumber();
}

function toggle(raw: string): boolean {
  if (raw === '1' || raw === 'true') return true;
  if (raw === '0' || raw === 'false') return false;
  return invalid('Use a valid filter toggle.');
}

/** Only filter parameters belong here; the HTTP boundary validates controls separately. */
export function parseMarketFilters(
  params: URLSearchParams,
): CanonicalMarketFilters {
  let pairs = 0;
  for (const [key, value] of params) {
    if (++pairs > 64 || key.length > 96 || value.length > 2048)
      invalid('The filter request is too large.');
  }
  if (params.toString().length > MARKET_FILTER_LIMITS.encodedBytes)
    invalid('The filter request is too large.');
  const keys = [...new Set(params.keys())];
  if (keys.length > MARKET_FILTER_LIMITS.keys)
    invalid('Use fewer filter keys.');
  const result: {
    -readonly [K in keyof CanonicalMarketFilters]: CanonicalMarketFilters[K];
  } = {};
  const dimensions = new Map<string, readonly string[]>();
  const price: { min?: number; max?: number } = {};
  let total = 0;
  const consume = (count: number) => {
    total += count;
    if (total > MARKET_FILTER_LIMITS.valuesTotal)
      invalid('Use at most 24 filter values.');
  };

  for (const key of keys) {
    const bracket = key.endsWith('[]');
    const base = bracket ? key.slice(0, -2) : key;
    const dimension = base.startsWith('dim.') ? base.slice(4) : null;
    const isList = own(listFields, base) || dimension !== null;
    if (!isList && !scalarKeys.has(base))
      invalid('An unsupported filter key was supplied.');
    if (bracket && !isList) invalid();
    const submitted = params.getAll(key);
    if (!bracket && submitted.length !== 1)
      invalid('Do not repeat scalar or CSV filter keys.');
    if (isList) {
      if (params.has(bracket ? base : base + '[]'))
        invalid('Do not mix filter array encodings.');
      if (dimension !== null && !slug.test(dimension))
        invalid('Select a valid filter dimension.');
      const parts = bracket ? submitted : submitted[0].split(',');
      if (parts.length > MARKET_FILTER_LIMITS.valuesPerKey)
        invalid('Use at most 8 values per filter.');
      consume(parts.length);
      const values = Object.freeze(
        [
          ...new Set(
            parts.map((value) =>
              listToken(dimension !== null ? 'dimension' : base, value),
            ),
          ),
        ].sort(),
      );
      if (dimension !== null) dimensions.set(dimension, values);
      else if (base === 'audience')
        result.audience = values as readonly MarketAudience[];
      else
        result[
          listFields[base as Exclude<keyof typeof listFields, 'audience'>]
        ] = values;
      continue;
    }
    consume(1);
    const value = submitted[0];
    if (base === 'price.min') price.min = money(value);
    else if (base === 'price.max') price.max = money(value);
    else if (base === 'fulfilment') {
      const fulfilment = token(value).toUpperCase();
      if (!['READY_TO_WEAR', 'MADE_TO_ORDER', 'ANY'].includes(fulfilment))
        invalid();
      if (fulfilment !== 'ANY')
        result.fulfilment = fulfilment as MarketFulfilment;
    } else if (base === 'onSale' && toggle(value)) result.onSale = true;
    else if (base === 'inStockOnly' && toggle(value)) result.inStockOnly = true;
  }
  if (
    price.min !== undefined &&
    price.max !== undefined &&
    price.min > price.max
  )
    invalid('The minimum price must not exceed the maximum price.');
  if (price.min !== undefined || price.max !== undefined)
    result.price = Object.freeze(price);
  if (dimensions.size)
    result.dimensions = Object.freeze(
      Object.fromEntries(
        [...dimensions].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ),
    );
  return Object.freeze(result);
}

function encodeKnownFilters(filters: CanonicalMarketFilters): URLSearchParams {
  if (!plainRecord(filters)) invalid();
  const permitted = new Set([
    ...Object.values(listFields),
    'dimensions',
    'price',
    'onSale',
    'fulfilment',
    'inStockOnly',
  ]);
  if (Object.keys(filters).some((key) => !permitted.has(key))) invalid();
  const params = new URLSearchParams();
  const addList = (key: string, values: unknown) => {
    if (
      !Array.isArray(values) ||
      !values.length ||
      values.some((value) => typeof value !== 'string')
    )
      invalid();
    if (values.some((value) => value.includes(',')))
      for (const value of values) params.append(key + '[]', value);
    else params.set(key, values.join(','));
  };
  for (const [wire, field] of Object.entries(listFields)) {
    const values = filters[field];
    if (values !== undefined) addList(wire, values);
  }
  if (filters.dimensions !== undefined) {
    if (!plainRecord(filters.dimensions)) invalid();
    for (const key of Object.keys(filters.dimensions).sort())
      addList('dim.' + key, filters.dimensions[key]);
  }
  if (filters.price !== undefined) {
    if (
      !plainRecord(filters.price) ||
      Object.keys(filters.price).some((key) => key !== 'min' && key !== 'max')
    )
      invalid();
    for (const key of ['min', 'max'] as const)
      if (filters.price[key] !== undefined) {
        if (typeof filters.price[key] !== 'number') invalid();
        params.set('price.' + key, String(filters.price[key]));
      }
  }
  for (const key of ['onSale', 'inStockOnly'] as const)
    if (filters[key] !== undefined) {
      if (typeof filters[key] !== 'boolean') invalid();
      params.set(key, filters[key] ? '1' : '0');
    }
  if (filters.fulfilment !== undefined) {
    if (typeof filters.fulfilment !== 'string') invalid();
    params.set('fulfilment', filters.fulfilment);
  }
  return params;
}

export function encodeMarketFilters(
  filters: CanonicalMarketFilters,
): URLSearchParams {
  return encodeKnownFilters(parseMarketFilters(encodeKnownFilters(filters)));
}

export function marketFilterHash(filters: CanonicalMarketFilters): string {
  const canonical = parseMarketFilters(encodeMarketFilters(filters));
  return createHash('sha256')
    .update('market-filter:v1\n')
    .update(JSON.stringify(canonical))
    .digest('hex');
}
