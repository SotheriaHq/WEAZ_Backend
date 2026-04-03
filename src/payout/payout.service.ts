import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  PayoutStatus,
  Prisma,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { CommissionService } from 'src/finance/commission.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class PayoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly commissionService: CommissionService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
  ) {}

  async findAll(brandId: string, page = 1, limit = 20) {
    const skip = (page - 1) * limit;

    const [total, payouts] = await Promise.all([
      this.prisma.payout.count({ where: { brandId } }),
      this.prisma.payout.findMany({
        where: { brandId },
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
    if (amount < 5000) {
      throw new BadRequestException('Minimum payout amount is 5000');
    }

    await this.assertBrandExists(brandId);
    await this.syncLegacyStandardOrderSources(brandId);
    const balance = await this.calculateAvailableBalance(brandId);

    if (amount > balance) {
      throw new BadRequestException(
        `Insufficient balance. Available: ${balance}`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Brand" WHERE "id" = ${brandId}::uuid FOR UPDATE`;
      const refreshedBalance = await this.calculateAvailableBalance(brandId);
      if (amount > refreshedBalance) {
        throw new BadRequestException(
          `Insufficient balance. Available: ${refreshedBalance}`,
        );
      }

      const payoutId = uuidv4();
      const payout = await tx.payout.create({
        data: {
          id: payoutId,
          brandId,
          amount,
          currency: 'NGN',
          status: PayoutStatus.PENDING_APPROVAL,
        },
      });

      await this.reserveLedgerSources(tx, brandId, payoutId, amount, payout.currency);
      return payout;
    });
  }

  async getOverview(brandId: string) {
    await this.assertBrandExists(brandId);
    const { availableBalance, releasedBalance, reservedPayoutBalance, paidOutBalance } =
      await this.calculateBalanceSnapshot(brandId);

    const [orderStats, customOrderStats, activeEscrowHolds, queuedCustomAllocations] =
      await Promise.all([
        this.prisma.order.aggregate({
          where: { brandId, paymentStatus: 'PAID' },
          _count: { id: true },
        }),
        (this.prisma as any).customOrder.aggregate({
          where: { brandId, paymentStatus: 'PAID' },
          _count: { id: true },
        }),
        this.prisma.escrowHold.count({
          where: {
            brandId,
            status: { in: ['HELD', 'PARTIALLY_RELEASED', 'FROZEN'] as any },
          },
        }),
        this.prisma.customOrderLedgerAllocation.count({
          where: {
            customOrder: { brandId },
            status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            paidOutAt: null,
            payoutId: null,
          },
        }),
      ]);

    return {
      currency: 'NGN',
      availableBalance,
      releasedBalance,
      reservedPayoutBalance,
      paidOutBalance,
      incomingCredits: releasedBalance,
      totalOrders: (orderStats._count?.id ?? 0) + (customOrderStats._count?.id ?? 0),
      activeEscrowHolds,
      queuedCustomAllocations,
      negativeBalance: availableBalance < 0,
    };
  }

  async listIncomingTransactions(brandId: string, page = 1, limit = 20) {
    await this.assertBrandExists(brandId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [entries, legacyOrders, fallbackCustomAllocations] = await Promise.all([
      (this.prisma as any).ledgerEntry.findMany({
        where: {
          account: {
            entityType: 'BRAND',
            entityId: brandId,
          },
          direction: 'CREDIT',
        },
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
      this.prisma.order.findMany({
        where: {
          brandId,
          paymentStatus: 'PAID' as any,
          escrowHold: { is: null },
        },
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
      this.prisma.customOrderLedgerAllocation.findMany({
        where: {
          customOrder: { brandId },
          status: {
            in: [
              CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
              CustomOrderLedgerAllocationStatus.PAID_OUT,
            ],
          },
        },
        orderBy: [{ eligibleAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          allocationType: true,
          amount: true,
          commissionAmount: true,
          netBrandAmount: true,
          currency: true,
          eligibleAt: true,
          paidOutAt: true,
          createdAt: true,
          customOrderId: true,
          customOrder: {
            select: {
              id: true,
              sourceTitleSnapshot: true,
              buyer: {
                select: {
                  firstName: true,
                  lastName: true,
                  username: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const orderIds: string[] = [
      ...new Set<string>(
        entries
          .filter((entry: any) => entry.transaction?.referenceType === 'Order' && entry.transaction?.referenceId)
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    ];
    const customOrderIds: string[] = [
      ...new Set<string>(
        entries
          .filter(
            (entry: any) =>
              entry.transaction?.referenceType === 'CustomOrder' &&
              entry.transaction?.referenceId,
          )
          .map((entry: any) => String(entry.transaction.referenceId)),
      ),
    ];

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
        ? this.prisma.customOrder.findMany({
            where: { id: { in: customOrderIds } },
            select: {
              id: true,
              sourceTitleSnapshot: true,
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
              (typeof order?.sourceTitleSnapshot === 'string' &&
                order.sourceTitleSnapshot.trim()) ||
              `Custom Order #${String(order.id).slice(0, 8).toUpperCase()}`,
            counterparty: buyerName || String(order?.buyer?.username || 'Buyer'),
          },
        ] as const;
      }),
    );

    const ledgerCustomReleaseKeys = new Set<string>();
    for (const entry of entries) {
      const transaction = entry.transaction;
      if (String(transaction?.referenceType || '') !== 'CustomOrder' || !transaction?.referenceId) {
        continue;
      }

      const stage = this.resolveReleaseStage(transaction?.description);
      ledgerCustomReleaseKeys.add(`${String(transaction.referenceId)}:${stage}`);
    }

    const ledgerItems = entries.map((entry: any) => {
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

    const legacyItems = await this.buildLegacyStandardIncomeItems(brandId, legacyOrders);
    const customFallbackItems = fallbackCustomAllocations
      .filter((allocation) => {
        const stage = this.mapCustomAllocationStage(allocation.allocationType);
        return !ledgerCustomReleaseKeys.has(`${allocation.customOrderId}:${stage}`);
      })
      .map((allocation) => {
        const buyerName = [
          allocation.customOrder?.buyer?.firstName,
          allocation.customOrder?.buyer?.lastName,
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' ');

        const stage = this.mapCustomAllocationStage(allocation.allocationType);
        return {
          id: allocation.id,
          amount: this.roundMoney(Number(allocation.netBrandAmount ?? 0)),
          grossAmount: this.roundMoney(Number(allocation.amount ?? 0)),
          commissionAmount: this.roundMoney(Number(allocation.commissionAmount ?? 0)),
          netAmount: this.roundMoney(Number(allocation.netBrandAmount ?? 0)),
          balanceAfter: 0,
          currency: allocation.currency || 'NGN',
          createdAt: allocation.eligibleAt ?? allocation.paidOutAt ?? allocation.createdAt,
          transactionId: null,
          transactionType: 'ESCROW_RELEASE',
          description:
            stage === 'ACCEPTED_RELEASE'
              ? `Immediate custom-order release for ${allocation.customOrderId.slice(0, 8).toUpperCase()}`
              : `Final custom-order release for ${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          referenceType: 'CustomOrder',
          referenceId: allocation.customOrderId,
          title:
            allocation.customOrder?.sourceTitleSnapshot ||
            `Custom Order #${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          counterparty: buyerName || String(allocation.customOrder?.buyer?.username || 'Buyer'),
          stage,
          metadata: null,
        };
      });

    const allItems = [...ledgerItems, ...legacyItems, ...customFallbackItems].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    return {
      items: allItems.slice(skip, skip + safeLimit),
      total: allItems.length,
      page: safePage,
      totalPages: Math.ceil(allItems.length / safeLimit),
    };
  }

  async listHeldFunds(brandId: string, page = 1, limit = 20) {
    await this.assertBrandExists(brandId);
    const safePage = Math.max(1, Number(page) || 1);
    const safeLimit = Math.min(100, Math.max(1, Number(limit) || 20));
    const skip = (safePage - 1) * safeLimit;

    const [standardHolds, customHeldAllocations] = await Promise.all([
      this.prisma.escrowHold.findMany({
        where: {
          brandId,
          status: { in: ['HELD', 'PARTIALLY_RELEASED', 'FROZEN'] as any },
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          orderId: true,
          totalAmount: true,
          currency: true,
          status: true,
          firstReleaseNetAmount: true,
          secondReleaseNetAmount: true,
          firstReleasedAt: true,
          secondReleaseEligibleAt: true,
          secondReleaseCondition: true,
          frozenReason: true,
          createdAt: true,
          order: {
            select: {
              id: true,
              customerName: true,
            },
          },
        },
      }),
      this.prisma.customOrderLedgerAllocation.findMany({
        where: {
          customOrder: { brandId },
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          customOrderId: true,
          amount: true,
          netBrandAmount: true,
          currency: true,
          createdAt: true,
          customOrder: {
            select: {
              sourceTitleSnapshot: true,
              buyer: {
                select: {
                  firstName: true,
                  lastName: true,
                  username: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const items = [
      ...standardHolds.map((hold) => ({
        id: hold.id,
        holdType: 'STANDARD_ORDER',
        referenceId: hold.orderId,
        title: hold.order?.id
          ? `Order #${hold.order.id.slice(0, 8).toUpperCase()}`
          : 'Standard order hold',
        counterparty: hold.order?.customerName ?? 'Buyer',
        currency: hold.currency,
        grossAmount: this.roundMoney(Number(hold.totalAmount ?? 0)),
        releasedNetAmount: this.roundMoney(
          hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount ?? 0) : 0,
        ),
        heldNetAmount: this.roundMoney(Number(hold.secondReleaseNetAmount ?? 0)),
        status: hold.status,
        nextReleaseAt: hold.secondReleaseEligibleAt,
        releaseCondition: hold.secondReleaseCondition,
        frozenReason: hold.frozenReason ?? null,
        canRequestManualRelease:
          hold.status !== 'FROZEN' && hold.status !== 'RELEASED' && Boolean(hold.orderId),
        createdAt: hold.createdAt,
      })),
      ...customHeldAllocations.map((allocation) => {
        const buyerName = [
          allocation.customOrder?.buyer?.firstName,
          allocation.customOrder?.buyer?.lastName,
        ]
          .map((value) => String(value || '').trim())
          .filter(Boolean)
          .join(' ');

        return {
          id: allocation.id,
          holdType: 'CUSTOM_ORDER',
          referenceId: allocation.customOrderId,
          title:
            allocation.customOrder?.sourceTitleSnapshot ||
            `Custom Order #${allocation.customOrderId.slice(0, 8).toUpperCase()}`,
          counterparty: buyerName || String(allocation.customOrder?.buyer?.username || 'Buyer'),
          currency: allocation.currency || 'NGN',
          grossAmount: this.roundMoney(Number(allocation.amount ?? 0)),
          releasedNetAmount: 0,
          heldNetAmount: this.roundMoney(Number(allocation.netBrandAmount ?? 0)),
          status: 'HELD',
          nextReleaseAt: null,
          releaseCondition: 'BUYER_DELIVERY_CONFIRMED',
          frozenReason: null,
          canRequestManualRelease: false,
          createdAt: allocation.createdAt,
        };
      }),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      items: items.slice(skip, skip + safeLimit),
      total: items.length,
      page: safePage,
      totalPages: Math.ceil(items.length / safeLimit),
    };
  }

  private async calculateAvailableBalance(brandId: string): Promise<number> {
    const snapshot = await this.calculateBalanceSnapshot(brandId);
    return snapshot.availableBalance;
  }

  private async calculateBalanceSnapshot(brandId: string) {
    const [standardReleasedBalance, customReleasedBalance, legacyFallbackBalance, payoutTotals] =
      await Promise.all([
        this.standardOrderEscrowService.getReleasedBalance(brandId),
        this.getCustomOrderReleasedBalance(brandId),
        this.getLegacyFallbackBalance(brandId),
        this.prisma.payout.groupBy({
          by: ['status'],
          where: { brandId },
          _sum: { amount: true },
        }),
      ]);

    const reservedStatuses = this.getReservedPayoutStatuses();

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

    const releasedBalance = this.roundMoney(
      standardReleasedBalance + customReleasedBalance + legacyFallbackBalance,
    );
    const availableBalance = this.roundMoney(
      releasedBalance - reservedPayoutBalance - paidOutBalance,
    );

    return {
      availableBalance,
      releasedBalance,
      reservedPayoutBalance: this.roundMoney(reservedPayoutBalance),
      paidOutBalance: this.roundMoney(paidOutBalance),
    };
  }

  private async getCustomOrderReleasedBalance(brandId: string): Promise<number> {
    const released = await this.prisma.customOrderLedgerAllocation.aggregate({
      where: {
        customOrder: { brandId },
        status: {
          in: [
            CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            CustomOrderLedgerAllocationStatus.PAID_OUT,
          ],
        },
      },
      _sum: {
        netBrandAmount: true,
      },
    });

    return this.roundMoney(Number(released._sum.netBrandAmount ?? 0));
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
        currency: true,
      },
    });

    if (paidOrders.length === 0) {
      return 0;
    }

    const rateMap = await this.getCommissionRateMap(
      brandId,
      paidOrders.map((order) => String(order.currency || 'NGN')),
    );

    return this.roundMoney(
      paidOrders.reduce((sum, order) => {
        const grossAmount = Number(order.totalAmount ?? 0);
        const commissionRate = rateMap.get(String(order.currency || 'NGN').toUpperCase()) ?? 0;
        const commissionAmount = this.roundMoney((grossAmount * commissionRate) / 100);
        return sum + this.roundMoney(grossAmount - commissionAmount);
      }, 0),
    );
  }

  private async buildLegacyStandardIncomeItems(
    brandId: string,
    orders: Array<{
      id: string;
      totalAmount: Prisma.Decimal;
      currency: string;
      customerName: string;
      createdAt: Date;
      status: string;
    }>,
  ) {
    if (orders.length === 0) {
      return [];
    }

    const rateMap = await this.getCommissionRateMap(
      brandId,
      orders.map((order) => String(order.currency || 'NGN')),
    );

    return orders.map((order) => {
      const grossAmount = Number(order.totalAmount ?? 0);
      const commissionRate = rateMap.get(String(order.currency || 'NGN').toUpperCase()) ?? 0;
      const commissionAmount = this.roundMoney((grossAmount * commissionRate) / 100);
      const netAmount = this.roundMoney(grossAmount - commissionAmount);

      return {
        id: order.id,
        amount: netAmount,
        grossAmount: this.roundMoney(grossAmount),
        commissionAmount,
        netAmount,
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
  }

  private async getCommissionRateMap(brandId: string, currencies: string[]) {
    const uniqueCurrencies = Array.from(
      new Set(
        currencies
          .map((currency) => String(currency || 'NGN').trim().toUpperCase())
          .filter(Boolean),
      ),
    );

    const resolvedRules = await Promise.all(
      uniqueCurrencies.map(async (currency) => {
        const resolved = await this.commissionService.resolveRule({ brandId, currency });
        return [currency, resolved.ratePercent] as const;
      }),
    );

    return new Map<string, number>(resolvedRules);
  }

  private async syncLegacyStandardOrderSources(brandId: string) {
    const legacyOrderIds = await this.prisma.order.findMany({
      where: {
        brandId,
        paymentStatus: 'PAID',
        paymentReference: { not: null },
        escrowHold: { is: null },
      },
      select: { id: true },
      take: 200,
    });

    if (legacyOrderIds.length === 0) {
      return;
    }

    await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds(
      legacyOrderIds.map((order) => order.id),
    );
  }

  private async reserveLedgerSources(
    tx: Prisma.TransactionClient,
    brandId: string,
    payoutId: string,
    requestedAmount: number,
    currency: string,
  ) {
    const reservedStatuses = [...this.getReservedPayoutStatuses(), PayoutStatus.PAID];
    const creditEntries = await (tx as any).ledgerEntry.findMany({
      where: {
        direction: 'CREDIT',
        account: {
          entityType: 'BRAND',
          entityId: brandId,
          subType: 'BRAND_AVAILABLE',
        },
        transaction: {
          currency,
        },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        amount: true,
        createdAt: true,
        transaction: {
          select: {
            id: true,
            type: true,
            referenceType: true,
            referenceId: true,
            description: true,
          },
        },
        payoutSourceAllocations: {
          where: {
            payout: {
              status: { in: reservedStatuses },
            },
          },
          select: {
            amount: true,
          },
        },
      },
    });

    let remaining = this.roundMoney(requestedAmount);
    const rows: Array<{
      payoutId: string;
      ledgerEntryId: string;
      amount: Prisma.Decimal;
      currency: string;
      escrowHoldId?: string | null;
      releaseStage?: 'SHIPMENT_PORTION' | 'FINAL_PORTION';
    }> = [];

    for (const entry of creditEntries) {
      const alreadyReserved = this.roundMoney(
        (entry.payoutSourceAllocations ?? []).reduce(
          (sum: number, allocation: { amount: Prisma.Decimal }) =>
            sum + Number(allocation.amount ?? 0),
          0,
        ),
      );
      const available = this.roundMoney(Number(entry.amount ?? 0) - alreadyReserved);
      if (available <= 0) {
        continue;
      }

      const toReserve = this.roundMoney(Math.min(available, remaining));
      if (toReserve <= 0) {
        continue;
      }

      const metadata = await this.resolveEscrowSourceForLedgerEntry(tx, {
        referenceType: entry.transaction?.referenceType,
        referenceId: entry.transaction?.referenceId,
        description: entry.transaction?.description,
      });
      rows.push({
        payoutId,
        ledgerEntryId: entry.id,
        amount: new Prisma.Decimal(toReserve.toFixed(2)),
        currency,
        escrowHoldId: metadata.escrowHoldId,
        releaseStage: metadata.releaseStage,
      });

      remaining = this.roundMoney(remaining - toReserve);
      if (remaining <= 0) {
        break;
      }
    }

    if (remaining > 0) {
      throw new BadRequestException(
        `Exact payout source reservation failed. Reservable balance is ${this.roundMoney(
          requestedAmount - remaining,
        )}.`,
      );
    }

    if (rows.length === 0) {
      throw new BadRequestException('No payout source allocations were available to reserve');
    }

    await (tx as any).payoutLedgerSourceAllocation.createMany({
      data: rows.map((row) => ({
        payoutId: row.payoutId,
        ledgerEntryId: row.ledgerEntryId,
        amount: row.amount,
        currency: row.currency,
        escrowHoldId: row.escrowHoldId ?? null,
        releaseStage: row.releaseStage ?? null,
      })),
    });
  }

  private async resolveEscrowSourceForLedgerEntry(
    tx: Prisma.TransactionClient,
    params?: {
      referenceType?: string | null;
      referenceId?: string | null;
      description?: string | null;
    },
  ): Promise<{
    escrowHoldId: string | null;
    releaseStage: 'SHIPMENT_PORTION' | 'FINAL_PORTION' | null;
  }> {
    if (String(params?.referenceType ?? '').trim().toUpperCase() !== 'ORDER') {
      return { escrowHoldId: null, releaseStage: null };
    }

    const orderId = String(params?.referenceId ?? '').trim();
    if (!orderId) {
      return { escrowHoldId: null, releaseStage: null };
    }

    const hold = await tx.escrowHold.findUnique({
      where: { orderId },
      select: { id: true, firstReleasedAt: true, secondReleasedAt: true },
    });

    if (!hold) {
      return { escrowHoldId: null, releaseStage: null };
    }

    const description = String(params?.description ?? '').toLowerCase();
    if (description.includes('shipment')) {
      return { escrowHoldId: hold.id, releaseStage: 'SHIPMENT_PORTION' };
    }
    if (description.includes('final')) {
      return { escrowHoldId: hold.id, releaseStage: 'FINAL_PORTION' };
    }
    if (hold.firstReleasedAt) {
      return { escrowHoldId: hold.id, releaseStage: 'SHIPMENT_PORTION' };
    }

    return { escrowHoldId: hold.id, releaseStage: null };
  }

  async assertBrandOwnership(brandId: string, ownerId: string): Promise<void> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.ownerId !== ownerId) {
      throw new BadRequestException('Not authorized for this brand');
    }
  }

  private async assertBrandExists(brandId: string): Promise<void> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
  }

  private resolveReleaseStage(description?: string | null) {
    const haystack = String(description || '').toLowerCase();
    if (haystack.includes('shipment')) return 'SHIPPED_RELEASE';
    if (haystack.includes('final')) return 'DELIVERED_RELEASE';
    if (haystack.includes('immediate')) return 'ACCEPTED_RELEASE';
    return 'RELEASE';
  }

  private mapCustomAllocationStage(type: CustomOrderLedgerAllocationType) {
    return type === CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION
      ? 'ACCEPTED_RELEASE'
      : 'DELIVERED_RELEASE';
  }

  private getReservedPayoutStatuses() {
    return new Set<PayoutStatus>([
      PayoutStatus.PENDING_APPROVAL,
      PayoutStatus.APPROVED,
      PayoutStatus.PROCESSING,
      PayoutStatus.ON_HOLD,
      PayoutStatus.RECONCILIATION_REVIEW,
      PayoutStatus.FAILED,
    ]);
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
