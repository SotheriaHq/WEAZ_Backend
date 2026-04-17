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

    if (originalPaystackSecretKey === undefined) delete process.env.PAYSTACK_SECRET_KEY;
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

    if (originalWebAppUseHttps === undefined) delete process.env.WEB_APP_USE_HTTPS;
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

    expect(service.preparePaymentRequest(PaymentMethod.PAYSTACK, paymentData)).toEqual(
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
    ).toThrow('Card holder name must closely match the billing name for this order');
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

    expect(getStoredSessionSpy).toHaveBeenCalledWith('session-used-1', 'buyer_1');
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

    const fetchSpy = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue({
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
      'Paystack did not return an inline access code. Threadly only supports in-app secure checkout and will not route buyers out of the product.',
    );
  });
});
