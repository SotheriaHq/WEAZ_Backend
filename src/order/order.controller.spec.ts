import { ForbiddenException } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

describe('OrderController', () => {
  let controller: OrderController;
  let orderService: jest.Mocked<
    Pick<OrderService, 'findAll' | 'findOne' | 'updateStatus'>
  >;

  beforeEach(() => {
    orderService = {
      findAll: jest.fn(),
      findOne: jest.fn(),
      updateStatus: jest.fn(),
    };
    controller = new OrderController(orderService as unknown as OrderService);
  });

  it('throws ForbiddenException for cross-brand list access', async () => {
    await expect(
      controller.findAll('brand_owner_1', { user: { id: 'other_owner' } }, '1', '20'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('delegates status update when brand owner matches', async () => {
    orderService.updateStatus.mockResolvedValue({ id: 'order_1', status: 'PROCESSING' } as any);

    const result = await controller.updateStatus(
      'brand_owner_1',
      'order_1',
      { status: 'PROCESSING' as any },
      { user: { id: 'brand_owner_1' } },
    );

    expect(orderService.updateStatus).toHaveBeenCalledWith('brand_owner_1', 'order_1', 'PROCESSING');
    expect(result).toEqual({ id: 'order_1', status: 'PROCESSING' });
  });
});
