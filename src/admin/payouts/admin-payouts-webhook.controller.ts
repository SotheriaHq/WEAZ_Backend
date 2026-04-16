import {
  Body,
  Controller,
  GoneException,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { Request } from 'express';
import { AdminPayoutsService } from './admin-payouts.service';

@Controller('admin/payouts/webhook')
export class AdminPayoutsWebhookController {
  private readonly logger = new Logger(AdminPayoutsWebhookController.name);

  constructor(private readonly payoutsService: AdminPayoutsService) {}

  private isLegacyPaystackWebhookAliasEnabled(): boolean {
    return (
      String(process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  @Post('paystack')
  @HttpCode(200)
  async paystackWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    if (!this.isLegacyPaystackWebhookAliasEnabled()) {
      this.logger.warn(
        'Blocked request to legacy /admin/payouts/webhook/paystack because legacy aliases are disabled.',
      );
      throw new GoneException(
        'Legacy payout Paystack webhook alias is disabled. Configure Paystack to POST /webhooks/paystack.',
      );
    }

    this.logger.warn(
      'Received Paystack transfer webhook on legacy /admin/payouts/webhook/paystack. Use /webhooks/paystack in the Paystack dashboard instead.',
    );
    await this.payoutsService.enqueuePaystackWebhook(payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    });

    return { status: 'ok' };
  }
}
