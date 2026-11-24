import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MARKET_SNAPSHOT_MAX_LENGTH } from './market-cursor';

export interface MarketReadContext {
  readonly asOf: Date;
  readonly snapshot: string;
}
const transactions = new WeakMap<MarketReadContext, object>();

/** A captured clock belongs to exactly one bounded read transaction. */
export async function captureMarketReadContext(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  withSnapshot = true,
): Promise<MarketReadContext> {
  const rows = await tx.$queryRaw<
    Array<{
      asOf: Date;
      snapshot: string;
      isolation: string;
      readOnly: string;
      encoding: string;
      statementTimeoutMs: number;
      lockTimeoutMs: number;
    }>
  >(Prisma.sql`
    SELECT date_trunc('milliseconds',statement_timestamp()) AS "asOf",
      ${withSnapshot ? Prisma.sql`left(pg_current_snapshot()::text,${MARKET_SNAPSHOT_MAX_LENGTH + 1})` : Prisma.sql`''::text`} AS snapshot,
      current_setting('transaction_isolation') AS isolation,current_setting('transaction_read_only') AS "readOnly",
      current_setting('server_encoding') AS encoding,
      (extract(epoch FROM current_setting('statement_timeout')::interval)*1000)::float8 AS "statementTimeoutMs",
      (extract(epoch FROM current_setting('lock_timeout')::interval)*1000)::float8 AS "lockTimeoutMs"`);
  const row = rows[0];
  if (
    !(row?.asOf instanceof Date) ||
    !Number.isFinite(row.asOf.getTime()) ||
    row.isolation !== 'repeatable read' ||
    row.readOnly !== 'on' ||
    row.encoding !== 'UTF8' ||
    !Number.isFinite(row.statementTimeoutMs) ||
    row.statementTimeoutMs < 1 ||
    row.statementTimeoutMs > 1500 ||
    !Number.isFinite(row.lockTimeoutMs) ||
    row.lockTimeoutMs < 1 ||
    row.lockTimeoutMs > 250
  )
    throw new ServiceUnavailableException({
      code: 'CATALOGUE_READ_CONTEXT_UNAVAILABLE',
      message: 'The catalogue is updating. Please try again shortly.',
    });
  const instant = row.asOf.getTime();
  const context = Object.freeze({
    get asOf() {
      return new Date(instant);
    },
    snapshot: row.snapshot,
  });
  transactions.set(context, tx);
  return context;
}

export function assertMarketReadContext(
  tx: object,
  context: MarketReadContext,
): void {
  if (transactions.get(context) !== tx)
    throw new RangeError(
      'Catalogue context belongs to a different transaction',
    );
}
