import { BadRequestException } from '@nestjs/common';
import { PaymentMethod } from '@prisma/client';
import { PaymentService } from './payment.service';

describe('PaymentService', () => {
  let originalPaymentsMode: string | undefined;
  let originalPaystackSecretKey: string | undefined;
  let originalNodeEnv: string | undefined;
  let originalRedisUrl: string | undefined;
  let originalRedisHost: string | undefined;
  let originalRedisPort: string | undefined;
  let originalFrontendPublicCheckoutCallbackUrl: string | undefined;
  let originalWebAppUrl: string | undefined;
  let originalWebAppUseHttps: string | undefined;
  let originalPaystackCustomCardEntryEnabled: string | undefined;
  let originalPaystackCardholderNameMatchMode: string | undefined;
  let service: PaymentService;

  beforeEach(() => {
    originalPaymentsMode = process.env.PAYMENTS_MODE;
    originalPaystackSecretKey = process.env.PAYSTACK_SECRET_KEY;
    originalNodeEnv = process.env.NODE_ENV;
    originalRedisUrl = process.env.REDIS_URL;
    originalRedisHost = process.env.REDIS_HOST;
    originalRedisPort = process.env.REDIS_PORT;
    originalFrontendPublicCheckoutCallbackUrl =
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL;
    originalWebAppUrl = process.env.WEB_APP_URL;
    originalWebAppUseHttps = process.env.WEB_APP_USE_HTTPS;
    originalPaystackCustomCardEntryEnabled =
      process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED;
    originalPaystackCardholderNameMatchMode =
      process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE;
    process.env.PAYMENTS_MODE = 'live';
    process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED = 'true';
    process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE = 'soft';
    service = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();

    if (originalPaymentsMode === undefined) delete process.env.PAYMENTS_MODE;
    else process.env.PAYMENTS_MODE = originalPaymentsMode;

    if (originalPaystackSecretKey === undefined)
      delete process.env.PAYSTACK_SECRET_KEY;
    else process.env.PAYSTACK_SECRET_KEY = originalPaystackSecretKey;

    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;

    if (originalRedisUrl === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = originalRedisUrl;

    if (originalRedisHost === undefined) delete process.env.REDIS_HOST;
    else process.env.REDIS_HOST = originalRedisHost;

    if (originalRedisPort === undefined) delete process.env.REDIS_PORT;
    else process.env.REDIS_PORT = originalRedisPort;

    if (originalFrontendPublicCheckoutCallbackUrl === undefined) {
      delete process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL;
    } else {
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL =
        originalFrontendPublicCheckoutCallbackUrl;
    }

    if (originalWebAppUrl === undefined) delete process.env.WEB_APP_URL;
    else process.env.WEB_APP_URL = originalWebAppUrl;

    if (originalWebAppUseHttps === undefined)
      delete process.env.WEB_APP_USE_HTTPS;
    else process.env.WEB_APP_USE_HTTPS = originalWebAppUseHttps;

    if (originalPaystackCustomCardEntryEnabled === undefined) {
      delete process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED;
    } else {
      process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED =
        originalPaystackCustomCardEntryEnabled;
    }

    if (originalPaystackCardholderNameMatchMode === undefined) {
      delete process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE;
    } else {
      process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE =
        originalPaystackCardholderNameMatchMode;
    }
  });

  it('accepts new-card Paystack payloads for gateway use and sanitizes stored snapshots', () => {
    const paymentData = {
      email: 'buyer@example.com',
      phone: '08030000000',
      consentAccepted: true,
      billingSameAsShipping: true,
      billingAddress: {
        firstName: 'Test',
        lastName: 'User',
        street: '10 Broad Street',
        city: 'Lagos',
        state: 'Lagos',
        country: 'Nigeria',
      },
      channel: 'CARD',
      newCardDraft: {
        cardHolderName: 'Test User',
        cardNumber: '4084 0840 8408 4081',
        expiry: '12/99',
        cvv: '408',
      },
    };

    expect(
      service.preparePaymentGatewayRequest(PaymentMethod.PAYSTACK, paymentData),
    ).toMatchObject({
      channel: 'CARD',
      newCardDraft: {
        cardHolderName: 'Test User',
        cardNumber: '4084 0840 8408 4081',
        expiry: '12/99',
        cvv: '408',
      },
    });

    expect(
      service.preparePaymentRequest(PaymentMethod.PAYSTACK, paymentData),
    ).toEqual(
      expect.objectContaining({
        email: 'buyer@example.com',
        phone: '08030000000',
        channel: 'CARD',
        saveNewCard: true,
        newCardDraft: {
          cardHolderName: 'Test User',
          expiry: '12/99',
          last4: '4081',
          maskedCardNumber: '************4081',
        },
      }),
    );
  });

  it('reconciles paid unified checkout attempts that still need finalization', async () => {
    const prisma = {
      paymentAttempt: {
        findMany: jest.fn().mockResolvedValue([
          { reference: 'TH-UC-1', buyerId: 'buyer_1' },
          { reference: 'TH-UC-2', buyerId: null },
        ]),
      },
    } as any;

    const target = new PaymentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const finalizeSpy = jest
      .spyOn(target as any, 'finalizeUnifiedCheckoutAttempt')
      .mockResolvedValue({} as any);

    await expect(
      target.reconcilePaidUnifiedCheckoutFinalization(10),
    ).resolves.toEqual({
      scanned: 2,
      finalized: 2,
      failed: [],
    });

    expect(prisma.paymentAttempt.findMany).toHaveBeenCalledTimes(1);
    expect(finalizeSpy).toHaveBeenNthCalledWith(1, 'TH-UC-1', 'buyer_1');
    expect(finalizeSpy).toHaveBeenNthCalledWith(2, 'TH-UC-2', '');
  });

  it('accepts hosted card checkout when neither a saved card nor a local new-card draft is provided', () => {
    expect(
      service.preparePaymentRequest(PaymentMethod.PAYSTACK, {
        email: 'buyer@example.com',
        phone: '08030000000',
        consentAccepted: true,
        billingSameAsShipping: true,
        channel: 'CARD',
        useSavedCard: false,
        savedCardId: null,
        savedCardDisplay: null,
        newCardDraft: null,
      }),
    ).toEqual(
      expect.objectContaining({
        channel: 'CARD',
        useSavedCard: false,
        saveNewCard: true,
        newCardDraft: null,
      }),
    );
  });

  it('fails closed for Flutterwave initialization in live mode', async () => {
    await expect(
      (service as any).initFlutterwave(
        'TH-FLW-1',
        {
          channel: 'CARD',
          email: 'buyer@example.com',
        },
        15000,
        'NGN',
        'https://localhost:3000/bag/payment-return',
      ),
    ).rejects.toThrow('Flutterwave live checkout is not enabled');
  });

  it('fails production startup when checkout callback URL is not HTTPS', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/0';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_required';
    process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL =
      'http://checkout.threadly.com/bag/payment-return';

    expect(() => service.onModuleInit()).toThrow(
      'Checkout callback URL must use HTTPS in production',
    );
  });

  it('fails production startup when checkout callback URL points to loopback host', () => {
    process.env.NODE_ENV = 'production';
    process.env.REDIS_URL = 'redis://127.0.0.1:6379/0';
    process.env.PAYSTACK_SECRET_KEY = 'sk_live_required';
    process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL =
      'https://localhost:3000/bag/payment-return';

    expect(() => service.onModuleInit()).toThrow(
      'Checkout callback URL cannot point to loopback/private network hosts in production.',
    );
  });

  it('rejects raw Paystack card payloads when custom in-screen entry is disabled', () => {
    process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED = 'false';

    expect(() =>
      service.preparePaymentGatewayRequest(PaymentMethod.PAYSTACK, {
        email: 'buyer@example.com',
        phone: '08030000000',
        consentAccepted: true,
        billingSameAsShipping: true,
        channel: 'CARD',
        newCardDraft: {
          cardHolderName: 'Test User',
          cardNumber: '4084 0840 8408 4081',
          expiry: '12/99',
          cvv: '408',
        },
      }),
    ).toThrow(BadRequestException);
  });

  it('rejects soft-mode cardholder names when there is no billing-name overlap', () => {
    process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE = 'soft';

    expect(() =>
      service.preparePaymentGatewayRequest(PaymentMethod.PAYSTACK, {
        email: 'buyer@example.com',
        phone: '08030000000',
        consentAccepted: true,
        billingSameAsShipping: true,
        billingAddress: {
          firstName: 'Test',
          lastName: 'User',
          street: '10 Broad Street',
          city: 'Lagos',
          state: 'Lagos',
          country: 'Nigeria',
        },
        channel: 'CARD',
        newCardDraft: {
          cardHolderName: 'Another Person',
          cardNumber: '4084 0840 8408 4081',
          expiry: '12/99',
          cvv: '408',
        },
      }),
    ).toThrow(
      'Card holder name must closely match the billing name for this order',
    );
  });

  it('fails closed before provider initialization when validation session is not VALIDATED', async () => {
    const getStoredSessionSpy = jest
      .spyOn(service as any, 'getStoredCardValidationSession')
      .mockResolvedValue({
        sessionId: 'session-used-1',
        status: 'EXPIRED',
        gateway: 'PAYSTACK',
        channel: 'CARD',
        useSavedCard: false,
        savedPaymentMethodId: null,
        savedCardId: null,
        email: 'buyer@example.com',
        validatedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        cardSummary: {
          source: 'new',
          brand: null,
          bank: null,
          last4: '4081',
          expMonth: '12',
          expYear: '99',
          holderName: 'Test User',
        },
        paymentMethod: PaymentMethod.PAYSTACK,
        paymentDataFingerprint: 'fingerprint',
        storage: 'canonical',
      });

    await expect(
      service.resolveCardValidationSessionForInitialize({
        paymentMethod: PaymentMethod.PAYSTACK,
        validationSessionId: 'session-used-1',
        userId: 'buyer_1',
        gatewayPaymentData: {
          channel: 'CARD',
          email: 'buyer@example.com',
          useSavedCard: false,
          newCardDraft: {
            cardHolderName: 'Test User',
            cardNumber: '4084 0840 8408 4081',
            expiry: '12/99',
            cvv: '408',
          },
        },
        sanitizedPaymentData: {
          channel: 'CARD',
          email: 'buyer@example.com',
          useSavedCard: false,
          newCardDraft: {
            cardHolderName: 'Test User',
            expiry: '12/99',
            last4: '4081',
            maskedCardNumber: '************4081',
          },
        },
      }),
    ).rejects.toThrow(
      'Card validation session is no longer usable. Validate your payment details again.',
    );

    expect(getStoredSessionSpy).toHaveBeenCalledWith(
      'session-used-1',
      'buyer_1',
    );
  });

  it('does not require a validation session before initializing hosted new-card checkout', async () => {
    await expect(
      service.resolveCardValidationSessionForInitialize({
        paymentMethod: PaymentMethod.PAYSTACK,
        validationSessionId: undefined,
        userId: 'buyer_1',
        gatewayPaymentData: {
          channel: 'CARD',
          email: 'buyer@example.com',
          useSavedCard: false,
          newCardDraft: null,
        },
        sanitizedPaymentData: {
          channel: 'CARD',
          email: 'buyer@example.com',
          useSavedCard: false,
          newCardDraft: null,
        },
      }),
    ).resolves.toBeNull();
  });

  it('initializes Paystack with an inline popup action and local HTTPS callback parity', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_inline';
    delete process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL;
    delete process.env.WEB_APP_URL;
    process.env.WEB_APP_USE_HTTPS = 'true';

    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Authorization URL created',
        data: {
          reference: 'TH-REF-1',
          access_code: 'ACCESS-CODE-1',
          authorization_url: 'https://checkout.paystack.com/example',
        },
      }),
    } as Response);

    const callbackBaseUrl = service['resolveCallbackBaseUrl']();
    const result = await service['initPaystack'](
      'TH-REF-1',
      {
        email: 'buyer@example.com',
        phone: '08030000000',
        channel: 'CARD',
      },
      5000,
      'NGN',
      callbackBaseUrl,
    );

    expect(callbackBaseUrl).toBe('https://localhost:3000/bag/payment-return');
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.paystack.co/transaction/initialize',
      expect.objectContaining({
        body: expect.stringContaining(
          '"callback_url":"https://localhost:3000/bag/payment-return"',
        ),
      }),
    );
    expect(result.providerAccessCode).toBe('ACCESS-CODE-1');
    expect(result.nextAction?.type).toBe('INLINE_POPUP');
  });

  it('rejects Paystack initialize responses that do not return an inline access code', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_inline';
    process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL =
      'https://checkout.threadly.test/bag/payment-return';

    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        message: 'Authorization URL created',
        data: {
          reference: 'TH-REF-2',
          authorization_url: 'https://checkout.paystack.com/example',
        },
      }),
    } as Response);

    await expect(
      service['initPaystack'](
        'TH-REF-2',
        {
          email: 'buyer@example.com',
          phone: '08030000000',
          channel: 'CARD',
        },
        7500,
        'NGN',
        service['resolveCallbackBaseUrl'](),
      ),
    ).rejects.toThrow(
      'Paystack did not return an inline access code. WIEZ only supports in-app secure checkout and will not route buyers out of the product.',
    );
  });

  it('replays the same unified checkout attempt for an existing idempotent checkout session', async () => {
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue(1),
    };
    const prisma = {
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'checkout-session-1',
          summaryJson: {
            items: [{ name: 'Threadly Tee', quantity: 1, price: 12000 }],
            subtotal: 12000,
            shippingCost: 2500,
            discount: 0,
            grandTotal: 14500,
            shippingName: 'Ada Okafor',
            shippingCity: 'Lagos',
            shippingState: 'Lagos',
          },
          blockedLinesJson: { items: [] },
          paymentAttempt: {
            id: 'attempt-1',
            reference: 'TH-UC-existing',
            correlationId: 'corr-existing',
            provider: 'PAYSTACK',
            status: 'REQUIRES_ACTION',
            currency: 'NGN',
            settlementCurrency: 'NGN',
            settlementAmount: 14500,
            exchangeRateSnapshotId: 'fx-1',
            channel: 'CARD',
            callbackUrl: 'https://threadly.test/bag/payment-return',
            providerAccessCode: 'access-1',
            authorizationUrl: 'https://checkout.paystack.com/example',
            bankAccount: null,
            nextAction: { type: 'INLINE_POPUP' },
            expiresAt: new Date(Date.now() + 10 * 60 * 1000),
            amount: 14500,
          },
        }),
      },
    } as any;

    const target = new PaymentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {
        getRedisClient: jest.fn().mockResolvedValue(redis),
      } as any,
    );

    await expect(
      target.initializeUnifiedCheckout(
        {
          customerName: 'Ada Okafor',
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Okafor',
            street: '1 Allen Avenue',
            city: 'Lagos',
            state: 'Lagos',
            country: 'Nigeria',
            phone: '08030000000',
          },
          contactInfo: { phone: '08030000000' },
          paymentMethod: PaymentMethod.PAYSTACK,
          email: 'ada@example.com',
          idempotencyKey: 'idem-checkout-1',
          paymentData: {
            phone: '08030000000',
            consentAccepted: true,
            billingSameAsShipping: true,
            channel: 'CARD',
            useSavedCard: false,
            newCardDraft: null,
            savedCardId: null,
            savedCardDisplay: null,
          },
        },
        'buyer_1',
        'corr-existing',
      ),
    ).resolves.toMatchObject({
      paymentAttemptId: 'attempt-1',
      reference: 'TH-UC-existing',
      checkoutSessionId: 'checkout-session-1',
      status: 'REQUIRES_ACTION',
    });

    expect(prisma.checkoutSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          buyerId: 'buyer_1',
          idempotencyKey: 'idem-checkout-1',
        },
      }),
    );
  });

  it('persists a local unified attempt before provider initialization and releases it on provider failure', async () => {
    const checkoutSession = {
      id: 'checkout-session-pending-1',
      summaryJson: {
        items: [{ name: 'Threadly Tee', quantity: 1, price: 12000 }],
        subtotal: 12000,
        shippingCost: 2500,
        discount: 0,
        grandTotal: 14500,
        shippingName: 'Ada Okafor',
        shippingCity: 'Lagos',
        shippingState: 'Lagos',
      },
      blockedLinesJson: { items: [] },
    };
    const createdAttempt = {
      id: 'attempt-pending-1',
      reference: 'TH-UC-pending-1',
      buyerId: 'buyer_1',
      provider: 'PAYSTACK',
      providerMode: 'live',
      status: 'PROCESSING',
      currency: 'NGN',
      settlementCurrency: 'NGN',
      settlementAmount: 14500,
      amount: 14500,
      exchangeRateSnapshotId: 'fx-1',
      checkoutSessionId: checkoutSession.id,
      callbackUrl: 'https://threadly.test/bag/payment-return',
      bankAccount: null,
      nextAction: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
    const tx = {
      checkoutSession: {
        create: jest.fn().mockResolvedValue(checkoutSession),
      },
      checkoutSessionLine: {
        create: jest.fn().mockResolvedValue({ id: 'checkout-line-1' }),
      },
      paymentAttempt: {
        create: jest.fn().mockResolvedValue(createdAttempt),
      },
      paymentAttemptCheckoutIntentLink: {
        createMany: jest.fn(),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const prisma = {
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn((callback) => callback(tx)),
    } as any;
    const fxRateService = {
      quoteAndPersist: jest.fn().mockResolvedValue({
        snapshot: { id: 'fx-1' },
        convertedAmount: 14500,
      }),
      getBaseCurrency: jest.fn().mockReturnValue('NGN'),
    };
    const target = new PaymentService(
      prisma,
      fxRateService as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(target as any, 'withUnifiedCheckoutInitializationLock')
      .mockImplementation((_userId, _correlationId, callback: any) =>
        callback(),
      );
    jest
      .spyOn(target as any, 'loadUnifiedStandardLineDrafts')
      .mockResolvedValue([
        {
          cartItemId: 'cart-line-1',
          brandId: 'brand-1',
          productId: 'product-1',
          productName: 'Threadly Tee',
          thumbnail: null,
          quantity: 1,
          selectedSize: null,
          selectedColor: null,
          currency: 'NGN',
          unitPrice: 12000,
          lineTotal: 12000,
          sizingMode: 'STANDARD',
          requiredMeasurementKeys: [],
          sizeFitData: null,
          sizeRecommendationSnapshot: null,
          variantId: null,
          reserveInventory: false,
          sourceProduct: {
            id: 'product-1',
            trackInventory: false,
            allowBackorders: true,
            totalStock: 0,
            sizeStock: null,
            sizes: [],
          },
        },
      ]);
    jest
      .spyOn(target as any, 'loadUnifiedCustomLineDrafts')
      .mockResolvedValue({ lines: [], blocked: [] });
    jest
      .spyOn(target as any, 'resolveCardValidationSessionForInitialize')
      .mockResolvedValue(null);
    jest
      .spyOn(target as any, 'consumeCardValidationSessionForInitialize')
      .mockResolvedValue(undefined);
    jest
      .spyOn(target as any, 'reserveUnifiedStandardLineInventory')
      .mockResolvedValue(undefined);
    jest
      .spyOn(target as any, 'resolveShippingCostForState')
      .mockReturnValue(2500);
    jest
      .spyOn(target as any, 'resolveCallbackBaseUrl')
      .mockReturnValue('https://threadly.test/bag/payment-return');
    jest.spyOn(target as any, 'preparePaymentGatewayRequest').mockReturnValue({
      email: 'ada@example.com',
      phone: '08030000000',
      channel: 'CARD',
    });
    jest.spyOn(target as any, 'preparePaymentRequest').mockReturnValue({
      email: 'ada@example.com',
      phone: '08030000000',
      channel: 'CARD',
    });
    const initializeGatewaySpy = jest
      .spyOn(target as any, 'initializeGateway')
      .mockRejectedValue(new Error('provider timeout'));
    const applyAttemptStatusSpy = jest
      .spyOn(target as any, 'applyAttemptStatus')
      .mockResolvedValue({ ...createdAttempt, status: 'FAILED' });

    await expect(
      target.initializeUnifiedCheckout(
        {
          customerName: 'Ada Okafor',
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Okafor',
            street: '1 Allen Avenue',
            city: 'Lagos',
            state: 'Lagos',
            country: 'Nigeria',
            phone: '08030000000',
          },
          contactInfo: { phone: '08030000000' },
          paymentMethod: PaymentMethod.PAYSTACK,
          email: 'ada@example.com',
          idempotencyKey: 'idem-provider-fail',
          paymentData: {
            phone: '08030000000',
            channel: 'CARD',
          },
        },
        'buyer_1',
        'corr-provider-fail',
      ),
    ).rejects.toThrow('Unable to initialize payment. Please retry checkout.');

    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          reference: expect.stringMatching(/^TH-UC-/),
          status: 'PROCESSING',
          provider: 'PAYSTACK',
        }),
      }),
    );
    expect(tx.paymentAttempt.create.mock.invocationCallOrder[0]).toBeLessThan(
      initializeGatewaySpy.mock.invocationCallOrder[0],
    );
    const attemptedReference = initializeGatewaySpy.mock.calls[0][1];
    expect(applyAttemptStatusSpy).toHaveBeenCalledWith(
      attemptedReference,
      'buyer_1',
      'FAILED',
      'initialize',
      expect.objectContaining({
        correlationId: 'corr-provider-fail',
        responseSnapshotPatch: expect.objectContaining({
          gatewayInitializationStatus: 'FAILED',
        }),
      }),
    );
  });

  it('rejects unified checkout when a required measurement snapshot is missing', async () => {
    const prisma = {
      checkoutSession: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      $transaction: jest.fn(),
    } as any;
    const target = new PaymentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest
      .spyOn(target as any, 'withUnifiedCheckoutInitializationLock')
      .mockImplementation((_userId, _correlationId, callback: any) =>
        callback(),
      );
    jest
      .spyOn(target as any, 'loadUnifiedStandardLineDrafts')
      .mockResolvedValue([
        {
          cartItemId: 'cart-line-1',
          brandId: 'brand-1',
          productId: 'product-1',
          productName: 'Tailored Agbada',
          thumbnail: null,
          quantity: 1,
          selectedSize: null,
          selectedColor: null,
          currency: 'NGN',
          unitPrice: 32000,
          lineTotal: 32000,
          sizingMode: 'RTW_PLUS_FITTINGS',
          requiredMeasurementKeys: ['chest', 'sleeve'],
          sizeFitData: {
            measurements: {
              chest: { value: 104, unit: 'CM', source: 'saved_profile' },
            },
            measurementSnapshot: {
              requiredMeasurementKeys: ['chest', 'sleeve'],
              capturedAt: new Date().toISOString(),
            },
          },
          sizeRecommendationSnapshot: null,
          variantId: null,
          reserveInventory: false,
          sourceProduct: {
            id: 'product-1',
            trackInventory: false,
            allowBackorders: true,
            totalStock: 0,
            sizeStock: null,
            sizes: [],
          },
        },
      ]);
    jest
      .spyOn(target as any, 'loadUnifiedCustomLineDrafts')
      .mockResolvedValue({ lines: [], blocked: [] });

    await expect(
      target.initializeUnifiedCheckout(
        {
          customerName: 'Ada Okafor',
          shippingAddress: {
            firstName: 'Ada',
            lastName: 'Okafor',
            street: '1 Allen Avenue',
            city: 'Lagos',
            state: 'Lagos',
            country: 'Nigeria',
            phone: '08030000000',
          },
          contactInfo: { phone: '08030000000' },
          paymentMethod: PaymentMethod.PAYSTACK,
          email: 'ada@example.com',
          idempotencyKey: 'idem-missing-measurement',
          paymentData: {
            phone: '08030000000',
            consentAccepted: true,
            billingSameAsShipping: true,
            channel: 'CARD',
          },
        },
        'buyer_1',
        'corr-missing-measurement',
      ),
    ).rejects.toThrow(
      'Required measurement snapshot is missing for Tailored Agbada: sleeve',
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects concurrent unified checkout initialization while the buyer lock is held', async () => {
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        getRedisClient: jest.fn().mockResolvedValue({
          set: jest.fn().mockResolvedValue(null),
          eval: jest.fn(),
        }),
      } as any,
    );

    await expect(
      (target as any).withUnifiedCheckoutInitializationLock(
        'buyer_1',
        'corr-lock',
        async () => 'ok',
      ),
    ).rejects.toThrow(
      'A checkout initialization is already in progress for this account. Please retry in a few seconds.',
    );
  });

  it('finalizes a webhook-first paid unified checkout when frontend verification arrives later', async () => {
    const prisma = {
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt-paid-webhook-1',
          buyerId: 'buyer_1',
          subjectType: 'UNIFIED_CHECKOUT',
          status: 'PAID',
          reference: 'TH-UC-paid-webhook-1',
          currency: 'NGN',
          settlementCurrency: 'NGN',
          settlementAmount: 14500,
          amount: 14500,
          exchangeRateSnapshotId: 'fx-1',
          confirmedAt: new Date('2026-04-17T09:00:00.000Z'),
          channel: 'CARD',
          failureMessage: null,
          checkoutSessionId: 'checkout-session-paid-webhook-1',
          providerMode: 'live',
        }),
      },
    } as any;

    const target = new PaymentService(
      prisma,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const finalizeSpy = jest
      .spyOn(target as any, 'finalizeUnifiedCheckoutAttempt')
      .mockResolvedValue({
        checkoutSessionId: 'checkout-session-paid-webhook-1',
        orderIds: ['order-1'],
        customOrderIds: ['custom-order-1'],
        summary: {
          currency: 'NGN',
          items: [{ name: 'Threadly Tee', quantity: 1, price: 12000 }],
          subtotal: 12000,
          shippingCost: 2500,
          discount: 0,
          grandTotal: 14500,
          shippingName: 'Ada Okafor',
          shippingCity: 'Lagos',
          shippingState: 'Lagos',
        },
      });

    await expect(
      target.verifyPayment(
        { reference: 'TH-UC-paid-webhook-1', gateway: 'PAYSTACK' },
        'buyer_1',
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        status: 'PAID',
        reference: 'TH-UC-paid-webhook-1',
        orderIds: ['order-1'],
        customOrderIds: ['custom-order-1'],
        checkoutSessionId: 'checkout-session-paid-webhook-1',
      }),
    );

    expect(finalizeSpy).toHaveBeenCalledWith('TH-UC-paid-webhook-1', 'buyer_1');
  });

  it('falls back to inline webhook processing when queue enqueue fails', async () => {
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {
        enqueuePaymentWebhook: jest
          .fn()
          .mockRejectedValue(new Error('queue unavailable')),
      } as any,
    );

    jest.spyOn(target as any, 'recordWebhookReceipt').mockResolvedValue({
      gateway: 'PAYSTACK',
      reference: 'TH-UC-queue-fallback',
      providerEventKey: 'paystack:charge.success:TH-UC-queue-fallback',
      attemptId: 'attempt-queue-fallback',
      correlationId: 'corr-queue-fallback',
      processedAt: null,
    });
    const processSpy = jest
      .spyOn(target as any, 'processWebhookPayload')
      .mockResolvedValue(undefined);

    await expect(
      target.enqueueWebhook(
        'PAYSTACK',
        {
          event: 'charge.success',
          data: { reference: 'TH-UC-queue-fallback' },
        },
        {
          headers: {},
          rawBody: '{}',
          correlationId: 'corr-queue-fallback',
        },
      ),
    ).resolves.toBeUndefined();

    expect(processSpy).toHaveBeenCalledWith(
      'PAYSTACK',
      { event: 'charge.success', data: { reference: 'TH-UC-queue-fallback' } },
      'TH-UC-queue-fallback',
      'paystack:charge.success:TH-UC-queue-fallback',
      expect.objectContaining({
        source: 'INLINE_FALLBACK',
        correlationId: 'corr-queue-fallback',
      }),
    );
  });

  it('dedupes duplicate webhook receipts by durable provider event key', async () => {
    const processedAt = new Date('2026-04-17T08:00:00.000Z');
    const target = new PaymentService(
      {
        paymentAttempt: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'attempt-dup-1',
            provider: 'PAYSTACK',
            correlationId: 'corr-dup-1',
          }),
          updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        },
        paymentEvent: {
          create: jest
            .fn()
            .mockRejectedValue(
              new Error(
                'Unique constraint failed on the fields: (`providerEventKey`)',
              ),
            ),
          findFirst: jest.fn().mockResolvedValue({
            processedAt,
            correlationId: 'corr-dup-existing',
          }),
        },
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    jest.spyOn(target as any, 'verifyWebhookSignature').mockReturnValue(true);

    await expect(
      (target as any).recordWebhookReceipt(
        'PAYSTACK',
        {
          event: 'charge.success',
          data: {
            reference: 'TH-UC-dup-1',
            status: 'success',
            id: 'provider-tx-1',
            paid_at: '2026-04-17T07:59:00.000Z',
          },
        },
        {
          headers: {},
          rawBody: '{}',
          correlationId: 'corr-dup-incoming',
        },
      ),
    ).resolves.toEqual({
      gateway: 'PAYSTACK',
      reference: 'TH-UC-dup-1',
      providerEventKey:
        'PAYSTACK:charge.success:TH-UC-dup-1:provider-tx-1:2026-04-17T07:59:00.000Z',
      attemptId: 'attempt-dup-1',
      correlationId: 'corr-dup-existing',
      processedAt,
    });
  });

  it('fails closed for missing, null, zero, wrong amount, or wrong currency webhook settlements', () => {
    expect((service as any).webhookAmountsMatch(145, 'NGN', 145, 'NGN')).toBe(
      true,
    );
    expect((service as any).webhookAmountsMatch(145, 'NGN', null, 'NGN')).toBe(
      false,
    );
    expect((service as any).webhookAmountsMatch(145, 'NGN', 0, 'NGN')).toBe(
      false,
    );
    expect((service as any).webhookAmountsMatch(145, 'NGN', 140, 'NGN')).toBe(
      false,
    );
    expect((service as any).webhookAmountsMatch(145, 'NGN', 145, null)).toBe(
      false,
    );
    expect((service as any).webhookAmountsMatch(145, 'NGN', 145, 'USD')).toBe(
      false,
    );
  });

  it('audits and marks paid webhook amount mismatches without applying paid status', async () => {
    const prisma = {
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt-mismatch-1',
          provider: 'PAYSTACK',
          buyerId: 'buyer_1',
          reference: 'TH-UC-mismatch-1',
          status: 'PROCESSING',
          amount: 145,
          currency: 'NGN',
          correlationId: 'corr-mismatch',
          subjectType: 'UNIFIED_CHECKOUT',
          responseSnapshot: {},
        }),
      },
      webhookIngressAudit: {
        create: jest.fn().mockResolvedValue({}),
      },
      paymentEvent: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const target = new PaymentService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    const applyAttemptStatusSpy = jest.spyOn(
      target as any,
      'applyAttemptStatus',
    );
    const alertSpy = jest
      .spyOn(target as any, 'emitReliabilityAlert')
      .mockImplementation(() => undefined);

    await (target as any).processWebhookPayload(
      'PAYSTACK',
      {
        event: 'charge.success',
        data: {
          reference: 'TH-UC-mismatch-1',
          status: 'success',
          amount: 14000,
          currency: 'NGN',
          id: 'provider-tx-mismatch',
          paid_at: '2026-04-17T08:00:00.000Z',
        },
      },
      'TH-UC-mismatch-1',
      'PAYSTACK:charge.success:TH-UC-mismatch-1:provider-tx-mismatch:2026-04-17T08:00:00.000Z',
      { source: 'INLINE_DIRECT', correlationId: 'corr-mismatch' },
    );

    expect(prisma.webhookIngressAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          rejectionReason: 'AMOUNT_CURRENCY_MISMATCH',
          reference: 'TH-UC-mismatch-1',
          paymentAttemptId: 'attempt-mismatch-1',
        }),
      }),
    );
    expect(alertSpy).toHaveBeenCalledWith(
      'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
      expect.objectContaining({
        reference: 'TH-UC-mismatch-1',
        expectedAmount: 145,
        receivedAmount: 140,
      }),
    );
    expect(applyAttemptStatusSpy).not.toHaveBeenCalled();
    expect(prisma.paymentEvent.updateMany).toHaveBeenCalled();
  });

  it('redacts sensitive webhook headers and provider payload snapshots', () => {
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    expect(
      (target as any).buildWebhookHeadersSnapshot({
        'x-paystack-signature': 'provider-signature',
        authorization: 'Bearer provider-token',
        cookie: 'session=private',
        'x-correlation-id': 'corr-safe',
      }),
    ).toEqual({
      'x-paystack-signature': '[REDACTED]',
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      'x-correlation-id': 'corr-safe',
    });

    expect(
      (target as any).sanitizeWebhookPayloadSnapshot({
        event: 'charge.success',
        data: {
          reference: 'TH-UC-safe-1',
          amount: 14500,
          currency: 'NGN',
          authorization: {
            authorization_code: 'AUTH_sensitive',
            signature: 'SIG_sensitive',
            last4: '4242',
          },
          customer: { email: 'buyer@example.com', phone: '08030000000' },
        },
      }),
    ).toEqual({
      event: 'charge.success',
      data: {
        reference: 'TH-UC-safe-1',
        amount: 14500,
        currency: 'NGN',
        authorization: '[REDACTED]',
        customer: '[REDACTED]',
      },
    });
  });

  it('rejects invalid webhook signatures before processing', async () => {
    const prisma = {
      webhookIngressAudit: { create: jest.fn().mockResolvedValue({}) },
    };
    const target = new PaymentService(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (target as any).recordWebhookReceipt(
        'PAYSTACK',
        {
          event: 'charge.success',
          data: {
            reference: 'TH-UC-invalid-sig',
            amount: 14500,
            currency: 'NGN',
          },
        },
        {
          headers: { 'x-paystack-signature': 'bad' },
          rawBody: '{}',
          remoteAddress: '203.0.113.99',
          correlationId: 'corr-invalid-sig',
        },
      ),
    ).resolves.toBeNull();

    expect(prisma.webhookIngressAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rejectionReason: 'INVALID_SIGNATURE' }),
      }),
    );
  });

  it('does not treat frontend success hints as live Paystack confirmation', async () => {
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );
    jest.spyOn(target as any, 'verifyPaystackAttempt').mockResolvedValue({
      status: 'PENDING',
      rawStatus: 'pending',
      message: 'awaiting provider',
      paidAt: null,
      channel: null,
      reference: 'TH-UC-front-only',
      transactionId: null,
      amount: null,
      currency: null,
      authorization: null,
    });

    await expect(
      target.resolveAttemptVerification(
        {
          provider: 'PAYSTACK',
          providerMode: 'live',
          responseSnapshot: {},
        } as any,
        {
          reference: 'TH-UC-front-only',
          gateway: 'PAYSTACK',
          statusHint: 'success',
        },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        nextStatus: 'PENDING',
        awaitingProviderConfirmation: true,
      }),
    );
  });

  it('rejects Paystack provider verification when the reference does not match the payment attempt', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_phase0';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: true,
        data: {
          reference: 'TH-UC-other',
          amount: 14500,
          currency: 'NGN',
          status: 'success',
        },
      }),
    } as any);

    await expect(
      (service as any).verifyPaystackAttempt({
        reference: 'TH-UC-expected',
        amount: 145,
        currency: 'NGN',
      }),
    ).rejects.toThrow(
      'Provider verification reference does not match the payment attempt',
    );
  });

  it('rejects Paystack provider verification when the amount is missing', async () => {
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_phase0';
    jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: jest.fn().mockResolvedValue({
        status: true,
        data: {
          reference: 'TH-UC-expected',
          currency: 'NGN',
          status: 'success',
        },
      }),
    } as any);

    await expect(
      (service as any).verifyPaystackAttempt({
        reference: 'TH-UC-expected',
        amount: 145,
        currency: 'NGN',
      }),
    ).rejects.toThrow(
      'Provider verification payload is missing the amount field',
    );
  });

  it('releases unified checkout reservations and abandons custom bag lines after a failed attempt', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt-release-1',
          reference: 'TH-UC-release-1',
          buyerId: 'buyer_1',
          subjectType: 'UNIFIED_CHECKOUT',
          checkoutSessionId: 'checkout-session-release-1',
          status: 'FAILED',
        }),
      },
      checkoutSession: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'checkout-session-release-1',
          status: 'PAYMENT_PROCESSING',
          lines: [
            {
              id: 'line-standard-1',
              lineType: 'STANDARD_ITEM',
              status: 'RESERVED',
              checkoutIntentId: null,
            },
            {
              id: 'line-custom-1',
              lineType: 'CUSTOM_ORDER',
              status: 'PENDING',
              checkoutIntentId: 'intent-release-1',
            },
          ],
          inventoryReservations: [
            {
              id: 'reservation-1',
              productId: 'product-1',
              productVariantId: 'variant-1',
              quantity: 2,
              reservedSize: 'M',
            },
          ],
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      product: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'product-1',
          sizeStock: { M: 3 },
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      productVariant: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservation: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      checkoutSessionLine: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      paymentAttemptCheckoutIntentLink: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };

    const target = new PaymentService(
      {
        $transaction: jest
          .fn()
          .mockImplementation(
            async (callback: (client: typeof tx) => Promise<void>) =>
              callback(tx),
          ),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (target as any).releaseUnifiedCheckoutAttempt(
        'TH-UC-release-1',
        'buyer_1',
        {
          reason: 'ATTEMPT_FAILED',
        },
      ),
    ).resolves.toBeUndefined();

    expect(tx.inventoryReservation.update).toHaveBeenCalledWith({
      where: { id: 'reservation-1' },
      data: expect.objectContaining({
        status: 'RELEASED',
        releaseReason: 'ATTEMPT_FAILED',
      }),
    });
    expect(tx.customOrderCheckoutSession.updateMany).toHaveBeenCalledWith({
      where: {
        checkoutIntentId: {
          in: ['intent-release-1'],
        },
        customOrderId: null,
      },
      data: expect.objectContaining({
        status: 'ABANDONED',
        lastAttemptReference: 'TH-UC-release-1',
        lastAttemptStatus: 'FAILED',
      }),
    });
    expect(tx.checkoutSession.update).toHaveBeenCalledWith({
      where: { id: 'checkout-session-release-1' },
      data: expect.objectContaining({
        status: 'FAILED',
        failureReason: 'ATTEMPT_FAILED',
      }),
    });
  });

  it('locks mapped product inventory columns when reserving unified checkout stock', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      product: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'product-1',
          name: 'Threadly Tee',
          totalStock: 5,
          sizeStock: null,
          trackInventory: true,
          allowBackorders: false,
        }),
        update: jest.fn().mockResolvedValue(undefined),
      },
      productVariant: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      inventoryReservation: {
        create: jest.fn().mockResolvedValue({ id: 'reservation-1' }),
      },
    };
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(
      (target as any).reserveUnifiedStandardLineInventory(
        tx,
        'checkout-session-1',
        'checkout-line-1',
        {
          cartItemId: 'cart-line-1',
          brandId: 'brand-1',
          productId: 'product-1',
          productName: 'Threadly Tee',
          thumbnail: null,
          quantity: 1,
          selectedSize: 'M',
          selectedColor: 'Black',
          currency: 'NGN',
          unitPrice: 12000,
          lineTotal: 12000,
          sizingMode: 'STANDARD',
          requiredMeasurementKeys: [],
          sizeFitData: null,
          sizeRecommendationSnapshot: null,
          variantId: 'variant-1',
          reserveInventory: true,
          sourceProduct: {
            id: 'product-1',
            trackInventory: true,
            allowBackorders: false,
            totalStock: 5,
            sizeStock: null,
            sizes: ['M'],
            colors: ['Black'],
          },
        },
        new Date(Date.now() + 30 * 60 * 1000),
      ),
    ).resolves.toBeUndefined();

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(String(tx.$queryRaw.mock.calls[0][0][0])).toContain(
      'SELECT "_id" FROM "Product" WHERE "_id"',
    );
    expect(String(tx.$queryRaw.mock.calls[1][0][0])).toContain(
      'SELECT "_id" FROM "ProductVariant" WHERE "_id"',
    );
    expect(tx.inventoryReservation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        checkoutSessionId: 'checkout-session-1',
        checkoutSessionLineId: 'checkout-line-1',
        productId: 'product-1',
        productVariantId: 'variant-1',
        quantity: 1,
        status: 'RESERVED',
      }),
    });
  });

  it('purges old payment telemetry only for closed attempts', async () => {
    const tx = {
      paymentAttempt: {
        findMany: jest.fn().mockResolvedValue([{ id: 'attempt-retain-1' }]),
      },
      paymentEvent: {
        deleteMany: jest.fn().mockResolvedValue({ count: 9 }),
      },
      paymentAttemptRetryHistory: {
        deleteMany: jest.fn().mockResolvedValue({ count: 4 }),
      },
      webhookIngressAudit: {
        deleteMany: jest.fn().mockResolvedValue({ count: 3 }),
      },
    };
    const target = new PaymentService(
      {
        $transaction: jest
          .fn()
          .mockImplementation(
            async (
              callback: (
                client: typeof tx,
              ) => Promise<readonly [number, number, number]>,
            ) => callback(tx),
          ),
      } as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
    );

    await expect(target.purgeOldPaymentTelemetry()).resolves.toEqual({
      paymentEventsDeleted: 9,
      retryHistoryDeleted: 4,
      webhookIngressAuditsDeleted: 3,
      retainedDays: {
        paymentEvents: 180,
        retryHistory: 180,
        webhookIngressAudit: 120,
      },
    });

    expect(tx.paymentEvent.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          processedAt: { not: null },
          paymentAttemptId: { in: ['attempt-retain-1'] },
        }),
      }),
    );
    expect(tx.paymentAttemptRetryHistory.deleteMany).toHaveBeenCalled();
    expect(tx.webhookIngressAudit.deleteMany).toHaveBeenCalled();
  });

  it('emits redacted monitoring alerts for critical payment mismatches', () => {
    const monitoring = { emitAlert: jest.fn() };
    const target = new PaymentService(
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      monitoring as any,
    );

    (target as any).emitReliabilityAlert(
      'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
      {
        paymentAttemptId: 'attempt_1',
        correlationId: 'corr_1',
        expectedAmount: 1000,
        expectedCurrency: 'NGN',
        receivedAmount: 1,
        receivedCurrency: 'USD',
        paystackSecret: 'sk_live_sensitive',
        webhookSignature: 'raw-signature',
      },
    );

    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'WEBHOOK',
        severity: 'critical',
        event: 'PAYMENT_WEBHOOK_AMOUNT_CURRENCY_MISMATCH',
        entityId: 'attempt_1',
        correlationId: 'corr_1',
        metadata: expect.objectContaining({
          paystackSecret: '[REDACTED]',
          webhookSignature: '[REDACTED]',
        }),
      }),
    );
  });
});
