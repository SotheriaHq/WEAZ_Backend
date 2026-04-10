import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, PaymentStatus, Prisma, NotificationType } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { reconcileStandardOrderPaymentStatuses } from 'src/common/payments/order-payment-reconciliation.util';
import { OrderRefundService } from './order-refund.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  /** Brand-side transitions: brands stop at SHIPPED. DELIVERED is buyer-initiated. */
  private readonly validTransitions: Record<OrderStatus, ReadonlyArray<OrderStatus>> = {
    [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
    [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    [OrderStatus.SHIPPED]: [],
    [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.RETURNED]: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly orderRefundService: OrderRefundService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePendingOrderPaymentsBackground() {
    const pendingOrders = await this.prisma.order.findMany({
      where: {
        paymentStatus: PaymentStatus.PENDING,
        paymentReference: { not: null },
      },
      select: {
        id: true,
        paymentReference: true,
        paymentStatus: true,
        paidAt: true,
      },
      take: 200,
      orderBy: { createdAt: 'desc' },
    });

    if (pendingOrders.length === 0) return;

    try {
      const resolvedByOrderId = await reconcileStandardOrderPaymentStatuses(
        this.prisma,
        pendingOrders,
      );
      const paidOrderIds = pendingOrders
        .filter((order) => resolvedByOrderId.get(order.id) === PaymentStatus.PAID)
        .map((order) => order.id);
      if (paidOrderIds.length > 0) {
        await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds(paidOrderIds);
      }
    } catch (error) {
      this.logger.error(
        `Background payment reconciliation failed: ${(error as Error).message}`,
      );
    }
  }

  @Cron('0 */15 * * * *')
  async releaseStandardOrderEscrowBackground() {
    try {
      await this.standardOrderEscrowService.autoConfirmDeliveredOrders();
      await this.standardOrderEscrowService.releaseEligibleFinalPortions();
    } catch (error) {
      this.logger.error(
        `Standard-order escrow release failed: ${(error as Error).message}`,
      );
    }
  }

  async findAll(
    brandId: string,
    page = 1,
    limit = 20,
    status?: OrderStatus,
    search?: string,
  ) {
    const skip = (page - 1) * limit;
    const realBrandId = await this.getBrandId(brandId);
    const where: Prisma.OrderWhereInput = {
      brandId: realBrandId,
      ...(status && { status }),
      ...(search && {
        OR: [
          { customerName: { contains: search, mode: 'insensitive' } },
          {
            contactInfo: {
              path: ['email'],
              string_contains: search,
              mode: 'insensitive',
            },
          },
          ...(this.isValidUuid(search) ? [{ id: { equals: search } }] : []),
        ],
      }),
    };

    const [total, orders, summaryAggregate, statusBreakdown] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          orderItems: {
            select: {
              id: true,
              quantity: true,
              unitPrice: true,
              totalPrice: true,
              selectedSize: true,
              selectedColor: true,
              sizingMode: true,
              requiredMeasurementKeys: true,
              sizeFitSnapshot: true,
              thumbnailAtPurchase: true,
              nameAtPurchase: true,
            },
          },
        },
      }),
      this.prisma.order.aggregate({
        where,
        _count: { id: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
      }),
    ]);
    const paymentStatusByOrderId = await reconcileStandardOrderPaymentStatuses(this.prisma, orders);
    const paidOrderIds = orders
      .filter((order) => paymentStatusByOrderId.get(order.id) === PaymentStatus.PAID)
      .map((order) => order.id);
    if (paidOrderIds.length > 0) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds(paidOrderIds);
    }

    const countsByStatus = statusBreakdown.reduce<Record<string, number>>((acc, entry) => {
      acc[entry.status] = entry._count._all;
      return acc;
    }, {});

    const normalizedOrders = orders.map((order) => ({
      ...order,
      paymentStatus:
        paymentStatusByOrderId.get(order.id) ?? order.paymentStatus,
      customerEmail:
        order.contactInfo && typeof order.contactInfo === 'object'
          ? ((order.contactInfo as Record<string, any>).email ?? null)
          : null,
      customerPhone:
        order.contactInfo && typeof order.contactInfo === 'object'
          ? ((order.contactInfo as Record<string, any>).phone ?? null)
          : null,
      orderItems: order.orderItems.map((item) => ({
        id: item.id,
        orderItemId: item.id,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: item.totalPrice,
        selectedSize: item.selectedSize,
        selectedColor: item.selectedColor,
        sizingMode: item.sizingMode,
        requiredMeasurementKeys: item.requiredMeasurementKeys,
        sizeFitSnapshot: item.sizeFitSnapshot,
        thumbnail: item.thumbnailAtPurchase,
        name: item.nameAtPurchase,
        productName: item.nameAtPurchase,
      })),
    }));

    return {
      items: normalizedOrders,
      total,
      page,
      totalPages: Math.ceil(total / limit),
      summary: {
        totalOrders: summaryAggregate._count.id ?? 0,
        totalRevenue: summaryAggregate._sum.totalAmount ?? new Prisma.Decimal(0),
        pendingCount: countsByStatus.PENDING ?? 0,
        processingCount: countsByStatus.PROCESSING ?? 0,
        shippedCount: countsByStatus.SHIPPED ?? 0,
        deliveredCount: countsByStatus.DELIVERED ?? 0,
        cancelledCount: countsByStatus.CANCELLED ?? 0,
        returnedCount: countsByStatus.RETURNED ?? 0,
      },
    };
  }

  async findOne(brandId: string, orderId: string) {
    const realBrandId = await this.getBrandId(brandId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        brandId: realBrandId,
      },
      include: {
        orderItems: true,
        brand: {
          select: {
            id: true,
            name: true,
            logo: true,
            currency: true,
            contactEmail: true,
            owner: {
              select: {
                phoneNumber: true,
                address: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }
    return this.hydrateOrderDetail(order);
  }

  async findOneForAdmin(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        orderItems: true,
        brand: {
          select: {
            id: true,
            name: true,
            logo: true,
            currency: true,
            contactEmail: true,
            owner: {
              select: {
                phoneNumber: true,
                address: true,
              },
            },
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    return this.hydrateOrderDetail(order);
  }

  async updateStatus(brandId: string, orderId: string, status: OrderStatus) {
    const realBrandId = await this.getBrandId(brandId);
    const order = await this.prisma.order.findFirst({
      where: {
        id: orderId,
        brandId: realBrandId,
      },
      include: {
        brand: {
          select: {
            name: true,
          },
        },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    if (order.status === status) {
      return order;
    }

    const allowedNext = this.validTransitions[order.status] ?? [];
    if (!allowedNext.includes(status)) {
      throw new BadRequestException('ORDER_INVALID_STATUS_TRANSITION');
    }

    // Brands cannot cancel an order once payment has been confirmed
    if (
      status === OrderStatus.CANCELLED &&
      order.paymentStatus === PaymentStatus.PAID
    ) {
      throw new BadRequestException(
        'ORDER_CANCEL_BLOCKED_PAYMENT_CONFIRMED',
      );
    }

    const previousStatus = order.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.order.update({
        where: { id: orderId },
        data: {
          status,
          ...(status === OrderStatus.DELIVERED && !order.deliveredAt
            ? { deliveredAt: new Date() }
            : {}),
        },
      });

      if (status === OrderStatus.SHIPPED) {
        await this.standardOrderEscrowService.releaseShipmentPortion(tx, orderId);
      }

      if (status === OrderStatus.RETURNED && order.paymentStatus === PaymentStatus.PAID) {
        await this.orderRefundService.initiateRefund(tx, {
          orderId,
          reason: 'ORDER_RETURNED',
          actorId: brandId,
        });
      }

      return next;
    });

    // Notify buyer about status change
    if (order.buyerId) {
      const firstItem = Array.isArray(order.items)
        ? order.items.find((item) => Boolean((item as Record<string, unknown>)?.name))
        : null;
      const orderTitle =
        firstItem && typeof (firstItem as Record<string, unknown>).name === 'string'
          ? ((firstItem as Record<string, unknown>).name as string).trim() || null
          : null;

      await this.notifications.create(
        order.buyerId,
        NotificationType.ORDER_STATUS_UPDATED,
        {
          actorId: brandId,
          payload: {
            orderId: order.id,
            orderTitle,
            status,
            previousStatus,
            brandName: order.brand?.name ?? null,
            targetUrl: `/orders/${order.id}`,
          },
        },
      );
    }

    return updated;
  }

  private async getBrandId(ownerId: string): Promise<string> {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      select: { id: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return brand.id;
  }

  private isValidUuid(id: string) {
    const regex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    return regex.test(id);
  }

  private async hydrateOrderDetail(order: any) {
    const paymentStatusByOrderId = await reconcileStandardOrderPaymentStatuses(
      this.prisma,
      [order],
    );
    if (paymentStatusByOrderId.get(order.id) === PaymentStatus.PAID) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByOrderIds([
        order.id,
      ]);
    }
    const financeSnapshot = await this.buildStandardOrderFinanceSnapshot(order);

    // Normalize contact fields for frontend consumption.
    const contactInfo = (order.contactInfo as Record<string, any>) || {};
    const shippingAddr = (order.shippingAddress as Record<string, any>) || null;

    return {
      ...order,
      paymentStatus: paymentStatusByOrderId.get(order.id) ?? order.paymentStatus,
      financeBreakdown: financeSnapshot.breakdown,
      buyerReceipt: financeSnapshot.receipt,
      customerEmail: contactInfo.email || null,
      customerPhone: contactInfo.phone || null,
      formattedShippingAddress: shippingAddr
        ? [
            shippingAddr.street,
            shippingAddr.apartment,
            shippingAddr.city,
            shippingAddr.state,
            shippingAddr.postalCode,
            shippingAddr.country,
          ]
            .filter(Boolean)
            .join(', ')
        : null,
    };
  }

  private async buildStandardOrderFinanceSnapshot(order: {
    id: string;
    paymentReference?: string | null;
    paymentStatus?: PaymentStatus | string | null;
    totalAmount: Prisma.Decimal | number;
    shippingCost?: Prisma.Decimal | number | null;
    discountAmount?: Prisma.Decimal | number | null;
    currency?: string | null;
    paidAt?: Date | string | null;
    createdAt?: Date | string | null;
    orderItems?: Array<{
      quantity?: number | null;
      unitPrice?: Prisma.Decimal | number | null;
      totalPrice?: Prisma.Decimal | number | null;
      nameAtPurchase?: string | null;
    }>;
  }) {
    const paymentAttempt = order.paymentReference
      ? await this.prisma.paymentAttempt.findFirst({
          where: { reference: order.paymentReference },
          select: {
            id: true,
            reference: true,
            amount: true,
            currency: true,
            settlementAmount: true,
            settlementCurrency: true,
            confirmedAt: true,
          },
        })
      : null;

    const [hold, receipt, ledgerTransactions] = await Promise.all([
      this.prisma.escrowHold.findUnique({
        where: { orderId: order.id },
        select: {
          totalAmount: true,
          commissionRate: true,
          commissionAmount: true,
          netBrandAmount: true,
          currency: true,
          status: true,
          firstReleaseAmount: true,
          firstReleaseCommissionAmount: true,
          firstReleaseNetAmount: true,
          firstReleasedAt: true,
          secondReleaseAmount: true,
          secondReleaseCommissionAmount: true,
          secondReleaseNetAmount: true,
          secondReleaseEligibleAt: true,
          secondReleaseCondition: true,
          secondReleasedAt: true,
          refundedAt: true,
          refundReason: true,
        },
      }),
      (this.prisma as any).financialDocument.findFirst({
        where: {
          type: 'BUYER_RECEIPT',
          OR: [
            ...(paymentAttempt?.id ? [{ paymentAttemptId: paymentAttempt.id }] : []),
            { orderId: order.id },
          ],
        },
        orderBy: { issuedAt: 'desc' },
      }),
      (this.prisma as any).ledgerTransaction.findMany({
        where: {
          referenceType: 'Order',
          referenceId: order.id,
        },
        orderBy: { createdAt: 'asc' },
        include: {
          entries: {
            include: {
              account: {
                select: {
                  code: true,
                  name: true,
                  type: true,
                  subType: true,
                  entityType: true,
                  entityId: true,
                },
              },
            },
          },
        },
      }),
    ]);

    const itemSubtotal = this.roundCurrency(
      Array.isArray(order.orderItems)
        ? order.orderItems.reduce((sum, item) => {
            if (item.totalPrice != null) {
              return sum + Number(item.totalPrice);
            }
            return sum + Number(item.unitPrice ?? 0) * Number(item.quantity ?? 0);
          }, 0)
        : 0,
    );
    const shippingAmount = this.roundCurrency(Number(order.shippingCost ?? 0));
    const discountAmount = this.roundCurrency(Number(order.discountAmount ?? 0));
    const grossAmount = this.roundCurrency(Number(order.totalAmount ?? 0));
    const receiptMetadata = this.asJsonObject(receipt?.metadataJson);

    return {
      breakdown: {
        currency: String(order.currency || paymentAttempt?.currency || hold?.currency || 'NGN'),
        itemSubtotal,
        shippingAmount,
        discountAmount,
        grossAmount,
        paymentReference: order.paymentReference ?? paymentAttempt?.reference ?? null,
        paymentStatus: order.paymentStatus ?? null,
        paidAt: order.paidAt ?? paymentAttempt?.confirmedAt ?? null,
        escrowStatus: hold?.status ?? null,
        commissionRate: hold ? Number(hold.commissionRate ?? 0) : null,
        commissionAmount: hold ? this.roundCurrency(Number(hold.commissionAmount ?? 0)) : null,
        netBrandAmount: hold ? this.roundCurrency(Number(hold.netBrandAmount ?? 0)) : null,
        releaseSchedule: hold
          ? [
              {
                stage: 'SHIPPED_RELEASE',
                grossAmount: this.roundCurrency(Number(hold.firstReleaseAmount ?? 0)),
                commissionAmount: this.roundCurrency(
                  Number(hold.firstReleaseCommissionAmount ?? 0),
                ),
                netAmount: this.roundCurrency(Number(hold.firstReleaseNetAmount ?? 0)),
                releasedAt: hold.firstReleasedAt ?? null,
              },
              {
                stage: 'DELIVERED_RELEASE',
                grossAmount: this.roundCurrency(Number(hold.secondReleaseAmount ?? 0)),
                commissionAmount: this.roundCurrency(
                  Number(hold.secondReleaseCommissionAmount ?? 0),
                ),
                netAmount: this.roundCurrency(Number(hold.secondReleaseNetAmount ?? 0)),
                eligibleAt: hold.secondReleaseEligibleAt ?? null,
                condition: hold.secondReleaseCondition ?? null,
                releasedAt: hold.secondReleasedAt ?? null,
              },
            ]
          : [],
        ledgerTransactions: Array.isArray(ledgerTransactions)
          ? ledgerTransactions.map((transaction: any) => ({
              id: transaction.id,
              type: transaction.type,
              description: transaction.description,
              totalAmount: this.roundCurrency(Number(transaction.totalAmount ?? 0)),
              currency: transaction.currency,
              createdAt: transaction.createdAt,
              entries: Array.isArray(transaction.entries)
                ? transaction.entries.map((entry: any) => ({
                    id: entry.id,
                    direction: entry.direction,
                    amount: this.roundCurrency(Number(entry.amount ?? 0)),
                    accountCode: entry.account?.code ?? null,
                    accountName: entry.account?.name ?? null,
                    accountType: entry.account?.type ?? null,
                    accountSubType: entry.account?.subType ?? null,
                  }))
                : [],
            }))
          : [],
      },
      receipt: receipt
        ? {
            id: receipt.id,
            documentNumber: receipt.documentNumber,
            type: receipt.type,
            issuedAt: receipt.issuedAt,
            currency: receipt.currency,
            grossAmount: this.roundCurrency(Number(receipt.grossAmount ?? 0)),
            commissionAmount:
              receipt.commissionAmount != null
                ? this.roundCurrency(Number(receipt.commissionAmount))
                : null,
            netAmount:
              receipt.netAmount != null
                ? this.roundCurrency(Number(receipt.netAmount))
                : null,
            paymentAttemptId: receipt.paymentAttemptId ?? paymentAttempt?.id ?? null,
            paymentReference: paymentAttempt?.reference ?? order.paymentReference ?? null,
            settlementCurrency:
              typeof receiptMetadata?.settlementCurrency === 'string'
                ? receiptMetadata.settlementCurrency
                : paymentAttempt?.settlementCurrency ?? null,
            settlementAmount:
              receiptMetadata?.settlementAmount != null
                ? this.roundCurrency(Number(receiptMetadata.settlementAmount))
                : paymentAttempt?.settlementAmount != null
                  ? this.roundCurrency(Number(paymentAttempt.settlementAmount))
                  : null,
            issuedToName:
              typeof receiptMetadata?.issuedToName === 'string'
                ? receiptMetadata.issuedToName
                : null,
            lineItems: Array.isArray(receiptMetadata?.lineItems)
              ? receiptMetadata.lineItems
                  .map((item) => {
                    const raw = this.asJsonObject(item);
                    return {
                      label:
                        typeof raw?.label === 'string'
                          ? raw.label
                          : `Order ${order.id.slice(0, 8)}`,
                      amount: this.roundCurrency(Number(raw?.amount ?? 0)),
                    };
                  })
                  .filter((item) => item.amount >= 0)
              : [],
          }
        : null,
    };
  }

  private asJsonObject(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : null;
  }

  private roundCurrency(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
