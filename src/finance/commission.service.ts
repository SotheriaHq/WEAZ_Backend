import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';

const COMMISSION_RULE_SCOPE = {
  PLATFORM: 'PLATFORM',
  BRAND: 'BRAND',
} as const;

type CommissionRuleScope =
  (typeof COMMISSION_RULE_SCOPE)[keyof typeof COMMISSION_RULE_SCOPE];

type CommissionOrderType = 'STANDARD_ORDER' | 'CUSTOM_ORDER';

type ResolveCommissionRuleParams = {
  brandId?: string | null;
  currency?: string | null;
  at?: Date;
  orderType?: CommissionOrderType;
};

type CommissionClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class CommissionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async listRules() {
    return (this.prisma as any).commissionRule.findMany({
      orderBy: [
        { scope: 'asc' },
        { isDefault: 'desc' },
        { effectiveFrom: 'desc' },
      ],
    });
  }

  async createRule(
    data: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return this.persistRule(client, null, data);
  }

  async updateRule(
    id: string,
    data: Record<string, unknown>,
    tx?: Prisma.TransactionClient,
  ) {
    const client = this.getClient(tx);
    return this.persistRule(client, id, data);
  }

  async resolveRule(
    params: ResolveCommissionRuleParams,
    tx?: Prisma.TransactionClient,
  ) {
    const at = params.at ?? new Date();
    const client = this.getClient(tx);

    const brandRule =
      params.brandId &&
      (await this.findActiveRule(
        client,
        {
          scope: COMMISSION_RULE_SCOPE.BRAND,
          brandId: params.brandId,
        },
        params.currency,
        at,
      ));

    if (brandRule) {
      return {
        ruleId: brandRule.id as string,
        scope: brandRule.scope as CommissionRuleScope,
        ratePercent: Number(brandRule.ratePercent),
        minFeeAmount: brandRule.minFeeAmount
          ? Number(brandRule.minFeeAmount)
          : null,
        maxFeeAmount: brandRule.maxFeeAmount
          ? Number(brandRule.maxFeeAmount)
          : null,
        source: 'RULE' as const,
      };
    }

    const platformRule = await this.findActiveRule(
      client,
      {
        scope: COMMISSION_RULE_SCOPE.PLATFORM,
      },
      params.currency,
      at,
    );

    if (platformRule) {
      return {
        ruleId: platformRule.id as string,
        scope: platformRule.scope as CommissionRuleScope,
        ratePercent: Number(platformRule.ratePercent),
        minFeeAmount: platformRule.minFeeAmount
          ? Number(platformRule.minFeeAmount)
          : null,
        maxFeeAmount: platformRule.maxFeeAmount
          ? Number(platformRule.maxFeeAmount)
          : null,
        source: 'RULE' as const,
      };
    }

    const fallbackRate = await this.systemConfigService.getNumber(
      this.getFallbackConfigKey(params.orderType),
    );
    return {
      ruleId: null,
      scope: COMMISSION_RULE_SCOPE.PLATFORM,
      ratePercent: fallbackRate,
      minFeeAmount: null,
      maxFeeAmount: null,
      source: 'SYSTEM_CONFIG' as const,
    };
  }

  async calculateBreakdown(
    amount: number,
    params: ResolveCommissionRuleParams,
    tx?: Prisma.TransactionClient,
  ) {
    const resolved = await this.resolveRule(params, tx);
    let commissionAmount = this.roundMoney(
      (amount * resolved.ratePercent) / 100,
    );

    if (resolved.minFeeAmount !== null) {
      commissionAmount = Math.max(commissionAmount, resolved.minFeeAmount);
    }
    if (resolved.maxFeeAmount !== null) {
      commissionAmount = Math.min(commissionAmount, resolved.maxFeeAmount);
    }

    return {
      ...resolved,
      grossAmount: this.roundMoney(amount),
      commissionAmount: this.roundMoney(commissionAmount),
      netAmount: this.roundMoney(amount - commissionAmount),
    };
  }

  private async persistRule(
    client: CommissionClient,
    id: string | null,
    data: Record<string, unknown>,
  ) {
    const normalizedDefault = data.isDefault === true;
    const normalizedScope =
      (data.scope as CommissionRuleScope | undefined) ?? undefined;
    const normalizedBrandId =
      typeof data.brandId === 'string' ? data.brandId : null;

    const performWrite = async (tx: CommissionClient) => {
      if (normalizedDefault) {
        await (tx as any).commissionRule.updateMany({
          where: {
            ...(normalizedScope ? { scope: normalizedScope } : {}),
            ...(normalizedBrandId
              ? { brandId: normalizedBrandId }
              : { brandId: null }),
            ...(id ? { id: { not: id } } : {}),
          },
          data: { isDefault: false },
        });
      }

      if (!id) {
        return (tx as any).commissionRule.create({ data });
      }

      return (tx as any).commissionRule.update({
        where: { id },
        data,
      });
    };

    if (client === this.prisma) {
      return this.prisma.$transaction((tx) => performWrite(tx));
    }

    return performWrite(client);
  }

  private async findActiveRule(
    client: CommissionClient,
    baseWhere: Record<string, unknown>,
    currency: string | null | undefined,
    at: Date,
  ) {
    if (currency) {
      const exact = await (client as any).commissionRule.findFirst({
        where: {
          ...baseWhere,
          currency,
          isActive: true,
          effectiveFrom: { lte: at },
          OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
        },
        orderBy: [{ isDefault: 'desc' }, { effectiveFrom: 'desc' }],
      });

      if (exact) {
        return exact;
      }
    }

    return (client as any).commissionRule.findFirst({
      where: {
        ...baseWhere,
        currency: null,
        isActive: true,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gte: at } }],
      },
      orderBy: [{ isDefault: 'desc' }, { effectiveFrom: 'desc' }],
    });
  }

  private getClient(tx?: Prisma.TransactionClient): CommissionClient {
    return tx ?? this.prisma;
  }

  private getFallbackConfigKey(orderType?: CommissionOrderType) {
    if (orderType === 'STANDARD_ORDER') {
      return 'finance.commission.standardOrderPercent';
    }
    if (orderType === 'CUSTOM_ORDER') {
      return 'finance.commission.customOrderPercent';
    }
    return 'finance.commission.defaultPercent';
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
