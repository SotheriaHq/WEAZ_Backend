import { GoneException, Logger } from '@nestjs/common';
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

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    delete process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED;
    warnSpy.mockRestore();
  });

  it('answers 410 on the retired webhook URLs and processes nothing, even with the old flags set', () => {
    // The flags were retired; setting them must not bring forwarding back.
    process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED = 'true';
    process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED = 'true';
    const controller = new PaymentController(
      paymentService,
      fxRateService,
      paymentRuntimeHealthService,
    );

    expect(() => controller.paystackWebhook()).toThrow(GoneException);
    expect(() => controller.paystackWebhook()).toThrow('/webhooks/paystack');
    expect(() => controller.flutterwaveWebhook()).toThrow(GoneException);
    expect(() => controller.flutterwaveWebhook()).toThrow(
      '/webhooks/flutterwave',
    );
    expect(paymentService.enqueueWebhook).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/payment/webhook/paystack'),
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
