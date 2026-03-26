import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma, PayoutStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
  ) {}

  async findAll(brandId: string, page = 1, limit = 20) {
    const realBrandId = await this.getBrandId(brandId);
    const skip = (page - 1) * limit;

    const [total, payouts] = await Promise.all([
      this.prisma.payout.count({ where: { brandId: realBrandId } }),
      this.prisma.payout.findMany({
        where: { brandId: realBrandId },
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      items: payouts,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async requestPayout(brandId: string, amount: number) {
    const realBrandId = await this.getBrandId(brandId);

    if (amount < 5000) {
      throw new BadRequestException('Minimum payout amount is 5000');
    }

    const balance = await this.calculateAvailableBalance(realBrandId);

    if (amount > balance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${balance}`,
      );
    }

    return this.prisma.payout.create({
      data: {
        id: uuidv4(),
        brandId: realBrandId,
        amount,
        currency: 'NGN',
        status: PayoutStatus.PENDING_APPROVAL,
      },
    });
  }

  async getOverview(brandId: string) {
    const realBrandId = await this.getBrandId(brandId);
    const { availableBalance, releasedBalance, reservedPayoutBalance, paidOutBalance } =
      await this.calculateBalanceSnapshot(realBrandId);

    return {
      currency: 'NGN',
      availableBalance,
      releasedBalance,
      reservedPayoutBalance,
      paidOutBalance,
      negativeBalance: availableBalance < 0,
    };
  }

  async listIncomingTransactions(brandId: string, page = 1, limit = 20) {
    const realBrandId = await this.getBrandId(brandId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const where = {
      account: {
        entityType: 'BRAND',
        entityId: realBrandId,
      },
      direction: 'CREDIT' as const,
    };

    const [total, entries] = await Promise.all([
      (this.prisma as any).ledgerEntry.count({ where }),
      (this.prisma as any).ledgerEntry.findMany({
        where,
        skip,
        take: safeLimit,
        orderBy: { createdAt: 'desc' },
        include: {
          account: {
            select: {
              code: true,
              name: true,
            },
          },
          transaction: {
            select: {
              id: true,
              type: true,
              description: true,
              referenceType: true,
              referenceId: true,
              totalAmount: true,
              currency: true,
              createdAt: true,
              metadata: true,
            },
          },
        },
      }),
    ]);

    const orderIds = Array.from(
      new Set(
        entries
          .filter((entry: any) => entry.transaction?.referenceType === 'Order' && entry.transaction?.referenceId)
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    );
    const customOrderIds = Array.from(
      new Set(
        entries
          .filter((entry: any) => entry.transaction?.referenceType === 'CustomOrder' && entry.transaction?.referenceId)
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    );

    const [orders, customOrders] = await Promise.all([
      orderIds.length > 0
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: {
              id: true,
              customerName: true,
              orderItems: {
                take: 1,
                select: {
                  nameAtPurchase: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      customOrderIds.length > 0
        ? (this.prisma as any).customOrder.findMany({
            where: { id: { in: customOrderIds } },
            select: {
              id: true,
              title: true,
              buyer: {
                select: {
                  firstName: true,
                  lastName: true,
                  username: true,
                },
              },
            },
          })
        : Promise.resolve([]),
    ]);

    const orderById = new Map(
      orders.map((order) => {
        const firstItem = order.orderItems[0];
        return [
          order.id,
          {
            title:
              (typeof firstItem?.nameAtPurchase === 'string' && firstItem.nameAtPurchase.trim()) ||
              `Order #${order.id.slice(0, 8).toUpperCase()}`,
            counterparty: order.customerName,
          },
        ] as const;
      }),
    );

    const customOrderById = new Map(
      customOrders.map((order: any) => {
        const buyerName = [order?.buyer?.firstName, order?.buyer?.lastName]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' ');

        return [
          String(order.id),
          {
            title:
              (typeof order?.title === 'string' && order.title.trim()) ||
              `Custom Order #${String(order.id).slice(0, 8).toUpperCase()}`,
            counterparty: buyerName || String(order?.buyer?.username || 'Buyer'),
          },
        ] as const;
      }),
    );

    const items = entries.map((entry: any) => {
      const transaction = entry.transaction;
      const referenceType = String(transaction?.referenceType || '');
      const referenceId = String(transaction?.referenceId || '');
      const orderMeta =
        referenceType === 'Order'
          ? orderById.get(referenceId)
          : referenceType === 'CustomOrder'
            ? customOrderById.get(referenceId)
            : null;

      return {
        id: entry.id,
        amount: Number(entry.amount ?? 0),
        balanceAfter: Number(entry.balanceAfter ?? 0),
        currency: transaction?.currency ?? 'NGN',
        createdAt: entry.createdAt,
        transactionId: transaction?.id ?? null,
        transactionType: transaction?.type ?? null,
        description: transaction?.description ?? null,
        referenceType: transaction?.referenceType ?? null,
        referenceId: transaction?.referenceId ?? null,
        title: orderMeta?.title ?? transaction?.description ?? 'Incoming transaction',
        counterparty: orderMeta?.counterparty ?? null,
        stage:
          String(transaction?.type || '').toUpperCase() === 'ESCROW_RELEASE'
            ? this.resolveReleaseStage(transaction?.description)
            : 'PAYMENT',
        metadata: transaction?.metadata ?? Prisma.JsonNull,
      };
    });

    return {
      items,
      total,
      page: safePage,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  private async calculateAvailableBalance(brandId: string): Promise<number> {
    const snapshot = await this.calculateBalanceSnapshot(brandId);
    return snapshot.availableBalance;
  }

  private async calculateBalanceSnapshot(brandId: string) {
    const releasedBalance = await this.standardOrderEscrowService.getReleasedBalance(brandId);
    const legacyFallbackBalance = await this.getLegacyFallbackBalance(brandId);

    const payoutTotals = await this.prisma.payout.groupBy({
      by: ['status'],
      where: { brandId },
      _sum: { amount: true },
    });

    const reservedStatuses = new Set<PayoutStatus>([
      PayoutStatus.PENDING_APPROVAL,
      PayoutStatus.APPROVED,
      PayoutStatus.PROCESSING,
      PayoutStatus.ON_HOLD,
      PayoutStatus.RECONCILIATION_REVIEW,
    ]);

    const reservedPayoutBalance = payoutTotals.reduce((sum, row) => {
      if (!reservedStatuses.has(row.status)) {
        return sum;
      }
      return sum + Number(row._sum.amount ?? 0);
    }, 0);

    const paidOutBalance = payoutTotals.reduce((sum, row) => {
      if (row.status !== PayoutStatus.PAID) {
        return sum;
      }
      return sum + Number(row._sum.amount ?? 0);
    }, 0);

    const availableBalance = Number(
      (releasedBalance + legacyFallbackBalance - reservedPayoutBalance - paidOutBalance).toFixed(2),
    );

    return {
      availableBalance,
      releasedBalance: Number((releasedBalance + legacyFallbackBalance).toFixed(2)),
      reservedPayoutBalance: Number(reservedPayoutBalance.toFixed(2)),
      paidOutBalance: Number(paidOutBalance.toFixed(2)),
    };
  }

  private async getLegacyFallbackBalance(brandId: string): Promise<number> {
    const paidOrders = await this.prisma.order.findMany({
      where: {
        brandId,
        paymentStatus: 'PAID',
        escrowHold: { is: null },
      },
      select: {
        totalAmount: true,
        shippingCost: true,
        discountAmount: true,
      },
    });
    return paidOrders.reduce(
      (sum, order) =>
        sum +
        Number(order.totalAmount) +
        Number(order.shippingCost ?? 0) -
        Number(order.discountAmount ?? 0),
      0,
    );
  }

  private async getBrandId(ownerId: string): Promise<string> {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand.id;
  }

  private resolveReleaseStage(description?: string | null) {
    const haystack = String(description || '').toLowerCase();
    if (haystack.includes('shipment')) return 'SHIPPED_RELEASE';
    if (haystack.includes('final')) return 'DELIVERED_RELEASE';
    if (haystack.includes('immediate')) return 'ACCEPTED_RELEASE';
    return 'RELEASE';
  }
}
