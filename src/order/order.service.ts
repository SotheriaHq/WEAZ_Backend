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

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);

  private readonly validTransitions: Record<OrderStatus, ReadonlyArray<OrderStatus>> = {
    [OrderStatus.PENDING]: [OrderStatus.PROCESSING, OrderStatus.CANCELLED],
    [OrderStatus.PROCESSING]: [OrderStatus.SHIPPED, OrderStatus.CANCELLED],
    [OrderStatus.SHIPPED]: [OrderStatus.DELIVERED],
    [OrderStatus.DELIVERED]: [OrderStatus.RETURNED],
    [OrderStatus.CANCELLED]: [],
    [OrderStatus.RETURNED]: [],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly orderRefundService: OrderRefundService,
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
      await reconcileStandardOrderPaymentStatuses(this.prisma, pendingOrders);
    } catch (error) {
      this.logger.error(
        `Background payment reconciliation failed: ${(error as Error).message}`,
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
        brand: { select: { id: true, name: true, logo: true, currency: true } },
      },
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }
    const paymentStatusByOrderId = await reconcileStandardOrderPaymentStatuses(this.prisma, [order]);

    // Normalize contact fields for frontend consumption
    const contactInfo = (order.contactInfo as Record<string, any>) || {};
    const shippingAddr = (order.shippingAddress as Record<string, any>) || null;

    return {
      ...order,
      paymentStatus:
        paymentStatusByOrderId.get(order.id) ?? order.paymentStatus,
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
      await this.notifications.create(
        order.buyerId,
        NotificationType.ORDER_STATUS_UPDATED,
        {
          actorId: brandId,
          payload: {
            orderId: order.id,
            status,
            previousStatus,
            brandName: order.brand?.name ?? null,
            targetUrl: `/orders/access/${order.id}`,
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
}
