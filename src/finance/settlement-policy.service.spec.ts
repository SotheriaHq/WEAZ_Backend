import { BadRequestException, ConflictException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import {
  Prisma,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementPolicyScope,
  SettlementReleaseMode,
} from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SettlementPolicyService } from './settlement-policy.service';

type PolicyRow = {
  id: string;
  orderType: SettlementOrderType;
  scope: SettlementPolicyScope;
  brandId: string | null;
  currency: string | null;
  releaseMode: SettlementReleaseMode;
  upfrontReleaseEnabled: boolean;
  upfrontReleasePercent: Prisma.Decimal;
  settlementDelayHours: number;
  autoReleaseDays: number;
  finalReleaseTrigger: SettlementFinalReleaseTrigger;
  isDefault: boolean;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  createdById: string | null;
  updatedById: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const baseTime = new Date('2026-05-01T10:00:00.000Z');

function makePolicy(overrides: Partial<PolicyRow> = {}): PolicyRow {
  return {
    id: overrides.id ?? `policy_${Math.random().toString(36).slice(2, 10)}`,
    orderType: overrides.orderType ?? SettlementOrderType.CUSTOM_ORDER,
    scope: overrides.scope ?? SettlementPolicyScope.PLATFORM,
    brandId: overrides.brandId ?? null,
    currency: overrides.currency ?? null,
    releaseMode: overrides.releaseMode ?? SettlementReleaseMode.SPLIT_RELEASE,
    upfrontReleaseEnabled: overrides.upfrontReleaseEnabled ?? true,
    upfrontReleasePercent:
      overrides.upfrontReleasePercent ?? new Prisma.Decimal('60.00'),
    settlementDelayHours: overrides.settlementDelayHours ?? 48,
    autoReleaseDays: overrides.autoReleaseDays ?? 7,
    finalReleaseTrigger:
      overrides.finalReleaseTrigger ??
      SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
    isDefault: overrides.isDefault ?? true,
    isActive: overrides.isActive ?? true,
    effectiveFrom: overrides.effectiveFrom ?? baseTime,
    effectiveTo: overrides.effectiveTo ?? null,
    createdById: overrides.createdById ?? null,
    updatedById: overrides.updatedById ?? null,
    createdAt: overrides.createdAt ?? baseTime,
    updatedAt: overrides.updatedAt ?? baseTime,
  };
}

function sortPolicies(policies: PolicyRow[]) {
  return [...policies].sort((left, right) => {
    if (left.isDefault !== right.isDefault) {
      return left.isDefault ? -1 : 1;
    }
    if (left.effectiveFrom.getTime() !== right.effectiveFrom.getTime()) {
      return right.effectiveFrom.getTime() - left.effectiveFrom.getTime();
    }
    return right.updatedAt.getTime() - left.updatedAt.getTime();
  });
}

function matchesPolicyQuery(where: any, policy: PolicyRow) {
  if (where.orderType && policy.orderType !== where.orderType) {
    return false;
  }
  if (where.scope && policy.scope !== where.scope) {
    return false;
  }
  if (Object.prototype.hasOwnProperty.call(where, 'brandId')) {
    if (policy.brandId !== where.brandId) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(where, 'currency')) {
    if (policy.currency !== where.currency) {
      return false;
    }
  }
  if (Object.prototype.hasOwnProperty.call(where, 'isActive')) {
    if (policy.isActive !== where.isActive) {
      return false;
    }
  }

  const effectiveFrom = where.effectiveFrom?.lte as Date | undefined;
  if (effectiveFrom && policy.effectiveFrom > effectiveFrom) {
    return false;
  }

  const now = effectiveFrom ?? baseTime;
  if (policy.effectiveTo && policy.effectiveTo < now) {
    return false;
  }

  return true;
}

function buildPrismaMock(policies: PolicyRow[]) {
  const state = [...policies];

  const client: any = {
    settlementPolicy: {
      findFirst: jest.fn().mockImplementation(async ({ where }: any) => {
        const match = sortPolicies(state).find((policy) =>
          matchesPolicyQuery(where, policy),
        );
        return match ?? null;
      }),
      findMany: jest.fn().mockResolvedValue(state),
      findUnique: jest.fn().mockImplementation(async ({ where }: any) => {
        return state.find((policy) => policy.id === where.id) ?? null;
      }),
      create: jest.fn().mockImplementation(async ({ data }: any) => {
        const created: PolicyRow = {
          id: data.id ?? `created_${state.length + 1}`,
          orderType: data.orderType,
          scope: data.scope,
          brandId: data.brandId ?? null,
          currency: data.currency ?? null,
          releaseMode: data.releaseMode,
          upfrontReleaseEnabled: data.upfrontReleaseEnabled,
          upfrontReleasePercent: data.upfrontReleasePercent,
          settlementDelayHours: data.settlementDelayHours,
          autoReleaseDays: data.autoReleaseDays,
          finalReleaseTrigger: data.finalReleaseTrigger,
          isDefault: data.isDefault,
          isActive: data.isActive,
          effectiveFrom: data.effectiveFrom,
          effectiveTo: data.effectiveTo ?? null,
          createdById: data.createdById ?? null,
          updatedById: data.updatedById ?? null,
          createdAt: data.createdAt ?? baseTime,
          updatedAt: data.updatedAt ?? baseTime,
        };
        state.unshift(created);
        return created;
      }),
      update: jest.fn().mockImplementation(async ({ where, data }: any) => {
        const index = state.findIndex((policy) => policy.id === where.id);
        if (index === -1) {
          return null;
        }

        const current = state[index];
        const updated: PolicyRow = {
          ...current,
          ...data,
          upfrontReleasePercent:
            data.upfrontReleasePercent ?? current.upfrontReleasePercent,
          updatedAt: baseTime,
        };
        state[index] = updated;
        return updated;
      }),
    },
  };

  client.$transaction = jest.fn(
    async (callback: (tx: any) => Promise<unknown>) => callback(client),
  );

  return client as any;
}

describe('SettlementPolicyService', () => {
  let service: SettlementPolicyService;
  let prisma: any;
  let systemConfigService: { getNumber: jest.Mock };

  beforeEach(async () => {
    systemConfigService = {
      getNumber: jest.fn().mockImplementation((key: string) => {
        if (key === 'finance.standardEscrow.settlementHours') {
          return Promise.resolve(48);
        }
        if (key === 'finance.standardEscrow.autoReleaseDays') {
          return Promise.resolve(7);
        }
        return Promise.resolve(0);
      }),
    };

    prisma = buildPrismaMock([]);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SettlementPolicyService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: systemConfigService },
      ],
    }).compile();

    service = module.get<SettlementPolicyService>(SettlementPolicyService);
  });

  it('resolves the custom default policy', async () => {
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const customDefault = makePolicy({
          id: 'custom_default',
          orderType: SettlementOrderType.CUSTOM_ORDER,
          releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
          upfrontReleaseEnabled: true,
          upfrontReleasePercent: new Prisma.Decimal('60.00'),
        });

        return matchesPolicyQuery(where, customDefault) ? customDefault : null;
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        id: 'custom_default',
        orderType: SettlementOrderType.CUSTOM_ORDER,
        releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 60,
        settlementDelayHours: 48,
        autoReleaseDays: 7,
      }),
    );
  });

  it('resolves the standard default policy', async () => {
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const standardDefault = makePolicy({
          id: 'standard_default',
          orderType: SettlementOrderType.STANDARD_ORDER,
          releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
          upfrontReleaseEnabled: false,
          upfrontReleasePercent: new Prisma.Decimal('0.00'),
        });

        return matchesPolicyQuery(where, standardDefault)
          ? standardDefault
          : null;
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.STANDARD_ORDER,
      currency: 'NGN',
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        id: 'standard_default',
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 0,
        settlementDelayHours: 48,
        autoReleaseDays: 7,
      }),
    );
  });

  it('lets a brand policy override a platform policy', async () => {
    const brandPolicy = makePolicy({
      id: 'brand_policy',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      scope: SettlementPolicyScope.BRAND,
      brandId: 'brand_1',
      currency: null,
      upfrontReleasePercent: new Prisma.Decimal('70.00'),
    });
    const platformPolicy = makePolicy({
      id: 'platform_policy',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      scope: SettlementPolicyScope.PLATFORM,
      upfrontReleasePercent: new Prisma.Decimal('60.00'),
    });
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const dataset = [brandPolicy, platformPolicy];
        return (
          sortPolicies(dataset).find((policy) =>
            matchesPolicyQuery(where, policy),
          ) ?? null
        );
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      brandId: 'brand_1',
      currency: 'NGN',
    });

    expect(resolved.id).toBe('brand_policy');
    expect(resolved.scope).toBe(SettlementPolicyScope.BRAND);
    expect(resolved.upfrontReleasePercent).toBe(70);
  });

  it('lets a currency-specific policy override a generic policy', async () => {
    const currencyPolicy = makePolicy({
      id: 'currency_policy',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
      upfrontReleasePercent: new Prisma.Decimal('65.00'),
    });
    const genericPolicy = makePolicy({
      id: 'generic_policy',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: null,
      upfrontReleasePercent: new Prisma.Decimal('60.00'),
    });
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const dataset = [currencyPolicy, genericPolicy];
        return (
          sortPolicies(dataset).find((policy) =>
            matchesPolicyQuery(where, policy),
          ) ?? null
        );
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
    });

    expect(resolved.id).toBe('currency_policy');
    expect(resolved.currency).toBe('NGN');
    expect(resolved.upfrontReleasePercent).toBe(65);
  });

  it('ignores inactive policies', async () => {
    const inactiveExact = makePolicy({
      id: 'inactive_exact',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
      isActive: false,
      upfrontReleasePercent: new Prisma.Decimal('80.00'),
    });
    const activeGeneric = makePolicy({
      id: 'active_generic',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: null,
      upfrontReleasePercent: new Prisma.Decimal('60.00'),
    });
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const dataset = [inactiveExact, activeGeneric];
        return (
          sortPolicies(dataset).find((policy) =>
            matchesPolicyQuery(where, policy),
          ) ?? null
        );
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
    });

    expect(resolved.id).toBe('active_generic');
    expect(resolved.upfrontReleasePercent).toBe(60);
  });

  it('ignores expired and future-dated policies', async () => {
    const futureExact = makePolicy({
      id: 'future_exact',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
      effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
      upfrontReleasePercent: new Prisma.Decimal('75.00'),
    });
    const expiredExact = makePolicy({
      id: 'expired_exact',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      effectiveTo: new Date('2026-04-01T00:00:00.000Z'),
      upfrontReleasePercent: new Prisma.Decimal('75.00'),
    });
    const activeGeneric = makePolicy({
      id: 'active_generic',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: null,
      upfrontReleasePercent: new Prisma.Decimal('60.00'),
    });
    prisma.settlementPolicy.findFirst.mockImplementation(
      async ({ where }: any) => {
        const dataset = [futureExact, expiredExact, activeGeneric];
        return (
          sortPolicies(dataset).find((policy) =>
            matchesPolicyQuery(where, policy),
          ) ?? null
        );
      },
    );

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      currency: 'NGN',
      at: baseTime,
    });

    expect(resolved.id).toBe('active_generic');
    expect(resolved.upfrontReleasePercent).toBe(60);
  });

  it('rejects HOLD_UNTIL_DELIVERY policies with a positive upfront percentage', async () => {
    await expect(
      service.createPolicy('admin_1', {
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 10,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts a valid SPLIT_RELEASE policy', async () => {
    const created = makePolicy({
      id: 'created_policy',
      orderType: SettlementOrderType.CUSTOM_ORDER,
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: new Prisma.Decimal('60.00'),
    });
    prisma.settlementPolicy.create.mockResolvedValue(created);

    const result = await service.createPolicy('admin_1', {
      orderType: SettlementOrderType.CUSTOM_ORDER,
      releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleaseEnabled: true,
      upfrontReleasePercent: 60,
      isDefault: false,
    });

    expect(prisma.settlementPolicy.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderType: SettlementOrderType.CUSTOM_ORDER,
          releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
          upfrontReleaseEnabled: true,
          upfrontReleasePercent: new Prisma.Decimal('60.00'),
        }),
      }),
    );
    expect(result.id).toBe('created_policy');
  });

  it('rejects overlapping active policies for the same brand/order type/currency window', async () => {
    prisma = buildPrismaMock([
      makePolicy({
        id: 'existing_brand_policy',
        scope: SettlementPolicyScope.BRAND,
        brandId: 'brand_1',
        currency: 'NGN',
        isDefault: false,
        effectiveFrom: new Date('2026-05-01T00:00:00.000Z'),
        effectiveTo: null,
      }),
    ]);
    service = new SettlementPolicyService(prisma, systemConfigService as any);

    await expect(
      service.createPolicy('admin_1', {
        orderType: SettlementOrderType.CUSTOM_ORDER,
        scope: SettlementPolicyScope.BRAND,
        brandId: 'brand_1',
        currency: 'NGN',
        releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleaseEnabled: true,
        upfrontReleasePercent: 50,
        effectiveFrom: new Date('2026-05-05T00:00:00.000Z'),
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('falls back to SystemConfig timing values when no DB policy exists', async () => {
    systemConfigService.getNumber.mockImplementation((key: string) => {
      if (key === 'finance.standardEscrow.settlementHours') {
        return Promise.resolve(51);
      }
      if (key === 'finance.standardEscrow.autoReleaseDays') {
        return Promise.resolve(9);
      }
      return Promise.resolve(0);
    });
    prisma.settlementPolicy.findFirst.mockResolvedValue(null);

    const resolved = await service.resolveActivePolicy({
      orderType: SettlementOrderType.STANDARD_ORDER,
      currency: 'NGN',
    });

    expect(resolved).toEqual(
      expect.objectContaining({
        orderType: SettlementOrderType.STANDARD_ORDER,
        releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
        upfrontReleaseEnabled: false,
        upfrontReleasePercent: 0,
        settlementDelayHours: 51,
        autoReleaseDays: 9,
      }),
    );
  });
});
