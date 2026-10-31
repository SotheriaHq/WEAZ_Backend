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
        findMany: jest.fn().mockResolvedValue([]),
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
});

describe('checkout card saving', () => {
  let service: PaymentService, prisma: any;
  const secret = process.env.PAYMENT_SAVED_METHODS_SECRET;
  const verifiedAuthorization = {
    brand: 'visa',
    bank: 'Test Bank',
    last4: '4081',
    expMonth: '12',
    expYear: '2030',
    reusable: true,
    signature: 'provider-signature',
    channel: 'card',
    authorizationCode: 'AUTH_private_test_value',
  };
  const paidAttempt = {
    id: 'attempt-1',
    buyerId: 'buyer',
    provider: 'PAYSTACK',
    channel: 'CARD',
    providerChannel: 'CARD',
    requestSnapshot: { email: 'payer@example.com', saveNewCard: true },
  };
  // No paymentAttempt or paymentEvent delegate: any read of attempt history
  // fails these tests with a TypeError.
  beforeEach(() => {
    process.env.PAYMENT_SAVED_METHODS_SECRET = 'isolated-unit-test-key';
    prisma = {
      $executeRaw: jest.fn(),
      savedPaymentMethod: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn((args) => ({ id: 'card-one', ...args.create })),
        update: jest.fn(),
      },
    };
    prisma.$transaction = jest.fn((fn) => fn(prisma));
    service = Object.create(PaymentService.prototype);
    Object.assign(service, { prisma, logger: { warn: jest.fn() } });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    if (secret === undefined) delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    else process.env.PAYMENT_SAVED_METHODS_SECRET = secret;
  });

  it('saves the card from a verified checkout, encrypted, with its payer email and source attempt', async () => {
    await service.rememberVerifiedCheckoutCard(
      paidAttempt,
      verifiedAuthorization,
    );
    expect(prisma.savedPaymentMethod.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.savedPaymentMethod.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      buyerId_providerAuthorizationSignature: {
        buyerId: 'buyer',
        providerAuthorizationSignature: 'sig:provider-signature',
      },
    });
    expect(args.create).toMatchObject({
      buyerId: 'buyer',
      status: 'ACTIVE',
      last4: '4081',
      isDefault: true,
      sourcePaymentAttemptId: 'attempt-1',
      providerAuthorizationMeta: {
        reusable: true,
        authorizationEmail: 'payer@example.com',
      },
    });
    expect(JSON.stringify(args)).not.toContain('AUTH_private_test_value');
    expect(
      (service as any).decryptSavedPaymentMethodAuthorizationCode(
        args.create.providerAuthorizationCodeEncrypted,
      ),
    ).toBe('AUTH_private_test_value');
  });

  it.each([
    [
      'the buyer opted out',
      { ...paidAttempt, requestSnapshot: { saveNewCard: false } },
      verifiedAuthorization,
    ],
    [
      'it was not a card payment',
      { ...paidAttempt, channel: 'BANK', providerChannel: 'BANK' },
      { ...verifiedAuthorization, channel: 'bank' },
    ],
    [
      'Paystack did not make it reusable',
      paidAttempt,
      { ...verifiedAuthorization, reusable: false },
    ],
    [
      'there is no buyer',
      { ...paidAttempt, buyerId: null },
      verifiedAuthorization,
    ],
    ['there is no authorization', paidAttempt, null],
  ])('saves nothing when %s', async (_why, attempt, authorization) => {
    await expect(
      service.rememberVerifiedCheckoutCard(attempt as any, authorization),
    ).resolves.toBeNull();
    expect(prisma.savedPaymentMethod.upsert).not.toHaveBeenCalled();
  });

  it('never fails the payment when the card cannot be stored', async () => {
    delete process.env.PAYMENT_SAVED_METHODS_SECRET;
    await expect(
      service.rememberVerifiedCheckoutCard(paidAttempt, verifiedAuthorization),
    ).resolves.toBeNull();
    expect(prisma.savedPaymentMethod.upsert).not.toHaveBeenCalled();
    expect((service as any).logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('attempt-1'),
    );
  });

  it('keeps the reusable code out of the stored payment snapshot', async () => {
    jest
      .spyOn(service as any, 'getProviderModeForAttempt')
      .mockReturnValue('live');
    jest.spyOn(service as any, 'verifyPaystackAttempt').mockResolvedValue({
      status: 'PAID',
      rawStatus: 'success',
      reference: 'TH-1',
      transactionId: '1',
      amount: 100,
      currency: 'NGN',
      channel: 'CARD',
      paidAt: null,
      message: null,
      authorization: verifiedAuthorization,
    });

    const resolved = await service.resolveAttemptVerification(
      { provider: 'PAYSTACK', responseSnapshot: {} } as any,
      { reference: 'TH-1', gateway: 'PAYSTACK' } as any,
    );

    expect(resolved.providerAuthorization).toBe(verifiedAuthorization);
    expect(JSON.stringify(resolved.responseSnapshotPatch)).not.toMatch(
      /AUTH_private|provider-signature/,
    );
    expect(resolved.responseSnapshotPatch?.providerVerificationCard).toEqual({
      brand: 'visa',
      bank: 'Test Bank',
      last4: '4081',
      expMonth: '12',
      expYear: '2030',
      reusable: true,
    });
  });

  it('lists only canonical saved cards', async () => {
    prisma.savedPaymentMethod.findMany.mockResolvedValue([
      {
        id: 'card-one',
        status: 'ACTIVE',
        last4: '4081',
        providerAuthorizationCodeEncrypted: 'sealed',
        providerAuthorizationMeta: { reusable: true },
      },
    ]);
    await expect(service.listSavedPaymentCards('buyer')).resolves.toEqual([
      expect.objectContaining({ id: 'card-one', reusable: true }),
    ]);
  });

  it('charges a saved card under the email Paystack bound it to', async () => {
    prisma.savedPaymentMethod.findFirst.mockResolvedValue({
      id: 'card-one',
      providerAuthorizationCodeEncrypted: (
        service as any
      ).encryptSavedPaymentMethodAuthorizationCode('AUTH_private_test_value'),
      providerAuthorizationMeta: {
        reusable: true,
        authorizationEmail: 'payer@example.com',
      },
      sourcePaymentAttemptId: 'attempt-1',
    });
    await expect(
      (service as any).resolveSavedPaystackAuthorization('buyer', 'card-one'),
    ).resolves.toEqual({
      authorizationCode: 'AUTH_private_test_value',
      authorizationEmail: 'payer@example.com',
    });
  });

  it('does not treat an old payment attempt id as a saved card', async () => {
    prisma.savedPaymentMethod.findFirst.mockResolvedValue(null);
    await expect(
      (service as any).resolveSavedPaystackAuthorization('buyer', 'attempt-1'),
    ).rejects.toThrow('no longer available');
  });
});
