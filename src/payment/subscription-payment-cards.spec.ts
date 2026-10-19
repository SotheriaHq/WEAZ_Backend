import { ConflictException, NotFoundException } from '@nestjs/common';
import { PaymentService } from './payment.service';

describe('subscription card storage and deletion boundaries', () => {
  let service: PaymentService, prisma: any;
  const secret = process.env.PAYMENT_SAVED_METHODS_SECRET;
  beforeEach(() => {
    process.env.PAYMENT_SAVED_METHODS_SECRET = 'isolated-unit-test-key';
    prisma = {
      $queryRaw: jest.fn(),
      $executeRaw: jest.fn(),
      savedPaymentMethod: {
        findFirst: jest.fn(),
        upsert: jest.fn((args) => ({ id: 'card-one', ...args.create })),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        update: jest.fn(),
      },
      brandSubscription: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ savedPaymentMethodId: 'card-one' }]),
      },
      brandSubscriptionInvoice: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    service = Object.create(PaymentService.prototype);
    Object.assign(service, { prisma, logger: { warn: jest.fn() } });
    jest
      .spyOn(service as any, 'isCanonicalSavedMethodsEnabledForUser')
      .mockReturnValue(true);
  });
  afterEach(() => {
    if (secret === undefined) delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    else process.env.PAYMENT_SAVED_METHODS_SECRET = secret;
  });
  it('stores only encrypted authorization and masks the public summary', async () => {
    const row = await service.saveVerifiedSubscriptionCard(
      prisma,
      'owner',
      {
        reusable: true,
        authorization_code: 'AUTH_private_test_value',
        last4: '4081',
        signature: 'provider-signature',
        exp_month: '12',
        exp_year: '2030',
      },
      'payer@example.com',
    );
    expect(row.providerAuthorizationCodeEncrypted).not.toContain(
      'AUTH_private_test_value',
    );
    expect(
      (service as any).decryptSavedPaymentMethodAuthorizationCode(
        row.providerAuthorizationCodeEncrypted,
      ),
    ).toBe('AUTH_private_test_value');
    const summary = (service as any).mapSavedPaymentMethodToSummary(row);
    expect(summary.last4).toBe('4081');
    expect(JSON.stringify(summary)).not.toMatch(
      /AUTH_private|payer@example|provider-signature|Authorization/,
    );
  });
  it('does not mark a display-only fingerprint as reusable', () => {
    expect(
      (service as any).mapSavedPaymentMethodToSummary({
        id: 'card',
        status: 'ACTIVE',
        last4: '4081',
        providerAuthorizationMeta: { reusable: false },
      }).reusable,
    ).toBe(false);
  });
  it('rejects renaming another user’s card and prevents PAN in nicknames', async () => {
    await expect(
      service.renameSavedPaymentCard('outsider', 'card-one', 'Business'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.savedPaymentMethod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'card-one', buyerId: 'outsider', status: 'ACTIVE' },
      }),
    );
    await expect(
      service.renameSavedPaymentCard(
        'owner',
        'card-one',
        '4111 1111 1111 1111',
      ),
    ).rejects.toThrow('without a card number');
  });
  it('blocks deletion until renewal uses a replacement or is stopped', async () => {
    prisma.savedPaymentMethod.findFirst.mockResolvedValue({
      id: 'card-one',
      buyerId: 'owner',
      status: 'ACTIVE',
      isDefault: false,
    });
    await expect(
      service.removeSavedPaymentCard('card-one', 'owner'),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.savedPaymentMethod.update).not.toHaveBeenCalled();
    prisma.brandSubscription.findMany.mockResolvedValue([]);
    await service.removeSavedPaymentCard('card-one', 'owner');
    expect(prisma.savedPaymentMethod.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DISABLED',
          providerAuthorizationCodeEncrypted: null,
        }),
      }),
    );
  });
  it('never resurrects a deleted historical card during backfill', async () => {
    jest
      .spyOn(service as any, 'collectLegacySavedPaystackCardsWithAuthorization')
      .mockResolvedValue([
        { identityKey: 'sig:deleted', authorizationCode: 'AUTH_old' },
      ]);
    prisma.savedPaymentMethod.findUnique = jest
      .fn()
      .mockResolvedValue({ status: 'DISABLED' });
    await (service as any).backfillSavedPaymentMethodsFromAttempts('owner');
    expect(prisma.savedPaymentMethod.upsert).not.toHaveBeenCalled();
  });
});
