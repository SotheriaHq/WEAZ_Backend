import { ForbiddenException } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

describe('OrderController', () => {
  let controller: OrderController;
  let orderService: jest.Mocked<
    Pick<OrderService, 'findAll' | 'findOne' | 'updateStatus'>
  >;
  let orderAccessService: any;
  let brandPermissionService: any;

  beforeEach(() => {
    orderService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      updateStatus: jest.fn(),
    };
    orderAccessService = {
      assertOrderBrandRead: jest.fn(),
      assertOrderBrandUpdate: jest.fn(),
    };
    brandPermissionService = {
      assertPermission: jest.fn(),
    };
    controller = new OrderController(
      orderService as unknown as OrderService,
      orderAccessService,
      brandPermissionService,
    );
  });

  it('propagates ForbiddenException for list access without orders.read', async () => {
    brandPermissionService.assertPermission.mockRejectedValue(
      new ForbiddenException(
        'You do not have permission for this brand action',
      ),
    );

    await expect(
      controller.findAll(
        'brand_owner_1',
        { user: { id: 'other_owner' } },
        '1',
        '20',
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates status update when actor has orders.update', async () => {
    orderService.updateStatus.mockResolvedValue({
      id: 'order_1',
      status: 'PROCESSING',
    } as any);

    const result = await controller.updateStatus(
      'brand_owner_1',
      'order_1',
      { status: 'PROCESSING' as any },
      { user: { id: 'staff_1' } },
    );

    expect(orderAccessService.assertOrderBrandUpdate).toHaveBeenCalledWith(
      'staff_1',
      'order_1',
    );
    expect(orderService.updateStatus).toHaveBeenCalledWith(
      'brand_owner_1',
      'order_1',
      'PROCESSING',
      'staff_1',
    );
    expect(result).toEqual({ id: 'order_1', status: 'PROCESSING' });
  });
});
