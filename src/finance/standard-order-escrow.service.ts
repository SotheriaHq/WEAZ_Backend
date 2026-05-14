import { Injectable } from '@nestjs/common';
import {
  EscrowHoldStatus,
  EscrowReleaseCondition,
  Prisma,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { LedgerService } from './ledger.service';
import { SettlementCalculatorService } from './settlement-calculator.service';
import { SettlementSnapshotService } from './settlement-snapshot.service';

type OrderSettlementInput = {
  id: string;
  brandId: string;
  buyerId: string | null;
  createdAt?: Date | string | null;
  totalAmount: Prisma.Decimal | number;
  shippingCost?: Prisma.Decimal | number | null;
  discountAmount?: Prisma.Decimal | number | null;
};

@Injectable()
export class StandardOrderEscrowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
    private readonly ledgerService: LedgerService,
    private readonly settlementCalculatorService: SettlementCalculatorService,
    private readonly settlementSnapshotService: SettlementSnapshotService,
  ) {}

  async ensureHoldsForPaidOrders(
    tx: Prisma.TransactionClient,
    orders: OrderSettlementInput[],
    settlementAmount: number,
    currency: string,
  ) {
    if (!orders.length || settlementAmount <= 0) {
      return;
    }

    const orderGrossAmounts = orders.map((order) =>
      this.getOrderGrossAmount(order),
    );
    const totalGross = orderGrossAmounts.reduce(
      (sum, amount) => sum + amount,
      0,
    );
    if (totalGross <= 0) {
      return;
    }

    let remainingSettlement = this.roundMoney(settlementAmount);

    for (const [index, order] of orders.entries()) {
      const effectiveAt = order.createdAt
        ? new Date(order.createdAt)
        : undefined;
      const proportionalAmount =
        index === orders.length - 1
          ? remainingSettlement
          : this.roundMoney(
              (settlementAmount * orderGrossAmounts[index]) / totalGross,
            );
      remainingSettlement = this.roundMoney(
        remainingSettlement - proportionalAmount,
      );

      const calculation = await this.settlementCalculatorService.calculate({
        orderType: SettlementOrderType.STANDARD_ORDER,
        orderId: order.id,
        brandId: order.brandId,
        grossAmount: proportionalAmount,
        currency,
        effectiveAt:
          effectiveAt && !Number.isNaN(effectiveAt.getTime())
            ? effectiveAt
            : new Date(),
      });
      const snapshot =
        await this.settlementSnapshotService.createFromCalculation(
          calculation,
          tx,
        );
      const hold = await tx.escrowHold.upsert({
        where: { orderId: order.id },
        update: {
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
        },
        create: {
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

      await this.ledgerService.postStandardOrderPaymentReceived(tx, hold);
      if (this.shouldReleaseUpfront(snapshot, hold)) {
        await this.releaseStandardOrderUpfrontPortion(tx, order.id);
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
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (
      !hold ||
      hold.firstReleasedAt ||
      hold.status === EscrowHoldStatus.REFUNDED ||
      hold.status === EscrowHoldStatus.FROZEN ||
      Number(hold.firstReleaseAmount) <= 0
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

    await this.ledgerService.postStandardOrderShipmentRelease(tx, updated);
    return updated;
  }

  async markBuyerDeliveryConfirmed(
    tx: Prisma.TransactionClient,
    orderId: string,
    condition: EscrowReleaseCondition = EscrowReleaseCondition.BUYER_DELIVERY_CONFIRMED,
  ) {
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (
      !hold ||
      hold.secondReleasedAt ||
      hold.status === EscrowHoldStatus.REFUNDED ||
      hold.status === EscrowHoldStatus.FROZEN
    ) {
      return hold;
    }

    const settlementHours = await this.getSettlementHoursForOrder(tx, orderId);
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
    const candidates = await this.prisma.escrowHold.findMany({
      where: {
        status: {
          in: [EscrowHoldStatus.HELD, EscrowHoldStatus.PARTIALLY_RELEASED],
        },
        secondReleaseEligibleAt: null,
        refundedAt: null,
        order: {
          is: {
            deliveredAt: { not: null },
            buyerConfirmedDeliveryAt: null,
            status: 'DELIVERED',
          },
        },
      },
      select: { orderId: true, order: { select: { deliveredAt: true } } },
      take: 200,
    });
    let confirmedCount = 0;

    for (const candidate of candidates) {
      if (!candidate.orderId || !candidate.order?.deliveredAt) {
        continue;
      }

      const autoReleaseDays = await this.getAutoReleaseDaysForOrder(
        candidate.orderId,
      );
      const threshold = new Date(
        Date.now() - autoReleaseDays * 24 * 60 * 60 * 1000,
      );
      if (candidate.order.deliveredAt > threshold) {
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.order.update({
          where: { id: candidate.orderId! },
          data: { buyerConfirmedDeliveryAt: new Date() },
        });
        await this.markBuyerDeliveryConfirmed(
          tx,
          candidate.orderId!,
          EscrowReleaseCondition.BUYER_TIMEOUT,
        );
      });
      confirmedCount += 1;
    }

    return confirmedCount;
  }

  async releaseEligibleFinalPortions() {
    const candidates = await this.prisma.escrowHold.findMany({
      where: {
        status: {
          in: [EscrowHoldStatus.HELD, EscrowHoldStatus.PARTIALLY_RELEASED],
        },
        refundedAt: null,
        secondReleasedAt: null,
        secondReleaseEligibleAt: { lte: new Date() },
      },
      select: { id: true },
      take: 200,
      orderBy: { secondReleaseEligibleAt: 'asc' },
    });

    for (const candidate of candidates) {
      await this.prisma.$transaction(async (tx) => {
        await this.releaseFinalPortionByHoldId(tx, candidate.id);
      });
    }

    return candidates.length;
  }

  async releaseFinalPortionNow(
    tx: Prisma.TransactionClient,
    orderId: string,
    condition: EscrowReleaseCondition = EscrowReleaseCondition.MANUAL_ADMIN,
  ) {
    const existing = await tx.escrowHold.findUnique({ where: { orderId } });
    if (
      !existing ||
      existing.secondReleasedAt ||
      existing.status === EscrowHoldStatus.REFUNDED ||
      existing.status === EscrowHoldStatus.FROZEN
    ) {
      return existing;
    }

    const eligible = await tx.escrowHold.update({
      where: { id: existing.id },
      data: {
        secondReleaseEligibleAt: new Date(),
        secondReleaseCondition: condition,
      },
    });

    return this.releaseFinalPortionByHoldId(tx, eligible.id);
  }

  async freezeHold(
    tx: Prisma.TransactionClient,
    orderId: string,
    frozenById: string,
    reason: string,
  ) {
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (
      !hold ||
      hold.status === EscrowHoldStatus.REFUNDED ||
      hold.status === EscrowHoldStatus.RELEASED
    ) {
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
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
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

  async refundOrderHold(
    tx: Prisma.TransactionClient,
    orderId: string,
    reason: string,
  ) {
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (!hold) {
      return null;
    }
    if (hold.refundedAt || hold.status === EscrowHoldStatus.REFUNDED) {
      return hold;
    }

    const updated = await tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        status: EscrowHoldStatus.REFUNDED,
        refundedAt: new Date(),
        refundReason: reason.trim().slice(0, 255),
        secondReleaseEligibleAt: null,
        secondReleaseCondition: EscrowReleaseCondition.REFUND_COMPLETED,
      },
    });

    await this.ledgerService.postStandardOrderRefund(tx, hold);
    return updated;
  }

  async getReleasedBalance(brandId: string) {
    const holds = await this.prisma.escrowHold.findMany({
      where: { brandId },
      select: {
        status: true,
        refundedAt: true,
        firstReleasedAt: true,
        firstReleaseNetAmount: true,
        secondReleasedAt: true,
        secondReleaseNetAmount: true,
      },
    });

    return holds.reduce((sum, hold) => {
      if (hold.refundedAt || hold.status === EscrowHoldStatus.REFUNDED) {
        return sum;
      }

      let next = sum;
      if (hold.firstReleasedAt) {
        next += Number(hold.firstReleaseNetAmount);
      }
      if (hold.secondReleasedAt) {
        next += Number(hold.secondReleaseNetAmount);
      }
      return next;
    }, 0);
  }

  private getOrderGrossAmount(order: OrderSettlementInput) {
    return this.roundMoney(Number(order.totalAmount ?? 0));
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
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
      Number(snapshot.upfrontReleaseGrossAmount) > 0 &&
      !hold.firstReleasedAt &&
      hold.status !== EscrowHoldStatus.REFUNDED &&
      hold.status !== EscrowHoldStatus.FROZEN
    );
  }

  private async releaseFinalPortionByHoldId(
    tx: Prisma.TransactionClient,
    holdId: string,
  ) {
    const hold = await tx.escrowHold.findUnique({ where: { id: holdId } });
    if (
      !hold ||
      hold.secondReleasedAt ||
      hold.status === EscrowHoldStatus.REFUNDED ||
      hold.status === EscrowHoldStatus.FROZEN
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

    if (Number(updated.secondReleaseAmount) > 0) {
      await this.ledgerService.postStandardOrderFinalRelease(tx, updated);
    }

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

  private async getAutoReleaseDaysForOrder(orderId: string) {
    const snapshot = await this.settlementSnapshotService.getByOrderId(orderId);
    if (snapshot) {
      return snapshot.autoReleaseDays;
    }
    return this.getAutoReleaseDays();
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
