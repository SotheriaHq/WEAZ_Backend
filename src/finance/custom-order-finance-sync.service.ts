import { Injectable, Logger } from '@nestjs/common';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  PaymentStatus,
  Prisma,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { LedgerService } from './ledger.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';

type PaidCustomOrderSnapshot = {
  id: string;
  brandId: string;
  currency: string;
  createdAt: Date;
  acceptedAt: Date | null;
  buyerPriceSummaryJson: Prisma.JsonValue;
  paymentStatus: PaymentStatus;
};

export type CustomOrderSettlementApplyParams = {
  customOrderId: string;
  brandId: string;
  grossAmount: number;
  currency: string;
  effectiveAt: Date;
  releaseEligibleAt: Date;
  /**
   * Paid, but still Pending or Up Next. Record the capture in escrow and do
   * not create the brand's 60% or 40% rows. Those are written when the order
   * becomes Active.
   */
  queueHold?: boolean;
};

/**
 * Ensures paid custom orders have settlement snapshots, dual ledger allocations,
 * payment-received ledger posts, and immediate production (upfront) release when
 * policy requires SPLIT_RELEASE. Idempotent via snapshot uniqueness, allocation
 * type checks, and ledger transaction idempotency keys.
 */
@Injectable()
export class CustomOrderFinanceSyncService {
  private readonly logger = new Logger(CustomOrderFinanceSyncService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly settlementCalculatorService: SettlementCalculatorService,
    private readonly settlementSnapshotService: SettlementSnapshotService,
  ) {}

  async applyPaidSettlement(
    tx: Prisma.TransactionClient,
    params: CustomOrderSettlementApplyParams,
  ) {
    const persisted = await tx.customOrder.findUnique({
      where: { id: params.customOrderId },
      select: { lane: true, queuePolicyVersion: true, activatedAt: true, cancelledAt: true, buyerPriceSummaryJson: true, jumpFeeAmount: true, brand: { select: { owner: { select: { status: true } } } } },
    });
    const summary = persisted?.buyerPriceSummaryJson && typeof persisted.buyerPriceSummaryJson === 'object' && !Array.isArray(persisted.buyerPriceSummaryJson) ? persisted.buyerPriceSummaryJson as Record<string, unknown> : {};
    const captureAmount = this.roundMoney(Number(summary.grandTotal ?? params.grossAmount));
    const grossAmount = this.roundMoney(persisted?.queuePolicyVersion ? captureAmount - Number(persisted.jumpFeeAmount) : Number(params.grossAmount));
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      this.logger.warn(
        `Skipping custom-order settlement for ${params.customOrderId}: invalid grossAmount=${params.grossAmount}`,
      );
      return null;
    }

    const calculation = await this.settlementCalculatorService.calculate({
      orderType: SettlementOrderType.CUSTOM_ORDER,
      customOrderId: params.customOrderId,
      brandId: params.brandId,
      grossAmount,
      currency: params.currency,
      effectiveAt: params.effectiveAt,
    });
    const snapshot = await this.settlementSnapshotService.createFromCalculation(
      calculation,
      tx,
    );

    const existingAllocations = await tx.customOrderLedgerAllocation.findMany({
      where: { customOrderId: params.customOrderId },
      select: { allocationType: true, status: true },
    });
    const existingAllocationTypes = new Set(
      existingAllocations.map((allocation) => allocation.allocationType),
    );

    // Eligibility is read from persisted state, including repair/read-triggered
    // settlement. A caller cannot override the hold with a stale boolean.
    const queueHold = Boolean(params.queueHold || persisted?.queuePolicyVersion && (!persisted.activatedAt || persisted.cancelledAt) || persisted?.lane === 'PENDING' || persisted?.lane === 'UP_NEXT');
    if (queueHold) {
      if (
        !existingAllocationTypes.has(
          CustomOrderLedgerAllocationType.PLACEMENT_CAPTURE,
        )
      ) {
        await tx.customOrderLedgerAllocation.create({
          data: {
            customOrderId: params.customOrderId,
            allocationType: CustomOrderLedgerAllocationType.PLACEMENT_CAPTURE,
            amount: new Prisma.Decimal(captureAmount),
            commissionRate: new Prisma.Decimal(0),
            commissionAmount: new Prisma.Decimal(0),
            netBrandAmount: new Prisma.Decimal(0),
            currency: params.currency,
            status: CustomOrderLedgerAllocationStatus.HELD,
          },
        });
      }
      await this.ledgerService.postCustomOrderPaymentReceived(tx, {
        customOrderId: params.customOrderId,
        totalAmount: captureAmount,
        currency: params.currency,
      });
      return snapshot;
    }

    const missingAllocations = [
      {
        customOrderId: params.customOrderId,
        allocationType:
          CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
        amount: snapshot.upfrontReleaseGrossAmount,
        commissionRate: snapshot.commissionRate,
        commissionAmount: snapshot.upfrontReleaseCommissionAmount,
        netBrandAmount: snapshot.upfrontReleaseNetBrandAmount,
        currency: params.currency,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
      {
        customOrderId: params.customOrderId,
        allocationType:
          CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
        amount: snapshot.finalReleaseGrossAmount,
        commissionRate: snapshot.commissionRate,
        commissionAmount: snapshot.finalReleaseCommissionAmount,
        netBrandAmount: snapshot.finalReleaseNetBrandAmount,
        currency: params.currency,
        status: CustomOrderLedgerAllocationStatus.HELD,
      },
    ].filter(
      (allocation) => !existingAllocationTypes.has(allocation.allocationType),
    );

    if (missingAllocations.length > 0) {
      await tx.customOrderLedgerAllocation.createMany({
        data: missingAllocations,
      });
    }

    await this.ledgerService.postCustomOrderPaymentReceived(tx, {
      customOrderId: params.customOrderId,
      totalAmount: captureAmount,
      currency: params.currency,
    });

    if (this.shouldReleaseCustomOrderUpfront(snapshot) && (!persisted?.brand || persisted.brand.owner.status === 'ACTIVE')) {
      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId: params.customOrderId,
          allocationType:
            CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: params.releaseEligibleAt,
        },
      });

      await this.ledgerService.postCustomOrderImmediateRelease(tx, {
        customOrderId: params.customOrderId,
        brandId: params.brandId,
        currency: params.currency,
        amount: Number(snapshot.upfrontReleaseGrossAmount),
        commissionAmount: Number(snapshot.upfrontReleaseCommissionAmount),
        netBrandAmount: Number(snapshot.upfrontReleaseNetBrandAmount),
      });
    }

    return snapshot;
  }

  /**
   * Repair path for paid custom orders missing allocations/snapshots.
   * Bounded batch for cost control; safe to call from brand finance reads.
   */
  async ensureSettlementsForBrand(brandId: string, limit = 25): Promise<number> {
    const safeLimit = Math.min(50, Math.max(1, Number(limit) || 25));
    const candidates = await this.findUnsettledPaidOrders({
      brandId,
      take: safeLimit,
    });
    return this.settleCandidates(candidates);
  }

  /**
   * Admin repair path — platform-wide bounded scan of paid custom orders
   * missing settlement artifacts.
   */
  async ensureSettlementsPlatform(limit = 50): Promise<{
    scanned: number;
    repaired: number;
  }> {
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 50));
    const candidates = await this.findUnsettledPaidOrders({ take: safeLimit });
    const repaired = await this.settleCandidates(candidates);
    return { scanned: candidates.length, repaired };
  }

  async ensureSettlementForCustomOrderIds(
    customOrderIds: string[],
  ): Promise<number> {
    const normalized = Array.from(new Set(customOrderIds.filter(Boolean)));
    if (normalized.length === 0) {
      return 0;
    }

    const orders = await this.prisma.customOrder.findMany({
      where: {
        id: { in: normalized },
        paymentStatus: PaymentStatus.PAID,
        cancelledAt: null,
        ...this.needsSettlementWhere(),
      },
      select: {
        id: true,
        brandId: true,
        currency: true,
        createdAt: true,
        acceptedAt: true,
        buyerPriceSummaryJson: true,
        paymentStatus: true,
        ledgerAllocations: {
          select: { allocationType: true },
        },
      },
      take: 100,
    });

    const needsWork = orders.filter((order) => {
      const types = new Set(
        order.ledgerAllocations.map((row) => row.allocationType),
      );
      return (
        !types.has(CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION) ||
        !types.has(CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION)
      );
    });

    return this.settleCandidates(
      needsWork.map((order) => ({
        id: order.id,
        brandId: order.brandId,
        currency: order.currency,
        createdAt: order.createdAt,
        acceptedAt: order.acceptedAt,
        buyerPriceSummaryJson: order.buyerPriceSummaryJson,
        paymentStatus: order.paymentStatus,
      })),
    );
  }

  private async findUnsettledPaidOrders(params: {
    brandId?: string;
    take: number;
  }): Promise<PaidCustomOrderSnapshot[]> {
    // Prefer orders that have zero allocations — cheapest signal of missing settlement.
    const withoutAllocations = await this.prisma.customOrder.findMany({
      where: {
        ...(params.brandId ? { brandId: params.brandId } : {}),
        paymentStatus: PaymentStatus.PAID,
        cancelledAt: null,
        ledgerAllocations: { none: {} },
      },
      orderBy: { createdAt: 'asc' },
      take: params.take,
      select: {
        id: true,
        brandId: true,
        currency: true,
        createdAt: true,
        acceptedAt: true,
        buyerPriceSummaryJson: true,
        paymentStatus: true,
      },
    });

    if (withoutAllocations.length >= params.take) {
      return withoutAllocations;
    }

    // Also catch partial allocation rows (one of two missing).
    const remaining = params.take - withoutAllocations.length;
    const already = new Set(withoutAllocations.map((row) => row.id));
    const partial = await this.prisma.customOrder.findMany({
      where: {
        ...(params.brandId ? { brandId: params.brandId } : {}),
        paymentStatus: PaymentStatus.PAID,
        cancelledAt: null,
        ...this.needsSettlementWhere(),
        id: already.size ? { notIn: [...already] } : undefined,
        ledgerAllocations: { some: {} },
      },
      orderBy: { createdAt: 'asc' },
      take: remaining * 3,
      select: {
        id: true,
        brandId: true,
        currency: true,
        createdAt: true,
        acceptedAt: true,
        buyerPriceSummaryJson: true,
        paymentStatus: true,
        ledgerAllocations: {
          select: { allocationType: true },
        },
      },
    });

    const partialNeeds = partial
      .filter((order) => {
        const types = new Set(
          order.ledgerAllocations.map((row) => row.allocationType),
        );
        return (
          !types.has(
            CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
          ) ||
          !types.has(CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION)
        );
      })
      .slice(0, remaining)
      .map(({ ledgerAllocations: _ignored, ...order }) => order);

    return [...withoutAllocations, ...partialNeeds];
  }

  private needsSettlementWhere(): Prisma.CustomOrderWhereInput {
    return { OR: [
      { lane: { in: ['PENDING', 'UP_NEXT'] }, ledgerAllocations: { none: { allocationType: 'PLACEMENT_CAPTURE' } } },
      { AND: [
        { OR: [{ queuePolicyVersion: null }, { activatedAt: { not: null } }] },
        { OR: [{ ledgerAllocations: { none: { allocationType: 'BRAND_ACCEPTANCE_PORTION' } } }, { ledgerAllocations: { none: { allocationType: 'FINAL_COMPLETION_PORTION' } } }] },
      ] },
    ] };
  }

  private async settleCandidates(
    candidates: PaidCustomOrderSnapshot[],
  ): Promise<number> {
    let repaired = 0;
    for (const order of candidates) {
      const grossAmount = this.extractGrandTotal(order.buyerPriceSummaryJson);
      if (grossAmount <= 0) {
        this.logger.warn(
          `Paid custom order ${order.id} has non-positive grandTotal; cannot settle`,
        );
        continue;
      }

      try {
        await this.prisma.$transaction(async (tx) => {
          await this.applyPaidSettlement(tx, {
            customOrderId: order.id,
            brandId: order.brandId,
            grossAmount,
            currency: order.currency || 'NGN',
            effectiveAt: order.createdAt,
            releaseEligibleAt: order.acceptedAt ?? order.createdAt ?? new Date(),
          });
        });
        repaired += 1;
      } catch (error) {
        this.logger.error(
          `Failed to repair settlement for custom order ${order.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
    return repaired;
  }

  private shouldReleaseCustomOrderUpfront(snapshot: {
    orderType: SettlementOrderType;
    releaseMode: SettlementReleaseMode;
    upfrontReleaseEnabled: boolean;
    upfrontReleaseGrossAmount: Prisma.Decimal | number;
  }) {
    return (
      snapshot.orderType === SettlementOrderType.CUSTOM_ORDER &&
      snapshot.releaseMode === SettlementReleaseMode.SPLIT_RELEASE &&
      snapshot.upfrontReleaseEnabled &&
      Number(snapshot.upfrontReleaseGrossAmount) > 0
    );
  }

  private extractGrandTotal(summary: Prisma.JsonValue): number {
    if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
      return 0;
    }
    const raw = summary as Record<string, unknown>;
    return this.roundMoney(Number(raw.grandTotal ?? 0));
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
