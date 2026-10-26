import { ForbiddenException } from '@nestjs/common';
import { BrandCustomersService } from './brand-customers.service';
describe('Brand customer authorization and classification', () => {
  const tx = { $queryRaw: jest.fn(), $executeRaw: jest.fn() };
  const prisma = { brand: { update: jest.fn() }, $queryRaw: jest.fn(), $transaction: jest.fn() };
  const access = {
    assertBrandOwnerAndResolve: jest.fn(),
    resolveBrandContext: jest.fn(),
  };
  const permissions = { assertPermission: jest.fn() };
  const commerce = { get: jest.fn() };
  const service = new BrandCustomersService(
    prisma as any,
    access as any,
    permissions as any,
    commerce as any,
  );
  beforeEach(() => {
    jest.resetAllMocks();
    access.assertBrandOwnerAndResolve.mockResolvedValue({ brandId: 'brand' });
    access.resolveBrandContext.mockResolvedValue({ brandId: 'brand' });
    prisma.$transaction.mockImplementation(work => work(tx));
  });
  it('rejects cross-brand requests before reading orders', async () => {
    permissions.assertPermission.mockRejectedValue(new ForbiddenException());
    await expect(
      service.list('attacker', 'brand', { page: 1, limit: 25 }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it('rejects free-plan setting writes server-side', async () => {
    commerce.get.mockResolvedValue({ canConfigureCustomers: false });
    await expect(
      service.updateSettings('owner', 'brand', 3),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });
  it('returns only customer criteria to staff and keeps billing/settings owner-only', async () => {
    commerce.get.mockResolvedValue({ tierKey: 'IGWE', canUpgrade: false, canConfigureCustomers: true, customerMinimumOrders: 3, effectiveMinimumOrders: 3, serverNow: 'private-server-time', entitlementExpiresAt: 'private-billing-date' });
    prisma.$queryRaw.mockResolvedValue([{ items: [], total: 0n }]);
    const result = await service.list('staff', 'brand', { page: 1, limit: 25 });
    expect(result.settings).toEqual({ effectiveMinimumOrders: 3 });
    access.assertBrandOwnerAndResolve.mockRejectedValue(new ForbiddenException());
    await expect(service.settings('staff', 'brand')).rejects.toBeInstanceOf(ForbiddenException);
  });
  it('refuses an expired or revoked entitlement after waiting for the brand lock', async () => {
    commerce.get.mockResolvedValue({ canConfigureCustomers: true });
    tx.$executeRaw.mockResolvedValue(0);
    await expect(service.updateSettings('owner', 'brand', 4)).rejects.toBeInstanceOf(ForbiddenException);
    expect(tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(tx.$executeRaw.mock.invocationCallOrder[0]);
    expect(prisma.brand.update).not.toHaveBeenCalled();
  });
  it('paginates aggregated customers, including an empty later page', async () => {
    commerce.get.mockResolvedValue({ effectiveMinimumOrders: 3 });
    prisma.$queryRaw.mockResolvedValue([{ items: [], total: 41n }]);
    expect(
      await service.list('owner', 'brand', {
        page: 3,
        limit: 25,
        search: '100%',
      }),
    ).toMatchObject({ items: [], total: 41, hasNextPage: false });
    const query = prisma.$queryRaw.mock.calls[0][0];
    expect(query.values).toContain('100%');
    expect(query.text).not.toContain('100%');
  });
});
