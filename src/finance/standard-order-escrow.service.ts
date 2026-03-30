import { Injectable } from '@nestjs/common';
import { EscrowHoldStatus, EscrowReleaseCondition, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { LedgerService } from './ledger.service';
import { CommissionService } from './commission.service';

type OrderSettlementInput = {
  id: string;
  brandId: string;
  buyerId: string | null;
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
    private readonly commissionService: CommissionService,
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

    const firstReleasePercent = await this.getFirstReleasePercent();
    const orderGrossAmounts = orders.map((order) => this.getOrderGrossAmount(order));
    const totalGross = orderGrossAmounts.reduce((sum, amount) => sum + amount, 0);
    if (totalGross <= 0) {
      return;
    }

    let remainingSettlement = this.roundMoney(settlementAmount);

    for (const [index, order] of orders.entries()) {
      const commissionRate = await this.getCommissionRate(tx, order.brandId, currency);
      const proportionalAmount =
        index === orders.length - 1
          ? remainingSettlement
          : this.roundMoney((settlementAmount * orderGrossAmounts[index]) / totalGross);
      remainingSettlement = this.roundMoney(remainingSettlement - proportionalAmount);

      const tranche = this.buildTrancheAmounts(proportionalAmount, commissionRate, firstReleasePercent);
      const hold = await tx.escrowHold.upsert({
        where: { orderId: order.id },
        update: {
          totalAmount: new Prisma.Decimal(tranche.totalAmount.toFixed(2)),
          commissionRate: new Prisma.Decimal(commissionRate.toFixed(2)),
          commissionAmount: new Prisma.Decimal(tranche.commissionAmount.toFixed(2)),
          netBrandAmount: new Prisma.Decimal(tranche.netBrandAmount.toFixed(2)),
          currency,
          firstReleaseAmount: new Prisma.Decimal(tranche.firstReleaseAmount.toFixed(2)),
          firstReleaseCommissionAmount: new Prisma.Decimal(
            tranche.firstReleaseCommissionAmount.toFixed(2),
          ),
          firstReleaseNetAmount: new Prisma.Decimal(tranche.firstReleaseNetAmount.toFixed(2)),
          secondReleaseAmount: new Prisma.Decimal(tranche.secondReleaseAmount.toFixed(2)),
          secondReleaseCommissionAmount: new Prisma.Decimal(
            tranche.secondReleaseCommissionAmount.toFixed(2),
          ),
          secondReleaseNetAmount: new Prisma.Decimal(tranche.secondReleaseNetAmount.toFixed(2)),
        },
        create: {
          orderId: order.id,
          brandId: order.brandId,
          buyerId: order.buyerId,
          totalAmount: new Prisma.Decimal(tranche.totalAmount.toFixed(2)),
          commissionRate: new Prisma.Decimal(commissionRate.toFixed(2)),
          commissionAmount: new Prisma.Decimal(tranche.commissionAmount.toFixed(2)),
          netBrandAmount: new Prisma.Decimal(tranche.netBrandAmount.toFixed(2)),
          currency,
          firstReleaseAmount: new Prisma.Decimal(tranche.firstReleaseAmount.toFixed(2)),
          firstReleaseCommissionAmount: new Prisma.Decimal(
            tranche.firstReleaseCommissionAmount.toFixed(2),
          ),
          firstReleaseNetAmount: new Prisma.Decimal(tranche.firstReleaseNetAmount.toFixed(2)),
          secondReleaseAmount: new Prisma.Decimal(tranche.secondReleaseAmount.toFixed(2)),
          secondReleaseCommissionAmount: new Prisma.Decimal(
            tranche.secondReleaseCommissionAmount.toFixed(2),
          ),
          secondReleaseNetAmount: new Prisma.Decimal(tranche.secondReleaseNetAmount.toFixed(2)),
          status: EscrowHoldStatus.HELD,
        },
      });

      await this.ledgerService.postStandardOrderPaymentReceived(tx, hold);
    }
  }

  async releaseShipmentPortion(tx: Prisma.TransactionClient, orderId: string) {
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (!hold || hold.firstReleasedAt || hold.status === EscrowHoldStatus.REFUNDED) {
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
    if (!hold || hold.secondReleasedAt || hold.status === EscrowHoldStatus.REFUNDED) {
      return hold;
    }

    const settlementHours = await this.getSettlementHours();
    const now = new Date();
    return tx.escrowHold.update({
      where: { id: hold.id },
      data: {
        secondReleaseEligibleAt: new Date(now.getTime() + settlementHours * 60 * 60 * 1000),
        secondReleaseCondition: condition,
      },
    });
  }

  async autoConfirmDeliveredOrders() {
    const autoReleaseDays = await this.getAutoReleaseDays();
    const threshold = new Date(Date.now() - autoReleaseDays * 24 * 60 * 60 * 1000);
    const candidates = await this.prisma.escrowHold.findMany({
      where: {
        status: EscrowHoldStatus.PARTIALLY_RELEASED,
        secondReleaseEligibleAt: null,
        refundedAt: null,
        order: {
          is: {
            deliveredAt: { lte: threshold },
            buyerConfirmedDeliveryAt: null,
            status: 'DELIVERED',
          },
        },
      },
      select: { orderId: true },
      take: 200,
    });

    for (const candidate of candidates) {
      if (!candidate.orderId) {
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
    }

    return candidates.length;
  }

  async releaseEligibleFinalPortions() {
    const candidates = await this.prisma.escrowHold.findMany({
      where: {
        status: EscrowHoldStatus.PARTIALLY_RELEASED,
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
        const updated = await tx.escrowHold.update({
          where: { id: candidate.id },
          data: {
            secondReleasedAt: new Date(),
            status: EscrowHoldStatus.RELEASED,
          },
        });

        await this.ledgerService.postStandardOrderFinalRelease(tx, updated);
      });
    }

    return candidates.length;
  }

  async refundOrderHold(tx: Prisma.TransactionClient, orderId: string, reason: string) {
    const hold = await tx.escrowHold.findUnique({ where: { orderId } });
    if (!hold) {
      return null;
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

  private buildTrancheAmounts(totalAmount: number, commissionRate: number, firstReleasePercent: number) {
    const firstReleaseAmount = this.roundMoney((totalAmount * firstReleasePercent) / 100);
    const secondReleaseAmount = this.roundMoney(totalAmount - firstReleaseAmount);

    const firstReleaseCommissionAmount = this.roundMoney(
      (firstReleaseAmount * commissionRate) / 100,
    );
    const secondReleaseCommissionAmount = this.roundMoney(
      (secondReleaseAmount * commissionRate) / 100,
    );
    const commissionAmount = this.roundMoney(
      firstReleaseCommissionAmount + secondReleaseCommissionAmount,
    );

    const firstReleaseNetAmount = this.roundMoney(
      firstReleaseAmount - firstReleaseCommissionAmount,
    );
    const secondReleaseNetAmount = this.roundMoney(
      secondReleaseAmount - secondReleaseCommissionAmount,
    );
    const netBrandAmount = this.roundMoney(firstReleaseNetAmount + secondReleaseNetAmount);

    return {
      totalAmount: this.roundMoney(totalAmount),
      commissionAmount,
      netBrandAmount,
      firstReleaseAmount,
      firstReleaseCommissionAmount,
      firstReleaseNetAmount,
      secondReleaseAmount,
      secondReleaseCommissionAmount,
      secondReleaseNetAmount,
    };
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private async getCommissionRate(
    tx: Prisma.TransactionClient,
    brandId: string,
    currency: string,
  ) {
    const resolved = await this.commissionService.resolveRule(
      { brandId, currency },
      tx,
    );
    return resolved.ratePercent;
  }

  private async getFirstReleasePercent() {
    return this.systemConfigService.getNumber('finance.standardEscrow.firstReleasePercent');
  }

  private async getSettlementHours() {
    return this.systemConfigService.getNumber('finance.standardEscrow.settlementHours');
  }

  private async getAutoReleaseDays() {
    return this.systemConfigService.getNumber('finance.standardEscrow.autoReleaseDays');
  }
}
