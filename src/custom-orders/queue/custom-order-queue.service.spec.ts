import { Prisma } from '@prisma/client';
import { CustomOrderQueueService } from './custom-order-queue.service';

const NOW = new Date('2026-10-18T12:00:00.000Z');
const hour = 3600000;
const order = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  brandId: 'brand',
  buyerId: 'buyer',
  lane: 'PENDING',
  status: 'QUEUED',
  paymentStatus: 'PAID',
  paymentReference: 'shared-capture',
  currency: 'NGN',
  orderRevision: 0,
  retainCount: 0,
  queuePosition: 1,
  queuePriority: 0,
  adminPromotionHeld: false,
  cancelledAt: null,
  queuedAt: NOW,
  createdAt: NOW,
  queueExpiresAt: new Date(+NOW + 36 * hour),
  jumpFeeAmount: new Prisma.Decimal(0),
  productionLeadDaysSnapshot: 7,
  deliveryMaxDaysSnapshot: 3,
  buyerPriceSummaryJson: {
    grandTotal: 132500,
    outfitTotal: 100000,
    vatAmount: 7500,
    shippingFee: 5000,
    queueJumpFee: 20000,
  },
  ...overrides,
});

function matches(
  row: Record<string, any>,
  where: Record<string, any> = {},
): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((part) => matches(row, part));
    if (key === 'AND') return expected.every((part) => matches(row, part));
    const value = row[key];
    if (
      expected &&
      typeof expected === 'object' &&
      !(expected instanceof Date)
    ) {
      return Object.entries(expected).every(
        ([operator, operand]: [string, any]) => {
          if (operator === 'in') return operand.includes(value);
          if (operator === 'not') return value !== operand;
          if (operator === 'lt') return value != null && value < operand;
          if (operator === 'lte') return value != null && value <= operand;
          if (operator === 'gt') return value != null && value > operand;
          if (operator === 'gte') return value != null && value >= operand;
          return true;
        },
      );
    }
    return value instanceof Date && expected instanceof Date
      ? +value === +expected
      : value === expected;
  });
}

function harness(initial: ReturnType<typeof order>[], cap = 0, streak = 0) {
  const rows = new Map<string, any>(initial.map((row) => [row.id, { ...row }]));
  const refunds: any[] = [];
  const allocations = initial.map((row) => ({
    customOrderId: row.id,
    allocationType: 'PLACEMENT_CAPTURE',
    status: 'HELD',
  }));
  const parent = {
    id: 'attempt',
    reference: 'shared-capture',
    status: 'PAID',
    currency: 'NGN',
    amount: new Prisma.Decimal(265000),
  };
  const brand = {
    id: 'brand',
    ownerId: 'brand-owner',
    queuePriorityStreak: streak,
    queueJumpEnabled: true,
  };
  const locks: string[] = [];
  const find = ({ where, orderBy, take }: any = {}) => {
    let values = [...rows.values()].filter((row) => matches(row, where));
    const sort = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    values.sort((left, right) => {
      for (const rule of sort) {
        const [key, direction] = Object.entries(rule)[0];
        const a = left[key],
          b = right[key];
        if (a < b) return direction === 'desc' ? 1 : -1;
        if (a > b) return direction === 'desc' ? -1 : 1;
      }
      return 0;
    });
    if (take) values = values.slice(0, take);
    return values.map((row) => ({ ...row }));
  };
  const apply = (row: any, data: any) =>
    Object.fromEntries(
      Object.entries(data).map(([key, value]: [string, any]) => [
        key,
        value && typeof value === 'object' && 'increment' in value
          ? row[key] + value.increment
          : value,
      ]),
    );
  const tx = {
    customOrder: {
      findFirst: jest.fn(async (args) => find(args)[0] ?? null),
      findUnique: jest.fn(async ({ where }) =>
        rows.has(where.id) ? { ...rows.get(where.id)! } : null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }) => {
        if (!rows.has(where.id)) throw new Error('not found');
        return { ...rows.get(where.id)! };
      }),
      findMany: jest.fn(async (args) => find(args)),
      count: jest.fn(async (args) => find(args).length),
      aggregate: jest.fn(async () => ({
        _max: {
          queuePosition: Math.max(
            0,
            ...[...rows.values()].map((row) => row.queuePosition),
          ),
        },
      })),
      update: jest.fn(async ({ where, data }) => {
        const current = rows.get(where.id)!;
        const next = { ...current, ...apply(current, data) };
        rows.set(where.id, next);
        return { ...next };
      }),
      updateMany: jest.fn(async ({ where, data }) => {
        const values = find({ where });
        for (const row of values)
          rows.set(row.id, { ...row, ...apply(row, data) });
        return { count: values.length };
      }),
    },
    brand: {
      findUnique: jest.fn(async () => brand),
      update: jest.fn(async ({ data }) => Object.assign(brand, data)),
    },
    paymentAttempt: {
      findUnique: jest.fn(async () => parent),
      findFirst: jest.fn(async () => parent),
      update: jest.fn(),
    },
    customOrderQueueRefund: {
      findMany: jest.fn(async () => []),
      aggregate: jest.fn(async () => ({
        _sum: {
          amount: refunds.reduce((sum, row) => sum + Number(row.amount), 0),
        },
      })),
      create: jest.fn(async ({ data }) => {
        refunds.push({ ...data });
        return data;
      }),
      findFirstOrThrow: jest.fn(async ({ where }) =>
        refunds.find((row) => row.customOrderId === where.customOrderId),
      ),
    },
    customOrderLedgerAllocation: {
      updateMany: jest.fn(async ({ where, data }) => {
        const values = allocations.filter((row) => matches(row, where));
        values.forEach((row) => Object.assign(row, data));
        return { count: values.length };
      }),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }) => data),
      createMany: jest.fn(async ({ data }) => {
        if (allocations.some((row) => row.customOrderId === data.customOrderId && row.allocationType === data.allocationType)) return { count: 0 };
        allocations.push({ ...data });
        return { count: 1 };
      }),
    },
    customOrderNotificationOutbox: {
      createMany: jest.fn(async () => ({ count: 1 })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    customOrderTimelineEvent: { create: jest.fn(async () => ({})) },
    adminAuditLog: { create: jest.fn(async () => ({})) },
    $queryRaw: jest.fn(async (query: TemplateStringsArray | Prisma.Sql) => {
      const text = Array.isArray(query) ? query.join('?') : (query as Prisma.Sql).sql;
      locks.push(text);
      if (text.includes('FROM "CustomOrder" o JOIN "Brand" b')) {
        const id = (query as Prisma.Sql).values[0] as string;
        const row = rows.get(id);
        return row ? [{ ...row, brandOwnerId: brand.ownerId }] : [];
      }
      return text.includes('NOW()') || text.includes('clock_timestamp()')
        ? [{ now: NOW }]
        : text.includes('Brand')
          ? [{ id: 'brand', _id: 'brand' }]
          : [];
    }),
  };
  let serial = Promise.resolve();
  const prisma = {
    ...tx,
    $transaction: jest.fn((work) => {
      const run = serial.then(async () => {
        const before = new Map([...rows].map(([id, row]) => [id, { ...row }]));
        const refundCount = refunds.length;
        try {
          return await work(tx);
        } catch (error) {
          rows.clear();
          before.forEach((row, id) => rows.set(id, row));
          refunds.splice(refundCount);
          throw error;
        }
      });
      serial = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    }),
  };
  const finance = { applyPaidSettlement: jest.fn(async () => undefined) };
  const ledger = { postTransaction: jest.fn(async () => undefined) };
  const permissions = { assertPermission: jest.fn(async () => undefined) };
  const service = new CustomOrderQueueService(
    prisma as any,
    permissions as any,
    finance as any,
    ledger as any,
  );
  jest.spyOn(service, 'capacity').mockImplementation(
    async () =>
      ({
        brand,
        active: cap,
        inDelivery: 5,
        safetyAllowed: true,
        intakeAllowed: true,
        queueJumpAllowed: true,
      }) as any,
  );
  jest
    .spyOn(service, 'present')
    .mockImplementation(
      async (ids) =>
        Object.fromEntries(ids.map((id) => [id, { ...rows.get(id) }])) as any,
    );
  return {
    service,
    prisma,
    tx,
    rows,
    refunds,
    allocations,
    parent,
    brand,
    finance,
    ledger,
    locks,
    permissions,
  };
}

describe('custom order queue transaction boundaries', () => {
  it('prevents a different shopper or unauthorized staff member from reading or cancelling an order', async () => {
    const h = harness([order('private-order')]);
    h.permissions.assertPermission.mockRejectedValue(
      new Error('Access denied'),
    );
    await expect(
      h.service.get('different-shopper', 'private-order'),
    ).rejects.toThrow('Access denied');
    await expect(
      h.service.cancel('unassigned-staff', 'private-order', 'Cancel this'),
    ).rejects.toThrow('Access denied');
    expect(h.refunds).toHaveLength(0);
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects a batch containing another shopper order without presenting any records', async () => {
    const h = harness([
      order('own'),
      order('other', { buyerId: 'another-buyer' }),
    ]);
    (h.prisma as any).user = {
      findUnique: jest.fn(async () => ({ type: 'REGULAR' })),
    };
    await expect(h.service.batch('buyer', ['own', 'other'])).rejects.toThrow(
      'Not authorized',
    );
    expect(h.service.present).not.toHaveBeenCalled();
  });
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
  });
  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('allows one concurrent retain and rejects the stale revision without changing position or priority', async () => {
    const h = harness([order('one', { queuePosition: 8, queuePriority: 1 })]);
    const oldExpiry = h.rows.get('one')!.queueExpiresAt;
    const results = await Promise.allSettled([
      h.service.retain('buyer', 'one', 0),
      h.service.retain('buyer', 'one', 0),
    ]);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(
      results.filter((result) => result.status === 'rejected'),
    ).toHaveLength(1);
    const row = h.rows.get('one')!;
    expect(row.retainCount).toBe(1);
    expect(+row.queueExpiresAt).toBe(+oldExpiry + 42 * 24 * hour);
    expect([row.queuePosition, row.queuePriority]).toEqual([8, 1]);
    expect(h.locks.filter((sql) => sql.includes('FOR UPDATE'))).toHaveLength(2);
  });

  it('requires the requesting shopper to own the retained order', async () => {
    const h = harness([order('one')]);
    await expect(h.service.retain('other-buyer', 'one', 0)).rejects.toThrow(
      'Custom order not found',
    );
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['PENDING', 'UP_NEXT'])(
    'retains %s at the exact 12-hour close boundary',
    async (lane) => {
      const h = harness([
        order('one', { lane, queueExpiresAt: new Date(+NOW + 12 * hour) }),
      ]);
      await h.service.retain('buyer', 'one', 0);
      expect(h.rows.get('one')!.retainCount).toBe(1);
    },
  );

  it('protects the incumbent Up Next even when a paid jump arrives', async () => {
    const h = harness(
      [
        order('active', { lane: 'ACTIVE' }),
        order('incumbent', { lane: 'UP_NEXT', queuePosition: 9 }),
        order('jump', { queuePriority: 1, queuePosition: 1 }),
      ],
      1,
    );
    await h.service.drain(h.tx as any, 'brand', NOW);
    expect(h.rows.get('incumbent')!.lane).toBe('UP_NEXT');
    expect(h.rows.get('jump')!.lane).toBe('PENDING');
    expect(h.finance.applyPaidSettlement).not.toHaveBeenCalled();
  });

  it('preserves paid FIFO and activates one ordinary order after two priority orders', async () => {
    const h = harness(
      [
        order('ordinary', { queuePosition: 0 }),
        order('paid-3', { queuePriority: 1, queuePosition: 3 }),
        order('paid-1', { queuePriority: 1, queuePosition: 1 }),
        order('paid-2', { queuePriority: 1, queuePosition: 2 }),
      ],
      3,
    );
    await h.service.drain(h.tx as any, 'brand', NOW);
    const activations = h.tx.customOrder.update.mock.calls
      .filter(([args]) => args.data.lane === 'ACTIVE')
      .map(([args]) => args.where.id);
    expect(activations).toEqual(['paid-1', 'paid-2', 'ordinary']);
    expect(h.rows.get('paid-3')!.lane).toBe('UP_NEXT');
    expect(
      [...h.rows.values()].filter((row) => row.lane === 'UP_NEXT'),
    ).toHaveLength(1);
  });

  it('promotes forty orders with bounded candidate reads and no per-order brand metadata lookup', async () => {
    const h = harness(
      Array.from({ length: 40 }, (_, i) =>
        order(`order-${i}`, { queuePosition: i }),
      ),
      40,
    );
    await h.service.drain(h.tx as any, 'brand', NOW);
    expect(
      [...h.rows.values()].filter((row) => row.lane === 'ACTIVE'),
    ).toHaveLength(40);
    expect(h.tx.customOrder.findFirst).toHaveBeenCalledTimes(1);
    expect(h.tx.customOrder.findMany).toHaveBeenCalledTimes(2);
    expect(h.service.capacity).toHaveBeenCalledTimes(1);
    expect(h.tx.brand.findUnique).not.toHaveBeenCalled();
    expect(h.finance.applyPaidSettlement).toHaveBeenCalledTimes(40);
  });

  it('starts production promises at activation and not during paid waiting', async () => {
    const h = harness(
      [order('one', { queuedAt: new Date(+NOW - 20 * 24 * hour) })],
      1,
    );
    await h.service.drain(h.tx as any, 'brand', NOW);
    const row = h.rows.get('one')!;
    expect(+row.activatedAt).toBe(+NOW);
    expect(+row.promisedProductionAt).toBe(+NOW + 7 * 24 * hour);
    expect(row.queueExpiresAt).toBeNull();
    expect(h.finance.applyPaidSettlement).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ releaseEligibleAt: NOW }),
    );
  });

  it('leaves an expired waiter for cancellation and never promotes it', async () => {
    const h = harness([order('expired', { queueExpiresAt: NOW })], 1);
    await h.service.drain(h.tx as any, 'brand', NOW);
    expect(h.rows.get('expired')!.lane).toBe('PENDING');
    expect(h.finance.applyPaidSettlement).not.toHaveBeenCalled();
  });

  it('does not let a newly paid arrival bypass older eligible waiters', async () => {
    const h = harness(
      [
        order('older', { queuePosition: 1 }),
        order('arrival', {
          lane: null,
          queuePosition: null,
          buyerPriceSummaryJson: {
            grandTotal: 112500,
            outfitTotal: 100000,
            vatAmount: 7500,
            shippingFee: 5000,
            queueJumpFee: 0,
          },
        }),
      ],
      0,
    );
    (h.tx as any).user = {
      findUnique: jest.fn(async () => ({ type: 'REGULAR', status: 'ACTIVE' })),
    };
    await h.service.admitPaid(h.tx as any, 'arrival');
    expect(h.rows.get('older')!.lane).toBe('UP_NEXT');
    expect(h.rows.get('arrival')!.lane).toBe('PENDING');
    expect(h.finance.applyPaidSettlement).toHaveBeenCalledWith(
      h.tx,
      expect.objectContaining({ queueHold: true }),
    );
    expect(h.tx.brand.findUnique).not.toHaveBeenCalled();
    await h.service.admitPaid(h.tx as any, 'arrival');
    expect(h.finance.applyPaidSettlement).toHaveBeenCalledTimes(1);
  });

  it('leaves unpaid orders without a lane while promoting eligible paid demand', async () => {
    const h = harness(
      [
        order('unpaid', {
          lane: null,
          paymentStatus: 'PENDING',
          status: 'PENDING_PAYMENT',
          queuePosition: null,
        }),
        order('paid'),
      ],
      0,
    );
    await h.service.drain(h.tx as any, 'brand', NOW);
    expect(h.rows.get('unpaid')).toMatchObject({
      lane: null,
      paymentStatus: 'PENDING',
      status: 'PENDING_PAYMENT',
    });
    expect(h.rows.get('paid')!.lane).toBe('UP_NEXT');
  });

  it('makes demoting the sole Up Next a durable visible hold without removing retain/cancel rights', async () => {
    const h = harness([order('one', { lane: 'UP_NEXT' })], 1);
    const original = h.rows.get('one')!.queueExpiresAt;
    await h.service.reorder(
      'one',
      'demote',
      'admin',
      'Pause promotion for review',
    );
    expect(h.rows.get('one')!.lane).toBe('PENDING');
    expect(h.rows.get('one')!.adminPromotionHeld).toBe(true);
    expect(h.rows.get('one')!.queueExpiresAt).toEqual(original);
    expect(h.tx.adminAuditLog.create).toHaveBeenCalled();
    await h.service.retain('buyer', 'one', 1);
    expect(h.rows.get('one')!.adminPromotionHeld).toBe(true);
    await h.service.cancel('buyer', 'one', 'Do not wait', 2);
    expect(h.rows.get('one')!.lane).toBe('TERMINAL');
    expect(h.refunds).toHaveLength(1);
  });

  it('expires both waiting lanes with deductions even if reminders failed or could not be delivered', async () => {
    const h = harness([
      order('pending', { queueExpiresAt: NOW }),
      order('up', { lane: 'UP_NEXT', queueExpiresAt: new Date(+NOW - hour) }),
    ]);
    h.tx.customOrderNotificationOutbox.updateMany.mockResolvedValue({
      count: 0,
    });
    await h.service.sweep();
    expect(h.service.present).not.toHaveBeenCalled();
    expect([...h.rows.values()].every((row) => row.lane === 'TERMINAL')).toBe(
      true,
    );
    expect(h.refunds.map((row) => row.amount)).toEqual([113000, 113000]);
    expect(h.rows.get('pending')!.cancellationActorType).toBe('SYSTEM');
    expect(h.rows.get('up')!.cancellationActorType).toBe('SYSTEM');
  });

  it('cancels only one mixed-checkout sibling, durably reserves its refund and makes retries idempotent', async () => {
    const h = harness([order('one'), order('sibling', { queuePosition: 2 })]);
    await h.service.cancel('buyer', 'one', 'No longer needed', 0);
    await h.service.cancel('buyer', 'one', 'Duplicate callback', 0);
    expect(h.refunds).toHaveLength(1);
    expect(h.refunds[0].amount).toBe(113000);
    expect(h.rows.get('sibling')!.paymentStatus).toBe('PAID');
    expect(
      h.allocations.find((row) => row.customOrderId === 'one')!.status,
    ).toBe('REVERSED');
    expect(
      h.allocations.find((row) => row.customOrderId === 'sibling')!.status,
    ).toBe('HELD');
    expect(h.parent.status).toBe('PAID');
    expect(h.tx.paymentAttempt.update).not.toHaveBeenCalled();
    expect(h.locks[0]).toContain('PaymentAttempt');
    expect(h.locks[1]).toContain('Brand');
  });

  it('keeps bulk cancellation authorization and per-order failures without unused queue responses', async () => {
    const h = harness([order('one'), order('active', { lane: 'ACTIVE' })]);
    const result = await h.service.cancelMany('brand-owner', 'brand', ['one', 'active'], 'Cancel selection');
    expect(result.results).toEqual([
      { id: 'one', cancelled: true },
      { id: 'active', cancelled: false, message: 'CUSTOM_ORDER_NO_LONGER_WAITING' },
    ]);
    expect(h.permissions.assertPermission).toHaveBeenCalledTimes(3);
    expect(h.service.present).not.toHaveBeenCalled();
    expect(h.tx.brand.findUnique).not.toHaveBeenCalled();
    expect(h.refunds).toHaveLength(1);
  });

  it('keeps the public cancellation response while refusing stale revisions', async () => {
    const h = harness([order('one')]);
    await expect(h.service.cancel('buyer', 'one', 'Cancel', 4)).rejects.toThrow('CUSTOM_ORDER_CHANGED_REFRESH_REQUIRED');
    expect(h.refunds).toHaveLength(0);
    expect(h.service.present).not.toHaveBeenCalled();
    expect(await h.service.cancel('buyer', 'one', 'Cancel', 0)).toMatchObject({ queue: { lane: 'TERMINAL' } });
    expect(h.service.present).toHaveBeenCalledTimes(1);
  });

  it('releases a priority fee without an existence lookup and preserves the allocation on replay', async () => {
    const h = harness([order('priority', { jumpFeeAmount: new Prisma.Decimal(20) })]);
    await (h.service as any).releaseJump(h.tx, h.rows.get('priority'));
    await (h.service as any).releaseJump(h.tx, h.rows.get('priority'));
    expect(h.tx.customOrderLedgerAllocation.findFirst).not.toHaveBeenCalled();
    expect(h.allocations.filter((row) => row.allocationType === 'JUMP_FEE')).toEqual([
      expect.objectContaining({ amount: 20, commissionAmount: 2, netBrandAmount: 18, status: 'PAYOUT_ELIGIBLE' }),
    ]);
    expect(h.ledger.postTransaction).toHaveBeenCalledWith(h.tx, expect.objectContaining({ idempotencyKey: 'ledger:custom-order:priority:jump_release' }));
  });

  it('rejects sibling refunds whose cumulative amount would exceed the shared capture', async () => {
    const h = harness([order('one')]);
    h.parent.amount = new Prisma.Decimal(200000);
    h.refunds.push({ customOrderId: 'previous-sibling', amount: 100000 });
    await expect(h.service.cancel('buyer', 'one', 'Cancel', 0)).rejects.toThrow(
      'CUSTOM_ORDER_REFUND_EXCEEDS_CAPTURE',
    );
    expect(h.refunds).toHaveLength(1);
    expect(h.rows.get('one')!.lane).toBe('PENDING');
    expect(h.tx.customOrderLedgerAllocation.updateMany).not.toHaveBeenCalled();
  });
});

describe('paid custom-order intake entitlement', () => {
  const now = new Date('2026-10-23T12:00:00Z');
  const tier = {
    key: 'THREAD',
    maxActive: 2,
    maxInDelivery: 2,
    queueJumpAllowed: false,
  };
  function setup(agreement: any = null, brandPatch: any = {}) {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          id: 'brand',
          ownerId: 'owner',
          ownerStatus: brandPatch.owner?.status ?? 'ACTIVE',
          verificationStatus: 'APPROVED',
          activeOrderCapOverride: null,
          activeOrderCapOverrideUntil: null,
          customOrderIntakeBlockedAt: null,
          agreementId: agreement ? 'agreement' : null,
          agreementStatus: agreement?.status ?? null,
          agreementPeriodEnd: agreement?.currentPeriodEnd ?? null,
          tierKey: tier.key,
          maxActive: tier.maxActive,
          maxInDelivery: tier.maxInDelivery,
          queueJumpAllowed: tier.queueJumpAllowed,
          deltaActive: 0,
          ...brandPatch,
        },
      ]),
      brand: {
        findUnique: jest
          .fn()
          .mockResolvedValue({
            ownerId: 'owner',
            owner: { status: 'ACTIVE' },
            verificationStatus: 'APPROVED',
            activeOrderCapOverride: null,
            customOrderIntakeBlockedAt: null,
            ...brandPatch,
          }),
      },
      brandSubscription: { findFirst: jest.fn().mockResolvedValue(agreement) },
      subscriptionTier: { findUnique: jest.fn().mockResolvedValue(tier) },
      capacityCampaign: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    return {
      prisma,
      service: new CustomOrderQueueService(
        prisma,
        {} as any,
        {} as any,
        {} as any,
      ),
    };
  }
  it('offers Thread capacity without granting intake to an unsubscribed brand', async () => {
    const h = setup();
    expect(await h.service.capacity(h.prisma, 'brand', now)).toMatchObject({
      tierKey: 'THREAD',
      active: 2,
      inDelivery: 2,
      intakeAllowed: false,
    });
    expect(h.prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(h.prisma.subscriptionTier.findUnique).not.toHaveBeenCalled();
  });
  it.each(['PAST_DUE', 'CANCELLED'])(
    'blocks intake for %s while retaining the agreement capacity',
    async (status) => {
      const h = setup({
        status,
        currentPeriodEnd: new Date(+now + 1000),
        tier,
      });
      expect(await h.service.capacity(h.prisma, 'brand', now)).toMatchObject({
        active: 2,
        intakeAllowed: false,
      });
    },
  );
  it('grants intake only through the exact unexpired paid period', async () => {
    const h = setup({
      status: 'ACTIVE',
      currentPeriodEnd: new Date(+now + 1),
      tier,
    });
    expect(
      (await h.service.capacity(h.prisma, 'brand', now)).intakeAllowed,
    ).toBe(true);
    expect(
      (await h.service.capacity(h.prisma, 'brand', new Date(+now + 1)))
        .intakeAllowed,
    ).toBe(false);
  });
  it.each([
    { owner: { status: 'SUSPENDED' } },
    { verificationStatus: 'PENDING' },
    { customOrderIntakeBlockedAt: now },
  ])('keeps safety enforcement for paid brands %j', async (patch) => {
    const h = setup(
      { status: 'ACTIVE', currentPeriodEnd: new Date(+now + 1000), tier },
      patch,
    );
    expect(
      (await h.service.capacity(h.prisma, 'brand', now)).intakeAllowed,
    ).toBe(false);
  });
  it('preserves a current admin capacity override without opening unpaid intake', async () => {
    const h = setup(null, { activeOrderCapOverride: 8 });
    expect(await h.service.capacity(h.prisma, 'brand', now)).toMatchObject({
      active: 8,
      intakeAllowed: false,
    });
  });
});
