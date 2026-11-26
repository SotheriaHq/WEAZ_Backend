import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  MarketCatalogAdmissionException,
  MarketCatalogReadService,
  MARKET_CATALOG_CONCURRENT_READS,
  isEndedConnection,
  marketReadSetupSql,
} from './market-catalog-read.service';

describe('catalogue read on a connection the server already ended', () => {
  const ended = () => new Error('Connection terminated unexpectedly');
  const setup = () => {
    const tx = {
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const transaction = jest.fn(async (read: (value: typeof tx) => unknown) =>
      read(tx),
    );
    const service = new MarketCatalogReadService({
      $transaction: transaction,
    } as unknown as PrismaService);
    return { transaction, service };
  };
  it('retries once on a fresh connection when BEGIN fails before any read', async () => {
    const { transaction, service } = setup();
    transaction.mockRejectedValueOnce(ended());
    const read = jest.fn().mockResolvedValue('value');
    await expect(service.run(read)).resolves.toBe('value');
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it('never retries once the read has started, and maps the failure to 503', async () => {
    const { transaction, service } = setup();
    const read = jest.fn().mockRejectedValue(ended());
    await expect(service.run(read)).rejects.toMatchObject({
      response: { code: 'CATALOGUE_READ_LIMIT' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
  });
  it('retries at most once', async () => {
    const { transaction, service } = setup();
    transaction.mockRejectedValueOnce(ended()).mockRejectedValueOnce(ended());
    await expect(service.run(jest.fn())).rejects.toMatchObject({
      response: { code: 'CATALOGUE_READ_LIMIT' },
    });
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('does not retry pool waits, timeouts or unrelated errors', async () => {
    const { transaction, service } = setup();
    const poolWait = new Prisma.PrismaClientKnownRequestError('pool', {
      code: 'P2024',
      clientVersion: 'test',
    });
    transaction.mockRejectedValueOnce(poolWait);
    await expect(service.run(jest.fn())).rejects.toMatchObject({
      response: { code: 'CATALOGUE_READ_LIMIT' },
    });
    expect(transaction).toHaveBeenCalledTimes(1);
    const unrelated = new Error('private failure');
    transaction.mockRejectedValueOnce(unrelated);
    await expect(service.run(jest.fn())).rejects.toBe(unrelated);
    expect(transaction).toHaveBeenCalledTimes(2);
  });
  it('recognises only server-ended connections', () => {
    expect(isEndedConnection(ended())).toBe(true);
    expect(
      isEndedConnection(Object.assign(new Error('x'), { code: '57P01' })),
    ).toBe(true);
    expect(
      isEndedConnection(Object.assign(new Error('x'), { code: '57014' })),
    ).toBe(false);
    expect(isEndedConnection('Connection terminated unexpectedly')).toBe(false);
  });
});

describe('catalogue read admission', () => {
  const fixture = () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const transaction: jest.Mock<
      Promise<unknown>,
      [
        read: (value: typeof tx) => unknown,
        options?: { timeout: number; maxWait: number },
      ]
    > = jest.fn(async (read) => read(tx));
    const service = new MarketCatalogReadService({
      $transaction: transaction,
    } as unknown as PrismaService);
    return { tx, transaction, service };
  };

  it('bounds the real transaction and establishes read-only before the callback', async () => {
    const { tx, transaction, service } = fixture();
    await expect(
      service.run(async () => {
        // One setup round trip: isolation, read-only mode and both limits.
        expect(tx.$executeRaw).not.toHaveBeenCalled();
        expect(tx.$queryRaw).not.toHaveBeenCalled();
        expect(tx.$executeRawUnsafe.mock.calls).toEqual([
          [
            'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;SET LOCAL statement_timeout=1500;SET LOCAL lock_timeout=250',
          ],
        ]);
        return ['result'];
      }),
    ).resolves.toEqual(['result']);
    // No isolationLevel option: the adapter would send it as another trip.
    expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
      maxWait: 250,
      timeout: 2000,
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity])(
    'refuses a %p budget instead of writing it into the setup statement',
    (budget) => {
      expect(() => marketReadSetupSql(budget)).toThrow(RangeError);
    },
  );
  it('keeps statement and lock limits inside a shorter transaction budget', () => {
    expect(marketReadSetupSql(90)).toBe(
      'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY;SET LOCAL statement_timeout=90;SET LOCAL lock_timeout=90;SET LOCAL transaction_timeout=90',
    );
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
    const refused = service.run(async () => 'extra');
    await expect(refused).rejects.toBeInstanceOf(
      MarketCatalogAdmissionException,
    );
    await expect(refused).rejects.toMatchObject({
      status: 503,
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
    expect(tx.$executeRawUnsafe).toHaveBeenCalledTimes(1);
    const setup = String(tx.$executeRawUnsafe.mock.calls[0][0]);
    expect(setup).toContain('REPEATABLE READ, READ ONLY');
    const limit = (name: string) =>
      Number(new RegExp(`${name}=(\\d+)`).exec(setup)?.[1]);
    expect(limit('statement_timeout')).toBeLessThanOrEqual(250);
    expect(limit('transaction_timeout')).toBeGreaterThan(0);
    expect(limit('transaction_timeout')).toBeLessThanOrEqual(550);
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
    tx.$executeRawUnsafe.mockRejectedValueOnce(setupError);
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
      const failure = new Prisma.PrismaClientKnownRequestError(
        'private database detail',
        {
          code,
          clientVersion: 'test',
          meta: databaseCode ? { code: databaseCode } : undefined,
        },
      );
      // A closed server connection (P1017) is retried once before it maps.
      for (let i = 0; i < (code === 'P1017' ? 2 : 1); i++)
        transaction.mockRejectedValueOnce(failure);
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
