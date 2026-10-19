import { Prisma } from '@prisma/client';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';

const decimal = (amount: number) => new Prisma.Decimal(amount);
const makeRow = (override: Record<string, unknown> = {}) => ({
  id: 'refund-1',
  customOrderId: 'order-1',
  paymentAttemptId: 'payment-1',
  amount: decimal(113000),
  currency: 'NGN',
  status: 'REQUESTED',
  providerRefundId: null,
  attempts: 0,
  lastError: null,
  lockedAt: null,
  nextAttemptAt: new Date(0),
  breakdownJson: {
    captureAmount: 132500,
    vatAmount: 7500,
    garmentCharge: 10000,
    jumpCharge: 2000,
    refundAmount: 113000,
    currency: 'NGN',
  },
  customOrder: {
    id: 'order-1',
    buyerId: 'buyer-1',
    lane: 'TERMINAL',
    cancelledAt: new Date(),
    paymentStatus: 'PAID',
  },
  paymentAttempt: {
    id: 'payment-1',
    amount: decimal(250000),
    reference: 'mixed-capture',
    provider: 'PAYSTACK',
    providerMode: 'live',
    providerTransactionId: '456',
    currency: 'NGN',
    status: 'PAID',
  },
  ...override,
});

function harness(override: Record<string, unknown> = {}) {
  const row = makeRow(override);
  let depth = 0;
  const entries = new Map<string, any>();
  const updateMany = jest.fn(async ({ where, data }) => {
    if (where.id && where.id !== row.id) return { count: 0 };
    if (
      where.status &&
      (typeof where.status === 'string'
        ? row.status !== where.status
        : !where.status.in.includes(row.status))
    )
      return { count: 0 };
    if (where.providerRefundId === null && row.providerRefundId !== null)
      return { count: 0 };
    Object.assign(row, data, {
      attempts: data.attempts?.increment
        ? row.attempts + data.attempts.increment
        : row.attempts,
    });
    return { count: 1 };
  });
  const tx = {
    customOrderQueueRefund: {
      findUnique: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      findFirst: jest.fn(async ({ where }) =>
        row.providerRefundId === where.providerRefundId ? { ...row } : null,
      ),
      findMany: jest.fn(async () => []),
      updateMany,
      update: jest.fn(async ({ data }) => {
        Object.assign(row, data);
        return { ...row };
      }),
    },
    customOrder: {
      update: jest.fn(async ({ data }) => {
        Object.assign(row.customOrder, data);
      }),
    },
    paymentAttempt: { update: jest.fn() },
    paymentEvent: { create: jest.fn(async () => ({})) },
    operationalAlert: {
      upsert: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 0 })),
    },
    customOrderTimelineEvent: { create: jest.fn(async () => ({})) },
    customOrderNotificationOutbox: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async () => [{ id: row.id }]),
  };
  const prisma = {
    ...tx,
    $transaction: jest.fn(async (work) => {
      depth++;
      try {
        return await work(tx);
      } finally {
        depth--;
      }
    }),
  };
  const ledger = {
    postTransaction: jest.fn(async (_tx, params) => {
      const debits = params.lines
        .filter((line) => line.direction === 'DEBIT')
        .reduce((sum, line) => sum + line.amount, 0);
      const credits = params.lines
        .filter((line) => line.direction === 'CREDIT')
        .reduce((sum, line) => sum + line.amount, 0);
      expect(debits).toBe(credits);
      if (!entries.has(params.idempotencyKey))
        entries.set(params.idempotencyKey, params);
      return entries.get(params.idempotencyKey);
    }),
  };
  const service = new CustomOrderQueueRefundsService(
    prisma as any,
    ledger as any,
  );
  const verification = jest.spyOn(service as any, 'verifyCapture').mockResolvedValue(undefined);
  return { row, tx, prisma, ledger, entries, service, verification, depth: () => depth };
}

const paystackData = (status = 'pending', extra = {}) => ({
  id: 77,
  transaction: { id: 456, reference: 'mixed-capture' },
  amount: 11300000,
  currency: 'NGN',
  status,
  ...extra,
});
const response = (data: unknown, status: unknown = true) =>
  ({ ok: true, json: async () => ({ status, data }) }) as Response;

describe('durable per-order queued refunds', () => {
  const originalFetch = global.fetch;
  const environment = { ...process.env };
  beforeEach(() => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_example';
    process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK-example';
    process.env.NODE_ENV = 'test';
  });
  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...environment };
    jest.restoreAllMocks();
  });

  it('reserves the whole captured order, refunds only its share, and keeps a mixed parent paid', async () => {
    const h = harness();
    global.fetch = jest.fn(async (_url, options) => {
      expect(h.depth()).toBe(0);
      expect(JSON.parse(String(options?.body)).amount).toBe(11300000);
      expect(h.entries.size).toBe(1);
      return response(paystackData());
    });
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('PROCESSING');
    expect(h.tx.customOrder.update).not.toHaveBeenCalled();
    expect(
      h.entries
        .values()
        .next()
        .value.lines.map((line) => line.amount),
    ).toEqual([132500, 113000, 7500, 12000]);
    await h.service.handleWebhook('PAYSTACK', {
      event: 'refund.processed',
      data: paystackData('processed'),
    });
    expect(h.row.status).toBe('SETTLED');
    expect(h.entries.size).toBe(2);
    expect(h.tx.paymentAttempt.update).not.toHaveBeenCalled();
    expect(h.row.paymentAttempt.status).toBe('PAID');
    expect(h.row.customOrder.paymentStatus).toBe('REFUNDED');
  });

  it('does not resubmit an accepted refund on duplicate worker execution', async () => {
    const h = harness();
    global.fetch = jest.fn(async () => response(paystackData()));
    await (h.service as any).processOne(h.row.id);
    await (h.service as any).processOne(h.row.id);
    const calls = (global.fetch as jest.Mock).mock.calls;
    expect(
      calls.filter(([, options]) => options?.method === 'POST'),
    ).toHaveLength(1);
  });

  it('verifies the capture using real API mode even with test merchant credentials', async () => {
    const h = harness();
    h.verification.mockRestore();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_fixture';
    global.fetch = jest.fn(async (url) => String(url).includes('/transaction/verify/')
      ? response({ id: 456, reference: 'mixed-capture', status: 'success', amount: 25000000, currency: 'NGN' })
      : response(paystackData()));
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('PROCESSING');
    expect((global.fetch as jest.Mock).mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(1);
  });

  it('never submits a refund when the authoritative capture differs', async () => {
    const h = harness();
    h.verification.mockRestore();
    global.fetch = jest.fn(async () => response({ id: 456, reference: 'another-capture', status: 'success', amount: 25000000, currency: 'NGN' }));
    await (h.service as any).processOne(h.row.id);
    expect(h.row.lastError).toBe('REFUND_ORIGINAL_CAPTURE_VERIFICATION_MISMATCH');
    expect((global.fetch as jest.Mock).mock.calls.some(([, options]) => options?.method === 'POST')).toBe(false);
  });

  it('submits and verifies the stored provider currency while keeping the financial ledger in the original currency', async () => {
    const h = harness();
    h.row.currency = 'USD';
    h.row.paymentAttempt.currency = 'USD';
    Object.assign(h.row.paymentAttempt, { settlementCurrency: 'NGN', settlementAmount: decimal(500000000) });
    Object.assign(h.row.breakdownJson, { currency: 'USD', settlement: { status: 'RECORDED', currency: 'NGN', amount: 226000000, rate: '2000' } });
    global.fetch = jest.fn(async (_url, options) => {
      expect(JSON.parse(String(options?.body))).toMatchObject({ currency: 'NGN', amount: 22600000000 });
      return response(paystackData('processed', { amount: 22600000000 }));
    });
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('SETTLED');
    expect([...h.entries.values()].every(post => post.currency === 'USD')).toBe(true);
  });

  it('quarantines a timeout after possible acceptance and never blindly retries', async () => {
    const h = harness();
    global.fetch = jest.fn(async () => {
      throw new Error('timeout with possible provider acceptance');
    });
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('NEEDS_ATTENTION');
    await (h.service as any).processOne(h.row.id);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(h.tx.operationalAlert.upsert).toHaveBeenCalledTimes(1);
    expect(h.tx.customOrderNotificationOutbox.create).toHaveBeenCalledTimes(1);
  });

  it('rejects mismatched amounts in signed events without changing sibling or order payment state', async () => {
    const h = harness({ status: 'PROCESSING', providerRefundId: '77' });
    await h.service.handleWebhook('PAYSTACK', {
      event: 'refund.processed',
      data: paystackData('processed', { amount: 11300100 }),
    });
    expect(h.row.status).toBe('NEEDS_ATTENTION');
    expect(h.tx.customOrder.update).not.toHaveBeenCalled();
    expect(h.entries.size).toBe(0);
  });

  it('makes duplicate processed webhooks financially idempotent', async () => {
    const h = harness({ status: 'PROCESSING', providerRefundId: '77' });
    const event = {
      event: 'refund.processed',
      data: paystackData('processed'),
    };
    await h.service.handleWebhook('PAYSTACK', event);
    await h.service.handleWebhook('PAYSTACK', event);
    expect(h.entries.size).toBe(2);
    expect(h.tx.customOrder.update).toHaveBeenCalledTimes(1);
    expect(h.tx.paymentEvent.create).toHaveBeenCalledTimes(1);
  });

  it('polls stored refund IDs when Paystack omits an ID rather than matching equal-priced siblings', async () => {
    const h = harness({ status: 'PROCESSING', providerRefundId: '77' });
    h.tx.customOrderQueueRefund.findMany.mockResolvedValueOnce([
      { ...h.row },
    ] as never);
    global.fetch = jest.fn(async () => response(paystackData('processed')));
    await h.service.handleWebhook('PAYSTACK', {
      event: 'refund.processed',
      data: {
        transaction_reference: 'mixed-capture',
        amount: 11300000,
        currency: 'NGN',
        status: 'processed',
      },
    });
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.paystack.co/refund/77',
      expect.any(Object),
    );
    expect(h.row.status).toBe('SETTLED');
  });

  it('uses Flutterwave transaction IDs and keeps bare completed as processing', async () => {
    const h = harness();
    h.row.paymentAttempt.provider = 'FLUTTERWAVE';
    global.fetch = jest.fn(async (url) =>
      String(url).endsWith('/verify')
        ? response(
            { id: 456, tx_ref: 'mixed-capture', currency: 'NGN' },
            'success',
          )
        : response(
            {
              id: 77,
              tx_id: 456,
              amount_refunded: 113000,
              status: 'completed',
            },
            'success',
          ),
    );
    await (h.service as any).processOne(h.row.id);
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.flutterwave.com/v3/transactions/456/refund',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(h.row.status).toBe('PROCESSING');
    await h.service.handleWebhook('FLUTTERWAVE', {
      id: 77,
      TransactionId: 456,
      AmountRefunded: 113000,
      status: 'completed-bank-transfer',
    });
    expect(h.row.status).toBe('SETTLED');
  });

  it('does not simulate mock refunds without an explicit local/test switch', async () => {
    const h = harness();
    h.row.paymentAttempt.providerMode = 'mock';
    delete process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED;
    global.fetch = jest.fn();
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('FAILED');
    expect(h.tx.customOrder.update).not.toHaveBeenCalled();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('rejects a nonconserving snapshot before contacting the provider', async () => {
    const h = harness({
      breakdownJson: {
        captureAmount: 132500,
        vatAmount: 7500,
        garmentCharge: 9999,
        jumpCharge: 2000,
        refundAmount: 113000,
        currency: 'NGN',
      },
    });
    // The real database rolls the CAS back with the failed reservation.
    h.prisma.$transaction.mockImplementationOnce(async (work) => {
      const old = { ...h.row };
      try {
        return await work(h.tx);
      } catch (failure) {
        Object.assign(h.row, old);
        throw failure;
      }
    });
    global.fetch = jest.fn();
    await (h.service as any).processOne(h.row.id);
    expect(h.row.status).toBe('NEEDS_ATTENTION');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('reconciles an uncertain acceptance only after the provider verifies every identity field', async () => {
    const h = harness({ status: 'NEEDS_ATTENTION' });
    global.fetch = jest.fn(async () => response(paystackData('processed')));
    const result = await h.service.reconcile(h.row.id, '77', 'admin-1');
    expect(result.status).toBe('SETTLED');
    expect(h.row.providerRefundId).toBe('77');
    expect(h.tx.paymentEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'CUSTOM_ORDER_QUEUE_REFUND_RECONCILED',
          payload: expect.objectContaining({ actorId: 'admin-1' }),
        }),
      }),
    );
    expect(
      (global.fetch as jest.Mock).mock.calls.every(
        ([, options]) => options.method !== 'POST',
      ),
    ).toBe(true);
  });

  it('refuses to attach another capture refund during reconciliation', async () => {
    const h = harness({ status: 'NEEDS_ATTENTION' });
    global.fetch = jest.fn(async () =>
      response(
        paystackData('processed', {
          transaction: { id: 999, reference: 'another-capture' },
        }),
      ),
    );
    await expect(
      h.service.reconcile(h.row.id, '77', 'admin-1'),
    ).rejects.toThrow('REFUND_PROVIDER_RECONCILIATION_MISMATCH');
    expect(h.row.providerRefundId).toBeNull();
    expect(h.entries.size).toBe(0);
  });

  it('does not settle a Flutterwave callback that says completed while disbursement failed', async () => {
    const h = harness({ status: 'PROCESSING', providerRefundId: '77' });
    h.row.paymentAttempt.provider = 'FLUTTERWAVE';
    global.fetch = jest.fn(async () =>
      response(
        { id: 456, tx_ref: 'mixed-capture', currency: 'NGN' },
        'success',
      ),
    );
    await h.service.handleWebhook('FLUTTERWAVE', {
      id: 77,
      TransactionId: 456,
      AmountRefunded: 113000,
      status: 'completed',
      meta: JSON.stringify({ disburse_status: 'failed' }),
    });
    expect(h.row.status).toBe('NEEDS_ATTENTION');
    expect(h.tx.customOrder.update).not.toHaveBeenCalled();
  });

  it('recovers stale submissions into attention without starting a second provider refund', async () => {
    const h = harness({ status: 'SUBMITTING' });
    h.tx.customOrderQueueRefund.findMany
      .mockResolvedValueOnce([{ id: h.row.id }] as never)
      .mockResolvedValueOnce([]);
    global.fetch = jest.fn();
    const result = await h.service.processPending();
    expect(result.attention).toBe(1);
    expect(h.row.status).toBe('NEEDS_ATTENTION');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
