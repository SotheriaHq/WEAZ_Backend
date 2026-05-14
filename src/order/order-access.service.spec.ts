import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { OrderAccessService } from './order-access.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

describe('OrderAccessService', () => {
  let prisma: any;
  let permissions: any;
  let service: OrderAccessService;

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
      },
    };
    permissions = {
      assertPermission: jest.fn(),
    };
    service = new OrderAccessService(prisma, permissions);
  });

  it('allows a buyer to read their own order', async () => {
    prisma.order.findUnique.mockResolvedValue({ buyerId: 'buyer_1', brandId: 'brand_1' });

    await expect(service.assertOrderBuyerAccess('buyer_1', 'order_1')).resolves.toBeUndefined();
  });

  it('blocks another buyer from reading an order', async () => {
    prisma.order.findUnique.mockResolvedValue({ buyerId: 'buyer_1', brandId: 'brand_1' });

    await expect(service.assertOrderBuyerAccess('buyer_2', 'order_1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('requires orders.read for brand order reads', async () => {
    prisma.order.findUnique.mockResolvedValue({ brandId: 'brand_1' });

    await service.assertOrderBrandRead('staff_1', 'order_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  });

  it('requires orders.update for brand order mutations', async () => {
    prisma.order.findUnique.mockResolvedValue({ brandId: 'brand_1' });

    await service.assertOrderBrandUpdate('staff_1', 'order_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
  });

  it('returns not found for a missing order', async () => {
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.assertOrderBrandRead('staff_1', 'missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
