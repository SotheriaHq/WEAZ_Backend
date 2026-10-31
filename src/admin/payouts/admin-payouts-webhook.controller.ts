import { Controller, GoneException, Logger, Post } from '@nestjs/common';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';

/**
 * Retired payout webhook URL. Paystack transfer events arrive on
 * `/webhooks/paystack` and are fanned out from there; this old path only
 * answers 410 with that instruction and never processes a payload.
 */
@IsPublic()
@Controller('admin/payouts/webhook')
export class AdminPayoutsWebhookController {
  private readonly logger = new Logger(AdminPayoutsWebhookController.name);

  @Post('paystack')
  paystackWebhook(): never {
    this.logger.warn(
      'Webhook received on retired /admin/payouts/webhook/paystack; configure /webhooks/paystack.',
    );
    throw new GoneException(
      'This webhook URL is retired. Configure Paystack to POST /webhooks/paystack.',
    );
  }
}
