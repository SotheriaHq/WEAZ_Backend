import { BadRequestException } from '@nestjs/common';
import {
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementPolicyScope,
  SettlementReleaseMode,
} from '@prisma/client';
import { CommissionService } from './commission.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementPolicyService } from './settlement-policy.service';

const effectiveAt = new Date('2026-05-05T10:00:00.000Z');

function policy(overrides: Record<string, unknown> = {}) {
  return {
    id: 'policy_platform',
    orderType: SettlementOrderType.CUSTOM_ORDER,
    scope: SettlementPolicyScope.PLATFORM,
    brandId: null,
    currency: null,
    releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
    upfrontReleaseEnabled: true,
    upfrontReleasePercent: 60,
    settlementDelayHours: 48,
    autoReleaseDays: 7,
    finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
    isDefault: true,
    isActive: true,
    effectiveFrom: effectiveAt,
    effectiveTo: null,
    ...overrides,
  };
}

function commission(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'commission_platform',
    scope: 'PLATFORM',
    ratePercent: 10,
    minFeeAmount: null,
    maxFeeAmount: null,
    source: 'RULE',
    grossAmount: 1000,
    commissionAmount: 100,
    netAmount: 900,
    ...overrides,
  };
}

describe('SettlementCalculatorService', () => {
  let service: SettlementCalculatorService;
  let settlementPolicyService: { resolveActivePolicy: jest.Mock };
  let commissionService: { calculateBreakdown: jest.Mock };

  beforeEach(() => {
    settlementPolicyService = {
      resolveActivePolicy: jest.fn().mockResolvedValue(policy()),
    };
    commissionService = {
      calculateBreakdown: jest.fn().mockResolvedValue(commission()),
    };
    service = new SettlementCalculatorService(
      settlementPolicyService as unknown as SettlementPolicyService,
      commissionService as unknown as CommissionService,
    );
  });

  it('calculates the custom order default 60/40 split', async () => {
    const result = await service.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'ngn',
      effectiveAt,
      customOrderId: 'custom_1',
    });

    expect(result).toEqual(
      expect.objectContaining({
        releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 60,
        upfrontReleaseGrossAmount: 600,
        upfrontReleaseCommissionAmount: 60,
        upfrontReleaseNetBrandAmount: 540,
        finalReleaseGrossAmount: 400,
        finalReleaseCommissionAmount: 40,
        finalReleaseNetBrandAmount: 360,
        brandNetAmount: 900,
      }),
    );
  });

  it('calculates the standard order default 0/100 hold-until-delivery release', async () => {
    settlementPolicyService.resolveActivePolicy.mockResolvedValue(
      policy({
        id: 'standard_policy',
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 0,
      }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.STANDARD_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt,
      orderId: 'order_1',
    });

    expect(result.upfrontReleaseGrossAmount).toBe(0);
    expect(result.upfrontReleaseCommissionAmount).toBe(0);
    expect(result.upfrontReleaseNetBrandAmount).toBe(0);
    expect(result.finalReleaseGrossAmount).toBe(1000);
    expect(result.finalReleaseCommissionAmount).toBe(100);
    expect(result.finalReleaseNetBrandAmount).toBe(900);
  });

  it('calculates a standard order split release 30/70 when policy is enabled', async () => {
    settlementPolicyService.resolveActivePolicy.mockResolvedValue(
      policy({
        id: 'standard_split',
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 30,
      }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.STANDARD_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt,
      orderId: 'order_1',
    });

    expect(result.upfrontReleaseGrossAmount).toBe(300);
    expect(result.upfrontReleaseCommissionAmount).toBe(30);
    expect(result.upfrontReleaseNetBrandAmount).toBe(270);
    expect(result.finalReleaseGrossAmount).toBe(700);
    expect(result.finalReleaseCommissionAmount).toBe(70);
    expect(result.finalReleaseNetBrandAmount).toBe(630);
  });

  it('applies the resolved commission rate correctly', async () => {
    commissionService.calculateBreakdown.mockResolvedValue(
      commission({
        ruleId: 'commission_12',
        ratePercent: 12,
        commissionAmount: 120,
        netAmount: 880,
      }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt,
      customOrderId: 'custom_1',
    });

    expect(result.commissionRuleId).toBe('commission_12');
    expect(result.commissionRate).toBe(12);
    expect(result.commissionAmount).toBe(120);
    expect(result.brandNetAmount).toBe(880);
  });

  it('uses brand-specific policy data returned by policy resolution', async () => {
    settlementPolicyService.resolveActivePolicy.mockImplementation(
      async ({ brandId }) =>
        policy({
          id: brandId === 'brand_1' ? 'brand_policy' : 'platform_policy',
          scope:
            brandId === 'brand_1'
              ? SettlementPolicyScope.BRAND
              : SettlementPolicyScope.PLATFORM,
          brandId: brandId === 'brand_1' ? brandId : null,
          upfrontReleasePercent: brandId === 'brand_1' ? 75 : 60,
        }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt,
      customOrderId: 'custom_1',
    });

    expect(result.settlementPolicyId).toBe('brand_policy');
    expect(result.upfrontReleasePercent).toBe(75);
    expect(result.finalReleaseGrossAmount).toBe(250);
  });

  it('uses brand-specific commission data returned by commission resolution', async () => {
    commissionService.calculateBreakdown.mockImplementation(
      async (_amount, { brandId }) =>
        commission({
          ruleId:
            brandId === 'brand_1' ? 'brand_commission' : 'platform_commission',
          scope: brandId === 'brand_1' ? 'BRAND' : 'PLATFORM',
          ratePercent: brandId === 'brand_1' ? 8 : 10,
          commissionAmount: brandId === 'brand_1' ? 80 : 100,
          netAmount: brandId === 'brand_1' ? 920 : 900,
        }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 1000,
      currency: 'NGN',
      effectiveAt,
      customOrderId: 'custom_1',
    });

    expect(result.commissionRuleId).toBe('brand_commission');
    expect(result.commissionScope).toBe('BRAND');
    expect(result.commissionAmount).toBe(80);
    expect(result.brandNetAmount).toBe(920);
  });

  it('rounds split release edge cases and keeps final tranche as residual', async () => {
    commissionService.calculateBreakdown.mockResolvedValue(
      commission({
        grossAmount: 10.01,
        ratePercent: 12.5,
        commissionAmount: 1.25,
        netAmount: 8.76,
      }),
    );

    const result = await service.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      grossAmount: 10.01,
      currency: 'NGN',
      effectiveAt,
      customOrderId: 'custom_1',
    });

    expect(result.upfrontReleaseGrossAmount).toBe(6.01);
    expect(result.finalReleaseGrossAmount).toBe(4);
    expect(result.upfrontReleaseCommissionAmount).toBe(0.75);
    expect(result.finalReleaseCommissionAmount).toBe(0.5);
    expect(
      result.upfrontReleaseNetBrandAmount + result.finalReleaseNetBrandAmount,
    ).toBe(8.76);
  });

  it('rejects zero or invalid gross amount', async () => {
    await expect(
      service.calculate({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        brandId: 'brand_1',
        grossAmount: 0,
        currency: 'NGN',
        effectiveAt,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      service.calculate({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        brandId: 'brand_1',
        grossAmount: Number.NaN,
        currency: 'NGN',
        effectiveAt,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects negative calculated money values', async () => {
    commissionService.calculateBreakdown.mockResolvedValue(
      commission({
        commissionAmount: 1100,
        netAmount: -100,
      }),
    );

    await expect(
      service.calculate({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        brandId: 'brand_1',
        grossAmount: 1000,
        currency: 'NGN',
        effectiveAt,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('checks calculation invariants', async () => {
    commissionService.calculateBreakdown.mockResolvedValue(
      commission({
        grossAmount: 1000,
        commissionAmount: 99,
        netAmount: 900,
      }),
    );

    await expect(
      service.calculate({
        orderType: SettlementOrderType.CUSTOM_ORDER,
        brandId: 'brand_1',
        grossAmount: 1000,
        currency: 'NGN',
        effectiveAt,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
