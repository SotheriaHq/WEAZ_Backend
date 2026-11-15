import { Prisma } from '@prisma/client';

export interface ProductPriceInput {
  price: Prisma.Decimal.Value;
  salePrice?: Prisma.Decimal.Value | null;
  saleStartAt?: Date | string | null;
  saleEndAt?: Date | string | null;
}

export interface ResolvedProductPrice {
  price: Prisma.Decimal;
  effectivePrice: Prisma.Decimal;
  isOnSale: boolean;
  computedAt: Date;
  nextChangeAt: Date | null;
}

/** One captured clock and decimal arithmetic for display, writes and ordering. */
export function resolveProductPrice(
  input: ProductPriceInput,
  now = new Date(),
): ResolvedProductPrice | null {
  const time = now.getTime();
  if (!Number.isFinite(time)) throw new RangeError('Invalid price clock');
  let price: Prisma.Decimal;
  let sale: Prisma.Decimal | null = null;
  try {
    price = new Prisma.Decimal(input.price);
  } catch {
    return null;
  }
  if (!price.isFinite() || price.lt(0)) return null;
  if (input.salePrice !== null && input.salePrice !== undefined) {
    try {
      sale = new Prisma.Decimal(input.salePrice);
    } catch {
      // Malformed promotion metadata cannot change a valid catalogue price.
      sale = null;
    }
  }
  const start =
    input.saleStartAt === null || input.saleStartAt === undefined
      ? null
      : new Date(input.saleStartAt).getTime();
  const end =
    input.saleEndAt === null || input.saleEndAt === undefined
      ? null
      : new Date(input.saleEndAt).getTime();
  const validSale = Boolean(
    sale?.isFinite() &&
      sale.gt(0) &&
      sale.lt(price) &&
      (start === null || Number.isFinite(start)) &&
      (end === null || Number.isFinite(end)) &&
      (start === null || end === null || start <= end),
  );
  const isOnSale =
    validSale &&
    (start === null || start <= time) &&
    (end === null || end >= time);
  // Existing sale windows include their ending millisecond. A price cursor or
  // cache must expire before using that price in a later window.
  const nextTime = !validSale
    ? null
    : start !== null && start > time
      ? start
      : end !== null && end >= time && end < 8640000000000000
        ? end + 1
        : null;
  return {
    price,
    effectivePrice: isOnSale ? sale! : price,
    isOnSale,
    computedAt: new Date(time),
    nextChangeAt: nextTime === null ? null : new Date(nextTime),
  };
}
