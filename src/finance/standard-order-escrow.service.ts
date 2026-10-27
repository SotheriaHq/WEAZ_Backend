import { Injectable } from '@nestjs/common';
import {
  BrandBalanceAdjustmentType,
  EscrowHoldStatus,
  EscrowHold,
  EscrowReleaseCondition,
  Prisma,
  SettlementOrderType,
  SettlementReleaseMode,
  SettlementSnapshot,
} from '@prisma/client';
import { BrandBalanceService } from './brand-balance.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { LedgerService, StandardRefundSplit } from './ledger.service';
import {
  SettlementCalculationInput,
  SettlementCalculatorService,
} from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';
import { loadDeliverySettlementCandidates } from './standard-order-settlement-query';

type OrderSettlementInput = {
  id: string;
  brandId: string;
  buyerId: string | null;
  createdAt?: Date | string | null;
  totalAmount: Prisma.Decimal | number;
  shippingCost?: Prisma.Decimal | number | null;
  discountAmount?: Prisma.Decimal | number | null;
};

/** Holds that may still pay the brand. A refund-pending hold may not. */
const RELEASABLE: EscrowHoldStatus[] = [
  EscrowHoldStatus.HELD,
  EscrowHoldStatus.PARTIALLY_RELEASED,
];

/**
 * Standard-order escrow. Every transition locks the hold row first, so a
 * release and a refund for the same order serialize and the second sees the
 * first's result. Lock order with the rest of finance: order → hold → refund
 * row → brand → debt rows → ledger accounts.
 */
@Injectable()
export class StandardOrderEscrowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
    private readonly ledgerService: LedgerService,
    private readonly settlementCalculatorService: SettlementCalculatorService,
    private readonly settlementSnapshotService: SettlementSnapshotService,
    private readonly brandBalance: BrandBalanceService,
  ) {}

  /** Lock and read the current hold row for an order in one statement, or null. */
  async lockHoldByOrderId(
    tx: Prisma.TransactionClient,
    orderId: string,
  ): Promise<EscrowHold | null> {
    const rows = await tx.$queryRaw<EscrowHold[]>`
      SELECT * FROM "EscrowHold" WHERE "orderId" = ${orderId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  private async lockHoldById(
    tx: Prisma.TransactionClient,
    holdId: string,
  ): Promise<EscrowHold | null> {
    const rows = await tx.$queryRaw<EscrowHold[]>`
      SELECT * FROM "EscrowHold" WHERE id = ${holdId}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /**
   * Create the hold for each newly paid order. `settlementAmount` is these
   * orders' share of the capture in `currency` (NGN at the original payment
   * rate); existing holds keep their purchase-time terms.
   */
  async ensureHoldsForPaidOrders(
    tx: Prisma.TransactionClient,
    orders: OrderSettlementInput[],
    settlementAmount: Prisma.Decimal | number,
    currency: string,
  ) {
    const settlement = new Prisma.Decimal(String(settlementAmount));
    if (!orders.length || !settlement.greaterThan(0)) {
      return;
    }

    const orderGrossAmounts = orders.map(
      (order) => new Prisma.Decimal(String(order.totalAmount ?? 0)),
    );
    const totalGross = orderGrossAmounts.reduce(
      (sum, amount) => sum.plus(amount),
      new Prisma.Decimal(0),
    );
    if (!totalGross.greaterThan(0)) {
      return;
    }

    let remainingSettlement = settlement;
    const calculationInputs: SettlementCalculationInput[] = orders.map(
      (order, index) => {
        const effectiveAt = order.createdAt
          ? new Date(order.createdAt)
          : undefined;
        const proportionalAmount =
          index === orders.length - 1
            ? remainingSettlement
            : settlement
                .times(orderGrossAmounts[index])
                .dividedBy(totalGross)
                .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
        remainingSettlement = remainingSettlement.minus(proportionalAmount);

        return {
          orderType: SettlementOrderType.STANDARD_ORDER,
          orderId: order.id,
          brandId: order.brandId,
          grossAmount: proportionalAmount.toNumber(),
          currency,
          effectiveAt:
            effectiveAt && !Number.isNaN(effectiveAt.getTime())
              ? effectiveAt
              : new Date(),
        };
      },
    );
    const calculations = await this.settlementCalculatorService.calculateBatch(
      calculationInputs,
      tx,
    );
    const snapshots =
      await this.settlementSnapshotService.createFromCalculations(
        calculations,
        tx,
      );
    // Brands before ledger accounts, in a stable order, as every money path does.
    for (const brandId of [
      ...new Set(orders.map((order) => order.brandId)),
    ].sort()) {
      await this.brandBalance.lockBrand(tx, brandId);
    }
    for (const [index, order] of orders.entries()) {
      const snapshot = snapshots[index];
      await tx.escrowHold.createMany({
        skipDuplicates: true,
        data: {
          orderId: order.id,
          brandId: order.brandId,
          buyerId: order.buyerId,
          totalAmount: snapshot.grossAmount,
          commissionRate: snapshot.commissionRate,
          commissionAmount: snapshot.commissionAmount,
          netBrandAmount: snapshot.brandNetAmount,
          currency,
          firstReleaseAmount: snapshot.upfrontReleaseGrossAmount,
          firstReleaseCommissionAmount: snapshot.upfrontReleaseCommissionAmount,
          firstReleaseNetAmount: snapshot.upfrontReleaseNetBrandAmount,
          secondReleaseAmount: snapshot.finalReleaseGrossAmount,
          secondReleaseCommissionAmount: snapshot.finalReleaseCommissionAmount,
          secondReleaseNetAmount: snapshot.finalReleaseNetBrandAmount,
          status: EscrowHoldStatus.HELD,
        },
      });
      const hold = await this.lockHoldByOrderId(tx, order.id);
      if (!hold) continue;

      await this.ledgerService.postStandardOrderPaymentReceived(tx, hold);
      if (this.shouldReleaseUpfront(snapshot, hold)) {
        await this.releaseUpfrontHold(tx, hold, snapshot);
      }
    }
  }

  async releaseShipmentPortion(tx: Prisma.TransactionClient, orderId: string) {
    return this.releaseStandardOrderUpfrontPortion(tx, orderId);
  }

  async releaseStandardOrderUpfrontPortion(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const hold = await this.lockHoldByOrderId(tx, orderId);
    if (
      !hold ||
      hold.firstReleasedAt ||
      !RELEASABLE.includes(hold.status) ||
      hold.firstReleaseAmount.lessThanOrEqualTo(0)
    ) {
      return hold;
    }

    const snapshot = await this.settlementSnapshotService.getByOrderId(
      orderId,
      tx,
    );
    if (!snapshot || !this.shouldReleaseUpfront(snapshot, hold)) {
      return hold;
    }

    return this.releaseUpfrontHold(tx, hold, snapshot);
  }

  /** Caller holds the hold row lock. */
  private async releaseUpfrontHold(
    tx: Prisma.TransactionClient,
    hold: EscrowHold,
    snapshot: SettlementSnapshot,
  ) {
    if (
      !this.shouldReleaseUpfront(snapshot, hold) ||
      hold.firstReleaseAmount.lessThanOrEqualTo(0)
    )
      return hold;

    const nextStatus = hold.secondReleasedAt
      ? EscrowHoldStatus.RELEASED
      : EscrowHoldStatus.PARTIALLY_RELEASED;

    const updated = await tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        firstReleasedAt: new Date(),
        status: nextStatus,
      },
    });

    await this.brandBalance.lockBrand(tx, updated.brandId);
    await this.ledgerService.postStandardOrderShipmentRelease(tx, updated);
    await this.brandBalance.reconcileRecoveries(
      tx,
      updated.brandId,
      updated.currency,
      {
        orderId: updated.orderId,
      },
    );
    return updated;
  }

  async markBuyerDeliveryConfirmed(
    tx: Prisma.TransactionClient,
    orderId: string,
    condition: EscrowReleaseCondition = EscrowReleaseCondition.BUYER_DELIVERY_CONFIRMED,
  ) {
    const hold = await this.lockHoldByOrderId(tx, orderId);
    if (!hold || hold.secondReleasedAt || !RELEASABLE.includes(hold.status)) {
      return hold;
    }

    const settlementHours = await this.getSettlementHoursForOrder(tx, orderId);
    return this.markDeliveryEligibility(tx, hold, settlementHours, condition);
  }

  /** Caller holds the hold row lock. */
  private async markDeliveryEligibility(
    tx: Prisma.TransactionClient,
    hold: EscrowHold,
    settlementHours: number,
    condition: EscrowReleaseCondition,
  ) {
    const now = new Date();
    return tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        secondReleaseEligibleAt: new Date(
          now.getTime() + settlementHours * 60 * 60 * 1000,
        ),
        secondReleaseCondition: condition,
      },
    });
  }

  async autoConfirmDeliveredOrders() {
    const candidates = await loadDeliverySettlementCandidates(this.prisma);
    const needsFallback = candidates.some(
      (row) =>
        row.autoReleaseDays === null || row.settlementDelayHours === null,
    );
    const [fallbackDays, fallbackHours] = needsFallback
      ? await Promise.all([
          this.getAutoReleaseDays(),
          this.getSettlementHours(),
        ])
      : [0, 0];
    let confirmedCount = 0;

    for (const candidate of candidates) {
      const autoReleaseDays = candidate.autoReleaseDays ?? fallbackDays;
      const threshold = new Date(
        Date.now() - autoReleaseDays * 24 * 60 * 60 * 1000,
      );
      if (candidate.deliveredAt > threshold) {
        continue;
      }

      const confirmed = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.order.updateMany({
          where: { id: candidate.orderId!, buyerConfirmedDeliveryAt: null },
          data: { buyerConfirmedDeliveryAt: new Date() },
        });
        const hold = await this.lockHoldByOrderId(tx, candidate.orderId!);
        if (
          hold &&
          !hold.secondReleasedAt &&
          RELEASABLE.includes(hold.status)
        ) {
          await this.markDeliveryEligibility(
            tx,
            hold,
            candidate.settlementDelayHours ?? fallbackHours,
            EscrowReleaseCondition.BUYER_TIMEOUT,
          );
        }
        return updated.count > 0;
      });
      if (confirmed) confirmedCount += 1;
    }

    return confirmedCount;
  }

  async releaseEligibleFinalPortions() {
    const candidates = await this.prisma.escrowHold.findMany({
      where: {
        status: { in: RELEASABLE },
        refundedAt: null,
        secondReleasedAt: null,
        secondReleaseEligibleAt: { lte: new Date() },
      },
      select: { id: true },
      take: 200,
      orderBy: { secondReleaseEligibleAt: 'asc' },
    });

    let released = 0;
    for (const candidate of candidates) {
      const hold = await this.prisma.$transaction(async (tx) =>
        this.releaseFinalPortionByHoldId(tx, candidate.id, true),
      );
      if (hold?.secondReleasedAt) released += 1;
    }

    return released;
  }

  async releaseFinalPortionNow(
    tx: Prisma.TransactionClient,
    orderId: string,
    condition: EscrowReleaseCondition = EscrowReleaseCondition.MANUAL_ADMIN,
  ) {
    const existing = await this.lockHoldByOrderId(tx, orderId);
    if (
      !existing ||
      existing.secondReleasedAt ||
      !RELEASABLE.includes(existing.status)
    ) {
      return existing;
    }

    await tx.escrowHold.update({
      where: { id: existing.id },
      data: {
        secondReleaseEligibleAt: new Date(),
        secondReleaseCondition: condition,
      },
    });

    return this.releaseFinalPortionByHoldId(tx, existing.id, false);
  }

  async freezeHold(
    tx: Prisma.TransactionClient,
    orderId: string,
    frozenById: string,
    reason: string,
  ) {
    const hold = await this.lockHoldByOrderId(tx, orderId);
    if (!hold || !RELEASABLE.includes(hold.status)) {
      return hold;
    }

    return tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        status: EscrowHoldStatus.FROZEN,
        frozenAt: new Date(),
        frozenById,
        frozenReason: reason.trim().slice(0, 255),
      },
    });
  }

  async unfreezeHold(tx: Prisma.TransactionClient, orderId: string) {
    const hold = await this.lockHoldByOrderId(tx, orderId);
    if (!hold || hold.status !== EscrowHoldStatus.FROZEN) {
      return hold;
    }

    const nextStatus = hold.secondReleasedAt
      ? EscrowHoldStatus.RELEASED
      : hold.firstReleasedAt
        ? EscrowHoldStatus.PARTIALLY_RELEASED
        : EscrowHoldStatus.HELD;

    return tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        status: nextStatus,
        frozenAt: null,
        frozenById: null,
        frozenReason: null,
      },
    });
  }

  /**
   * A refund was requested for this order. The hold stops paying the brand,
   * everything it held or released moves to refund payable, and any released
   * brand money is recorded once as a clawback keyed to this refund. Caller
   * holds the order lock; this takes the hold lock. Idempotent.
   */
  async reserveRefund(
    tx: Prisma.TransactionClient,
    params: { orderId: string; refundId: string; reason: string },
  ): Promise<{ hold: EscrowHold; split: StandardRefundSplit } | null> {
    const hold = await this.lockHoldByOrderId(tx, params.orderId);
    if (!hold) return null;
    const split = this.ledgerService.standardRefundSplit(hold);
    if (
      hold.status === EscrowHoldStatus.REFUND_PENDING ||
      hold.status === EscrowHoldStatus.REFUNDED
    ) {
      return { hold, split };
    }
    if (hold.status === EscrowHoldStatus.FORFEITED) {
      throw new Error('ESCROW_HOLD_FORFEITED');
    }

    const updated = await tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        status: EscrowHoldStatus.REFUND_PENDING,
        refundReason: params.reason.trim().slice(0, 255),
        secondReleaseEligibleAt: null,
        secondReleaseCondition: EscrowReleaseCondition.REFUND_COMPLETED,
      },
    });

    await this.brandBalance.lockBrand(tx, hold.brandId);
    await this.ledgerService.postStandardOrderRefundReserved(tx, {
      refundId: params.refundId,
      orderId: params.orderId,
      brandId: hold.brandId,
      currency: hold.currency,
      totalAmount: hold.totalAmount,
      split,
    });

    /*
      Standard orders settle the other way round — the goods reach the shopper
      before the brand is paid out — but the same shortfall is possible: the
      first release fires on dispatch, and a refund after that is money the
      brand has already been credited. The released hold no longer counts
      towards the brand's position; this row says why, exactly once per refund.
    */
    if (split.releasedNet.greaterThan(0)) {
      await this.brandBalance.raiseAdjustment(tx, {
        brandId: hold.brandId,
        type: BrandBalanceAdjustmentType.REFUND_CLAWBACK,
        amount: split.releasedNet,
        currency: hold.currency,
        reason: `Refund issued to the shopper on a released standard order (${params.reason.trim().slice(0, 120)})`,
        orderId: params.orderId,
        sourceKey: `standard-order-refund:${params.refundId}`,
      });
    }

    return { hold: updated, split };
  }

  /** The provider confirmed the refund. Caller holds refund and order locks. */
  async settleRefund(
    tx: Prisma.TransactionClient,
    params: {
      orderId: string;
      refundId: string;
      captureCurrency: string;
      captureAmount: Prisma.Decimal;
      exchangeRateSnapshotId?: string | null;
    },
  ) {
    const hold = await this.lockHoldByOrderId(tx, params.orderId);
    if (!hold) throw new Error('ESCROW_HOLD_MISSING');
    if (hold.status === EscrowHoldStatus.REFUNDED) return hold;
    if (hold.status !== EscrowHoldStatus.REFUND_PENDING) {
      throw new Error('ESCROW_HOLD_NOT_REFUND_PENDING');
    }
    const updated = await tx.escrowHold.update({
      where: { id: hold.id },
      data: { status: EscrowHoldStatus.REFUNDED, refundedAt: new Date() },
    });
    await this.ledgerService.postStandardOrderRefundSettled(tx, {
      refundId: params.refundId,
      orderId: params.orderId,
      currency: hold.currency,
      totalAmount: hold.totalAmount,
      captureCurrency: params.captureCurrency,
      captureAmount: params.captureAmount,
      exchangeRateSnapshotId: params.exchangeRateSnapshotId,
    });
    return updated;
  }

  /** Released, unrefunded brand money from standard orders, exactly. */
  async getReleasedBalance(brandId: string, currency = 'NGN') {
    const [row] = await this.prisma.$queryRaw<
      Array<{ released: Prisma.Decimal }>
    >`
      SELECT COALESCE(SUM(
        CASE WHEN "firstReleasedAt" IS NOT NULL THEN "firstReleaseNetAmount" ELSE 0 END +
        CASE WHEN "secondReleasedAt" IS NOT NULL THEN "secondReleaseNetAmount" ELSE 0 END), 0) AS released
      FROM "EscrowHold"
      WHERE "brandId" = ${brandId}::uuid AND currency = ${currency}
        AND status NOT IN ('REFUNDED', 'REFUND_PENDING') AND "refundedAt" IS NULL`;
    return new Prisma.Decimal(row?.released ?? 0);
  }

  private shouldReleaseUpfront(
    snapshot: {
      orderType: SettlementOrderType;
      releaseMode: SettlementReleaseMode;
      upfrontReleaseEnabled: boolean;
      upfrontReleaseGrossAmount: Prisma.Decimal;
    },
    hold: {
      firstReleasedAt: Date | null;
      status: EscrowHoldStatus;
    },
  ) {
    return (
      snapshot.orderType === SettlementOrderType.STANDARD_ORDER &&
      snapshot.releaseMode === SettlementReleaseMode.SPLIT_RELEASE &&
      snapshot.upfrontReleaseEnabled &&
      new Prisma.Decimal(snapshot.upfrontReleaseGrossAmount).greaterThan(0) &&
      !hold.firstReleasedAt &&
      RELEASABLE.includes(hold.status)
    );
  }

  private async releaseFinalPortionByHoldId(
    tx: Prisma.TransactionClient,
    holdId: string,
    requireEligible: boolean,
  ) {
    const hold = await this.lockHoldById(tx, holdId);
    if (
      !hold ||
      hold.secondReleasedAt ||
      !RELEASABLE.includes(hold.status) ||
      (requireEligible &&
        (!hold.secondReleaseEligibleAt ||
          hold.secondReleaseEligibleAt.getTime() > Date.now()))
    ) {
      return hold;
    }

    const updated = await tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        secondReleasedAt: new Date(),
        status: EscrowHoldStatus.RELEASED,
      },
    });

    await this.brandBalance.lockBrand(tx, updated.brandId);
    if (updated.secondReleaseAmount.greaterThan(0)) {
      await this.ledgerService.postStandardOrderFinalRelease(tx, updated);
    }
    await this.brandBalance.reconcileRecoveries(
      tx,
      updated.brandId,
      updated.currency,
      {
        orderId: updated.orderId,
      },
    );

    return updated;
  }

  private async getSettlementHoursForOrder(
    tx: Prisma.TransactionClient,
    orderId: string,
  ) {
    const snapshot = await this.settlementSnapshotService.getByOrderId(
      orderId,
      tx,
    );
    if (snapshot) {
      return snapshot.settlementDelayHours;
    }
    return this.getSettlementHours();
  }

  private async getSettlementHours() {
    return this.systemConfigService.getNumber(
      'finance.standardEscrow.settlementHours',
    );
  }

  private async getAutoReleaseDays() {
    return this.systemConfigService.getNumber(
      'finance.standardEscrow.autoReleaseDays',
    );
  }
}
