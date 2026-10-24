import { CustomOrderQueueService } from './custom-order-queue.service';

describe('checkout intake eligibility batch', () => {
  const setup = (overrides: Record<string, any> = {}, buyer: any = { type: 'REGULAR', status: 'ACTIVE' }) => {
    const row = { id: 'brand', ownerId: 'owner', tierConfigured: true, intakeAllowed: true, ...overrides };
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue(buyer) }, $queryRaw: jest.fn().mockResolvedValue([row]) };
    const service = Object.assign(Object.create(CustomOrderQueueService.prototype), { prisma });
    return { service, prisma };
  };
  it('deduplicates brands and reads the buyer once', async () => {
    const { service, prisma } = setup();
    await service.assertIntakeForBrands('buyer', ['brand', 'brand']);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
  it('does no work for an empty batch', async () => {
    const { service, prisma } = setup();
    await service.assertIntakeForBrands('buyer', []);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
  it.each([null, { type: 'BRAND', status: 'ACTIVE' }, { type: 'REGULAR', status: 'SUSPENDED' }])('rejects an ineligible buyer: %s', async (buyer) => {
    const { service, prisma } = setup({}, buyer);
    await expect(service.assertIntakeForBrands('buyer', ['brand'])).rejects.toThrow('Only an eligible shopper');
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
  it.each([
    [{ ownerId: 'buyer' }, 'Only an eligible shopper'],
    [{ tierConfigured: false }, 'CUSTOM_ORDER_TIER_CONFIGURATION_MISSING'],
    [{ intakeAllowed: false }, 'CUSTOM_ORDER_INTAKE_UNAVAILABLE'],
  ])('fails closed for invalid brand entitlement: %s', async (row, message) => {
    const { service } = setup(row);
    await expect(service.assertIntakeForBrands('buyer', ['brand'])).rejects.toThrow(message);
  });
  it('rejects a missing brand', async () => {
    const { service, prisma } = setup(); prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.assertIntakeForBrands('buyer', ['brand'])).rejects.toThrow('Brand not found');
  });
});
