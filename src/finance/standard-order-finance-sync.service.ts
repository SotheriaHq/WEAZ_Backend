import { Injectable, Logger } from '@nestjs/common';
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
  private readonly logger = new Logger(StandardOrderFinanceSyncService.name);

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

      await this.prisma.$transaction((tx) =>
        this.syncCapture(tx, attempt, linkedOrders),
      );
    }
  }

  /**
   * Same as the post-payment sync, inside the caller's transaction: a refund
   * requested before the asynchronous sync ran still finds its escrow hold.
   */
  async ensureHoldsForReferenceInTransaction(
    tx: Prisma.TransactionClient,
    reference: string,
  ) {
    const [attempt, orders] = await Promise.all([
      tx.paymentAttempt.findFirst({
        where: { reference, status: 'PAID' },
        select: {
          id: true,
          reference: true,
          amount: true,
          currency: true,
          settlementAmount: true,
          settlementCurrency: true,
        },
      }),
      tx.order.findMany({
        where: {
          paymentReference: reference,
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
        orderBy: { id: 'asc' },
      }),
    ]);
    if (attempt && orders.length) await this.syncCapture(tx, attempt, orders);
  }

  private async syncCapture(
    tx: Prisma.TransactionClient,
    attempt: {
      id: string;
      reference: string;
      amount: Prisma.Decimal;
      currency: string;
      settlementAmount: Prisma.Decimal | null;
      settlementCurrency: string;
    },
    linkedOrders: PaidOrderSnapshot[],
  ) {
    const paymentCurrency =
      attempt.currency || linkedOrders[0]?.currency || 'NGN';
    const settlementCurrency = attempt.settlementCurrency || paymentCurrency;
    const gross = linkedOrders.reduce(
      (sum, order) => sum.plus(order.totalAmount ?? 0),
      new Prisma.Decimal(0),
    );
    // These orders' share of the capture at the original payment rate. A
    // unified capture can also carry custom lines and other brands' orders.
    const captureAmount = new Prisma.Decimal(attempt.amount ?? 0);
    const settlement =
      settlementCurrency === paymentCurrency
        ? gross
        : captureAmount.greaterThan(0) && attempt.settlementAmount !== null
          ? new Prisma.Decimal(attempt.settlementAmount)
              .times(gross)
              .dividedBy(captureAmount)
              .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
          : new Prisma.Decimal(0);
    if (!settlement.greaterThan(0)) {
      this.logger.warn(
        `Capture ${attempt.id} has no recorded settlement amount; escrow not created`,
      );
      return;
    }

    await this.standardOrderEscrowService.ensureHoldsForPaidOrders(
      tx,
      linkedOrders,
      settlement,
      settlementCurrency,
    );

    await this.financialDocumentsService.issueBuyerReceipt(tx, {
      paymentAttemptId: attempt.id,
      orderIds: linkedOrders.map((order) => order.id),
      currency: paymentCurrency,
      grossAmount: gross.toNumber(),
      settlementCurrency,
      settlementAmount: settlement.toNumber(),
      issuedToName: linkedOrders[0]?.customerName ?? null,
      lineItems: linkedOrders.map((order) => ({
        label: `Order ${order.id.slice(0, 8)}`,
        amount: Number(order.totalAmount ?? 0),
      })),
    });
  }
}
