import {
  EscrowHoldStatus,
  EscrowReleaseCondition,
  Prisma,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';
import { StandardOrderEscrowService } from './standard-order-escrow.service';

const now = new Date('2026-05-05T10:00:00.000Z');

type HoldRow = {
  id: string;
  orderId: string | null;
  brandId: string;
  buyerId: string | null;
  totalAmount: Prisma.Decimal;
  commissionRate: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  netBrandAmount: Prisma.Decimal;
  currency: string;
  status: EscrowHoldStatus;
  firstReleaseAmount: Prisma.Decimal;
  firstReleaseCommissionAmount: Prisma.Decimal;
  firstReleaseNetAmount: Prisma.Decimal;
  secondReleaseAmount: Prisma.Decimal;
  secondReleaseCommissionAmount: Prisma.Decimal;
  secondReleaseNetAmount: Prisma.Decimal;
  firstReleasedAt: Date | null;
  secondReleaseEligibleAt: Date | null;
  secondReleaseCondition: EscrowReleaseCondition | null;
  secondReleasedAt: Date | null;
  frozenAt: Date | null;
  frozenById: string | null;
  frozenReason: string | null;
  refundedAt: Date | null;
  refundReason: string | null;
};

type SnapshotRow = {
  id: string;
  orderType: SettlementOrderType;
  orderId: string | null;
  customOrderId: string | null;
  brandId: string;
  grossAmount: Prisma.Decimal;
  currency: string;
  commissionRuleId: string | null;
  commissionSource: string | null;
  commissionRate: Prisma.Decimal;
  commissionAmount: Prisma.Decimal;
  brandNetAmount: Prisma.Decimal;
  settlementPolicyId: string | null;
  releaseMode: SettlementReleaseMode;
  upfrontReleaseEnabled: boolean;
  upfrontReleasePercent: Prisma.Decimal;
  upfrontReleaseGrossAmount: Prisma.Decimal;
  upfrontReleaseCommissionAmount: Prisma.Decimal;
  upfrontReleaseNetBrandAmount: Prisma.Decimal;
  finalReleaseGrossAmount: Prisma.Decimal;
  finalReleaseCommissionAmount: Prisma.Decimal;
  finalReleaseNetBrandAmount: Prisma.Decimal;
  settlementDelayHours: number;
  autoReleaseDays: number;
  finalReleaseTrigger: SettlementFinalReleaseTrigger;
  calculatedAt: Date;
  createdAt: Date;
};

function decimal(value: number | string) {
  return new Prisma.Decimal(Number(value).toFixed(2));
}

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order_1',
    brandId: 'brand_1',
    buyerId: 'buyer_1',
    createdAt: now,
    totalAmount: decimal(1000),
    ...overrides,
  };
}

function buildCalculation(
  input: {
    orderId?: string | null;
    brandId: string;
    grossAmount: number;
    currency: string;
  },
  mode: 'HOLD' | 'SPLIT' = 'HOLD',
) {
  const commissionAmount = roundMoney(input.grossAmount * 0.1);
  const brandNetAmount = roundMoney(input.grossAmount - commissionAmount);
  const upfrontPercent = mode === 'SPLIT' ? 30 : 0;
  const upfrontGross = roundMoney((input.grossAmount * upfrontPercent) / 100);
  const upfrontCommission = roundMoney(
    (commissionAmount * upfrontPercent) / 100,
  );
  const upfrontNet = roundMoney(upfrontGross - upfrontCommission);
  const finalGross = roundMoney(input.grossAmount - upfrontGross);
  const finalCommission = roundMoney(commissionAmount - upfrontCommission);
  const finalNet = roundMoney(finalGross - finalCommission);

  return {
    orderType: SettlementOrderType.STANDARD_ORDER,
    orderId: input.orderId ?? null,
    customOrderId: null,
    brandId: input.brandId,
    grossAmount: input.grossAmount,
    currency: input.currency,
    commissionRuleId: 'commission_1',
    commissionScope: 'PLATFORM',
    commissionSource: 'RULE',
    commissionRate: 10,
    commissionAmount,
    brandNetAmount,
    settlementPolicyId: mode === 'SPLIT' ? 'policy_split' : 'policy_hold',
    releaseMode:
      mode === 'SPLIT'
        ? SettlementReleaseMode.SPLIT_RELEASE
        : SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
    upfrontReleaseEnabled: mode === 'SPLIT',
    upfrontReleasePercent: upfrontPercent,
    upfrontReleaseGrossAmount: upfrontGross,
    upfrontReleaseCommissionAmount: upfrontCommission,
    upfrontReleaseNetBrandAmount: upfrontNet,
    finalReleaseGrossAmount: finalGross,
    finalReleaseCommissionAmount: finalCommission,
    finalReleaseNetBrandAmount: finalNet,
    settlementDelayHours: 48,
    autoReleaseDays: 7,
    finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
    calculatedAt: now,
  };
}

function snapshotFromCalculation(
  calculation: ReturnType<typeof buildCalculation>,
): SnapshotRow {
  return {
    id: `snapshot_${calculation.orderId}`,
    orderType: calculation.orderType,
    orderId: calculation.orderId,
    customOrderId: calculation.customOrderId,
    brandId: calculation.brandId,
    grossAmount: decimal(calculation.grossAmount),
    currency: calculation.currency,
    commissionRuleId: calculation.commissionRuleId,
    commissionSource: calculation.commissionSource,
    commissionRate: decimal(calculation.commissionRate),
    commissionAmount: decimal(calculation.commissionAmount),
    brandNetAmount: decimal(calculation.brandNetAmount),
    settlementPolicyId: calculation.settlementPolicyId,
    releaseMode: calculation.releaseMode,
    upfrontReleaseEnabled: calculation.upfrontReleaseEnabled,
    upfrontReleasePercent: decimal(calculation.upfrontReleasePercent),
    upfrontReleaseGrossAmount: decimal(calculation.upfrontReleaseGrossAmount),
    upfrontReleaseCommissionAmount: decimal(
      calculation.upfrontReleaseCommissionAmount,
    ),
    upfrontReleaseNetBrandAmount: decimal(
      calculation.upfrontReleaseNetBrandAmount,
    ),
    finalReleaseGrossAmount: decimal(calculation.finalReleaseGrossAmount),
    finalReleaseCommissionAmount: decimal(
      calculation.finalReleaseCommissionAmount,
    ),
    finalReleaseNetBrandAmount: decimal(calculation.finalReleaseNetBrandAmount),
    settlementDelayHours: calculation.settlementDelayHours,
    autoReleaseDays: calculation.autoReleaseDays,
    finalReleaseTrigger: calculation.finalReleaseTrigger,
    calculatedAt: calculation.calculatedAt,
    createdAt: now,
  };
}

function buildHarness(mode: 'HOLD' | 'SPLIT' = 'HOLD') {
  const holds: HoldRow[] = [];
  const snapshots = new Map<string, SnapshotRow>();
  const orders = new Map<string, any>();
  const ledgerTransactions = new Set<string>();

  const tx: any = {
    escrowHold: {
      upsert: jest.fn(async ({ where, update, create }: any) => {
        const existing = holds.find((hold) => hold.orderId === where.orderId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }

        const created: HoldRow = {
          id: `hold_${holds.length + 1}`,
          orderId: create.orderId,
          brandId: create.brandId,
          buyerId: create.buyerId ?? null,
          totalAmount: create.totalAmount,
          commissionRate: create.commissionRate,
          commissionAmount: create.commissionAmount,
          netBrandAmount: create.netBrandAmount,
          currency: create.currency,
          status: create.status,
          firstReleaseAmount: create.firstReleaseAmount,
          firstReleaseCommissionAmount: create.firstReleaseCommissionAmount,
          firstReleaseNetAmount: create.firstReleaseNetAmount,
          secondReleaseAmount: create.secondReleaseAmount,
          secondReleaseCommissionAmount: create.secondReleaseCommissionAmount,
          secondReleaseNetAmount: create.secondReleaseNetAmount,
          firstReleasedAt: null,
          secondReleaseEligibleAt: null,
          secondReleaseCondition: null,
          secondReleasedAt: null,
          frozenAt: null,
          frozenById: null,
          frozenReason: null,
          refundedAt: null,
          refundReason: null,
        };
        holds.push(created);
        return created;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        if (where.orderId !== undefined) {
          return holds.find((hold) => hold.orderId === where.orderId) ?? null;
        }
        return holds.find((hold) => hold.id === where.id) ?? null;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const hold =
          holds.find((candidate) => candidate.id === where.id) ??
          holds.find((candidate) => candidate.orderId === where.orderId);
        if (!hold) {
          return null;
        }
        Object.assign(hold, data);
        return hold;
      }),
      findMany: jest.fn(async ({ where, select }: any) => {
        return holds
          .filter((hold) => {
            if (where.status?.in && !where.status.in.includes(hold.status)) {
              return false;
            }
            if (where.refundedAt === null && hold.refundedAt) {
              return false;
            }
            if (where.secondReleasedAt === null && hold.secondReleasedAt) {
              return false;
            }
            if (
              where.secondReleaseEligibleAt?.lte &&
              (!hold.secondReleaseEligibleAt ||
                hold.secondReleaseEligibleAt >
                  where.secondReleaseEligibleAt.lte)
            ) {
              return false;
            }
            if (
              where.secondReleaseEligibleAt === null &&
              hold.secondReleaseEligibleAt
            ) {
              return false;
            }
            if (where.order?.is) {
              const order = orders.get(hold.orderId ?? '');
              if (!order) {
                return false;
              }
              if (
                where.order.is.status &&
                order.status !== where.order.is.status
              ) {
                return false;
              }
              if (
                where.order.is.buyerConfirmedDeliveryAt === null &&
                order.buyerConfirmedDeliveryAt
              ) {
                return false;
              }
              if (
                where.order.is.deliveredAt?.not === null &&
                !order.deliveredAt
              ) {
                return false;
              }
            }
            return true;
          })
          .map((hold) => {
            if (select?.order) {
              return {
                orderId: hold.orderId,
                order: {
                  deliveredAt:
                    orders.get(hold.orderId ?? '')?.deliveredAt ?? null,
                },
              };
            }
            return { id: hold.id };
          });
      }),
    },
    order: {
      update: jest.fn(async ({ where, data }: any) => {
        const current = orders.get(where.id) ?? { id: where.id };
        const updated = { ...current, ...data };
        orders.set(where.id, updated);
        return updated;
      }),
    },
    settlementSnapshot: {
      findFirst: jest.fn(async ({ where }: any) => {
        return snapshots.get(where.orderId) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (!data.orderId) {
          return null;
        }
        const created = { id: `snapshot_${data.orderId}`, ...data };
        snapshots.set(data.orderId, created);
        return created;
      }),
    },
  };

  const prisma: any = {
    ...tx,
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

  const ledgerService = {
    postStandardOrderPaymentReceived: jest.fn(
      async (_tx: any, hold: HoldRow) => {
        ledgerTransactions.add(`payment:${hold.orderId}`);
      },
    ),
    postStandardOrderShipmentRelease: jest.fn(
      async (_tx: any, hold: HoldRow) => {
        ledgerTransactions.add(`upfront:${hold.orderId}`);
      },
    ),
    postStandardOrderFinalRelease: jest.fn(async (_tx: any, hold: HoldRow) => {
      ledgerTransactions.add(`final:${hold.orderId}`);
    }),
    postStandardOrderRefund: jest.fn(async (_tx: any, hold: HoldRow) => {
      ledgerTransactions.add(`refund:${hold.orderId}`);
    }),
  };

  const calculatorService = {
    calculate: jest.fn(async (input: any) => buildCalculation(input, mode)),
  };

  const snapshotService = {
    createFromCalculation: jest.fn(async (calculation: any) => {
      const existing = snapshots.get(calculation.orderId);
      if (existing) {
        return existing;
      }
      const snapshot = snapshotFromCalculation(calculation);
      snapshots.set(calculation.orderId, snapshot);
      return snapshot;
    }),
    getByOrderId: jest.fn(
      async (orderId: string) => snapshots.get(orderId) ?? null,
    ),
  };

  const service = new StandardOrderEscrowService(
    prisma as PrismaService,
    systemConfigService as unknown as SystemConfigService,
    ledgerService as unknown as LedgerService,
    calculatorService as unknown as SettlementCalculatorService,
    snapshotService as unknown as SettlementSnapshotService,
  );

  return {
    service,
    tx,
    prisma,
    holds,
    orders,
    snapshots,
    ledgerService,
    ledgerTransactions,
    calculatorService,
    snapshotService,
  };
}

function roundMoney(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

describe('StandardOrderEscrowService', () => {
  it('creates a default standard-order hold after paid sync without brand wallet credit', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('HOLD');

    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    expect(holds).toHaveLength(1);
    expect(holds[0].status).toBe(EscrowHoldStatus.HELD);
    expect(holds[0].firstReleasedAt).toBeNull();
    expect(
      ledgerService.postStandardOrderPaymentReceived,
    ).toHaveBeenCalledTimes(1);
    expect(
      ledgerService.postStandardOrderShipmentRelease,
    ).not.toHaveBeenCalled();
  });

  it('stores default hold values as 0 upfront and full final net release', async () => {
    const { service, tx, holds } = buildHarness('HOLD');

    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    expect(Number(holds[0].firstReleaseAmount)).toBe(0);
    expect(Number(holds[0].firstReleaseNetAmount)).toBe(0);
    expect(Number(holds[0].secondReleaseAmount)).toBe(1000);
    expect(Number(holds[0].secondReleaseCommissionAmount)).toBe(100);
    expect(Number(holds[0].secondReleaseNetAmount)).toBe(900);
  });

  it('schedules final release for a HELD hold after buyer delivery confirmation', async () => {
    const { service, tx, holds } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    await service.markBuyerDeliveryConfirmed(tx, 'order_1');

    expect(holds[0].status).toBe(EscrowHoldStatus.HELD);
    expect(holds[0].secondReleaseEligibleAt).toBeInstanceOf(Date);
    expect(holds[0].secondReleaseCondition).toBe(
      EscrowReleaseCondition.BUYER_DELIVERY_CONFIRMED,
    );
  });

  it('releases eligible final portion for a HELD hold', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');
    holds[0].secondReleaseEligibleAt = new Date('2026-05-05T09:00:00.000Z');

    const count = await service.releaseEligibleFinalPortions();

    expect(count).toBe(1);
    expect(holds[0].status).toBe(EscrowHoldStatus.RELEASED);
    expect(ledgerService.postStandardOrderFinalRelease).toHaveBeenCalledTimes(
      1,
    );
    expect(Number(holds[0].secondReleaseNetAmount)).toBe(900);
  });

  it('admin manual final release works when no upfront release happened', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    await service.releaseFinalPortionNow(tx, 'order_1');

    expect(holds[0].firstReleasedAt).toBeNull();
    expect(holds[0].status).toBe(EscrowHoldStatus.RELEASED);
    expect(
      ledgerService.postStandardOrderShipmentRelease,
    ).not.toHaveBeenCalled();
    expect(ledgerService.postStandardOrderFinalRelease).toHaveBeenCalledTimes(
      1,
    );
  });

  it('auto-confirms delivered HELD orders after timeout', async () => {
    const { service, tx, holds, orders } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');
    orders.set('order_1', {
      id: 'order_1',
      status: 'DELIVERED',
      deliveredAt: new Date('2026-04-01T10:00:00.000Z'),
      buyerConfirmedDeliveryAt: null,
    });

    const count = await service.autoConfirmDeliveredOrders();

    expect(count).toBe(1);
    expect(orders.get('order_1').buyerConfirmedDeliveryAt).toBeInstanceOf(Date);
    expect(holds[0].secondReleaseCondition).toBe(
      EscrowReleaseCondition.BUYER_TIMEOUT,
    );
  });

  it('admin-enabled standard-order split release credits the upfront tranche after payment', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('SPLIT');

    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    expect(holds[0].status).toBe(EscrowHoldStatus.PARTIALLY_RELEASED);
    expect(Number(holds[0].firstReleaseAmount)).toBe(300);
    expect(Number(holds[0].firstReleaseNetAmount)).toBe(270);
    expect(
      ledgerService.postStandardOrderShipmentRelease,
    ).toHaveBeenCalledTimes(1);
  });

  it('split-release final confirmation releases only the remaining tranche', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('SPLIT');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');
    holds[0].secondReleaseEligibleAt = new Date('2026-05-05T09:00:00.000Z');

    await service.releaseEligibleFinalPortions();

    expect(holds[0].status).toBe(EscrowHoldStatus.RELEASED);
    expect(Number(holds[0].secondReleaseAmount)).toBe(700);
    expect(Number(holds[0].secondReleaseNetAmount)).toBe(630);
    expect(ledgerService.postStandardOrderFinalRelease).toHaveBeenCalledTimes(
      1,
    );
  });

  it('refund before any release reverses only held escrow', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    await service.refundOrderHold(tx, 'order_1', 'buyer refund');

    expect(holds[0].status).toBe(EscrowHoldStatus.REFUNDED);
    expect(ledgerService.postStandardOrderRefund).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        firstReleasedAt: null,
        secondReleasedAt: null,
      }),
    );
  });

  it('refund after upfront release reverses released and held portions', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('SPLIT');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    await service.refundOrderHold(tx, 'order_1', 'buyer refund');

    expect(holds[0].status).toBe(EscrowHoldStatus.REFUNDED);
    expect(ledgerService.postStandardOrderRefund).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        firstReleasedAt: expect.any(Date),
        firstReleaseAmount: decimal(300),
        secondReleasedAt: null,
        secondReleaseAmount: decimal(700),
      }),
    );
  });

  it('frozen hold blocks final release', async () => {
    const { service, tx, holds, ledgerService } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');
    await service.freezeHold(tx, 'order_1', 'admin_1', 'dispute');

    await service.releaseFinalPortionNow(tx, 'order_1');

    expect(holds[0].status).toBe(EscrowHoldStatus.FROZEN);
    expect(ledgerService.postStandardOrderFinalRelease).not.toHaveBeenCalled();
  });

  it('repeated finance sync does not duplicate snapshot or ledger transactions', async () => {
    const { service, tx, holds, snapshots, ledgerTransactions } =
      buildHarness('HOLD');
    const order = makeOrder();

    await service.ensureHoldsForPaidOrders(tx, [order], 1000, 'NGN');
    await service.ensureHoldsForPaidOrders(tx, [order], 1000, 'NGN');

    expect(holds).toHaveLength(1);
    expect(snapshots.size).toBe(1);
    expect(ledgerTransactions.size).toBe(1);
    expect(ledgerTransactions.has('payment:order_1')).toBe(true);
  });

  it('repeated final release does not duplicate ledger transaction', async () => {
    const { service, tx, holds, ledgerTransactions } = buildHarness('HOLD');
    await service.ensureHoldsForPaidOrders(tx, [makeOrder()], 1000, 'NGN');

    await service.releaseFinalPortionNow(tx, 'order_1');
    await service.releaseFinalPortionNow(tx, 'order_1');

    expect(holds[0].status).toBe(EscrowHoldStatus.RELEASED);
    expect(ledgerTransactions.size).toBe(2);
    expect(ledgerTransactions.has('payment:order_1')).toBe(true);
    expect(ledgerTransactions.has('final:order_1')).toBe(true);
  });
});
