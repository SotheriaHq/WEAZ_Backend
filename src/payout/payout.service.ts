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

    // Count of paid orders and total incoming credits for the brand
    const [orderStats, incomingCreditsAgg] = await Promise.all([
      this.prisma.order.aggregate({
        where: { brandId: realBrandId, paymentStatus: 'PAID' },
        _count: { id: true },
        _sum: { totalAmount: true },
      }),
      (this.prisma as any).ledgerEntry.aggregate({
        where: {
          account: { entityType: 'BRAND', entityId: realBrandId },
          direction: 'CREDIT',
        },
        _sum: { amount: true },
        _count: { id: true },
      }).catch(() => ({ _sum: { amount: null }, _count: { id: 0 } })),
    ]);

    const incomingCredits = Number(incomingCreditsAgg?._sum?.amount ?? 0) > 0
      ? Number(Number(incomingCreditsAgg._sum.amount).toFixed(2))
      : Number(Number(orderStats._sum?.totalAmount ?? 0).toFixed(2));

    return {
      currency: 'NGN',
      availableBalance,
      releasedBalance,
      reservedPayoutBalance,
      paidOutBalance,
      incomingCredits,
      totalOrders: orderStats._count?.id ?? 0,
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
              entries: {
                select: {
                  direction: true,
                  amount: true,
                  account: {
                    select: {
                      subType: true,
                      entityId: true,
                    },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const orderIds: string[] = Array.from(
      new Set(
        entries
          .filter((entry: any) => entry.transaction?.referenceType === 'Order' && entry.transaction?.referenceId)
          .map((entry: any) => String(entry.transaction.referenceId))
          .filter((value: string) => value.length > 0),
      ),
    );
    const customOrderIds: string[] = Array.from(
      new Set(
        entries
          .filter((entry: any) => entry.transaction?.referenceType === 'CustomOrder' && entry.transaction?.referenceId)
          .map((entry: any) => String(entry.transaction.referenceId))
          .filter((value: string) => value.length > 0),
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

    const orderById = new Map<string, { title: string; counterparty: string | null }>(
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

    const customOrderById = new Map<string, { title: string; counterparty: string | null }>(
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
        grossAmount: this.roundMoney(Number(transaction?.totalAmount ?? entry.amount ?? 0)),
        commissionAmount: this.roundMoney(
          Array.isArray(transaction?.entries)
            ? transaction.entries
                .filter(
                  (line: any) =>
                    line.direction === 'CREDIT' &&
                    line.account?.subType === 'PLATFORM_COMMISSION',
                )
                .reduce((sum: number, line: any) => sum + Number(line.amount ?? 0), 0)
            : 0,
        ),
        netAmount: this.roundMoney(Number(entry.amount ?? 0)),
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

    // Fallback: if no ledger entries exist, show paid orders directly as income records
    if (total === 0) {
      return this.listLegacyOrderIncome(realBrandId, safePage, safeLimit);
    }

    return {
      items,
      total,
      page: safePage,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  private async listLegacyOrderIncome(brandId: string, page: number, limit: number) {
    const skip = (page - 1) * limit;

    const standardWhere: Prisma.OrderWhereInput = {
      brandId,
      paymentStatus: 'PAID' as any,
    };

    const [standardTotal, paidOrders, customOrderTotal, paidCustomOrders] = await Promise.all([
      this.prisma.order.count({ where: standardWhere }),
      this.prisma.order.findMany({
        where: standardWhere,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          totalAmount: true,
          currency: true,
          customerName: true,
          createdAt: true,
          status: true,
        },
      }),
      (this.prisma as any).customOrder.count({
        where: { brandId, paymentStatus: 'PAID' },
      }),
      (this.prisma as any).customOrder.findMany({
        where: { brandId, paymentStatus: 'PAID' },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          sourceTitleSnapshot: true,
          buyerPriceSummaryJson: true,
          currency: true,
          status: true,
          createdAt: true,
          buyer: {
            select: { firstName: true, lastName: true, username: true },
          },
        },
      }),
    ]);

    const standardItems = paidOrders.map((order: any) => {
      const netAmount = Number(order.totalAmount ?? 0);
      return {
        id: order.id,
        amount: Number(netAmount.toFixed(2)),
        grossAmount: Number(netAmount.toFixed(2)),
        commissionAmount: 0,
        netAmount: Number(netAmount.toFixed(2)),
        balanceAfter: 0,
        currency: order.currency || 'NGN',
        createdAt: order.createdAt,
        transactionId: null,
        transactionType: 'PAYMENT_RECEIVED',
        description: `Payment for order #${order.id.slice(0, 8).toUpperCase()}`,
        referenceType: 'Order',
        referenceId: order.id,
        title: `Order #${order.id.slice(0, 8).toUpperCase()}`,
        counterparty: order.customerName,
        stage:
          String(order.status) === 'DELIVERED'
            ? 'DELIVERED_RELEASE'
            : String(order.status) === 'SHIPPED'
              ? 'SHIPPED_RELEASE'
              : 'PAYMENT',
        metadata: null,
      };
    });

    const customItems = paidCustomOrders.map((order: any) => {
      const summary =
        order.buyerPriceSummaryJson && typeof order.buyerPriceSummaryJson === 'object'
          ? (order.buyerPriceSummaryJson as Record<string, unknown>)
          : {};
      const netAmount = Number((summary as any).grandTotal ?? 0);
      const buyerName = [order.buyer?.firstName, order.buyer?.lastName]
        .map((v: string) => String(v || '').trim())
        .filter(Boolean)
        .join(' ') || String(order.buyer?.username || 'Buyer');
      return {
        id: order.id,
        amount: Number(netAmount.toFixed(2)),
        grossAmount: Number(netAmount.toFixed(2)),
        commissionAmount: 0,
        netAmount: Number(netAmount.toFixed(2)),
        balanceAfter: 0,
        currency: (summary as any).currency || order.currency || 'NGN',
        createdAt: order.createdAt,
        transactionId: null,
        transactionType: 'PAYMENT_RECEIVED',
        description: `Custom order #${order.id.slice(0, 8).toUpperCase()}`,
        referenceType: 'CustomOrder',
        referenceId: order.id,
        title: order.sourceTitleSnapshot || `Custom Order #${order.id.slice(0, 8).toUpperCase()}`,
        counterparty: buyerName,
        stage: String(order.status) === 'COMPLETED' ? 'DELIVERED_RELEASE' : 'PAYMENT',
        metadata: null,
      };
    });

    // Merge, sort by date, then paginate
    const allItems = [...standardItems, ...customItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
    const total = standardTotal + customOrderTotal;
    const paginated = allItems.slice(skip, skip + limit);

    return {
      items: paginated,
      total,
      page,
      totalPages: Math.ceil(total / limit),
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
        sum + Number(order.totalAmount ?? 0),
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

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
