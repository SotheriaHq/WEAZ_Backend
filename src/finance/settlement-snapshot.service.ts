import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, SettlementOrderType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SettlementCalculationResult } from './settlement-calculator.service';

@Injectable()
export class SettlementSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async createFromCalculation(calculation: SettlementCalculationResult) {
    this.validateBusinessObject(calculation);

    const existing = await this.findExisting(calculation);
    if (existing) {
      return existing;
    }

    try {
      return await this.prisma.settlementSnapshot.create({
        data: this.toSnapshotData(calculation),
      });
    } catch (error) {
      if (!this.isUniqueViolation(error)) {
        throw error;
      }

      const snapshot = await this.findExisting(calculation);
      if (snapshot) {
        return snapshot;
      }

      throw error;
    }
  }

  async getByOrderId(orderId: string) {
    return this.prisma.settlementSnapshot.findFirst({
      where: { orderId },
    });
  }

  async getByCustomOrderId(customOrderId: string) {
    return this.prisma.settlementSnapshot.findFirst({
      where: { customOrderId },
    });
  }

  private async findExisting(calculation: SettlementCalculationResult) {
    if (calculation.orderId) {
      return this.getByOrderId(calculation.orderId);
    }

    if (calculation.customOrderId) {
      return this.getByCustomOrderId(calculation.customOrderId);
    }

    return null;
  }

  private validateBusinessObject(calculation: SettlementCalculationResult) {
    if (calculation.orderId && calculation.customOrderId) {
      throw new BadRequestException(
        'Settlement snapshot must target either orderId or customOrderId, not both',
      );
    }

    if (!calculation.orderId && !calculation.customOrderId) {
      throw new BadRequestException(
        'Settlement snapshot requires orderId or customOrderId',
      );
    }

    if (
      calculation.orderType === SettlementOrderType.STANDARD_ORDER &&
      !calculation.orderId
    ) {
      throw new BadRequestException(
        'STANDARD_ORDER settlement snapshot requires orderId',
      );
    }

    if (
      calculation.orderType === SettlementOrderType.CUSTOM_ORDER &&
      !calculation.customOrderId
    ) {
      throw new BadRequestException(
        'CUSTOM_ORDER settlement snapshot requires customOrderId',
      );
    }
  }

  private toSnapshotData(calculation: SettlementCalculationResult) {
    return {
      orderType: calculation.orderType,
      orderId: calculation.orderId,
      customOrderId: calculation.customOrderId,
      brandId: calculation.brandId,
      grossAmount: this.decimal(calculation.grossAmount),
      currency: calculation.currency,
      commissionRuleId: calculation.commissionRuleId,
      commissionSource: calculation.commissionSource,
      commissionRate: this.decimal(calculation.commissionRate),
      commissionAmount: this.decimal(calculation.commissionAmount),
      brandNetAmount: this.decimal(calculation.brandNetAmount),
      settlementPolicyId: calculation.settlementPolicyId,
      releaseMode: calculation.releaseMode,
      upfrontReleaseEnabled: calculation.upfrontReleaseEnabled,
      upfrontReleasePercent: this.decimal(calculation.upfrontReleasePercent),
      upfrontReleaseGrossAmount: this.decimal(
        calculation.upfrontReleaseGrossAmount,
      ),
      upfrontReleaseCommissionAmount: this.decimal(
        calculation.upfrontReleaseCommissionAmount,
      ),
      upfrontReleaseNetBrandAmount: this.decimal(
        calculation.upfrontReleaseNetBrandAmount,
      ),
      finalReleaseGrossAmount: this.decimal(
        calculation.finalReleaseGrossAmount,
      ),
      finalReleaseCommissionAmount: this.decimal(
        calculation.finalReleaseCommissionAmount,
      ),
      finalReleaseNetBrandAmount: this.decimal(
        calculation.finalReleaseNetBrandAmount,
      ),
      settlementDelayHours: calculation.settlementDelayHours,
      autoReleaseDays: calculation.autoReleaseDays,
      finalReleaseTrigger: calculation.finalReleaseTrigger,
      calculatedAt: calculation.calculatedAt,
    };
  }

  private decimal(value: number) {
    return new Prisma.Decimal(value.toFixed(2));
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
