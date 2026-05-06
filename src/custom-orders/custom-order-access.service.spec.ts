import { ForbiddenException } from '@nestjs/common';
import { CustomOrderAccessService } from './custom-order-access.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';

describe('CustomOrderAccessService', () => {
  let prisma: any;
  let permissions: any;
  let service: CustomOrderAccessService;

  beforeEach(() => {
    prisma = {
      brand: {
        findFirst: jest.fn(),
      },
      customOrder: {
        findUnique: jest.fn(),
      },
    };
    permissions = {
      assertPermission: jest.fn(),
    };
    service = new CustomOrderAccessService(prisma, permissions);
  });

  it('allows a buyer to read their own custom order', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({ buyerId: 'buyer_1' });

    await expect(
      service.assertCustomOrderBuyerAccess('buyer_1', 'co_1'),
    ).resolves.toBeUndefined();
  });

  it('blocks another buyer from reading a custom order', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({ buyerId: 'buyer_1' });

    await expect(
      service.assertCustomOrderBuyerAccess('buyer_2', 'co_1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requires orders.read for brand custom-order reads', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({ brandId: 'brand_1' });

    await service.assertCustomOrderBrandRead('staff_1', 'co_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  });

  it('requires orders.update for brand custom-order mutations', async () => {
    prisma.customOrder.findUnique.mockResolvedValue({ brandId: 'brand_1' });

    await service.assertCustomOrderBrandUpdate('staff_1', 'co_1');

    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
  });

  it('resolves brand id from brand id or owner id before list checks', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand_1' });

    await expect(service.assertBrandOrdersRead('staff_1', 'owner_1')).resolves.toBe('brand_1');
    expect(permissions.assertPermission).toHaveBeenCalledWith(
      'staff_1',
      'brand_1',
      BRAND_PERMISSIONS.ORDERS_READ,
    );
  });
});
