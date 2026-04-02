import { Logger } from '@nestjs/common';
import { PaymentController } from './payment.controller';

describe('PaymentController', () => {
  const paymentService = {
    enqueueWebhook: jest.fn(),
  } as any;

  const fxRateService = {} as any;

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns and forwards legacy Paystack webhooks', async () => {
    const controller = new PaymentController(paymentService, fxRateService);
    const req = {
      headers: { 'x-paystack-signature': 'signature' },
      rawBody: '{"event":"charge.success"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'charge.success' };

    await expect(controller.paystackWebhook(payload, req)).resolves.toEqual({ status: 'ok' });

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
});