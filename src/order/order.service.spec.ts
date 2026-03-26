import { BadRequestException } from '@nestjs/common';
import { OrderService } from './order.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { OrderStatus } from '@prisma/client';
import { OrderRefundService } from './order-refund.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';

describe('OrderService', () => {
  let service: OrderService;
  let prisma: any;
  let notifications: any;
  let refundService: any;
  let escrowService: any;

  beforeEach(() => {
    prisma = {
      brand: {
        findUnique: jest.fn(),
      },
      order: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    notifications = {
      create: jest.fn(),
    };

    refundService = {
      initiateRefund: jest.fn(),
    };

    escrowService = {
      releaseShipmentPortion: jest.fn(),
      autoConfirmDeliveredOrders: jest.fn(),
      releaseEligibleFinalPortions: jest.fn(),
    };

    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));

    service = new OrderService(
      prisma as PrismaService,
      notifications as NotificationsService,
      refundService as OrderRefundService,
      escrowService as StandardOrderEscrowService,
    );
  });

  it('blocks invalid status transitions', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.PENDING,
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });

    await expect(
      service.updateStatus('owner_1', 'order_1', OrderStatus.DELIVERED),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.order.update).not.toHaveBeenCalled();
  });

  it('allows valid transitions and sets deliveredAt when delivered', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.SHIPPED,
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });
    prisma.order.update.mockResolvedValue({ id: 'order_1', status: OrderStatus.DELIVERED });

    const result = await service.updateStatus('owner_1', 'order_1', OrderStatus.DELIVERED);

    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1' },
        data: expect.objectContaining({ status: OrderStatus.DELIVERED, deliveredAt: expect.any(Date) }),
      }),
    );
    expect(notifications.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'order_1', status: OrderStatus.DELIVERED });
  });

  it('releases the first escrow tranche when the brand confirms shipment', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.PROCESSING,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });
    prisma.order.update.mockResolvedValue({ id: 'order_1', status: OrderStatus.SHIPPED });

    await service.updateStatus('owner_1', 'order_1', OrderStatus.SHIPPED);

    expect(escrowService.releaseShipmentPortion).toHaveBeenCalledWith(prisma, 'order_1');
  });

  it('initiates refund when transitioning a paid delivered order to returned', async () => {
    prisma.brand.findUnique.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.DELIVERED,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    prisma.order.update.mockResolvedValue({ id: 'order_1', status: OrderStatus.RETURNED });

    await service.updateStatus('owner_1', 'order_1', OrderStatus.RETURNED);

    expect(refundService.initiateRefund).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        orderId: 'order_1',
        reason: 'ORDER_RETURNED',
        actorId: 'owner_1',
      }),
    );
  });
});
