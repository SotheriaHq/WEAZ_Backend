import {
  BadRequestException,
  Controller,
  Post,
  Body,
  Delete,
  Get,
  GoneException,
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
  ValidatePaymentCardDto,
  SavedPaymentCardSummary,
  SavedPaymentMethodMutationResult,
  SimulatePaymentAttemptDto,
  VerifyPaymentDto,
} from './payment.types';
import { Request } from 'express';
import { PaymentRuntimeHealthService } from './payment-runtime-health.service';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';

@Controller('payment')
export class PaymentController {
  private readonly logger = new Logger(PaymentController.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly fxRateService: FxRateService,
    private readonly paymentRuntimeHealthService: PaymentRuntimeHealthService,
  ) {}

  private readIdempotencyHeader(req: Request): string | null {
    const candidates = [
      req.headers['idempotency-key'],
      req.headers['x-idempotency-key'],
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

  private assertUnifiedIdempotencyKey(
    req: Request,
    bodyKey: string | null | undefined,
  ): void {
    const headerKey = this.readIdempotencyHeader(req);
    const normalizedBodyKey = String(bodyKey ?? '').trim();

    if (!headerKey || !normalizedBodyKey) {
      throw new BadRequestException(
        'Idempotency-Key header and body idempotencyKey are required for unified checkout initialization.',
      );
    }

    if (headerKey !== normalizedBodyKey) {
      throw new BadRequestException(
        'Idempotency-Key header must match body idempotencyKey for unified checkout initialization.',
      );
    }
  }

  private isLegacyPaystackWebhookAliasEnabled(): boolean {
    return (
      String(process.env.PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

  private isLegacyFlutterwaveWebhookAliasEnabled(): boolean {
    return (
      String(process.env.PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED ?? '')
        .trim()
        .toLowerCase() === 'true'
    );
  }

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

  @Post('initialize-unified')
  @UseGuards(JwtAuthGuard)
  @UseInterceptors(IdempotencyInterceptor)
  async initializeUnified(
    @Body() dto: InitializeUnifiedCheckoutDto,
    @Req() req: Request,
  ) {
    this.assertUnifiedIdempotencyKey(req, dto.idempotencyKey);
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.initializeUnifiedCheckout(
      dto,
      userId,
      this.readCorrelationHeader(req),
    );
  }

  @Get('attempts/:reference')
  @UseGuards(JwtAuthGuard)
  async getAttempt(@Param('reference') reference: string, @Req() req: Request) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getPaymentAttemptByReference(reference, userId);
  }

  @Get('attempts/by-order/:orderId')
  @UseGuards(JwtAuthGuard)
  async getAttemptByOrderId(
    @Param('orderId') orderId: string,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.getPaymentAttemptByOrderId(orderId, userId);
  }

  @Get('saved-cards')
  @UseGuards(JwtAuthGuard)
  async listSavedCards(
    @Req() req: Request,
  ): Promise<SavedPaymentCardSummary[]> {
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
    return this.paymentService.getPaymentCardValidationSession(
      sessionId,
      userId,
    );
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
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.PAYMENTS_SIMULATE)
  async simulate(
    @Param('reference') reference: string,
    @Body() dto: SimulatePaymentAttemptDto,
    @Req() req: Request,
  ) {
    const userId = (req as any).user?.id ?? (req as any).user?.sub;
    return this.paymentService.simulatePaymentAttempt(reference, dto, userId);
  }

  @Get('ops/runtime-health')
  @UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
  @Roles(Role.SuperAdmin, Role.Admin)
  @RequirePermissions(ADMIN_PERMISSIONS.PAYMENTS_RUNTIME_READ)
  async runtimeHealth() {
    return this.paymentRuntimeHealthService.getRuntimeHealth();
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
    if (!this.isLegacyPaystackWebhookAliasEnabled()) {
      this.logger.warn(
        'Blocked request to legacy /payment/webhook/paystack because legacy aliases are disabled.',
      );
      throw new GoneException(
        'Legacy Paystack webhook alias is disabled. Configure Paystack to POST /webhooks/paystack.',
      );
    }

    this.logger.warn(
      'Received Paystack webhook on legacy /payment/webhook/paystack. Use /webhooks/paystack in the Paystack dashboard instead.',
    );
    await this.paymentService.enqueueWebhook('PAYSTACK', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
      correlationId: this.readCorrelationHeader(req),
    });
    return { status: 'ok' };
  }

  @Post('webhook/flutterwave')
  @HttpCode(200)
  async flutterwaveWebhook(
    @Body() payload: Record<string, any>,
    @Req() req: Request & { rawBody?: string },
  ) {
    if (!this.isLegacyFlutterwaveWebhookAliasEnabled()) {
      this.logger.warn(
        'Blocked request to legacy /payment/webhook/flutterwave because legacy aliases are disabled.',
      );
      throw new GoneException(
        'Legacy Flutterwave webhook alias is disabled. Configure Flutterwave to POST /webhooks/flutterwave.',
      );
    }

    this.logger.warn(
      'Received Flutterwave webhook on legacy /payment/webhook/flutterwave. Use /webhooks/flutterwave in the Flutterwave dashboard instead.',
    );
    await this.paymentService.enqueueWebhook('FLUTTERWAVE', payload, {
      headers: req.headers,
      rawBody: req.rawBody,
      remoteAddress: req.ip ?? req.socket?.remoteAddress ?? null,
      correlationId: this.readCorrelationHeader(req),
    });
    return { status: 'ok' };
  }
}
