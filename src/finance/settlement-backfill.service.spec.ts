import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  EscrowHoldStatus,
  PaymentStatus,
  Prisma,
  SettlementReleaseMode,
} from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SettlementBackfillService } from './settlement-backfill.service';

const now = new Date('2026-05-05T12:00:00.000Z');

function decimal(value: number) {
  return new Prisma.Decimal(value.toFixed(2));
}

function makeHold(overrides: Record<string, unknown> = {}) {
  return {
    id: 'hold_1',
    orderId: 'order_1',
    brandId: 'brand_1',
    buyerId: 'buyer_1',
    totalAmount: decimal(1000),
    commissionRate: decimal(10),
    commissionAmount: decimal(100),
    netBrandAmount: decimal(900),
    currency: 'NGN',
    status: EscrowHoldStatus.HELD,
    firstReleaseAmount: decimal(0),
    firstReleaseCommissionAmount: decimal(0),
    firstReleaseNetAmount: decimal(0),
    secondReleaseAmount: decimal(1000),
    secondReleaseCommissionAmount: decimal(100),
    secondReleaseNetAmount: decimal(900),
    firstReleasedAt: null,
    secondReleaseEligibleAt: null,
    secondReleaseCondition: null,
    secondReleasedAt: null,
    frozenAt: null,
    frozenById: null,
    frozenReason: null,
    refundedAt: null,
    refundReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeAllocation(
  type: CustomOrderLedgerAllocationType,
  amount: number,
  overrides: Record<string, unknown> = {},
) {
  const commissionAmount = amount * 0.1;
  return {
    id: `${type}_${Math.random()}`,
    customOrderId: 'custom_1',
    payoutId: null,
    allocationType: type,
    amount: decimal(amount),
    commissionRate: decimal(10),
    commissionAmount: decimal(commissionAmount),
    netBrandAmount: decimal(amount - commissionAmount),
    currency: 'NGN',
    status: CustomOrderLedgerAllocationStatus.HELD,
    eligibleAt: null,
    paidOutAt: null,
    reversedAt: null,
    reversalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeCustomOrder(overrides: Record<string, unknown> = {}) {
  const ledgerAllocations = (overrides.ledgerAllocations as unknown[]) ?? [
    makeAllocation(
      CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
      600,
    ),
    makeAllocation(
      CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
      400,
    ),
  ];

  return {
    id: 'custom_1',
    brandId: 'brand_1',
    paymentStatus: PaymentStatus.PAID,
    status: CustomOrderStatus.ACCEPTED,
    buyerPriceSummaryJson: { grandTotal: 1000 },
    acceptedAt: now,
    createdAt: now,
    ledgerAllocations,
    disputes: [],
    ...overrides,
  };
}

function buildHarness(
  params: {
    holds?: any[];
    customOrders?: any[];
    snapshots?: any[];
    allocations?: any[];
  } = {},
) {
  const holds = params.holds ?? [];
  const customOrders = params.customOrders ?? [];
  const snapshots = params.snapshots ?? [];
  const allocations =
    params.allocations ??
    customOrders.flatMap((order) => order.ledgerAllocations ?? []);

  const settlementSnapshot = {
    findMany: jest.fn(async ({ where }: any) => {
      if (where.orderId) {
        return snapshots.filter((snapshot) => snapshot.orderId);
      }
      if (where.customOrderId) {
        return snapshots.filter((snapshot) => snapshot.customOrderId);
      }
      return snapshots;
    }),
    findFirst: jest.fn(async ({ where }: any) => {
      if (where.orderId !== undefined) {
        return (
          snapshots.find((snapshot) => snapshot.orderId === where.orderId) ??
          null
        );
      }
      if (where.customOrderId !== undefined) {
        return (
          snapshots.find(
            (snapshot) => snapshot.customOrderId === where.customOrderId,
          ) ?? null
        );
      }
      return null;
    }),
    create: jest.fn(async ({ data }: any) => {
      const duplicate = snapshots.find(
        (snapshot) =>
          (data.orderId && snapshot.orderId === data.orderId) ||
          (data.customOrderId && snapshot.customOrderId === data.customOrderId),
      );
      if (duplicate) {
        const error: any = new Error('Unique constraint failed');
        error.code = 'P2002';
        throw error;
      }
      const created = {
        id: `snapshot_${snapshots.length + 1}`,
        ...data,
        createdAt: now,
      };
      snapshots.push(created);
      return created;
    }),
    update: jest.fn(),
  };

  const tx = { settlementSnapshot };
  const prisma = {
    settlementSnapshot,
    escrowHold: {
      findMany: jest.fn(async ({ where }: any) => {
        const notIn = where.orderId?.notIn ?? [];
        return holds.filter(
          (hold) => hold.orderId && !notIn.includes(hold.orderId),
        );
      }),
    },
    customOrder: {
      findMany: jest.fn(async ({ where }: any) => {
        const notIn = where.id?.notIn ?? [];
        return customOrders.filter((order) => !notIn.includes(order.id));
      }),
    },
    customOrderLedgerAllocation: {
      findMany: jest.fn(async () => allocations),
    },
    ledgerTransaction: {
      create: jest.fn(),
      update: jest.fn(),
    },
    payout: {
      update: jest.fn(),
    },
    $transaction: jest.fn(async (callback: (client: any) => Promise<unknown>) =>
      callback(tx),
    ),
  };

  const systemConfigService = {
    getNumber: jest.fn(async (key: string) => {
      if (key === 'finance.standardEscrow.settlementHours') {
        return 48;
      }
      if (key === 'finance.standardEscrow.autoReleaseDays') {
        return 7;
      }
      return 0;
    }),
  };
  const service = new SettlementBackfillService(
    prisma as unknown as PrismaService,
    systemConfigService as unknown as SystemConfigService,
  );

  return { service, prisma, snapshots };
}

describe('SettlementBackfillService', () => {
  it('classifies a standard HELD hold without snapshot as safe and backfills from hold values', async () => {
    const { service, prisma, snapshots } = buildHarness({
      holds: [makeHold()],
    });

    const report = await service.auditAndBackfill({
      orderType: 'standard',
      write: true,
    });

    expect(report.standard.records[0]).toMatchObject({
      escrowHoldId: 'hold_1',
      orderId: 'order_1',
      backfillSafe: true,
      releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
    });
    expect(report.standard.summary.created).toBe(1);
    expect(snapshots[0]).toMatchObject({
      orderId: 'order_1',
      grossAmount: decimal(1000),
      upfrontReleaseGrossAmount: decimal(0),
      finalReleaseGrossAmount: decimal(1000),
    });
    expect(prisma.ledgerTransaction.create).not.toHaveBeenCalled();
  });

  it('classifies a standard PARTIALLY_RELEASED hold as safe and mirrors split values', async () => {
    const { service, snapshots } = buildHarness({
      holds: [
        makeHold({
          status: EscrowHoldStatus.PARTIALLY_RELEASED,
          firstReleaseAmount: decimal(300),
          firstReleaseCommissionAmount: decimal(30),
          firstReleaseNetAmount: decimal(270),
          secondReleaseAmount: decimal(700),
          secondReleaseCommissionAmount: decimal(70),
          secondReleaseNetAmount: decimal(630),
          firstReleasedAt: now,
        }),
      ],
    });

    const report = await service.auditAndBackfill({
      orderType: 'standard',
      write: true,
    });

    expect(report.standard.records[0].backfillSafe).toBe(true);
    expect(report.standard.records[0].releaseMode).toBe(
      SettlementReleaseMode.SPLIT_RELEASE,
    );
    expect(snapshots[0]).toMatchObject({
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseGrossAmount: decimal(300),
      finalReleaseGrossAmount: decimal(700),
    });
  });

  it('skips an inconsistent standard hold', async () => {
    const { service, prisma } = buildHarness({
      holds: [
        makeHold({
          firstReleaseAmount: decimal(200),
          secondReleaseAmount: decimal(700),
        }),
      ],
    });

    const report = await service.auditAndBackfill({
      orderType: 'standard',
      write: true,
    });

    expect(report.standard.records[0].backfillSafe).toBe(false);
    expect(report.standard.records[0].unsafeReasons).toContain(
      'Release gross amounts do not sum to totalAmount',
    );
    expect(report.standard.summary.created).toBe(0);
    expect(prisma.settlementSnapshot.create).not.toHaveBeenCalled();
  });

  it('classifies a custom order with both allocations as safe and backfills from allocation values', async () => {
    const customOrder = makeCustomOrder();
    const { service, snapshots } = buildHarness({
      customOrders: [customOrder],
    });

    const report = await service.auditAndBackfill({
      orderType: 'custom',
      write: true,
    });

    expect(report.custom.records[0]).toMatchObject({
      customOrderId: 'custom_1',
      backfillSafe: true,
      allocationState: 'both allocation types exist',
    });
    expect(report.custom.summary.created).toBe(1);
    expect(snapshots[0]).toMatchObject({
      customOrderId: 'custom_1',
      grossAmount: decimal(1000),
      upfrontReleaseGrossAmount: decimal(600),
      finalReleaseGrossAmount: decimal(400),
    });
  });

  it('skips a custom order with one missing allocation', async () => {
    const { service, prisma } = buildHarness({
      customOrders: [
        makeCustomOrder({
          ledgerAllocations: [
            makeAllocation(
              CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
              600,
            ),
          ],
        }),
      ],
    });

    const report = await service.auditAndBackfill({
      orderType: 'custom',
      write: true,
    });

    expect(report.custom.records[0]).toMatchObject({
      backfillSafe: false,
      allocationState: 'only BRAND_ACCEPTANCE_PORTION exists',
    });
    expect(report.custom.records[0].unsafeReasons).toContain(
      'Missing FINAL_COMPLETION_PORTION allocation',
    );
    expect(prisma.settlementSnapshot.create).not.toHaveBeenCalled();
  });

  it('flags duplicate custom-order allocation types', async () => {
    const allocations = [
      makeAllocation(
        CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
        600,
        { id: 'allocation_1', createdAt: new Date('2026-05-05T10:00:00Z') },
      ),
      makeAllocation(
        CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
        600,
        {
          id: 'allocation_2',
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: now,
          createdAt: new Date('2026-05-05T11:00:00Z'),
        },
      ),
    ];
    const { service } = buildHarness({
      customOrders: [makeCustomOrder({ ledgerAllocations: allocations })],
      allocations,
    });

    const report = await service.auditAndBackfill({ orderType: 'custom' });

    expect(report.custom.records[0]).toMatchObject({
      backfillSafe: false,
      allocationState: 'duplicate allocation types exist',
    });
    expect(report.duplicateAllocations.groups).toHaveLength(1);
    expect(report.duplicateAllocations.groups[0]).toMatchObject({
      customOrderId: 'custom_1',
      allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
      count: 2,
      hasPayoutOrReleaseMarkers: true,
    });
    expect(report.duplicateAllocations.recommendation).toContain(
      'Run a cleanup phase before adding a unique constraint',
    );
  });

  it('dry-run writes nothing', async () => {
    const { service, prisma } = buildHarness({
      holds: [makeHold()],
      customOrders: [makeCustomOrder()],
    });

    const report = await service.auditAndBackfill();

    expect(report.mode).toBe('dry-run');
    expect(report.standard.summary.safe).toBe(1);
    expect(report.custom.summary.safe).toBe(1);
    expect(prisma.settlementSnapshot.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('write mode creates snapshots only for safe records', async () => {
    const { service, snapshots } = buildHarness({
      holds: [
        makeHold({ id: 'safe_hold', orderId: 'safe_order' }),
        makeHold({
          id: 'unsafe_hold',
          orderId: 'unsafe_order',
          firstReleaseAmount: decimal(100),
          secondReleaseAmount: decimal(800),
        }),
      ],
    });

    const report = await service.auditAndBackfill({
      orderType: 'standard',
      write: true,
    });

    expect(report.standard.summary.safe).toBe(1);
    expect(report.standard.summary.unsafe).toBe(1);
    expect(report.standard.summary.created).toBe(1);
    expect(snapshots.map((snapshot) => snapshot.orderId)).toEqual([
      'safe_order',
    ]);
  });

  it('repeated write mode is idempotent and existing snapshots are not mutated', async () => {
    const existingSnapshot = {
      id: 'existing_snapshot',
      orderId: 'existing_order',
      customOrderId: null,
      grossAmount: decimal(1000),
    };
    const { service, prisma, snapshots } = buildHarness({
      holds: [
        makeHold({ id: 'existing_hold', orderId: 'existing_order' }),
        makeHold({ id: 'new_hold', orderId: 'new_order' }),
      ],
      snapshots: [existingSnapshot],
    });

    await service.auditAndBackfill({ orderType: 'standard', write: true });
    await service.auditAndBackfill({ orderType: 'standard', write: true });

    expect(prisma.settlementSnapshot.create).toHaveBeenCalledTimes(1);
    expect(prisma.settlementSnapshot.update).not.toHaveBeenCalled();
    expect(snapshots).toHaveLength(2);
    expect(snapshots[0]).toBe(existingSnapshot);
  });

  it('does not call ledger or payout mutation methods during backfill', async () => {
    const { service, prisma } = buildHarness({
      holds: [makeHold()],
      customOrders: [makeCustomOrder()],
    });

    await service.auditAndBackfill({ write: true });

    expect(prisma.ledgerTransaction.create).not.toHaveBeenCalled();
    expect(prisma.ledgerTransaction.update).not.toHaveBeenCalled();
    expect(prisma.payout.update).not.toHaveBeenCalled();
  });
});
