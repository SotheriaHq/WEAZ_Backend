import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, PaymentStatus, Prisma, NotificationType } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private mapAttemptStatusToPaymentStatus(status: string | null | undefined): PaymentStatus {
    switch ((status ?? '').toUpperCase()) {
      case 'PAID':
        return PaymentStatus.PAID;
      case 'FAILED':
      case 'CANCELLED':
      case 'EXPIRED':
        return PaymentStatus.FAILED;
      default:
        return PaymentStatus.PENDING;
    }
  }

  private async reconcileOrderPaymentStatuses(
    orders: Array<{
      id: string;
      paymentReference: string | null;
      paymentStatus: PaymentStatus;
      paidAt?: Date | null;
    }>,
  ): Promise<Map<string, PaymentStatus>> {
    const references = Array.from(
      new Set(
        orders
          .map((order) => order.paymentReference)
          .filter((reference): reference is string => Boolean(reference)),
      ),
    );

    const resolvedByOrderId = new Map<string, PaymentStatus>();
    if (references.length === 0) {
      return resolvedByOrderId;
    }

    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { reference: { in: references } },
      select: { reference: true, status: true, confirmedAt: true },
    });

    const attemptByReference = new Map(
      attempts.map((attempt) => [attempt.reference, attempt]),
    );

    const updates = orders
      .map((order) => {
        const reference = order.paymentReference;
        if (!reference) return null;
        const attempt = attemptByReference.get(reference);
        if (!attempt) return null;

        const resolvedStatus = this.mapAttemptStatusToPaymentStatus(
          attempt.status,
        );
        resolvedByOrderId.set(order.id, resolvedStatus);

        if (
          order.paymentStatus === resolvedStatus &&
          (resolvedStatus !== PaymentStatus.PAID || order.paidAt || !attempt.confirmedAt)
        ) {
          return null;
        }

        return this.prisma.order.update({
          where: { id: order.id },
          data: {
            paymentStatus: resolvedStatus,
            paidAt: resolvedStatus === PaymentStatus.PAID ? attempt.confirmedAt : null,
          },
        });
      })
      .filter(Boolean);

    if (updates.length > 0) {
      await this.prisma.$transaction(updates as Prisma.PrismaPromise<unknown>[]);
    }

    return resolvedByOrderId;
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
        where: { brandId: realBrandId },
        _count: { id: true },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.groupBy({
        by: ['status'],
        where: { brandId: realBrandId },
        _count: { _all: true },
      }),
    ]);
    const paymentStatusByOrderId = await this.reconcileOrderPaymentStatuses(orders);

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
    const paymentStatusByOrderId = await this.reconcileOrderPaymentStatuses([order]);

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
    });

    if (!order) {
      throw new NotFoundException('Order not found');
    }

    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data: {
        status,
        ...(status === OrderStatus.DELIVERED && !order.deliveredAt
          ? { deliveredAt: new Date() }
          : {}),
      },
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
}
