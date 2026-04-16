import { Logger } from '@nestjs/common';
import { AdminPayoutsWebhookController } from './admin-payouts-webhook.controller';

describe('AdminPayoutsWebhookController', () => {
  const payoutsService = {
    enqueuePaystackWebhook: jest.fn(),
  } as any;

  let warnSpy: jest.SpyInstance;
  let originalLegacyAlias: string | undefined;

  beforeEach(() => {
    jest.clearAllMocks();
    originalLegacyAlias = process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    if (originalLegacyAlias === undefined) {
      delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
    } else {
      process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED = originalLegacyAlias;
    }
    warnSpy.mockRestore();
  });

  it('blocks legacy transfer webhooks when alias support is disabled', async () => {
    const controller = new AdminPayoutsWebhookController(payoutsService);
    const req = {
      headers: { 'x-paystack-signature': 'signature' },
      rawBody: '{"event":"transfer.success"}',
      ip: '127.0.0.1',
      socket: { remoteAddress: '127.0.0.1' },
    } as any;
    const payload = { event: 'transfer.success' };

    await expect(controller.paystackWebhook(payload, req)).rejects.toThrow(
      'Legacy payout Paystack webhook alias is disabled',
    );

    expect(payoutsService.enqueuePaystackWebhook).not.toHaveBeenCalled();
  });

  it('warns and forwards legacy transfer webhooks when alias support is enabled', async () => {
    process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED = 'true';

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