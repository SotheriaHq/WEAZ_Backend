import { Body, Controller, HttpCode, Logger, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { PaymentService } from 'src/payment/payment.service';
import { AdminPayoutsService } from 'src/admin/payouts/admin-payouts.service';

@Controller('webhooks')
export class PaystackWebhookController {
  private readonly logger = new Logger(PaystackWebhookController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly adminPayoutsService: AdminPayoutsService,
  ) {}

  @Post('paystack')
  @HttpCode(200)
  async handlePaystackWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    const event = String(payload?.event ?? '').toLowerCase();
    const context = {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    };

    if (event.startsWith('transfer.')) {
      await this.adminPayoutsService.enqueuePaystackWebhook(payload, context);
      return { status: 'ok' };
    }

    await this.paymentService.enqueueWebhook('PAYSTACK', payload, context);
    if (!event) {
      this.logger.warn('Received Paystack webhook without an event field; defaulted to payment pipeline');
    }

    return { status: 'ok' };
  }

  @Post('flutterwave')
  @HttpCode(200)
  async handleFlutterwaveWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    await this.paymentService.enqueueWebhook('FLUTTERWAVE', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    });

    return { status: 'ok' };
  }
}
