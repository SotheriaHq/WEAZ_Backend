import { Prisma } from '@prisma/client';
import {
  assertMarketReadContext,
  captureMarketReadContext,
} from './market-read-context';
import { MARKET_SNAPSHOT_MAX_LENGTH } from './market-cursor';

const instant = new Date('2026-11-21T12:00:00.000Z');
const validRow = () => ({
  asOf: new Date(instant),
  snapshot: '10:20:12',
  isolation: 'repeatable read',
  readOnly: 'on',
  encoding: 'UTF8',
  statementTimeoutMs: 1500,
  lockTimeoutMs: 250,
});
const txFor = (rows: unknown[]) =>
  ({ $queryRaw: jest.fn().mockResolvedValue(rows) }) as unknown as Pick<
    Prisma.TransactionClient,
    '$queryRaw'
  >;

describe('transaction-owned catalogue read context', () => {
  it('accepts only the real originating transaction object', async () => {
    const tx = txFor([validRow()]);
    const context = await captureMarketReadContext(tx);
    expect(() => assertMarketReadContext(tx, context)).not.toThrow();
    expect(() => assertMarketReadContext({ ...tx }, context)).toThrow(
      RangeError,
    );
    expect(() =>
      assertMarketReadContext(tx, {
        asOf: context.asOf,
        snapshot: context.snapshot,
      }),
    ).toThrow(RangeError);
  });
  it('clones database and caller-visible Dates so neither can move the captured clock', async () => {
    const row = validRow(),
      tx = txFor([row]);
    const context = await captureMarketReadContext(tx);
    row.asOf.setTime(0);
    const visible = context.asOf;
    visible.setTime(1);
    expect(context.asOf.getTime()).toBe(instant.getTime());
    expect(context.asOf).not.toBe(context.asOf);
    expect(Object.isFrozen(context)).toBe(true);
  });
  it('keeps different captures bound independently even on the same connection', async () => {
    const tx = txFor([validRow()]),
      other = txFor([validRow()]);
    const first = await captureMarketReadContext(tx),
      second = await captureMarketReadContext(other);
    expect(() => assertMarketReadContext(tx, second)).toThrow(RangeError);
    expect(() => assertMarketReadContext(other, first)).toThrow(RangeError);
  });
  it.each([
    ['wrong isolation', { isolation: 'read committed' }],
    ['writable transaction', { readOnly: 'off' }],
    ['non-UTF8 database', { encoding: 'LATIN1' }],
    ['invalid date', { asOf: new Date(NaN) }],
    ['string date', { asOf: instant.toISOString() }],
    ['unlimited statement time', { statementTimeoutMs: 0 }],
    ['excess statement time', { statementTimeoutMs: 1501 }],
    ['nonfinite statement time', { statementTimeoutMs: Infinity }],
    ['unlimited lock time', { lockTimeoutMs: 0 }],
    ['excess lock time', { lockTimeoutMs: 251 }],
    ['nonfinite lock time', { lockTimeoutMs: NaN }],
  ])('fails closed for %s', async (_label, overrides) => {
    const tx = txFor([{ ...validRow(), ...overrides }]);
    await expect(captureMarketReadContext(tx)).rejects.toMatchObject({
      response: { code: 'CATALOGUE_READ_CONTEXT_UNAVAILABLE' },
    });
  });
  it('rejects missing database authority metadata', async () => {
    await expect(captureMarketReadContext(txFor([]))).rejects.toMatchObject({
      response: { code: 'CATALOGUE_READ_CONTEXT_UNAVAILABLE' },
    });
  });
  it('bounds snapshot text in PostgreSQL before transfer', async () => {
    const query = jest.fn().mockResolvedValue([validRow()]);
    await captureMarketReadContext({ $queryRaw: query } as unknown as Pick<
      Prisma.TransactionClient,
      '$queryRaw'
    >);
    const sql = query.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain('left(pg_current_snapshot()::text,');
    expect(sql.values).toContain(MARKET_SNAPSHOT_MAX_LENGTH + 1);
    expect(sql.text).toContain(
      "date_trunc('milliseconds',statement_timestamp())",
    );
  });
  it('does not request a snapshot for a newest-only context', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ ...validRow(), snapshot: '' }]);
    const context = await captureMarketReadContext(
      { $queryRaw: query } as unknown as Pick<
        Prisma.TransactionClient,
        '$queryRaw'
      >,
      false,
    );
    expect(context.snapshot).toBe('');
    expect((query.mock.calls[0][0] as Prisma.Sql).text).not.toContain(
      'pg_current_snapshot',
    );
  });
  it('propagates database failure without fabricating a context', async () => {
    const error = new Error('Database failed');
    const tx = {
      $queryRaw: jest.fn().mockRejectedValue(error),
    } as unknown as Pick<Prisma.TransactionClient, '$queryRaw'>;
    await expect(captureMarketReadContext(tx)).rejects.toBe(error);
  });
});
