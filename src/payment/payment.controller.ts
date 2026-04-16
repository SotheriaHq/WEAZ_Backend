import {
  Controller,
  Post,
  Body,
  Delete,
  Get,
  Param,
  Query,
  UseGuards,
  Req,
  HttpCode,
  UseInterceptors,
  Logger,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';
import { IdempotencyInterceptor } from 'src/common/interceptors/idempotency.interceptor';
import { PaymentService } from './payment.service';
import { FxRateService } from './fx-rate.service';
import {
  PaymentClientCheckoutPolicy,
  InitializeUnifiedCheckoutDto,
  ReconcileStalePaymentsDto,
  ValidatePaymentCardDto,
  InitializePaymentDto,
  SavedPaymentCardSummary,
  SavedPaymentMethodMutationResult,
  SimulatePaymentAttemptDto,
  VerifyPaymentDto,
} from './payment.types';
import { Request } from 'express';

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

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
    return result;
  }

  @Post('initialize')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async initialize(
    @Body() dto: InitializePaymentDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.initializePayment(dto, userId);
  }

  @Post('initialize-unified')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async initializeUnified(
    @Body() dto: InitializeUnifiedCheckoutDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.initializeUnifiedCheckout(dto, userId);
  }

  @Get('attempts/:reference')
  @UseGuards(JwtAuthGuard)
  async getAttempt(@Param('reference') reference: string, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getPaymentAttemptByReference(reference, userId);
  }

  @Get('attempts/by-order/:orderId')
  @UseGuards(JwtAuthGuard)
  async getAttemptByOrderId(@Param('orderId') orderId: string, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getPaymentAttemptByOrderId(orderId, userId);
  }

  @Get('saved-cards')
  @UseGuards(JwtAuthGuard)
  async listSavedCards(@Req() req: Request): Promise<SavedPaymentCardSummary[]> {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.listSavedPaymentCards(userId);
  }

  @Delete('saved-cards/:savedCardId')
  @UseGuards(JwtAuthGuard)
  async removeSavedCard(
    @Param('savedCardId') savedCardId: string,
    @Req() req: Request,
  ): Promise<SavedPaymentMethodMutationResult> {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.removeSavedPaymentCard(savedCardId, userId);
  }

  @Post('saved-cards/:savedCardId/default')
  @UseGuards(JwtAuthGuard)
  async setDefaultSavedCard(
    @Param('savedCardId') savedCardId: string,
    @Req() req: Request,
  ): Promise<SavedPaymentMethodMutationResult> {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.setDefaultSavedPaymentCard(savedCardId, userId);
  }

  @Post('cards/validate')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async validateCard(@Body() dto: ValidatePaymentCardDto, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.validatePaymentCardSelection(dto, userId);
  }

  @Get('cards/validate/:sessionId')
  @UseGuards(JwtAuthGuard)
  async getCardValidationSession(
    @Param('sessionId') sessionId: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getPaymentCardValidationSession(sessionId, userId);
  }

  @Get('policy')
  @UseGuards(JwtAuthGuard)
  async getCheckoutPolicy(
    @Req() req: Request,
  ): Promise<PaymentClientCheckoutPolicy> {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getClientCheckoutPolicy(userId);
  }

  @Post('verify')
  @UseGuards(JwtAuthGuard)
  async verify(@Body() dto: VerifyPaymentDto, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.verifyPayment(dto, userId);
  }

  @Post('mock/:reference/simulate')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  async simulate(
    @Param('reference') reference: string,
    @Body() dto: SimulatePaymentAttemptDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.simulatePaymentAttempt(reference, dto, userId);
  }

  @Post('reconcile/stale')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  async reconcileStaleAttempts(
    @Body() dto: ReconcileStalePaymentsDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.reconcileStalePaymentAttempts(dto, userId);
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
    this.logger.warn(
      'Received Paystack webhook on legacy /payment/webhook/paystack. Use /webhooks/paystack in the Paystack dashboard instead.',
    );
    await this.paymentService.enqueueWebhook('PAYSTACK', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
    });
    return { status: 'ok' };
  }

  @Post('webhook/flutterwave')
  @HttpCode(200)
  async flutterwaveWebhook(
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
