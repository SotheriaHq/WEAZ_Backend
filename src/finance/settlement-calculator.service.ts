import { BadRequestException, Injectable } from '@nestjs/common';
import {
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { CommissionService } from './commission.service';
import { SettlementPolicyService } from './settlement-policy.service';

export type SettlementCalculationInput = {
  orderType: SettlementOrderType;
  brandId: string;
  grossAmount: number;
  currency: string;
  effectiveAt: Date;
  orderId?: string | null;
  customOrderId?: string | null;
};

export type SettlementCalculationResult = {
  orderType: SettlementOrderType;
  brandId: string;
  orderId: string | null;
  customOrderId: string | null;
  grossAmount: number;
  currency: string;
  commissionRuleId: string | null;
  commissionScope: string | null;
  commissionSource: string | null;
  commissionRate: number;
  commissionAmount: number;
  brandNetAmount: number;
  settlementPolicyId: string | null;
  releaseMode: SettlementReleaseMode;
  upfrontReleaseEnabled: boolean;
  upfrontReleasePercent: number;
  upfrontReleaseGrossAmount: number;
  upfrontReleaseCommissionAmount: number;
  upfrontReleaseNetBrandAmount: number;
  finalReleaseGrossAmount: number;
  finalReleaseCommissionAmount: number;
  finalReleaseNetBrandAmount: number;
  settlementDelayHours: number;
  autoReleaseDays: number;
  finalReleaseTrigger: SettlementFinalReleaseTrigger;
  calculatedAt: Date;
};

@Injectable()
export class SettlementCalculatorService {
  constructor(
    private readonly settlementPolicyService: SettlementPolicyService,
    private readonly commissionService: CommissionService,
  ) {}

  async calculate(
    input: SettlementCalculationInput,
  ): Promise<SettlementCalculationResult> {
    const normalized = this.normalizeInput(input);

    const [policy, commission] = await Promise.all([
      this.settlementPolicyService.resolveActivePolicy({
        orderType: normalized.orderType,
        brandId: normalized.brandId,
        currency: normalized.currency,
        at: normalized.effectiveAt,
      }),
      this.commissionService.calculateBreakdown(normalized.grossAmount, {
        orderType: normalized.orderType,
        brandId: normalized.brandId,
        currency: normalized.currency,
        at: normalized.effectiveAt,
      }),
    ]);

    const grossAmount = this.roundMoney(commission.grossAmount);
    const commissionAmount = this.roundMoney(commission.commissionAmount);
    const brandNetAmount = this.roundMoney(commission.netAmount);

    const upfrontPercent =
      policy.releaseMode === SettlementReleaseMode.SPLIT_RELEASE &&
      policy.upfrontReleaseEnabled
        ? this.roundMoney(policy.upfrontReleasePercent)
        : 0;

    const upfrontReleaseGrossAmount =
      policy.releaseMode === SettlementReleaseMode.SPLIT_RELEASE
        ? this.roundMoney((grossAmount * upfrontPercent) / 100)
        : 0;
    const finalReleaseGrossAmount = this.roundMoney(
      grossAmount - upfrontReleaseGrossAmount,
    );

    const upfrontReleaseCommissionAmount =
      policy.releaseMode === SettlementReleaseMode.SPLIT_RELEASE
        ? this.roundMoney((commissionAmount * upfrontPercent) / 100)
        : 0;
    const finalReleaseCommissionAmount = this.roundMoney(
      commissionAmount - upfrontReleaseCommissionAmount,
    );

    const upfrontReleaseNetBrandAmount = this.roundMoney(
      upfrontReleaseGrossAmount - upfrontReleaseCommissionAmount,
    );
    const finalReleaseNetBrandAmount = this.roundMoney(
      finalReleaseGrossAmount - finalReleaseCommissionAmount,
    );

    const result: SettlementCalculationResult = {
      orderType: normalized.orderType,
      brandId: normalized.brandId,
      orderId: normalized.orderId,
      customOrderId: normalized.customOrderId,
      grossAmount,
      currency: normalized.currency,
      commissionRuleId: commission.ruleId,
      commissionScope: commission.scope ?? null,
      commissionSource: commission.source ?? null,
      commissionRate: this.roundMoney(commission.ratePercent),
      commissionAmount,
      brandNetAmount,
      settlementPolicyId: policy.id,
      releaseMode: policy.releaseMode,
      upfrontReleaseEnabled: policy.upfrontReleaseEnabled,
      upfrontReleasePercent: upfrontPercent,
      upfrontReleaseGrossAmount,
      upfrontReleaseCommissionAmount,
      upfrontReleaseNetBrandAmount,
      finalReleaseGrossAmount,
      finalReleaseCommissionAmount,
      finalReleaseNetBrandAmount,
      settlementDelayHours: policy.settlementDelayHours,
      autoReleaseDays: policy.autoReleaseDays,
      finalReleaseTrigger: policy.finalReleaseTrigger,
      calculatedAt: new Date(),
    };

    this.assertInvariants(result);
    return result;
  }

  private normalizeInput(input: SettlementCalculationInput) {
    const grossAmount = this.roundMoney(Number(input.grossAmount));
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      throw new BadRequestException('grossAmount must be greater than 0');
    }

    const brandId = String(input.brandId ?? '').trim();
    if (!brandId) {
      throw new BadRequestException('brandId is required');
    }

    const currency = String(input.currency ?? '')
      .trim()
      .toUpperCase();
    if (!currency) {
      throw new BadRequestException('currency is required');
    }

    const effectiveAt =
      input.effectiveAt instanceof Date
        ? input.effectiveAt
        : new Date(input.effectiveAt);
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('effectiveAt must be a valid date');
    }

    return {
      orderType: input.orderType,
      brandId,
      grossAmount,
      currency,
      effectiveAt,
      orderId: input.orderId ?? null,
      customOrderId: input.customOrderId ?? null,
    };
  }

  private assertInvariants(result: SettlementCalculationResult) {
    const moneyValues = [
      result.grossAmount,
      result.commissionAmount,
      result.brandNetAmount,
      result.upfrontReleaseGrossAmount,
      result.upfrontReleaseCommissionAmount,
      result.upfrontReleaseNetBrandAmount,
      result.finalReleaseGrossAmount,
      result.finalReleaseCommissionAmount,
      result.finalReleaseNetBrandAmount,
    ];

    if (moneyValues.some((value) => value < 0)) {
      throw new BadRequestException(
        'Settlement calculation produced a negative amount',
      );
    }

    this.assertMoneyEqual(
      result.upfrontReleaseGrossAmount + result.finalReleaseGrossAmount,
      result.grossAmount,
      'gross release amounts must equal grossAmount',
    );
    this.assertMoneyEqual(
      result.upfrontReleaseCommissionAmount +
        result.finalReleaseCommissionAmount,
      result.commissionAmount,
      'commission release amounts must equal commissionAmount',
    );
    this.assertMoneyEqual(
      result.upfrontReleaseNetBrandAmount + result.finalReleaseNetBrandAmount,
      result.brandNetAmount,
      'net release amounts must equal brandNetAmount',
    );
    this.assertMoneyEqual(
      result.commissionAmount + result.brandNetAmount,
      result.grossAmount,
      'commissionAmount plus brandNetAmount must equal grossAmount',
    );
  }

  private assertMoneyEqual(left: number, right: number, message: string) {
    if (this.roundMoney(left) !== this.roundMoney(right)) {
      throw new BadRequestException(
        `Invalid settlement calculation: ${message}`,
      );
    }
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
