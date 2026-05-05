import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementPolicyScope,
  SettlementReleaseMode,
} from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';

const DEFAULT_SEED_SETTLEMENT_DELAY_HOURS = 48;
const DEFAULT_SEED_AUTO_RELEASE_DAYS = 7;
const DEFAULT_CUSTOM_UPFRONT_PERCENT = 60;
const DEFAULT_STANDARD_UPFRONT_PERCENT = 0;

type SettlementPolicyRecord = {
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

type SettlementPolicyInput = {
  orderType: SettlementOrderType;
  scope?: SettlementPolicyScope;
  brandId?: string | null;
  currency?: string | null;
  releaseMode?: SettlementReleaseMode;
  upfrontReleaseEnabled?: boolean;
  upfrontReleasePercent?: number;
  settlementDelayHours?: number;
  autoReleaseDays?: number;
  finalReleaseTrigger?: SettlementFinalReleaseTrigger;
  isDefault?: boolean;
  isActive?: boolean;
  effectiveFrom?: Date | string;
  effectiveTo?: Date | string | null;
};

type SettlementPolicyResolution = {
  id: string | null;
  orderType: SettlementOrderType;
  scope: SettlementPolicyScope;
  brandId: string | null;
  currency: string | null;
  releaseMode: SettlementReleaseMode;
  upfrontReleaseEnabled: boolean;
  upfrontReleasePercent: number;
  settlementDelayHours: number;
  autoReleaseDays: number;
  finalReleaseTrigger: SettlementFinalReleaseTrigger;
  isDefault: boolean;
  isActive: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
};

@Injectable()
export class SettlementPolicyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async listPolicies(params?: {
    orderType?: SettlementOrderType;
    scope?: SettlementPolicyScope;
    brandId?: string | null;
    currency?: string | null;
    isActive?: boolean;
    take?: number;
  }) {
    return this.prisma.settlementPolicy.findMany({
      where: {
        ...(params?.orderType ? { orderType: params.orderType } : {}),
        ...(params?.scope ? { scope: params.scope } : {}),
        ...(params?.brandId !== undefined ? { brandId: params.brandId } : {}),
        ...(params?.currency !== undefined ? { currency: params.currency } : {}),
        ...(params?.isActive !== undefined ? { isActive: params.isActive } : {}),
      },
      orderBy: [
        { orderType: 'asc' },
        { scope: 'asc' },
        { isDefault: 'desc' },
        { effectiveFrom: 'desc' },
      ],
      take: Math.min(params?.take ?? 50, 200),
    });
  }

  async createPolicy(actorId: string | null, input: SettlementPolicyInput) {
    const normalized = this.normalizeInput(input);
    this.validateInput(normalized);

    return this.prisma.$transaction(async (tx) => {
      await this.assertNoDuplicateActiveDefaultPolicy(tx, normalized);

      return tx.settlementPolicy.create({
        data: {
          ...normalized,
          createdById: actorId,
          updatedById: actorId,
          upfrontReleasePercent: new Prisma.Decimal(
            normalized.upfrontReleasePercent.toFixed(2),
          ),
        },
      });
    });
  }

  async updatePolicy(
    id: string,
    actorId: string | null,
    input: SettlementPolicyInput,
  ) {
    const existing = await this.prisma.settlementPolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Settlement policy not found');
    }

    const normalized = this.normalizeInput(input, existing);
    this.validateInput(normalized);

    return this.prisma.$transaction(async (tx) => {
      await this.assertNoDuplicateActiveDefaultPolicy(tx, normalized, id);

      return tx.settlementPolicy.update({
        where: { id },
        data: {
          ...normalized,
          updatedById: actorId,
          upfrontReleasePercent: new Prisma.Decimal(
            normalized.upfrontReleasePercent.toFixed(2),
          ),
        },
      });
    });
  }

  async deactivatePolicy(id: string, actorId: string | null) {
    const existing = await this.prisma.settlementPolicy.findUnique({
      where: { id },
    });
    if (!existing) {
      throw new NotFoundException('Settlement policy not found');
    }

    return this.prisma.settlementPolicy.update({
      where: { id },
      data: {
        isActive: false,
        effectiveTo: new Date(),
        updatedById: actorId,
      },
    });
  }

  async resolveActivePolicy(params: {
    orderType: SettlementOrderType;
    brandId?: string | null;
    currency?: string | null;
    at?: Date;
  }): Promise<SettlementPolicyResolution> {
    const at = params.at ?? new Date();
    const currency = this.normalizeCurrency(params.currency);

    const brandPolicy = params.brandId
      ? await this.findMatchingPolicy({
          orderType: params.orderType,
          scope: SettlementPolicyScope.BRAND,
          brandId: params.brandId,
          currency,
          at,
        })
      : null;
    if (brandPolicy) {
      return this.toResolution(brandPolicy);
    }

    const platformPolicy = await this.findMatchingPolicy({
      orderType: params.orderType,
      scope: SettlementPolicyScope.PLATFORM,
      brandId: null,
      currency,
      at,
    });
    if (platformPolicy) {
      return this.toResolution(platformPolicy);
    }

    return await this.buildFallbackResolution({
      orderType: params.orderType,
      currency,
      at,
    });
  }

  async seedDefaults(): Promise<void> {
    await Promise.all(
      [
        this.buildSeedPolicy({
          orderType: SettlementOrderType.CUSTOM_ORDER,
          releaseMode: SettlementReleaseMode.SPLIT_RELEASE,
          upfrontReleaseEnabled: true,
          upfrontReleasePercent: DEFAULT_CUSTOM_UPFRONT_PERCENT,
        }),
        this.buildSeedPolicy({
          orderType: SettlementOrderType.STANDARD_ORDER,
          releaseMode: SettlementReleaseMode.HOLD_UNTIL_DELIVERY,
          upfrontReleaseEnabled: false,
          upfrontReleasePercent: DEFAULT_STANDARD_UPFRONT_PERCENT,
        }),
      ].map(async (seed) => {
        const existing = await this.prisma.settlementPolicy.findFirst({
          where: seed.lookup,
          select: { id: true },
        });
        if (existing) {
          return;
        }

        try {
          await this.prisma.settlementPolicy.create({ data: seed.data });
        } catch (error: any) {
          if (!this.isUniqueViolation(error)) {
            throw error;
          }
        }
      }),
    );
  }

  private async findMatchingPolicy(params: {
    orderType: SettlementOrderType;
    scope: SettlementPolicyScope;
    brandId: string | null;
    currency: string | null;
    at: Date;
  }) {
    const baseWhere = {
      orderType: params.orderType,
      scope: params.scope,
      brandId: params.brandId,
      isActive: true,
      effectiveFrom: { lte: params.at },
      OR: [{ effectiveTo: null }, { effectiveTo: { gte: params.at } }],
    };

    if (params.currency) {
      const exact = await this.prisma.settlementPolicy.findFirst({
        where: { ...baseWhere, currency: params.currency },
        orderBy: [
          { isDefault: 'desc' },
          { effectiveFrom: 'desc' },
          { updatedAt: 'desc' },
        ],
      });

      if (exact) {
        return exact;
      }
    }

    return this.prisma.settlementPolicy.findFirst({
      where: { ...baseWhere, currency: null },
      orderBy: [
        { isDefault: 'desc' },
        { effectiveFrom: 'desc' },
        { updatedAt: 'desc' },
      ],
    });
  }

  private async assertNoDuplicateActiveDefaultPolicy(
    client: Prisma.TransactionClient | PrismaService,
    input: ReturnType<typeof this.normalizeInput>,
    id?: string,
  ) {
    if (!input.isDefault || !input.isActive) {
      return;
    }

    const duplicate = await client.settlementPolicy.findFirst({
      where: {
        id: id ? { not: id } : undefined,
        orderType: input.orderType,
        scope: input.scope,
        brandId: input.brandId,
        currency: input.currency,
        isDefault: true,
        isActive: true,
      },
      select: { id: true },
    });

    if (duplicate) {
      throw new ConflictException(
        'An active default settlement policy already exists for this combination',
      );
    }
  }

  private normalizeInput(
    input: SettlementPolicyInput,
    existing?: SettlementPolicyRecord,
  ) {
    const orderType = input.orderType ?? existing?.orderType;
    if (!orderType) {
      throw new BadRequestException('orderType is required');
    }

    const scope = input.scope ?? existing?.scope ?? SettlementPolicyScope.PLATFORM;
    const brandId =
      input.brandId !== undefined ? this.normalizeOptionalId(input.brandId) : existing?.brandId ?? null;
    const currency =
      input.currency !== undefined ? this.normalizeCurrency(input.currency) : this.normalizeCurrency(existing?.currency ?? null);

    if (scope === SettlementPolicyScope.BRAND && !brandId) {
      throw new BadRequestException('brandId is required for brand-scoped settlement policies');
    }
    if (scope === SettlementPolicyScope.PLATFORM && brandId) {
      throw new BadRequestException('brandId must be null for platform-scoped settlement policies');
    }

    const releaseMode =
      input.releaseMode ??
      existing?.releaseMode ??
      (orderType === SettlementOrderType.CUSTOM_ORDER
        ? SettlementReleaseMode.SPLIT_RELEASE
        : SettlementReleaseMode.HOLD_UNTIL_DELIVERY);

    const upfrontReleaseEnabled =
      input.upfrontReleaseEnabled ?? existing?.upfrontReleaseEnabled ?? releaseMode === SettlementReleaseMode.SPLIT_RELEASE;

    const upfrontReleasePercentRaw =
      input.upfrontReleasePercent ?? Number(existing?.upfrontReleasePercent ?? 0);
    const settlementDelayHours =
      input.settlementDelayHours ?? existing?.settlementDelayHours ?? DEFAULT_SEED_SETTLEMENT_DELAY_HOURS;
    const autoReleaseDays =
      input.autoReleaseDays ?? existing?.autoReleaseDays ?? DEFAULT_SEED_AUTO_RELEASE_DAYS;
    const finalReleaseTrigger =
      input.finalReleaseTrigger ?? existing?.finalReleaseTrigger ?? SettlementFinalReleaseTrigger.BUYER_CONFIRMATION;
    const isDefault = input.isDefault ?? existing?.isDefault ?? false;
    const isActive = input.isActive ?? existing?.isActive ?? true;

    const effectiveFrom = this.normalizeDate(input.effectiveFrom ?? existing?.effectiveFrom ?? new Date());
    const effectiveTo = this.normalizeNullableDate(input.effectiveTo ?? existing?.effectiveTo ?? null);

    return {
      orderType,
      scope,
      brandId,
      currency,
      releaseMode,
      upfrontReleaseEnabled,
      upfrontReleasePercent: this.roundMoney(upfrontReleasePercentRaw),
      settlementDelayHours,
      autoReleaseDays,
      finalReleaseTrigger,
      isDefault,
      isActive,
      effectiveFrom,
      effectiveTo,
    };
  }

  private validateInput(input: ReturnType<typeof this.normalizeInput>) {
    if (input.effectiveTo && input.effectiveTo <= input.effectiveFrom) {
      throw new BadRequestException('effectiveTo must be after effectiveFrom');
    }

    if (input.upfrontReleasePercent < 0 || input.upfrontReleasePercent > 100) {
      throw new BadRequestException('upfrontReleasePercent must be between 0 and 100');
    }

    if (input.releaseMode === SettlementReleaseMode.HOLD_UNTIL_DELIVERY) {
      if (input.upfrontReleaseEnabled) {
        throw new BadRequestException(
          'HOLD_UNTIL_DELIVERY policies must disable upfront release',
        );
      }
      if (input.upfrontReleasePercent > 0) {
        throw new BadRequestException(
          'HOLD_UNTIL_DELIVERY policies must use an upfrontReleasePercent of 0',
        );
      }
    }

    if (!input.upfrontReleaseEnabled && input.upfrontReleasePercent !== 0) {
      throw new BadRequestException(
        'upfrontReleasePercent must be 0 when upfrontReleaseEnabled is false',
      );
    }
  }

  private buildSeedPolicy(params: {
    orderType: SettlementOrderType;
    releaseMode: SettlementReleaseMode;
    upfrontReleaseEnabled: boolean;
    upfrontReleasePercent: number;
  }) {
    const now = new Date();
    const data = {
      orderType: params.orderType,
      scope: SettlementPolicyScope.PLATFORM,
      brandId: null,
      currency: null,
      releaseMode: params.releaseMode,
      upfrontReleaseEnabled: params.upfrontReleaseEnabled,
      upfrontReleasePercent: new Prisma.Decimal(params.upfrontReleasePercent.toFixed(2)),
      settlementDelayHours: DEFAULT_SEED_SETTLEMENT_DELAY_HOURS,
      autoReleaseDays: DEFAULT_SEED_AUTO_RELEASE_DAYS,
      finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
      isDefault: true,
      isActive: true,
      effectiveFrom: now,
      effectiveTo: null,
      createdById: null,
      updatedById: null,
    };

    return {
      lookup: {
        orderType: params.orderType,
        scope: SettlementPolicyScope.PLATFORM,
        brandId: null,
        currency: null,
        isDefault: true,
        isActive: true,
      },
      data,
    };
  }

  private async buildFallbackResolution(params: {
    orderType: SettlementOrderType;
    currency: string | null;
    at: Date;
  }): Promise<SettlementPolicyResolution> {
    const [settlementDelayHours, autoReleaseDays] = await Promise.all([
      this.systemConfigService.getNumber('finance.standardEscrow.settlementHours'),
      this.systemConfigService.getNumber('finance.standardEscrow.autoReleaseDays'),
    ]);

    const releaseMode =
      params.orderType === SettlementOrderType.CUSTOM_ORDER
        ? SettlementReleaseMode.SPLIT_RELEASE
        : SettlementReleaseMode.HOLD_UNTIL_DELIVERY;

    return {
      id: null,
      orderType: params.orderType,
      scope: SettlementPolicyScope.PLATFORM,
      brandId: null,
      currency: params.currency,
      releaseMode,
      upfrontReleaseEnabled: params.orderType === SettlementOrderType.CUSTOM_ORDER,
      upfrontReleasePercent:
        params.orderType === SettlementOrderType.CUSTOM_ORDER
          ? DEFAULT_CUSTOM_UPFRONT_PERCENT
          : DEFAULT_STANDARD_UPFRONT_PERCENT,
      settlementDelayHours,
      autoReleaseDays,
      finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
      isDefault: true,
      isActive: true,
      effectiveFrom: params.at,
      effectiveTo: null,
    };
  }

  private toResolution(policy: SettlementPolicyRecord): SettlementPolicyResolution {
    return {
      id: policy.id,
      orderType: policy.orderType,
      scope: policy.scope,
      brandId: policy.brandId,
      currency: policy.currency,
      releaseMode: policy.releaseMode,
      upfrontReleaseEnabled: policy.upfrontReleaseEnabled,
      upfrontReleasePercent: Number(policy.upfrontReleasePercent),
      settlementDelayHours: policy.settlementDelayHours,
      autoReleaseDays: policy.autoReleaseDays,
      finalReleaseTrigger: policy.finalReleaseTrigger,
      isDefault: policy.isDefault,
      isActive: policy.isActive,
      effectiveFrom: policy.effectiveFrom,
      effectiveTo: policy.effectiveTo,
    };
  }

  private normalizeCurrency(value?: string | null) {
    const normalized = String(value ?? '').trim().toUpperCase();
    return normalized || null;
  }

  private normalizeOptionalId(value?: string | null) {
    const normalized = String(value ?? '').trim();
    return normalized || null;
  }

  private normalizeDate(value: Date | string) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('effectiveFrom must be a valid date');
    }
    return date;
  }

  private normalizeNullableDate(value?: Date | string | null) {
    if (value == null) {
      return null;
    }

    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('effectiveTo must be a valid date');
    }

    return date;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private isUniqueViolation(error: unknown) {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002',
    );
  }
}