import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { Prisma, SettlementOrderType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SettlementCalculationResult } from './settlement-calculator.service';

type SettlementSnapshotClient = PrismaService | Prisma.TransactionClient;

@Injectable()
export class SettlementSnapshotService {
  constructor(private readonly prisma: PrismaService) {}

  async createFromCalculation(
    calculation: SettlementCalculationResult,
    tx?: Prisma.TransactionClient,
  ) {
    return (await this.createFromCalculations([calculation], tx))[0];
  }

  async createFromCalculations(
    calculations: SettlementCalculationResult[],
    tx?: Prisma.TransactionClient,
  ) {
    for (const calculation of calculations)
      this.validateBusinessObject(calculation);
    const client: SettlementSnapshotClient = tx ?? this.prisma;
    const results: Prisma.SettlementSnapshotGetPayload<
      Record<string, never>
    >[] = [];
    for (let start = 0; start < calculations.length; start += 100) {
      const chunk = calculations.slice(start, start + 100);
      // ON CONFLICT never aborts a PostgreSQL transaction. Existing immutable
      // snapshots win; only conflict rows need a fresh shared lookup afterward.
      const inserted = await client.settlementSnapshot.createManyAndReturn({
        data: chunk.map((calculation) => this.toSnapshotData(calculation)),
        skipDuplicates: true,
      });
      const key = (row: {
        orderId: string | null;
        customOrderId: string | null;
      }) =>
        row.orderId ? `order:${row.orderId}` : `custom:${row.customOrderId}`;
      const snapshots = new Map(inserted.map((row) => [key(row), row]));
      const missing = chunk.filter((row) => !snapshots.has(key(row)));
      if (missing.length) {
        const existing = await client.settlementSnapshot.findMany({
          where: {
            OR: [
              {
                orderId: {
                  in: [
                    ...new Set(
                      missing.flatMap((row) =>
                        row.orderId ? [row.orderId] : [],
                      ),
                    ),
                  ],
                },
              },
              {
                customOrderId: {
                  in: [
                    ...new Set(
                      missing.flatMap((row) =>
                        row.customOrderId ? [row.customOrderId] : [],
                      ),
                    ),
                  ],
                },
              },
            ],
          },
        });
        for (const row of existing) snapshots.set(key(row), row);
      }
      for (const row of chunk) {
        const snapshot = snapshots.get(key(row));
        if (!snapshot)
          throw new ConflictException(
            'Settlement snapshot changed during creation. Retry the operation.',
          );
        results.push(snapshot);
      }
    }
    return results;
  }

  async getByOrderId(orderId: string, tx?: Prisma.TransactionClient) {
    const client = tx ?? this.prisma;
    return client.settlementSnapshot.findFirst({
      where: { orderId },
    });
  }

  async getByCustomOrderId(
    customOrderId: string,
    tx?: Prisma.TransactionClient,
  ) {
    const client = tx ?? this.prisma;
    return client.settlementSnapshot.findFirst({
      where: { customOrderId },
    });
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
}
