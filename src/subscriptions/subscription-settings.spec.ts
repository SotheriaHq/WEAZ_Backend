import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { SubscriptionsService } from './subscriptions.service';

describe('private billing settings and shared notice tracker', () => {
  const now = new Date('2026-10-19T10:00:00Z');
  let prisma: any, access: any, service: SubscriptionsService;
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(now);
    prisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      $transaction: jest.fn((fn) => fn(prisma)),
      brandSubscription: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      brandSubscriptionInvoice: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
      brand: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ customOrderLegacyEligible: false }),
      },
      subscriptionTier: {
        findUnique: jest.fn(({ where }) => ({
          key: where.key,
          name: where.key,
          monthlyPriceNgn: 10000,
        })),
      },
      subscriptionNoticeReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn(),
        updateMany: jest.fn(),
      },
    };
    access = {
      assertBrandOwnerAndResolve: jest
        .fn()
        .mockResolvedValue({ brandId: 'brand-one' }),
    };
    service = new SubscriptionsService(prisma, access, {} as any, {} as any);
  });
  afterEach(() => jest.useRealTimers());

  it.each(['notice', 'history', 'cards'])(
    'authorizes ownership before reading %s',
    async (kind) => {
      access.assertBrandOwnerAndResolve.mockRejectedValue(
        new ForbiddenException(),
      );
      await expect(
        kind === 'notice'
          ? service.claimNotice('outsider', 'brand-one')
          : kind === 'history'
            ? service.historyForOwner('outsider', 'brand-one', {})
            : service.paymentMethods('outsider', 'brand-one'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.brandSubscriptionInvoice.findMany).not.toHaveBeenCalled();
    },
  );
  it.each([
    ['THREAD', 'ASO_OKE'],
    ['ASO_OKE', 'ARU'],
    ['ARU', 'IGWE'],
  ])('offers the next tier for %s', async (tierKey, expected) => {
    prisma.brandSubscription.findFirst.mockResolvedValue({
      tierKey,
      status: 'ACTIVE',
      currentPeriodEnd: new Date(+now + 86400000),
    });
    expect(
      (await service.claimNotice('owner', 'brand-one')).notice?.tierKey,
    ).toBe(expected);
    expect(prisma.subscriptionNoticeReceipt.upsert).toHaveBeenCalledTimes(1);
  });
  it('offers Thread for no subscription, suppresses Legacy and Igwe, and enforces the exact shared 24-hour boundary', async () => {
    expect(
      (await service.claimNotice('owner', 'brand-one')).notice?.tierKey,
    ).toBe('THREAD');
    prisma.brand.findUnique.mockResolvedValue({
      customOrderLegacyEligible: true,
    });
    expect((await service.claimNotice('owner', 'brand-one')).notice).toBeNull();
    prisma.brand.findUnique.mockResolvedValue({
      customOrderLegacyEligible: false,
    });
    prisma.brandSubscription.findFirst.mockResolvedValue({
      tierKey: 'IGWE',
      status: 'ACTIVE',
      currentPeriodEnd: new Date(+now + 86400000),
    });
    expect((await service.claimNotice('owner', 'brand-one')).notice).toBeNull();
    prisma.brandSubscription.findFirst.mockResolvedValue(null);
    prisma.subscriptionNoticeReceipt.findUnique.mockResolvedValue({
      lastShownAt: new Date(+now - 86400000 + 1),
    });
    expect((await service.claimNotice('owner', 'brand-one')).notice).toBeNull();
    prisma.subscriptionNoticeReceipt.findUnique.mockResolvedValue({
      lastShownAt: new Date(+now - 86400000),
    });
    expect(
      (await service.claimNotice('owner', 'brand-one')).notice?.tierKey,
    ).toBe('THREAD');
  });
  it('rejects another brand’s history cursor and bounds the page to 25', async () => {
    prisma.brandSubscriptionInvoice.findFirst.mockResolvedValue(null);
    await expect(
      service.historyForOwner('owner', 'brand-one', { cursor: 'foreign-id' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.brandSubscriptionInvoice.findMany).not.toHaveBeenCalled();
    prisma.brandSubscriptionInvoice.findMany.mockResolvedValue(
      Array.from({ length: 26 }, (_, i) => ({
        id: String(i),
        amount: 10000,
        subscription: { tierKey: 'THREAD' },
        providerAuthorizationCode: 'must-not-leak',
        paymentIdentityJson: { secret: 'must-not-leak' },
      })),
    );
    const page = await service.historyForOwner('owner', 'brand-one', {});
    expect(page.items).toHaveLength(25);
    expect(page.nextCursor).toBe('24');
    expect(JSON.stringify(page)).not.toContain('must-not-leak');
    expect(prisma.brandSubscriptionInvoice.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscription: { brandId: 'brand-one' } },
        take: 26,
      }),
    );
  });
  it('preserves the per-attempt payer after changing the agreement email', () => {
    const invoice = {
      payerEmail: 'original@example.com',
      paymentIdentityJson: { retry: { email: 'retry@example.com' } },
      subscription: { providerCustomerEmail: 'new-card@example.com' },
    };
    expect((service as any).paymentEmail(invoice, 'initial')).toBe(
      'original@example.com',
    );
    expect((service as any).paymentEmail(invoice, 'retry')).toBe(
      'retry@example.com',
    );
  });
});
