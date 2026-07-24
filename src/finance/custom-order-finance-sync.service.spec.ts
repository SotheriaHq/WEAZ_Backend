import { Prisma, SettlementOrderType, SettlementReleaseMode } from '@prisma/client';
import { CustomOrderFinanceSyncService } from './custom-order-finance-sync.service';

function decimal(value: number) {
  return new Prisma.Decimal(value.toFixed(2));
}

describe('CustomOrderFinanceSyncService', () => {
  let service: CustomOrderFinanceSyncService;
  let prisma: any;
  let ledgerService: any;
  let settlementCalculatorService: any;
  let settlementSnapshotService: any;

  beforeEach(() => {
    prisma = {
      customOrder: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $transaction: jest.fn(async (fn: (tx: any) => Promise<unknown>) => {
        const tx = {
          customOrderLedgerAllocation: {
            findMany: jest.fn().mockResolvedValue([]),
            createMany: jest.fn().mockResolvedValue({ count: 2 }),
            updateMany: jest.fn().mockResolvedValue({ count: 1 }),
          },
        };
        return fn(tx);
      }),
    };

    ledgerService = {
      postCustomOrderPaymentReceived: jest.fn().mockResolvedValue(undefined),
      postCustomOrderImmediateRelease: jest.fn().mockResolvedValue(undefined),
    };

    settlementCalculatorService = {
      calculate: jest.fn().mockResolvedValue({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        orderId: null,
        customOrderId: 'co_1',
        brandId: 'brand_1',
        grossAmount: 1000,
        currency: 'NGN',
        commissionRuleId: null,
        commissionScope: null,
        commissionSource: null,
        commissionRate: 10,
        commissionAmount: 100,
        brandNetAmount: 900,
        settlementPolicyId: null,
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
        finalReleaseTrigger: 'BUYER_CONFIRMATION',
        calculatedAt: new Date(),
      }),
    };

    settlementSnapshotService = {
      createFromCalculation: jest.fn().mockImplementation(async (calc: any) => ({
        id: 'snap_1',
        ...calc,
        grossAmount: decimal(calc.grossAmount),
        commissionRate: decimal(calc.commissionRate),
        commissionAmount: decimal(calc.commissionAmount),
        brandNetAmount: decimal(calc.brandNetAmount),
        upfrontReleasePercent: decimal(calc.upfrontReleasePercent),
        upfrontReleaseGrossAmount: decimal(calc.upfrontReleaseGrossAmount),
        upfrontReleaseCommissionAmount: decimal(
          calc.upfrontReleaseCommissionAmount,
        ),
        upfrontReleaseNetBrandAmount: decimal(calc.upfrontReleaseNetBrandAmount),
        finalReleaseGrossAmount: decimal(calc.finalReleaseGrossAmount),
        finalReleaseCommissionAmount: decimal(calc.finalReleaseCommissionAmount),
        finalReleaseNetBrandAmount: decimal(calc.finalReleaseNetBrandAmount),
      })),
    };

    service = new CustomOrderFinanceSyncService(
      prisma,
      ledgerService,
      settlementCalculatorService,
      settlementSnapshotService,
    );
  });

  it('applies paid settlement with allocations and immediate release', async () => {
    const tx = {
      customOrderLedgerAllocation: {
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    await service.applyPaidSettlement(tx as any, {
      customOrderId: 'co_1',
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt: new Date('2026-03-12T09:00:00.000Z'),
      releaseEligibleAt: new Date('2026-03-12T10:00:00.000Z'),
    });

    expect(settlementCalculatorService.calculate).toHaveBeenCalled();
    expect(settlementSnapshotService.createFromCalculation).toHaveBeenCalled();
    expect(tx.customOrderLedgerAllocation.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          allocationType: 'BRAND_ACCEPTANCE_PORTION',
        }),
        expect.objectContaining({
          allocationType: 'FINAL_COMPLETION_PORTION',
        }),
      ]),
    });
    expect(ledgerService.postCustomOrderPaymentReceived).toHaveBeenCalled();
    expect(ledgerService.postCustomOrderImmediateRelease).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        customOrderId: 'co_1',
        amount: 600,
        netBrandAmount: 540,
      }),
    );
  });

  it('skips invalid gross amounts', async () => {
    const tx = {
      customOrderLedgerAllocation: {
        findMany: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
    };

    const result = await service.applyPaidSettlement(tx as any, {
      customOrderId: 'co_bad',
      brandId: 'brand_1',
      grossAmount: 0,
      currency: 'NGN',
      effectiveAt: new Date(),
      releaseEligibleAt: new Date(),
    });

    expect(result).toBeNull();
    expect(settlementCalculatorService.calculate).not.toHaveBeenCalled();
  });

  it('repairs brand orders missing allocations', async () => {
    prisma.customOrder.findMany
      .mockResolvedValueOnce([
        {
          id: 'co_missing',
          brandId: 'brand_1',
          currency: 'NGN',
          createdAt: new Date('2026-03-12T09:00:00.000Z'),
          acceptedAt: new Date('2026-03-12T10:00:00.000Z'),
          buyerPriceSummaryJson: { grandTotal: 1500 },
          paymentStatus: 'PAID',
        },
      ])
      .mockResolvedValueOnce([]);

    const repaired = await service.ensureSettlementsForBrand('brand_1', 10);
    expect(repaired).toBe(1);
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});
