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

  private readCorrelationHeader(req: Request): string | null {
    const candidates: Array<unknown> = [
      req.headers['x-correlation-id'],
      req.headers['x-request-id'],
      (req as any).requestId,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === 'string') {
        const value = candidate.trim();
        if (value) return value;
      }
      if (Array.isArray(candidate) && candidate.length > 0) {
        const value = String(candidate[0] ?? '').trim();
        if (value) return value;
      }
    }

    return null;
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
      correlationId: this.readCorrelationHeader(req),
    });

    return { status: 'ok' };
  }
}
