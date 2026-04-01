import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Request } from 'express';
import { AdminPayoutsService } from './admin-payouts.service';

@Controller('admin/payouts/webhook')
export class AdminPayoutsWebhookController {
  constructor(private readonly payoutsService: AdminPayoutsService) {}

  @Post('paystack')
  @HttpCode(200)
  async paystackWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    await this.payoutsService.enqueuePaystackWebhook(payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    });

    return { status: 'ok' };
  }
}
