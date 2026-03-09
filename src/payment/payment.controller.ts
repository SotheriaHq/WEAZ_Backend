import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { PaymentService } from './payment.service';
import {
  InitializePaymentDto,
  VerifyPaymentDto,
} from './payment.types';
import { Request } from 'express';

@Controller('payment')
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post('initialize')
  @UseGuards(JwtAuthGuard)
  async initialize(
    @Body() dto: InitializePaymentDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.initializePayment(dto, userId);
    return { status: 'success', data: result };
  }

  @Post('verify')
  @UseGuards(JwtAuthGuard)
  async verify(@Body() dto: VerifyPaymentDto, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.verifyPayment(dto, userId);
    return { status: 'success', data: result };
  }

  /**
   * Webhook endpoints for Paystack and Flutterwave.
   * These receive POST requests from the payment gateways
   * when a payment is completed. No auth guard — gateways
   * authenticate via signature headers (validated in service).
   */
  @Post('webhook/paystack')
  @HttpCode(200)
  async paystackWebhook(@Body() payload: Record<string, any>) {
    await this.paymentService.handleWebhook('PAYSTACK', payload);
    return { status: 'ok' };
  }

  @Post('webhook/flutterwave')
  @HttpCode(200)
  async flutterwaveWebhook(@Body() payload: Record<string, any>) {
    await this.paymentService.handleWebhook('FLUTTERWAVE', payload);
    return { status: 'ok' };
  }
}
