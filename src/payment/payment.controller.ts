import {
  Controller,
  Post,
  Body,
  Get,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { PaymentService } from './payment.service';
import { FxRateService } from './fx-rate.service';
import {
  InitializePaymentDto,
  SimulatePaymentAttemptDto,
  VerifyPaymentDto,
} from './payment.types';
import { Request } from 'express';

@Controller('payment')
export class PaymentController {
  constructor(
    private readonly paymentService: PaymentService,
    private readonly fxRateService: FxRateService,
  ) {}

  @Get('fx/quote')
  async getFxQuote(
    @Query('from') from: string,
    @Query('to') to?: string,
    @Query('amount') amount = '1',
  ) {
    const result = await this.fxRateService.getQuotePreview({
      from,
      to,
      amount: Number(amount),
    });
    return { status: 'success', data: result };
  }

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

  @Get('attempts/:reference')
  @UseGuards(JwtAuthGuard)
  async getAttempt(@Param('reference') reference: string, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.getPaymentAttemptByReference(reference, userId);
    return { status: 'success', data: result };
  }

  @Get('attempts/by-order/:orderId')
  @UseGuards(JwtAuthGuard)
  async getAttemptByOrderId(@Param('orderId') orderId: string, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.getPaymentAttemptByOrderId(orderId, userId);
    return { status: 'success', data: result };
  }

  @Post('verify')
  @UseGuards(JwtAuthGuard)
  async verify(@Body() dto: VerifyPaymentDto, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.verifyPayment(dto, userId);
    return { status: 'success', data: result };
  }

  @Post('mock/:reference/simulate')
  @UseGuards(JwtAuthGuard)
  async simulate(
    @Param('reference') reference: string,
    @Body() dto: SimulatePaymentAttemptDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    const result = await this.paymentService.simulatePaymentAttempt(reference, dto, userId);
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
  async paystackWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    await this.paymentService.handleWebhook('PAYSTACK', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
    });
    return { status: 'ok' };
  }

  @Post('webhook/flutterwave')
  @HttpCode(200)
  async flutterwaveWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    await this.paymentService.handleWebhook('FLUTTERWAVE', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
    });
    return { status: 'ok' };
  }
}
