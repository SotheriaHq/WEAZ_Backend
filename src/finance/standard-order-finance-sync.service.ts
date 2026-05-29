import { Injectable } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import { FinancialDocumentsService } from './financial-documents.service';
import { StandardOrderEscrowService } from './standard-order-escrow.service';
import { PrismaService } from 'src/prisma/prisma.service';

type PaidOrderSnapshot = {
  id: string;
  brandId: string;
  buyerId: string | null;
  createdAt: Date;
  customerName: string;
  paymentReference: string | null;
  totalAmount: Prisma.Decimal;
  currency: string;
};

@Injectable()
export class StandardOrderFinanceSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly financialDocumentsService: FinancialDocumentsService,
  ) {}

  async syncPaidOrdersByOrderIds(orderIds: string[]) {
    const normalized = Array.from(new Set(orderIds.filter(Boolean)));
    if (normalized.length === 0) {
      return;
    }

    const orders = await this.prisma.order.findMany({
      where: {
        id: { in: normalized },
        paymentStatus: PaymentStatus.PAID,
        paymentReference: { not: null },
      },
      select: {
        id: true,
        brandId: true,
        buyerId: true,
        createdAt: true,
        customerName: true,
        paymentReference: true,
        totalAmount: true,
        currency: true,
      },
    });

    await this.syncPaidOrdersBySnapshots(orders);
  }

  async syncPaidOrdersByReferences(references: string[]) {
    const normalized = Array.from(new Set(references.filter(Boolean)));
    if (normalized.length === 0) {
      return;
    }

    const orders = await this.prisma.order.findMany({
      where: {
        paymentReference: { in: normalized },
        paymentStatus: PaymentStatus.PAID,
      },
      select: {
        id: true,
        brandId: true,
        buyerId: true,
        createdAt: true,
        customerName: true,
        paymentReference: true,
        totalAmount: true,
        currency: true,
      },
    });

    await this.syncPaidOrdersBySnapshots(orders);
  }

  private async syncPaidOrdersBySnapshots(orders: PaidOrderSnapshot[]) {
    const references = Array.from(
      new Set(
        orders
          .map((order) => order.paymentReference)
          .filter((reference): reference is string => Boolean(reference)),
      ),
    );

    if (references.length === 0) {
      return;
    }

    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        reference: { in: references },
        status: 'PAID',
      },
      select: {
        id: true,
        reference: true,
        amount: true,
        currency: true,
        settlementAmount: true,
        settlementCurrency: true,
      },
    });

    const ordersByReference = new Map<string, PaidOrderSnapshot[]>();
    for (const order of orders) {
      if (!order.paymentReference) {
        continue;
      }

      const current = ordersByReference.get(order.paymentReference) ?? [];
      current.push(order);
      ordersByReference.set(order.paymentReference, current);
    }

    for (const attempt of attempts) {
      const linkedOrders = ordersByReference.get(attempt.reference) ?? [];
      if (linkedOrders.length === 0) {
        continue;
      }

      await this.prisma.$transaction(async (tx) => {
        const paymentCurrency =
          attempt.currency || linkedOrders[0]?.currency || 'NGN';
        const settlementCurrency =
          attempt.settlementCurrency || paymentCurrency;
        const grossAmount = this.roundMoney(
          linkedOrders.reduce(
            (sum, order) => sum + Number(order.totalAmount ?? 0),
            0,
          ),
        );
        const settlementAmount =
          settlementCurrency === paymentCurrency
            ? grossAmount
            : this.roundMoney(
                Number(
                  attempt.settlementAmount ?? attempt.amount ?? grossAmount,
                ),
              );

        await this.standardOrderEscrowService.ensureHoldsForPaidOrders(
          tx,
          linkedOrders,
          settlementAmount,
          settlementCurrency,
        );

        await this.financialDocumentsService.issueBuyerReceipt(tx, {
          paymentAttemptId: attempt.id,
          orderIds: linkedOrders.map((order) => order.id),
          currency: paymentCurrency,
          grossAmount,
          settlementCurrency,
          settlementAmount,
          issuedToName: linkedOrders[0]?.customerName ?? null,
          lineItems: linkedOrders.map((order) => ({
            label: `Order ${order.id.slice(0, 8)}`,
            amount: Number(order.totalAmount ?? 0),
          })),
        });
      });
    }
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
