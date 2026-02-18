import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, Prisma, NotificationType } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';

@Injectable()
export class OrderService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async findAll(
    brandId: string,
    page = 1,
    limit = 20,
    status?: OrderStatus,
    search?: string,
  ) {
    const skip = (page - 1) * limit;
    const where: Prisma.OrderWhereInput = {
      brandId: {
        equals: await this.getBrandId(brandId),
      },
      ...(status && { status }),
      ...(search && {
        OR: [
          { customerName: { contains: search, mode: 'insensitive' } },
          ...(this.isValidUuid(search) ? [{ id: { equals: search } }] : []),
        ],
      }),
    };

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
      }),
    ]);

    return {
      items: orders,
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findOne(brandId: string, orderId: string) {
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

    return order;
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
      data: { status },
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
