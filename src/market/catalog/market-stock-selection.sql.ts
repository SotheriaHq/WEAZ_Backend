import { Prisma } from '@prisma/client';
import { CanonicalMarketFilters } from './market-filters';
import { normalizeTokenSql } from '../../common/utils/sql-text-normalization';

const aliases = { p: Prisma.sql`p`, mp: Prisma.sql`mp` } as const;

/** Internal SQL expressions only; these never come from request parameters. */
export interface MarketStockCandidate {
  readonly color?: Prisma.Sql;
  readonly size?: Prisma.Sql;
  readonly channel?: 'ANY' | 'STOCK' | 'CUSTOM';
}

/** All fixed/user selections describe one SKU, not one SKU per predicate. */
export function marketStockSelectionSql(
  layers: readonly CanonicalMarketFilters[],
  alias: keyof typeof aliases = 'p',
  candidate: MarketStockCandidate = {},
): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(aliases, alias))
    throw new RangeError('Unsupported stock-selection alias');
  const p = aliases[alias];
  const colorLists = layers.flatMap((filters) =>
    filters.colors?.length ? [filters.colors] : [],
  );
  const sizeLists = layers.flatMap((filters) =>
    filters.sizes?.length ? [filters.sizes] : [],
  );
  const channel = candidate.channel ?? 'ANY';
  if (!['ANY', 'STOCK', 'CUSTOM'].includes(channel))
    throw new RangeError('Unsupported stock-selection channel');
  const hasColor = colorLists.length > 0 || candidate.color !== undefined;
  const hasSize = sizeLists.length > 0 || candidate.size !== undefined;
  if (!hasColor && !hasSize && channel === 'ANY') return Prisma.sql`true`;
  const colorPredicates = (value: Prisma.Sql) =>
    Prisma.join(
      [
        ...colorLists.map(
          (colors) => Prisma.sql`
    lower(${normalizeTokenSql(value)}) IN (
      ${Prisma.join(colors.map((color) => Prisma.sql`lower(${normalizeTokenSql(Prisma.sql`${color}::text`)})`))}
    )`,
        ),
        ...(candidate.color
          ? [
              Prisma.sql`lower(${normalizeTokenSql(value)}) = lower(${normalizeTokenSql(candidate.color)})`,
            ]
          : []),
      ],
      ' AND ',
    );
  const sizePredicates = (value: Prisma.Sql) =>
    Prisma.join(
      [
        ...sizeLists.map(
          (sizes) => Prisma.sql`
    ${normalizeTokenSql(value)} IN (${Prisma.join(sizes.map((size) => normalizeTokenSql(Prisma.sql`${size}::text`)))})`,
        ),
        ...(candidate.size
          ? [
              Prisma.sql`${normalizeTokenSql(value)} = ${normalizeTokenSql(candidate.size)}`,
            ]
          : []),
      ],
      ' AND ',
    );
  const productColor = hasColor
    ? Prisma.sql`EXISTS (
    SELECT 1 FROM unnest(${p}.colors) filter_color WHERE ${colorPredicates(Prisma.sql`filter_color`)}
  )`
    : Prisma.sql`true`;
  const variantColor = hasColor
    ? Prisma.sql`AND ${colorPredicates(Prisma.sql`filter_variant.color`)}`
    : Prisma.empty;
  const variantSize = hasSize
    ? Prisma.sql`AND ${sizePredicates(Prisma.sql`filter_variant.size`)}`
    : Prisma.empty;
  const productSize = hasSize
    ? Prisma.sql`EXISTS (
    SELECT 1 FROM jsonb_each(CASE WHEN jsonb_typeof(${p}."sizeStock"::jsonb)='object'
      THEN ${p}."sizeStock"::jsonb ELSE '{}'::jsonb END) stock_size
    WHERE ${sizePredicates(Prisma.sql`stock_size.key`)}
      AND CASE WHEN jsonb_typeof(stock_size.value)='number'
        THEN (stock_size.value #>> '{}')::numeric BETWEEN 1 AND 2147483647
          AND trunc((stock_size.value #>> '{}')::numeric)=(stock_size.value #>> '{}')::numeric
        ELSE false END
  )`
    : Prisma.sql`true`;
  const variant = Prisma.sql`EXISTS (
    SELECT 1 FROM "ProductVariant" filter_variant
    WHERE filter_variant."productId"=${p}."_id" AND filter_variant.stock>0 ${variantColor} ${variantSize}
  )`;
  const aggregate = Prisma.sql`NOT EXISTS (SELECT 1 FROM "ProductVariant" any_variant
    WHERE any_variant."productId"=${p}."_id") AND ${productColor} AND ${productSize}`;
  const permitsCustom = layers.every(
    (filters) => filters.fulfilment !== 'READY_TO_WEAR' && !filters.inStockOnly,
  );
  const custom = permitsCustom
    ? Prisma.sql`(${p}."customOrderEnabled"=true AND ${productColor})`
    : Prisma.sql`false`;
  if (channel === 'CUSTOM') return custom;
  if (channel === 'STOCK') return Prisma.sql`(${variant} OR (${aggregate}))`;
  return Prisma.sql`(${custom} OR ${variant} OR (${aggregate}))`;
}
