import { BadRequestException, ConflictException } from '@nestjs/common';
import { OrderService } from './order.service';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { OrderStatus } from '@prisma/client';
import { OrderRefundService } from './order-refund.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';

describe('OrderService', () => {
  let service: OrderService;
  let prisma: any;
  let notifications: any;
  let refundService: any;
  let escrowService: any;
  let financeSyncService: any;

  beforeEach(() => {
    prisma = {
      brand: {
        findUnique: jest.fn(),
        findFirst: jest.fn(),
      },
      order: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUniqueOrThrow: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    notifications = {
      create: jest.fn(),
      emitOrderUpdated: jest.fn(),
    };

    refundService = {
      initiateRefund: jest.fn(),
    };

    escrowService = {
      releaseShipmentPortion: jest.fn(),
      autoConfirmDeliveredOrders: jest.fn(),
      releaseEligibleFinalPortions: jest.fn(),
    };

    financeSyncService = {
      syncPaidOrdersByOrderIds: jest.fn(),
    };

    prisma.$transaction.mockImplementation(async (cb: any) => cb(prisma));

    service = new OrderService(
      prisma as PrismaService,
      notifications as NotificationsService,
      refundService as OrderRefundService,
      escrowService as StandardOrderEscrowService,
      financeSyncService as StandardOrderFinanceSyncService,
    );
  });

  it('blocks invalid status transitions', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });
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
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('refuses a transition when a concurrent command already moved the order', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.PROCESSING,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });
    prisma.order.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.updateStatus('owner_1', 'order_1', OrderStatus.SHIPPED),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(escrowService.releaseShipmentPortion).not.toHaveBeenCalled();
    expect(notifications.create).not.toHaveBeenCalled();
  });

  it('allows valid transitions from processing to shipped', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.PROCESSING,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });
    prisma.order.findUniqueOrThrow.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.SHIPPED,
    });

    const result = await service.updateStatus(
      'owner_1',
      'order_1',
      OrderStatus.SHIPPED,
    );

    // Conditional on the status the command validated.
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order_1', status: OrderStatus.PROCESSING },
        data: expect.objectContaining({ status: OrderStatus.SHIPPED }),
      }),
    );
    expect(notifications.create).toHaveBeenCalled();
    expect(result).toEqual({ id: 'order_1', status: OrderStatus.SHIPPED });
  });

  it('releases the first escrow tranche when the brand confirms shipment', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.PROCESSING,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: null,
    });
    prisma.order.update.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.SHIPPED,
    });

    await service.updateStatus('owner_1', 'order_1', OrderStatus.SHIPPED);

    expect(escrowService.releaseShipmentPortion).toHaveBeenCalledWith(
      prisma,
      'order_1',
    );
  });

  it('initiates refund when transitioning a paid delivered order to returned', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });
    prisma.order.findFirst.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.DELIVERED,
      paymentStatus: 'PAID',
      brandId: 'brand_1',
      buyerId: 'buyer_1',
      brand: { name: 'Brand' },
      deliveredAt: new Date('2026-03-01T10:00:00.000Z'),
    });
    prisma.order.update.mockResolvedValue({
      id: 'order_1',
      status: OrderStatus.RETURNED,
    });

    await service.updateStatus('owner_1', 'order_1', OrderStatus.RETURNED);

    expect(refundService.initiateRefund).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        orderId: 'order_1',
        reason: 'ORDER_RETURNED',
        trigger: 'RETURN',
        actorId: 'owner_1',
      }),
    );
    // The shopper is told the refund is pending, never that it is done.
    expect(notifications.create).toHaveBeenCalledWith(
      'buyer_1',
      expect.anything(),
      expect.objectContaining({
        payload: expect.objectContaining({ refundStatus: 'PENDING' }),
      }),
    );
  });
});
