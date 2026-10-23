import { Prisma } from '@prisma/client';
import { LedgerService } from './ledger.service';

describe('LedgerService posting invariants', () => {
  const input = () => ({
    idempotencyKey: 'fixture',
    type: 'PAYMENT_RECEIVED' as const,
    description: 'Fixture',
    totalAmount: 0.3,
    currency: 'NGN',
    lines: [
      {
        code: 'A',
        name: 'A',
        type: 'ASSET' as const,
        subType: 'FIXTURE',
        direction: 'DEBIT' as const,
        amount: 0.1,
      },
      {
        code: 'A',
        name: 'A',
        type: 'ASSET' as const,
        subType: 'FIXTURE',
        direction: 'DEBIT' as const,
        amount: 0.2,
      },
      {
        code: 'B',
        name: 'B',
        type: 'LIABILITY' as const,
        subType: 'FIXTURE',
        direction: 'CREDIT' as const,
        amount: 0.3,
      },
    ],
  });
  const decimal = (amount: string) => new Prisma.Decimal(amount);
  let tx: any;
  let service: LedgerService;
  beforeEach(() => {
    tx = {
      ledgerTransaction: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'winner' }),
      },
      ledgerAccount: {
        findMany: jest.fn().mockResolvedValue([{ code: 'A' }, { code: 'B' }]),
        createMany: jest.fn(),
      },
      ledgerEntry: { createMany: jest.fn().mockResolvedValue({ count: 3 }) },
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'a',
          code: 'A',
          type: 'ASSET',
          subType: 'FIXTURE',
          currentBalance: decimal('999999999999999.90'),
        },
        {
          id: 'b',
          code: 'B',
          type: 'LIABILITY',
          subType: 'FIXTURE',
          currentBalance: decimal('0'),
        },
      ]),
      $executeRaw: jest.fn().mockResolvedValue(2),
    };
    service = new LedgerService({} as any);
  });

  it.each([-1, NaN, Infinity])(
    'rejects invalid money %s before claiming a transaction',
    async (amount) => {
      const params = input();
      params.lines[0].amount = amount;
      await expect(service.postTransaction(tx, params)).rejects.toThrow(
        'LEDGER_INVALID_AMOUNT',
      );
      expect(tx.ledgerTransaction.createMany).not.toHaveBeenCalled();
    },
  );

  it('rejects an unbalanced journal before any write', async () => {
    const params = input();
    params.lines[2].amount = 0.4;
    await expect(service.postTransaction(tx, params)).rejects.toThrow(
      'LEDGER_UNBALANCED_TRANSACTION',
    );
    expect(tx.ledgerTransaction.createMany).not.toHaveBeenCalled();
  });

  it('retains exact debit totals and intermediate snapshots at large balances', async () => {
    await service.postTransaction(tx, input());
    const entries = tx.ledgerEntry.createMany.mock.calls[0][0].data;
    expect(entries.map((entry: any) => entry.amount.toFixed(2))).toEqual([
      '0.10',
      '0.20',
      '0.30',
    ]);
    expect(entries.map((entry: any) => entry.balanceAfter.toFixed(2))).toEqual([
      '1000000000000000.00',
      '1000000000000000.20',
      '0.30',
    ]);
    expect(tx.ledgerAccount.findMany).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('returns a duplicate winner without touching balances or entries', async () => {
    tx.ledgerTransaction.createMany.mockResolvedValue({ count: 0 });
    const params = input();
    const winner = {
      id: 'winner',
      type: params.type,
      currency: 'NGN',
      referenceType: null,
      referenceId: null,
      totalAmount: decimal('0.30'),
      entries: params.lines.map((line) => ({
        ...line,
        amount: decimal(String(line.amount)),
        account: { code: line.code },
      })),
    };
    tx.ledgerTransaction.findUniqueOrThrow.mockResolvedValue(winner);
    await expect(service.postTransaction(tx, params)).resolves.toBe(winner);
    expect(tx.ledgerAccount.findMany).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.createMany).not.toHaveBeenCalled();
  });

  it('rejects reuse of a key with a changed currency', async () => {
    tx.ledgerTransaction.createMany.mockResolvedValue({ count: 0 });
    tx.ledgerTransaction.findUniqueOrThrow.mockResolvedValue({
      type: 'PAYMENT_RECEIVED',
      currency: 'USD',
      referenceType: null,
      referenceId: null,
      totalAmount: decimal('0.30'),
      entries: [],
    });
    await expect(service.postTransaction(tx, input())).rejects.toThrow(
      'LEDGER_IDEMPOTENCY_CONFLICT',
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('refuses to reinterpret an existing asset account as a liability', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        id: 'a',
        code: 'A',
        type: 'LIABILITY',
        subType: 'FIXTURE',
        currentBalance: decimal('0'),
      },
      {
        id: 'b',
        code: 'B',
        type: 'LIABILITY',
        subType: 'FIXTURE',
        currentBalance: decimal('0'),
      },
    ]);
    await expect(service.postTransaction(tx, input())).rejects.toThrow(
      'LEDGER_ACCOUNT_DEFINITION_MISMATCH',
    );
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
