import { Logger } from '@nestjs/common';
import { PaymentController } from './payment.controller';

describe('PaymentController', () => {
  const paymentService = {
    enqueueWebhook: jest.fn(),
    initializeUnifiedCheckout: jest.fn(),
  } as any;

  const fxRateService = {
    getQuotePreview: jest.fn(),
  } as any;
  const paymentRuntimeHealthService = {
    getRuntimeHealth: jest.fn(),
  } as any;

  let warnSpy: jest.SpyInstance;
  let originalLegacyAlias: string | undefined;
  let originalLegacyFlutterwaveAlias: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalLegacyAlias =
      process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    originalLegacyFlutterwaveAlias =
      process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED;
    delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    delete process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED;
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    if (originalLegacyAlias === undefined) {
      delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    } else {
      process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED =
        originalLegacyAlias;
    }

    if (originalLegacyFlutterwaveAlias === undefined) {
      delete process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED;
    } else {
      process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED =
        originalLegacyFlutterwaveAlias;
    }

    warnSpy.mockRestore();
  });

  it('blocks legacy Paystack webhooks when alias support is disabled', async () => {
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const req = {
      headers: { 'x-paystack-signature': 'signature' },
      rawBody: '{"event":"charge.success"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'charge.success' };

    await expect(controller.paystackWebhook(payload, req)).rejects.toThrow(
      'Legacy Paystack webhook alias is disabled',
    );

    expect(paymentService.enqueueWebhook).not.toHaveBeenCalled();
  });

  it('warns and forwards legacy Paystack webhooks when alias support is enabled', async () => {
    process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED = 'true';

    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const req = {
      headers: { 'x-paystack-signature': 'signature' },
      rawBody: '{"event":"charge.success"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'charge.success' };

    await expect(controller.paystackWebhook(payload, req)).resolves.toEqual({
      status: 'ok',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/payment/webhook/paystack'),
    );
    expect(paymentService.enqueueWebhook).toHaveBeenCalledWith(
      'PAYSTACK',
      payload,
      expect.objectContaining({
        headers: req.headers,
        rawBody: req.rawBody,
        remoteAddress: '127.0.0.1',
      }),
    );
  });

  it('blocks legacy Flutterwave webhooks when alias support is disabled', async () => {
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const req = {
      headers: { 'verif-hash': 'signature' },
      rawBody: '{"event":"charge.completed"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'charge.completed' };

    await expect(controller.flutterwaveWebhook(payload, req)).rejects.toThrow(
      'Legacy Flutterwave webhook alias is disabled',
    );

    expect(paymentService.enqueueWebhook).not.toHaveBeenCalled();
  });

  it('warns and forwards legacy Flutterwave webhooks when alias support is enabled', async () => {
    process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED = 'true';

    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const req = {
      headers: { 'verif-hash': 'signature' },
      rawBody: '{"event":"charge.completed"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'charge.completed' };

    await expect(controller.flutterwaveWebhook(payload, req)).resolves.toEqual({
      status: 'ok',
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/payment/webhook/flutterwave'),
    );
    expect(paymentService.enqueueWebhook).toHaveBeenCalledWith(
      'FLUTTERWAVE',
      payload,
      expect.objectContaining({
        headers: req.headers,
        rawBody: req.rawBody,
        remoteAddress: '127.0.0.1',
      }),
    );
  });

  it('returns runtime health for admin operations view', async () => {
    paymentRuntimeHealthService.getRuntimeHealth.mockResolvedValue({
      ok: true,
    });
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );

    await expect(controller.runtimeHealth()).resolves.toEqual({ ok: true });
    expect(paymentRuntimeHealthService.getRuntimeHealth).toHaveBeenCalledTimes(
      1,
    );
  });

  it('passes sanitized FX quote query values to the FX service', async () => {
    fxRateService.getQuotePreview.mockResolvedValue({
      provider: 'INTERNAL_PARITY',
      from: 'NGN',
      to: 'NGN',
      amount: 5000,
      convertedAmount: 5000,
    });
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );

    await expect(
      controller.getFxQuote({ from: 'NGN', to: 'NGN', amount: '5000' }),
    ).resolves.toMatchObject({ provider: 'INTERNAL_PARITY' });

    expect(fxRateService.getQuotePreview).toHaveBeenCalledWith({
      from: 'NGN',
      to: 'NGN',
      amount: 5000,
    });
  });

  it('rejects unified initialize when the idempotency header is missing', async () => {
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const dto = { idempotencyKey: 'idem-1' } as any;
    const req = {
      headers: {},
      user: { id: 'buyer_1' },
    } as any;

    await expect(controller.initializeUnified(dto, req)).rejects.toThrow(
      'Idempotency-Key header and body idempotencyKey are required',
    );

    expect(paymentService.initializeUnifiedCheckout).not.toHaveBeenCalled();
  });

  it('rejects unified initialize when header/body idempotency keys do not match', async () => {
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const dto = { idempotencyKey: 'idem-body' } as any;
    const req = {
      headers: { 'idempotency-key': 'idem-header' },
      user: { id: 'buyer_1' },
    } as any;

    await expect(controller.initializeUnified(dto, req)).rejects.toThrow(
      'Idempotency-Key header must match body idempotencyKey',
    );

    expect(paymentService.initializeUnifiedCheckout).not.toHaveBeenCalled();
  });

  it('initializes unified checkout when idempotency header/body keys match', async () => {
    paymentService.initializeUnifiedCheckout.mockResolvedValue({
      reference: 'TH-UC-1',
    });

    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );
    const dto = { idempotencyKey: 'idem-ok' } as any;
    const req = {
      headers: { 'idempotency-key': 'idem-ok' },
      user: { id: 'buyer_1' },
    } as any;

    await expect(controller.initializeUnified(dto, req)).resolves.toEqual({
      reference: 'TH-UC-1',
    });

    expect(paymentService.initializeUnifiedCheckout).toHaveBeenCalledWith(
      dto,
      'buyer_1',
      null,
      {
        appVersion: '',
        ipAddress: null,
        locale: '',
        userAgent: '',
      },
    );
  });
});
