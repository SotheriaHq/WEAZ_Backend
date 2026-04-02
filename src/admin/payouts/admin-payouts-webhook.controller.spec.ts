import { Logger } from '@nestjs/common';
import { AdminPayoutsWebhookController } from './admin-payouts-webhook.controller';

describe('AdminPayoutsWebhookController', () => {
  const payoutsService = {
    enqueuePaystackWebhook: jest.fn(),
  } as any;

  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('warns and forwards legacy transfer webhooks', async () => {
    const controller = new AdminPayoutsWebhookController(payoutsService);
    const req = {
      headers: { 'x-paystack-signature': 'signature' },
      rawBody: '{"event":"transfer.success"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'transfer.success' };

    await expect(controller.paystackWebhook(payload, req)).resolves.toEqual({ status: 'ok' });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/admin/payouts/webhook/paystack'),
    );
    expect(payoutsService.enqueuePaystackWebhook).toHaveBeenCalledWith(
      payload,
      expect.objectContaining({
        headers: req.headers,
        rawBody: req.rawBody,
        remoteAddress: '127.0.0.1',
      }),
    );
  });
});