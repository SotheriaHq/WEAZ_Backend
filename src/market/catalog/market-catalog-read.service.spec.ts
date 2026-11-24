import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MarketCatalogReadService,
  MARKET_CATALOG_CONCURRENT_READS,
} from './market-catalog-read.service';

describe('catalogue read admission', () => {
  const fixture = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const transaction = jest.fn(
      async (
        read: (value: typeof tx) => unknown,
        _options?: { timeout: number; maxWait: number },
      ) => read(tx),
    );
    const service = new MarketCatalogReadService({
      $transaction: transaction,
    } as unknown as PrismaService);
    return { tx, transaction, service };
  };

  it('bounds the real transaction and establishes read-only before the callback', async () => {
    const { tx, transaction, service } = fixture();
    await expect(
      service.run(async () => {
        expect(
          tx.$executeRaw.mock.calls.map((call) => String(call[0])),
        ).toEqual([
          'SET TRANSACTION READ ONLY',
          "SET LOCAL statement_timeout='1500ms'",
          "SET LOCAL lock_timeout='250ms'",
        ]);
        return ['result'];
      }),
    ).resolves.toEqual(['result']);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 250,
      timeout: 2000,
    });
  });

  it('rejects excess work before pool acquisition and releases every slot', async () => {
    const { service, transaction } = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = Array.from(
      { length: MARKET_CATALOG_CONCURRENT_READS },
      () => service.run(async () => blocked),
    );
    await expect(service.run(async () => 'extra')).rejects.toMatchObject({
      response: { code: 'CATALOGUE_BUSY' },
    });
    expect(transaction).toHaveBeenCalledTimes(MARKET_CATALOG_CONCURRENT_READS);
    release();
    await Promise.all(pending);
    await expect(service.run(async () => 'available')).resolves.toBe(
      'available',
    );
  });
  it('rejects expired, invalid and aborted budgets before acquiring a connection', async () => {
    const { service, transaction } = fixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      service.run(async () => null, { deadline: performance.now() - 1 }),
    ).rejects.toMatchObject({ response: { code: 'CATALOGUE_READ_LIMIT' } });
    await expect(
      service.run(async () => null, { signal: controller.signal }),
    ).rejects.toMatchObject({ response: { code: 'CATALOGUE_READ_LIMIT' } });
    await expect(
      service.run(async () => null, { deadline: NaN }),
    ).rejects.toThrow(RangeError);
    expect(transaction).not.toHaveBeenCalled();
  });
  it('bounds the whole PostgreSQL transaction as well as each statement under one monotonic deadline', async () => {
    const { service, tx, transaction } = fixture();
    await expect(
      service.run(async () => 'result', { deadline: performance.now() + 550 }),
    ).resolves.toBe('result');
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sql.text).toContain("set_config('transaction_timeout'");
    expect(Number(sql.values[0])).toBeLessThanOrEqual(250);
    expect(Number(sql.values[2])).toBeGreaterThan(0);
    expect(Number(sql.values[2])).toBeLessThanOrEqual(550);
    const options = transaction.mock.calls[0][1];
    expect(options.timeout).toBeLessThanOrEqual(550);
    expect(options.maxWait).toBeLessThanOrEqual(250);
  });
  it('rejects results after an abort and releases admission only when actual work settles', async () => {
    const { service } = fixture();
    const controller = new AbortController();
    await expect(
      service.run(
        async () => {
          controller.abort();
          return 'late';
        },
        { signal: controller.signal, deadline: performance.now() + 550 },
      ),
    ).rejects.toMatchObject({ response: { code: 'CATALOGUE_READ_LIMIT' } });
    await expect(service.run(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it('releases a slot after setup and validation failures without hiding their cause', async () => {
    const { service, tx } = fixture();
    const setupError = new Error('setup failed');
    tx.$executeRaw.mockRejectedValueOnce(setupError);
    await expect(service.run(async () => null)).rejects.toBe(setupError);
    const invalid = new BadRequestException({ code: 'INVALID_FILTER' });
    await expect(
      service.run(async () => {
        throw invalid;
      }),
    ).rejects.toBe(invalid);
    await expect(service.run(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it.each([
    ['P2024', undefined],
    ['P2028', undefined],
    ['P2037', undefined],
    ['P1017', undefined],
    ['P2010', '25P04'],
    ['P2010', '57014'],
    ['P2010', '55P03'],
    ['P2010', '53300'],
  ])(
    'returns a retryable error for %s / %s without database text',
    async (code, databaseCode) => {
      const { service, transaction } = fixture();
      transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('private database detail', {
          code,
          clientVersion: 'test',
          meta: databaseCode ? { code: databaseCode } : undefined,
        }),
      );
      await expect(service.run(async () => null)).rejects.toMatchObject({
        response: { code: 'CATALOGUE_READ_LIMIT' },
      });
      await expect(service.run(async () => 'recovered')).resolves.toBe(
        'recovered',
      );
    },
  );

  it('does not disguise a broken query as an empty catalogue or a timeout', async () => {
    const { service, transaction } = fixture();
    const error = new Prisma.PrismaClientKnownRequestError('broken schema', {
      code: 'P2010',
      clientVersion: 'test',
      meta: { code: '42703' },
    });
    transaction.mockRejectedValueOnce(error);
    await expect(service.run(async () => null)).rejects.toBe(error);
  });

  it('fails safely when the database lacks the required whole-transaction deadline capability', async () => {
    const { service, transaction } = fixture();
    transaction.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('private configuration detail', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { code: '42704' },
      }),
    );
    await expect(
      service.run(async () => null, { deadline: performance.now() + 1000 }),
    ).rejects.toMatchObject({
      response: { code: 'CATALOGUE_DATABASE_CAPABILITY_REQUIRED' },
    });
    await expect(service.run(async () => 'recovered')).resolves.toBe(
      'recovered',
    );
  });

  it.each(['57014', '55P03', '53300'])(
    'classifies PostgreSQL adapter SQLSTATE %s without reading its message',
    async (originalCode) => {
      const { service, transaction } = fixture();
      transaction.mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError('private query text', {
          code: 'P2010',
          clientVersion: 'test',
          meta: { driverAdapterError: { cause: { originalCode } } },
        }),
      );
      await expect(service.run(async () => null)).rejects.toMatchObject({
        response: { code: 'CATALOGUE_READ_LIMIT' },
      });
    },
  );

  it.each([
    undefined,
    null,
    '57014',
    {},
    { cause: null },
    { cause: '57014' },
    { cause: { originalCode: '42703' } },
  ])(
    'does not guess timeout codes from malformed or unrelated adapter metadata: %j',
    async (driverAdapterError) => {
      const { service, transaction } = fixture();
      const error = new Prisma.PrismaClientKnownRequestError('57014', {
        code: 'P2010',
        clientVersion: 'test',
        meta: { driverAdapterError },
      });
      transaction.mockRejectedValueOnce(error);
      await expect(service.run(async () => null)).rejects.toBe(error);
    },
  );
});
