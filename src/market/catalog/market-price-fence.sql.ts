import { Prisma } from '@prisma/client';
import { parseMarketSnapshot } from './market-cursor';

/**
 * A committed row was invisible in the old snapshot iff its top-level xid was
 * active then, or >= xmax. Two index probes avoid scanning every xid >= xmin
 * when an unrelated old transaction holds xmin back. No current price/filter
 * predicate may narrow this fence: a changed product can have left that filter.
 * Run inside the same repeatable-read transaction as the next page's rows.
 */
export function marketPriceWritesSinceSql(snapshot: string): Prisma.Sql {
  const { xmax, active } = parseMarketSnapshot(snapshot);
  const future = Prisma.sql`EXISTS (
    SELECT 1 FROM "Product" price_future
    WHERE price_future."priceChangeXid" >= ${xmax}::xid8
  )`;
  if (!active.length) return future;
  const inFlight = Prisma.sql`EXISTS (
    SELECT 1 FROM "Product" price_inflight
    WHERE price_inflight."priceChangeXid" IN (
      ${Prisma.join(active.map((transaction) => Prisma.sql`${transaction}::xid8`))}
    )
  )`;
  return Prisma.sql`(${future} OR ${inFlight})`;
}
