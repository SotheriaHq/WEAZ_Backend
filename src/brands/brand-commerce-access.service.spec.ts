import { BrandCommerceAccessService } from './brand-commerce-access.service';
const now = new Date('2026-10-21T12:00:00Z');
function service(agreement: unknown = null, legacy = false, available = ['THREAD', 'ASO_OKE', 'ARU', 'IGWE']) {
  const prisma = {
    brand: {
      findUnique: jest.fn().mockResolvedValue({
        customerMinimumOrders: 3,
        customOrderLegacyEligible: legacy,
      }),
    },
    brandSubscription: { findFirst: jest.fn().mockResolvedValue(agreement) },
    subscriptionTier: {
      findMany: jest
        .fn()
        .mockResolvedValue(
          available.map((key) => ({ key })),
        ),
    },
  };
  return new BrandCommerceAccessService(prisma as any);
}
describe('Brand commerce access', () => {
  it('offers the first paid tier to a free brand in a partially seeded environment', async () => {
    expect(await service(null, false, ['THREAD']).get('brand', now)).toMatchObject({tierKey:'FREE',canUpgrade:true});
    expect((await service({status:'ACTIVE',tierKey:'THREAD',currentPeriodEnd:new Date(now.getTime()+1000),tier:{monthlyPriceNgn:10000}},false,['THREAD']).get('brand',now)).canUpgrade).toBe(false);
  });
  it('shows all qualifying shoppers for free brands and offers upgrade', async () => {
    expect(await service().get('brand', now)).toMatchObject({
      effectiveMinimumOrders: 1,
      canConfigureCustomers: false,
      canUpgrade: true,
    });
  });
  it('uses the saved paid threshold until the exact end of the paid period', async () => {
    const agreement = {
      status: 'ACTIVE',
      tierKey: 'ASO_OKE',
      currentPeriodEnd: new Date(now.getTime() + 1),
      tier: { monthlyPriceNgn: 1000 },
    };
    expect(await service(agreement).get('brand', now)).toMatchObject({
      effectiveMinimumOrders: 3,
      canConfigureCustomers: true,
      canUpgrade: true,
    });
    expect(
      await service({ ...agreement, currentPeriodEnd: now }).get('brand', now),
    ).toMatchObject({
      effectiveMinimumOrders: 1,
      canConfigureCustomers: false,
    });
  });
  it('never offers a nonexistent upgrade to the highest or legacy tiers', async () => {
    expect(
      (
        await service({
          status: 'ACTIVE',
          tierKey: 'IGWE',
          currentPeriodEnd: new Date(now.getTime() + 1000),
          tier: { monthlyPriceNgn: 10000 },
        }).get('brand', now)
      ).canUpgrade,
    ).toBe(false);
    expect((await service(null, true).get('brand', now)).canUpgrade).toBe(
      false,
    );
  });
});
