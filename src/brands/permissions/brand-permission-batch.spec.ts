import { BrandPermissionService } from './brand-permission.service';
import { BRAND_PERMISSIONS } from './brand-permissions';
import { CustomOrderQueueService } from '../../custom-orders/queue/custom-order-queue.service';

describe('scoped brand permission reads', () => {
  it('skips empty pages and deduplicates bounded permission queries', async () => {
    const query = jest.fn().mockResolvedValue([{ id: 'allowed' }]);
    const service = new BrandPermissionService({ $queryRaw: query } as any);
    expect(await service.getPermittedBrandIds('user', [], BRAND_PERMISSIONS.ORDERS_READ)).toEqual(new Set());
    expect(query).not.toHaveBeenCalled();
    const ids = Array.from({ length: 501 }, (_, i) => String(i));
    expect(await service.getPermittedBrandIds('user', [...ids, ids[0]], BRAND_PERMISSIONS.ORDERS_READ)).toEqual(new Set(['allowed']));
    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0][0].text).toContain('EXISTS');
  });

  const queue = (allowed: string[], userType = 'BRAND') => {
    const permissions = { getPermittedBrandIds: jest.fn().mockResolvedValue(new Set(allowed)) };
    const present = jest.fn().mockResolvedValue({});
    const service = Object.assign(Object.create(CustomOrderQueueService.prototype), {
      prisma: {
        user: { findUnique: jest.fn().mockResolvedValue({ type: userType }) },
        customOrder: { findMany: jest.fn().mockResolvedValue([
          { id: 'first', brandId: 'a', buyerId: 'buyer' },
          { id: 'second', brandId: 'b', buyerId: 'other-buyer' },
        ]) },
      }, permissions, present,
    });
    return { service, permissions, present };
  };

  it('rejects the entire mixed-brand page when any permission is absent', async () => {
    const { service, permissions, present } = queue(['a']);
    await expect(service.batch('staff', ['first', 'second'])).rejects.toThrow('You do not have permission');
    expect(permissions.getPermittedBrandIds).toHaveBeenCalledTimes(1);
    expect(present).not.toHaveBeenCalled();
  });

  it('authorizes all brands once before presenting the page', async () => {
    const { service, permissions, present } = queue(['a', 'b']);
    await service.batch('staff', ['first', 'second']);
    expect(permissions.getPermittedBrandIds).toHaveBeenCalledWith('staff', ['a', 'b'], BRAND_PERMISSIONS.ORDERS_READ);
    expect(present).toHaveBeenCalledTimes(1);
  });

  it('retains strict buyer ownership checks without reading staff permissions', async () => {
    const { service, permissions } = queue(['a', 'b'], 'REGULAR');
    await expect(service.batch('buyer', ['first', 'second'])).rejects.toThrow('Not authorized');
    expect(permissions.getPermittedBrandIds).not.toHaveBeenCalled();
  });
});
