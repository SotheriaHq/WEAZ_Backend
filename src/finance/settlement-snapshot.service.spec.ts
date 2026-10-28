import { BadRequestException } from '@nestjs/common';
import {
  Prisma,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SettlementCalculationResult } from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';

const calculatedAt = new Date('2026-05-05T10:00:00.000Z');

function calculation(
  overrides: Partial<SettlementCalculationResult> = {},
): SettlementCalculationResult {
  return {
    orderType: SettlementOrderType.CUSTOM_ORDER,
    brandId: 'brand_1',
    orderId: null,
    customOrderId: 'custom_1',
    grossAmount: 1000,
    currency: 'NGN',
    commissionRuleId: 'commission_1',
    commissionScope: 'PLATFORM',
    commissionSource: 'RULE',
    commissionRate: 10,
    commissionAmount: 100,
    brandNetAmount: 900,
    settlementPolicyId: 'policy_1',
    releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
    upfrontReleaseEnabled: true,
    upfrontReleasePercent: 60,
    upfrontReleaseGrossAmount: 600,
    upfrontReleaseCommissionAmount: 60,
    upfrontReleaseNetBrandAmount: 540,
    finalReleaseGrossAmount: 400,
    finalReleaseCommissionAmount: 40,
    finalReleaseNetBrandAmount: 360,
    settlementDelayHours: 48,
    autoReleaseDays: 7,
    finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
    calculatedAt,
    ...overrides,
  };
}

function buildPrismaMock() {
  const snapshots: any[] = [];

  const prisma = {
    settlementSnapshot: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
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
      findMany: jest
        .fn()
        .mockImplementation(async ({ where }: any) =>
          snapshots.filter((snapshot) =>
            where.OR.some(
              (clause: any) =>
                (clause.orderId &&
                  clause.orderId.in.includes(snapshot.orderId)) ||
                (clause.customOrderId &&
                  clause.customOrderId.in.includes(snapshot.customOrderId)),
            ),
          ),
        ),
      createManyAndReturn: jest
        .fn()
        .mockImplementation(async ({ data: records }: any) => {
          const result: any[] = [];
          for (const data of records) {
            const duplicate = snapshots.find(
              (snapshot) =>
                (data.orderId && snapshot.orderId === data.orderId) ||
                (data.customOrderId &&
                  snapshot.customOrderId === data.customOrderId),
            );

            if (duplicate) {
              continue;
            }

            const created = {
              id: `snapshot_${snapshots.length + 1}`,
              ...data,
              createdAt: new Date('2026-05-05T10:01:00.000Z'),
            };
            snapshots.push(created);
            result.push(created);
          }
          return result;
        }),
    },
  };

  return { prisma: prisma as unknown as PrismaService, snapshots };
}

describe('SettlementSnapshotService', () => {
  let service: SettlementSnapshotService;
  let prisma: any;
  let snapshots: any[];

  beforeEach(() => {
    const mock = buildPrismaMock();
    prisma = mock.prisma;
    snapshots = mock.snapshots;
    service = new SettlementSnapshotService(prisma);
  });

  it('creates a snapshot from a calculation', async () => {
    const created = await service.createFromCalculation(calculation());

    expect(created.id).toBe('snapshot_1');
    expect(prisma.settlementSnapshot.createManyAndReturn).toHaveBeenCalledWith({
      skipDuplicates: true,
      data: [
        expect.objectContaining({
          customOrderId: 'custom_1',
          grossAmount: new Prisma.Decimal('1000.00'),
          commissionRate: new Prisma.Decimal('10.00'),
          settlementPolicyId: 'policy_1',
        }),
      ],
    });
    expect(prisma.settlementSnapshot.findMany).not.toHaveBeenCalled();
  });

  it('returns an existing duplicate snapshot idempotently', async () => {
    const first = await service.createFromCalculation(calculation());
    const second = await service.createFromCalculation(
      calculation({
        commissionRuleId: 'commission_updated',
        commissionRate: 12,
        commissionAmount: 120,
        brandNetAmount: 880,
      }),
    );

    expect(second).toBe(first);
    expect(prisma.settlementSnapshot.createManyAndReturn).toHaveBeenCalledTimes(
      2,
    );
    expect(prisma.settlementSnapshot.findMany).toHaveBeenCalledTimes(1);
  });

  it('reads snapshots by orderId and customOrderId', async () => {
    const standard = await service.createFromCalculation(
      calculation({
        orderType: SettlementOrderType.STANDARD_ORDER,
        orderId: 'order_1',
        customOrderId: null,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 0,
        upfrontReleaseGrossAmount: 0,
        upfrontReleaseCommissionAmount: 0,
        upfrontReleaseNetBrandAmount: 0,
        finalReleaseGrossAmount: 1000,
        finalReleaseCommissionAmount: 100,
        finalReleaseNetBrandAmount: 900,
      }),
    );
    const custom = await service.createFromCalculation(calculation());

    await expect(service.getByOrderId('order_1')).resolves.toBe(standard);
    await expect(service.getByCustomOrderId('custom_1')).resolves.toBe(custom);
  });

  it('does not change an old snapshot after SettlementPolicy update', async () => {
    const original = await service.createFromCalculation(calculation());

    await service.createFromCalculation(
      calculation({
        settlementPolicyId: 'policy_2',
        upfrontReleasePercent: 80,
        upfrontReleaseGrossAmount: 800,
        upfrontReleaseCommissionAmount: 80,
        upfrontReleaseNetBrandAmount: 720,
        finalReleaseGrossAmount: 200,
        finalReleaseCommissionAmount: 20,
        finalReleaseNetBrandAmount: 180,
      }),
    );

    expect(snapshots).toHaveLength(1);
    expect(original.settlementPolicyId).toBe('policy_1');
    expect(Number(original.upfrontReleasePercent)).toBe(60);
  });

  it('does not change an old snapshot after CommissionRule update', async () => {
    const original = await service.createFromCalculation(calculation());

    await service.createFromCalculation(
      calculation({
        commissionRuleId: 'commission_2',
        commissionRate: 12,
        commissionAmount: 120,
        brandNetAmount: 880,
        upfrontReleaseCommissionAmount: 72,
        upfrontReleaseNetBrandAmount: 528,
        finalReleaseCommissionAmount: 48,
        finalReleaseNetBrandAmount: 352,
      }),
    );

    expect(snapshots).toHaveLength(1);
    expect(original.commissionRuleId).toBe('commission_1');
    expect(Number(original.commissionRate)).toBe(10);
    expect(Number(original.commissionAmount)).toBe(100);
  });

  it('rejects snapshot creation without a business object id', async () => {
    await expect(
      service.createFromCalculation(
        calculation({ orderId: null, customOrderId: null }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('batches100 rows, preserves input order and resolves duplicates to their immutable winner', async () => {
    const inputs = Array.from({ length: 101 }, (_, index) =>
      calculation({ customOrderId: `custom_${index}` }),
    );
    const saved = await service.createFromCalculations([...inputs, inputs[0]]);
    expect(saved).toHaveLength(102);
    expect(saved[101].id).toBe(saved[0].id);
    expect(saved.slice(0, 101).map((row) => row.customOrderId)).toEqual(
      inputs.map((row) => row.customOrderId),
    );
    expect(prisma.settlementSnapshot.createManyAndReturn).toHaveBeenCalledTimes(
      2,
    );
    expect(prisma.settlementSnapshot.findMany).toHaveBeenCalledTimes(1);
    await service.createFromCalculations([]);
    expect(prisma.settlementSnapshot.createManyAndReturn).toHaveBeenCalledTimes(
      2,
    );
  });

  it('validates the entire batch before writing any snapshot', async () => {
    await expect(
      service.createFromCalculations([
        calculation(),
        calculation({ customOrderId: null }),
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      prisma.settlementSnapshot.createManyAndReturn,
    ).not.toHaveBeenCalled();
  });

  it('rejects a snapshot keyed by the wrong order type id', async () => {
    await expect(
      service.createFromCalculation(
        calculation({
          orderType: SettlementOrderType.STANDARD_ORDER,
          orderId: null,
          customOrderId: 'custom_1',
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
