import { GoneException, Logger } from '@nestjs/common';
import { AdminPayoutsWebhookController } from './admin-payouts-webhook.controller';

describe('AdminPayoutsWebhookController', () => {
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined as any);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    delete process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED;
  });

  it('answers 410 with the canonical URL and processes nothing, even with the retired flag set', () => {
    // The old flag no longer exists; setting it must not bring forwarding back.
    process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED = 'true';
    const controller = new AdminPayoutsWebhookController();

    expect(() => controller.paystackWebhook()).toThrow(GoneException);
    expect(() => controller.paystackWebhook()).toThrow('/webhooks/paystack');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('/admin/payouts/webhook/paystack'),
    );
  });
});
