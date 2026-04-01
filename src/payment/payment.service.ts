import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
  Role,
} from '@prisma/client';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { FxRateService } from './fx-rate.service';
import { StandardOrderFinanceSyncService } from 'src/finance/standard-order-finance-sync.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import {
  WebhookEventsQueueService,
  type PaymentWebhookProcessJob,
} from 'src/queue/webhook-events.queue.service';
import {
  InitializePaymentDto,
  PaymentAttemptStatus,
  PaymentChannel,
  PaymentInitResult,
  PaymentAttemptSummary,
  PaymentNextAction,
  PaymentVerifyResult,
  SimulatePaymentAttemptDto,
  VerifyPaymentDto,
} from './payment.types';

type PaymentAttemptRecord = Awaited<ReturnType<PrismaService['paymentAttempt']['findUnique']>>;

type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
  remoteAddress?: string | null;
};

type AttemptStatusUpdatePayload = {
  eventPayload?: Record<string, any>;
  responseSnapshotPatch?: Record<string, any>;
  providerReference?: string | null;
  providerTransactionId?: string | null;
  providerAccessCode?: string | null;
  providerChannel?: string | null;
};

type ResolvedAttemptVerification = {
  nextStatus: PaymentAttemptStatus;
  awaitingProviderConfirmation: boolean;
  eventPayload?: Record<string, any>;
  responseSnapshotPatch?: Record<string, any>;
  providerReference?: string | null;
  providerTransactionId?: string | null;
  providerAccessCode?: string | null;
  providerChannel?: string | null;
};

interface GatewayInitializationResult {
  gateway: string;
  status: PaymentAttemptStatus;
  channel?: PaymentChannel;
  callbackUrl?: string;
  authorizationUrl?: string;
  providerReference?: string;
  providerTransactionId?: string;
  providerAccessCode?: string;
  providerChannel?: string;
  bankAccount?: PaymentInitResult['bankAccount'];
  nextAction?: PaymentNextAction;
  expiresAt?: string;
  responseSnapshot?: Record<string, any>;
}

const TERMINAL_ATTEMPT_STATUSES = new Set<PaymentAttemptStatus>([
  'PAID',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

const PAYSTACK_WEBHOOK_IPS = [
  '52.31.139.75',
  '52.49.173.169',
  '52.214.14.220',
] as const;

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRateService: FxRateService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
    private readonly notificationsService: NotificationsService,
    private readonly webhookEventsQueue: WebhookEventsQueueService,
  ) {}

  async initializePayment(
    dto: InitializePaymentDto,
    userId: string,
  ): Promise<PaymentInitResult> {
    const normalizedOrderIds = Array.from(
      new Set(
        (dto.orderIds ?? [])
          .map((orderId) => String(orderId || '').trim())
          .filter(Boolean),
      ),
    ).sort();

    if (normalizedOrderIds.length === 0) {
      throw new BadRequestException('At least one order is required for checkout');
    }

    const orders = await this.prisma.order.findMany({
      where: { id: { in: normalizedOrderIds }, buyerId: userId },
      select: {
        id: true,
        status: true,
        paymentStatus: true,
        customerName: true,
        shippingAddress: true,
        items: true,
        totalAmount: true,
        shippingCost: true,
        discountAmount: true,
        currency: true,
      },
    });

    if (orders.length !== normalizedOrderIds.length) {
      throw new BadRequestException('No eligible orders found');
    }

    this.ensureSingleCurrency(orders.map((order) => order.currency));

    const payableStatuses = new Set(['PENDING', 'PROCESSING', 'SHIPPED', 'DELIVERED']);
    const invalidOrder = orders.find(
      (order) =>
        order.paymentStatus === PaymentStatus.PAID ||
        order.paymentStatus === PaymentStatus.REFUNDED ||
        !payableStatuses.has(String(order.status || '').trim().toUpperCase()),
    );
    if (invalidOrder) {
      throw new BadRequestException('One or more selected orders can no longer be paid');
    }

    const paymentData = this.validatePaymentRequest(dto.paymentMethod, dto.paymentData);
    const amount = orders.reduce(
      (sum, order) => sum + Number(order.totalAmount ?? 0),
      0,
    );
    const currency = orders[0].currency;
    const callbackBaseUrl = this.resolveCallbackBaseUrl(dto.callbackUrl);
    const providerMode = this.getProviderMode();
    const existingAttempt =
      (dto.idempotencyKey
        ? await this.prisma.paymentAttempt.findFirst({
            where: {
              buyerId: userId,
              subjectType: PaymentSubjectType.STANDARD_ORDER,
              idempotencyKey: dto.idempotencyKey,
            },
            orderBy: { createdAt: 'desc' },
          })
        : null) ??
      (await this.prisma.paymentAttempt.findFirst({
        where: {
          buyerId: userId,
          subjectType: PaymentSubjectType.STANDARD_ORDER,
          paymentMethod: dto.paymentMethod,
          status: { in: ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'] },
          orderIds: { equals: normalizedOrderIds },
        },
        orderBy: { createdAt: 'desc' },
      }));

    if (existingAttempt) {
      if (existingAttempt.expiresAt && existingAttempt.expiresAt <= new Date()) {
        await this.applyAttemptStatus(existingAttempt.reference, userId, 'EXPIRED', 'verify', {
          eventPayload: {
            reason: 'ATTEMPT_REUSED_AFTER_EXPIRY',
          },
          responseSnapshotPatch: {
            expiredAt: new Date().toISOString(),
          },
        });
      } else {
        await this.prisma.order.updateMany({
          where: { id: { in: normalizedOrderIds }, buyerId: userId },
          data: {
            paymentMethod: existingAttempt.paymentMethod,
            paymentReference: existingAttempt.reference,
            paymentGateway: existingAttempt.provider,
            paymentStatus: this.mapAttemptStatusToOrderPaymentStatus(
              existingAttempt.status as PaymentAttemptStatus,
            ),
          },
        });

        return this.buildInitResultFromAttempt(existingAttempt);
      }
    }

    const settlementQuote = await this.fxRateService.quoteAndPersist({
      from: currency,
      amount,
      actorId: userId,
    });
    const reference = `TH-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const gatewayResult = await this.initializeGateway(
      dto.paymentMethod,
      reference,
      paymentData,
      amount,
      currency,
      callbackBaseUrl,
    );

    const attempt = await this.prisma.$transaction(async (tx) => {
      const createdAttempt = await tx.paymentAttempt.create({
        data: {
          buyerId: userId,
          provider: gatewayResult.gateway,
          providerMode,
          paymentMethod: dto.paymentMethod,
          providerReference: gatewayResult.providerReference,
          providerTransactionId: gatewayResult.providerTransactionId,
          providerAccessCode: gatewayResult.providerAccessCode,
          providerChannel: gatewayResult.providerChannel ?? gatewayResult.channel,
          channel: gatewayResult.channel,
          status: gatewayResult.status,
          reference,
          idempotencyKey: dto.idempotencyKey,
          callbackUrl: gatewayResult.callbackUrl ?? callbackBaseUrl,
          authorizationUrl: gatewayResult.authorizationUrl,
          amount,
          currency,
          settlementCurrency: this.fxRateService.getBaseCurrency(),
          settlementAmount: settlementQuote.convertedAmount,
          exchangeRateSnapshotId: settlementQuote.snapshot.id,
          orderIds: normalizedOrderIds,
          requestSnapshot: paymentData as unknown as Prisma.InputJsonValue,
          responseSnapshot: (gatewayResult.responseSnapshot ?? null) as unknown as Prisma.InputJsonValue,
          nextAction: (gatewayResult.nextAction ?? null) as unknown as Prisma.InputJsonValue,
          bankAccount: (gatewayResult.bankAccount ?? null) as unknown as Prisma.InputJsonValue,
          expiresAt: gatewayResult.expiresAt ? new Date(gatewayResult.expiresAt) : null,
        },
      });

      await tx.order.updateMany({
        where: { id: { in: orders.map((order) => order.id) }, buyerId: userId },
        data: {
          paymentMethod: dto.paymentMethod,
          paymentReference: reference,
          paymentGateway: gatewayResult.gateway,
          paymentStatus: this.mapAttemptStatusToOrderPaymentStatus(gatewayResult.status),
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: createdAttempt.id,
          type: 'INITIALIZED',
          source: providerMode === 'mock' ? 'mock-initialize' : 'initialize',
          payload: {
            paymentMethod: dto.paymentMethod,
            gateway: gatewayResult.gateway,
            channel: gatewayResult.channel,
            status: gatewayResult.status,
          },
        },
      });

      return createdAttempt;
    });

    return this.buildInitResultFromAttempt(attempt);
  }

  async getPaymentAttemptByReference(
    reference: string,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt || attempt.buyerId !== userId) {
      throw new NotFoundException('Payment attempt not found');
    }

    return this.buildAttemptSummary(attempt, userId);
  }

  async getPaymentAttemptByOrderId(
    orderId: string,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, buyerId: userId },
      select: { paymentReference: true },
    });

    if (!order?.paymentReference) {
      throw new NotFoundException('No payment attempt found for this order');
    }

    return this.getPaymentAttemptByReference(order.paymentReference, userId);
  }

  async verifyPayment(
    dto: VerifyPaymentDto,
    userId: string,
  ): Promise<PaymentVerifyResult> {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference: dto.reference },
    });

    if (!attempt || attempt.buyerId !== userId) {
      throw new BadRequestException('No payment attempt found for this reference');
    }

    const orders = await this.getOwnedOrdersForAttempt(attempt, userId);
    if (!orders.length) {
      throw new BadRequestException('No orders found for this reference');
    }

    if (attempt.status === 'PAID') {
      return this.buildVerifyResult(attempt, orders, true);
    }

    if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
      return this.buildVerifyResult(attempt, orders, false);
    }

    const resolvedVerification = await this.resolveAttemptVerification(attempt, dto);
    const updatedAttempt = await this.applyAttemptStatus(
      attempt.reference,
      userId,
      resolvedVerification.nextStatus,
      'verify',
      resolvedVerification,
    );

    const refreshedOrders = await this.getOwnedOrdersForAttempt(updatedAttempt, userId);
    return this.buildVerifyResult(
      updatedAttempt,
      refreshedOrders,
      updatedAttempt.status === 'PAID',
    );
  }

  async simulatePaymentAttempt(
    reference: string,
    dto: SimulatePaymentAttemptDto,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    if (!this.isMockMode() || !this.allowPaymentSimulation()) {
      throw new BadRequestException('Payment simulation is not enabled');
    }

    const updatedAttempt = await this.applyAttemptStatus(
      reference,
      userId,
      dto.outcome,
      'simulation',
      {
        eventPayload: { outcome: dto.outcome },
        responseSnapshotPatch: {
          simulatedOutcome: dto.outcome,
          simulatedAt: new Date().toISOString(),
        },
      },
    );

    return this.buildAttemptSummary(updatedAttempt, userId);
  }

  preparePaymentRequest(
    paymentMethod: PaymentMethod,
    paymentData?: Record<string, any>,
  ) {
    return this.validatePaymentRequest(paymentMethod, paymentData);
  }

  resolvePaymentCallbackUrl(callbackUrl?: string) {
    return this.resolveCallbackBaseUrl(callbackUrl);
  }

  async initializeGatewayForAttempt(
    paymentMethod: PaymentMethod,
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ) {
    return this.initializeGateway(
      paymentMethod,
      reference,
      paymentData,
      amount,
      currency,
      callbackBaseUrl,
    );
  }

  async resolveAttemptVerification(
    attempt: NonNullable<PaymentAttemptRecord>,
    dto: Pick<VerifyPaymentDto, 'reference' | 'gateway' | 'otp' | 'statusHint'>,
  ): Promise<ResolvedAttemptVerification> {
    const requestedGateway = String(dto.gateway || '').trim().toUpperCase();
    const attemptGateway = String(attempt.provider || '').trim().toUpperCase();
    if (requestedGateway && requestedGateway !== attemptGateway) {
      throw new BadRequestException(
        'Payment verification gateway does not match the initialized payment attempt',
      );
    }

    if (attemptGateway === 'PAYSTACK' && this.getProviderModeForAttempt(attempt) === 'live') {
      const verification = await this.verifyPaystackAttempt(attempt);
      const nextStatus = verification.status;
      const awaitingProviderConfirmation = this.isPendingVerificationStatus(nextStatus);

      return {
        nextStatus,
        awaitingProviderConfirmation,
        eventPayload: {
          gateway: 'PAYSTACK',
          providerStatus: verification.rawStatus,
          providerMessage: verification.message,
          paidAt: verification.paidAt,
          channel: verification.channel,
        },
        responseSnapshotPatch: {
          ...(this.asObject(attempt.responseSnapshot) ?? {}),
          providerVerificationGateway: 'PAYSTACK',
          providerVerificationStatus: nextStatus,
          providerVerificationReference: verification.reference,
          providerVerificationTransactionId: verification.transactionId,
          providerVerificationAmount: verification.amount,
          providerVerificationCurrency: verification.currency,
          providerVerificationChannel: verification.channel,
          providerVerificationPaidAt: verification.paidAt,
          providerVerificationMessage: verification.message,
          providerVerificationVerifiedAt: new Date().toISOString(),
          awaitingProviderConfirmation,
          recoveryAction: awaitingProviderConfirmation
            ? 'WAIT_FOR_PROVIDER_CONFIRMATION'
            : null,
          recoveryMessage: awaitingProviderConfirmation
            ? 'Payment is still awaiting provider callback or settlement confirmation.'
            : null,
        },
        providerReference: verification.reference,
        providerTransactionId: verification.transactionId,
        providerChannel: verification.channel,
      };
    }

    const nextStatus = this.resolveVerificationStatus(attempt, dto as VerifyPaymentDto);
    const now = new Date();
    const awaitingProviderConfirmation =
      this.getProviderModeForAttempt(attempt) === 'live' &&
      this.isPendingVerificationStatus(nextStatus);

    return {
      nextStatus,
      awaitingProviderConfirmation,
      ...this.buildVerificationUpdatePayload(
        attempt,
        dto as VerifyPaymentDto,
        nextStatus,
        now,
        awaitingProviderConfirmation,
      ),
    };
  }

  getAttemptProviderMode() {
    return this.getProviderMode();
  }

  isAttemptTerminalStatus(status: PaymentAttemptStatus) {
    return this.isTerminalStatus(status);
  }

  isAttemptPendingVerificationStatus(status: string | null | undefined) {
    return this.isPendingVerificationStatus(status);
  }

  async enqueueWebhook(
    gateway: string,
    payload: Record<string, any>,
    context: WebhookContext,
  ): Promise<void> {
    const receipt = await this.recordWebhookReceipt(gateway, payload, context);
    if (!receipt || receipt.processedAt) {
      return;
    }

    await this.webhookEventsQueue.enqueuePaymentWebhook({
      gateway: receipt.gateway,
      payload,
      providerEventKey: receipt.providerEventKey,
      reference: receipt.reference,
    });
  }

  async handleWebhook(
    gateway: string,
    payload: Record<string, any>,
    context: WebhookContext,
  ): Promise<void> {
    const receipt = await this.recordWebhookReceipt(gateway, payload, context);
    if (!receipt || receipt.processedAt) {
      return;
    }

    await this.processWebhookPayload(
      receipt.gateway,
      payload,
      receipt.reference,
      receipt.providerEventKey,
    );
  }

  async processQueuedWebhook(job: PaymentWebhookProcessJob): Promise<void> {
    await this.processWebhookPayload(
      job.gateway,
      job.payload,
      job.reference,
      job.providerEventKey,
    );
  }

  private async recordWebhookReceipt(
    gateway: string,
    payload: Record<string, any>,
    context: WebhookContext,
  ) {
    const normalizedGateway = String(gateway || '').trim().toUpperCase();
    if (!this.verifyWebhookSignature(normalizedGateway, payload, context)) {
      this.logger.warn(
        `Rejected ${normalizedGateway} webhook due to signature verification failure`,
      );
      return null;
    }

    const reference = this.extractWebhookReference(normalizedGateway, payload);
    if (!reference) {
      this.logger.warn(`Webhook from ${normalizedGateway}: missing reference`);
      return null;
    }

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      this.logger.warn(
        `Webhook from ${normalizedGateway}: unknown reference ${reference}`,
      );
      return null;
    }

    if (String(attempt.provider || '').trim().toUpperCase() !== normalizedGateway) {
      this.logger.warn(
        `Webhook gateway mismatch for ${reference}: expected ${attempt.provider}, received ${normalizedGateway}`,
      );
      return null;
    }

    const providerEventKey = this.computeWebhookEventKey(
      normalizedGateway,
      payload,
      reference,
    );
    if (!providerEventKey) {
      this.logger.warn(
        `Webhook from ${normalizedGateway}: unable to compute durable event key for ${reference}`,
      );
      return null;
    }

    const providerEventType = this.extractWebhookEvent(normalizedGateway, payload);

    try {
      await this.prisma.paymentEvent.create({
        data: {
          paymentAttemptId: attempt.id,
          type: 'WEBHOOK_RECEIVED',
          source: 'webhook-receipt',
          providerEventKey,
          providerEventType,
          providerEventReceivedAt: new Date(),
          payload,
        },
      });
    } catch (error: any) {
      const message = String(error?.message || '');
      if (message.includes('providerEventKey') || message.includes('Unique constraint')) {
        const existing = await this.prisma.paymentEvent.findFirst({
          where: { providerEventKey },
          select: { processedAt: true },
        });
        return {
          gateway: normalizedGateway,
          reference,
          providerEventKey,
          processedAt: existing?.processedAt ?? null,
        };
      }
      throw error;
    }

    this.logger.log(`Webhook received from ${normalizedGateway}: ${reference}`);

    return {
      gateway: normalizedGateway,
      reference,
      providerEventKey,
      processedAt: null,
    };
  }

  private async processWebhookPayload(
    normalizedGateway: string,
    payload: Record<string, any>,
    reference: string,
    providerEventKey: string,
  ) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      this.logger.warn(
        `Webhook processing skipped for ${normalizedGateway}: unknown reference ${reference}`,
      );
      await this.markProviderEventProcessed(providerEventKey);
      return;
    }

    if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
      await this.markProviderEventProcessed(providerEventKey);
      return;
    }

    const nextStatus = this.resolveWebhookStatus(normalizedGateway, payload);
    if (!nextStatus) {
      this.logger.warn(
        `Webhook from ${normalizedGateway}: unsupported status payload for ${reference}`,
      );
      await this.markProviderEventProcessed(providerEventKey);
      return;
    }

    const payloadAmount = this.extractWebhookAmount(normalizedGateway, payload);
    const payloadCurrency = this.extractWebhookCurrency(payload);

    if (
      nextStatus === 'PAID' &&
      !this.webhookAmountsMatch(
        Number(attempt.amount ?? 0),
        attempt.currency,
        payloadAmount,
        payloadCurrency,
      )
    ) {
      this.logger.warn(
        `Webhook from ${normalizedGateway}: amount or currency mismatch for ${reference}`,
      );
      await this.markProviderEventProcessed(providerEventKey);
      return;
    }

    await this.applyAttemptStatus(reference, attempt.buyerId ?? '', nextStatus, 'webhook', {
      eventPayload: payload,
      responseSnapshotPatch: {
        ...(this.asObject(attempt.responseSnapshot) ?? {}),
        providerWebhookGateway: normalizedGateway,
        providerWebhookStatus: nextStatus,
        providerWebhookReceivedAt: new Date().toISOString(),
        providerWebhookAmount: payloadAmount,
        providerWebhookCurrency: payloadCurrency,
        providerWebhookEvent: this.extractWebhookEvent(normalizedGateway, payload),
        providerWebhookVerified: true,
      },
      providerReference: this.extractWebhookReference(normalizedGateway, payload),
      providerTransactionId: this.extractWebhookTransactionId(normalizedGateway, payload),
      providerChannel: this.extractWebhookChannel(payload),
    });

    await this.markProviderEventProcessed(providerEventKey);
  }

  private async initializeGateway(
    paymentMethod: PaymentMethod,
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    switch (paymentMethod) {
      case PaymentMethod.PAYSTACK:
        return this.initPaystack(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.FLUTTERWAVE:
        return this.initFlutterwave(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.BANK_TRANSFER:
        return this.initBankTransfer(reference, paymentData, amount, currency, callbackBaseUrl);
      case PaymentMethod.PAY_ON_DELIVERY:
        throw new BadRequestException('Pay on delivery is temporarily unavailable');
      default:
        throw new BadRequestException(`Unsupported payment method: ${paymentMethod}`);
    }
  }

  private async initPaystack(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    const channel = (paymentData.channel as PaymentChannel | undefined) ?? 'CARD';
    const mockReturnStatus = this.resolveMockReturnStatus(paymentData);
    if (this.isMockMode()) {
      return {
        gateway: 'PAYSTACK',
        status: 'REQUIRES_ACTION',
        channel,
        callbackUrl: callbackBaseUrl,
        authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'PAYSTACK', mockReturnStatus),
        nextAction: {
          type: 'REDIRECT',
          title:
            channel === 'BANK_TRANSFER'
              ? 'Continue to Paystack transfer checkout'
              : 'Continue to Paystack checkout',
          description:
            channel === 'BANK_TRANSFER'
              ? 'Transfer instructions will be collected on the hosted Paystack checkout flow.'
              : 'Card details will be collected on the hosted checkout flow.',
          ctaLabel: 'Continue to Paystack',
          instructions: [
            `Use ${paymentData.email} as the payer email if prompted.`,
            'In mock mode, the return status is simulated through the payment-return route.',
            'The order is not treated as paid until verification confirms success.',
          ],
        },
        responseSnapshot: {
          mockReturnStatus,
          providerChannel: channel,
        },
      };
    }

    if (currency !== 'NGN') {
      throw new BadRequestException('Paystack is only enabled for NGN payments in this phase');
    }

    const secret = this.getRequiredEnv('PAYSTACK_SECRET_KEY');
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: paymentData.email,
        amount: Math.round(this.roundMoney(amount) * 100),
        currency,
        reference,
        callback_url: callbackBaseUrl,
        channels: [channel === 'BANK_TRANSFER' ? 'bank_transfer' : 'card'],
        metadata: {
          threadlyReference: reference,
          threadlyChannel: channel,
          payerPhone: paymentData.phone,
          source: 'threadly-checkout',
        },
      }),
    });

    const payload = await this.parseJsonResponse(response);
    if (!response.ok || payload?.status === false || !payload?.data?.reference) {
      throw new BadRequestException(
        String(payload?.message || 'Unable to initialize Paystack payment'),
      );
    }

    return {
      gateway: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel,
      callbackUrl: callbackBaseUrl,
      authorizationUrl: String(payload.data.authorization_url || '').trim() || undefined,
      providerReference: String(payload.data.reference || reference),
      providerAccessCode: String(payload.data.access_code || '').trim() || undefined,
      providerChannel: channel,
      nextAction: {
        type: 'REDIRECT',
        title:
          channel === 'BANK_TRANSFER'
            ? 'Continue to Paystack transfer checkout'
            : 'Continue to Paystack checkout',
        description:
          channel === 'BANK_TRANSFER'
            ? 'Paystack will display the bank-transfer instructions on the hosted checkout page.'
            : 'Card details will be collected on Paystack’s hosted checkout flow.',
        ctaLabel: 'Continue to Paystack',
        instructions: [
          `Use ${paymentData.email} as the payer email if prompted.`,
          'Threadly will verify the payment after Paystack redirects you back.',
          'The order is not treated as paid until provider verification confirms success.',
        ],
      },
      responseSnapshot: {
        initializedAt: new Date().toISOString(),
        providerStatus: 'INITIALIZED',
        providerMessage: payload?.message ?? null,
        providerChannel: channel,
      },
    };
  }

  private async initFlutterwave(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    const channel = paymentData.channel as PaymentChannel;
    const mockReturnStatus = this.resolveMockReturnStatus(paymentData);

    if (channel === 'CARD') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'REQUIRES_ACTION',
        channel,
        callbackUrl: callbackBaseUrl,
        authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'FLUTTERWAVE', mockReturnStatus),
        nextAction: {
          type: 'REDIRECT',
          title: 'Continue to Flutterwave checkout',
          description: 'The hosted checkout will simulate card authorization and then return to Threadly.',
          ctaLabel: 'Continue to Flutterwave',
          instructions: [
            `Proceed with ${paymentData.email} as the payer email.`,
            'Mock mode still routes through the same callback flow that live mode will use later.',
            'Verification will mark the payment according to the simulated return status.',
          ],
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'BANK_TRANSFER') {
      return this.buildVirtualAccountResult(reference, 'FLUTTERWAVE', amount, currency, 45, paymentData.email, callbackBaseUrl);
    }

    if (channel === 'BANK_ACCOUNT') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'REQUIRES_ACTION',
        channel,
        callbackUrl: callbackBaseUrl,
        authorizationUrl: this.buildMockReturnUrl(callbackBaseUrl, reference, 'FLUTTERWAVE', mockReturnStatus),
        nextAction: {
          type: 'BANK_ACCOUNT_AUTH',
          title: 'Authorize the bank account payment',
          description: 'This flow simulates issuer-side bank-account authorization before completion.',
          ctaLabel: 'Authorize bank account',
          instructions: [
            `Bank: ${paymentData.bankAccount.bankName}`,
            `Account number: ${paymentData.bankAccount.accountNumber}`,
            'Use the continue action to move through the mock callback flow.',
          ],
          metadata: {
            bankName: String(paymentData.bankAccount.bankName),
            accountNumber: String(paymentData.bankAccount.accountNumber),
          },
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'USSD') {
      const shortReference = String(reference).slice(-4);
      const ussdCode = `*${paymentData.ussd.bankCode}*000*${shortReference}#`;
      return {
        gateway: 'FLUTTERWAVE',
        status: 'PENDING',
        channel,
        callbackUrl: callbackBaseUrl,
        nextAction: {
          type: 'USSD_INSTRUCTIONS',
          title: 'Complete payment with USSD',
          description: 'Dial the generated code and then use the mock simulator if you want to mark the payment outcome.',
          instructions: [
            `Selected bank: ${paymentData.ussd.bankName}`,
            `Dial ${ussdCode} on your phone.`,
            'In mock mode, the order stays pending until you simulate or verify an outcome.',
          ],
          ussdCode,
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    if (channel === 'MOBILE_MONEY') {
      return {
        gateway: 'FLUTTERWAVE',
        status: 'PENDING',
        channel,
        callbackUrl: callbackBaseUrl,
        nextAction: {
          type: 'MOBILE_MONEY_APPROVAL',
          title: 'Approve the mobile money request',
          description: 'A wallet approval is expected. In mock mode, this remains pending until you simulate or verify an outcome.',
          instructions: [
            `Network: ${paymentData.mobileMoney.networkName}`,
            `Phone: ${paymentData.mobileMoney.phone}`,
            'Use the simulator controls to approve, fail, or expire the request during testing.',
          ],
        },
        responseSnapshot: {
          mockReturnStatus,
        },
      };
    }

    throw new BadRequestException(`Unsupported Flutterwave channel: ${channel}`);
  }

  private async initBankTransfer(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    return this.buildVirtualAccountResult(
      reference,
      'BANK_TRANSFER',
      amount,
      currency,
      60,
      paymentData.senderName,
      callbackBaseUrl,
    );
  }

  private buildVirtualAccountResult(
    reference: string,
    gateway: 'FLUTTERWAVE' | 'BANK_TRANSFER',
    amount: number,
    currency: string,
    expiryMinutes: number,
    accountNameSeed: string,
    callbackBaseUrl: string,
  ): GatewayInitializationResult {
    const expiresAt = new Date(Date.now() + expiryMinutes * 60 * 1000);
    const bankAccount = {
      bankName: gateway === 'FLUTTERWAVE' ? 'Wema Bank' : 'Providus Bank',
      accountNumber: gateway === 'FLUTTERWAVE' ? '7845123098' : '4012568897',
      accountName: `${accountNameSeed || 'Threadly'} - Threadly Checkout`,
      expiresAt: expiresAt.toISOString(),
      amount,
      narration: reference,
    };

    return {
      gateway,
      status: 'PENDING',
      channel: 'BANK_TRANSFER',
      callbackUrl: callbackBaseUrl,
      bankAccount,
      expiresAt: expiresAt.toISOString(),
      nextAction: {
        type: 'BANK_TRANSFER_INSTRUCTIONS',
        title: 'Transfer to the generated virtual account',
        description: 'Use the exact amount and narration below. In mock mode, the payment remains pending until you simulate completion or failure.',
        expiresAt: expiresAt.toISOString(),
        instructions: [
          `Send ${amount.toFixed(2)} ${currency} to the generated account.`,
          `Use ${reference} as the transfer narration/reference.`,
          'Verification and simulation routes use the same durable attempt record as live mode will later use.',
        ],
        metadata: {
          bankName: bankAccount.bankName,
          accountNumber: bankAccount.accountNumber,
          accountName: bankAccount.accountName,
          amount: amount.toFixed(2),
          narration: reference,
        },
      },
      responseSnapshot: {
        mockReturnStatus: this.resolveMockReturnStatus({ email: accountNameSeed }),
      },
    };
  }

  private async buildAttemptSummary(
    attempt: NonNullable<PaymentAttemptRecord>,
    userId: string,
  ): Promise<PaymentAttemptSummary> {
    if (attempt.subjectType === PaymentSubjectType.CUSTOM_ORDER) {
      if (!attempt.customOrderId) {
        throw new NotFoundException('Custom-order payment attempt is missing its order reference');
      }

      const customOrder = await this.prisma.customOrder.findFirst({
        where: {
          id: attempt.customOrderId,
          buyerId: userId,
        },
        select: {
          id: true,
          sourceTitleSnapshot: true,
          sourceBrandNameSnapshot: true,
          buyerPriceSummaryJson: true,
          shippingAddressJson: true,
          currency: true,
        },
      });

      if (!customOrder) {
        throw new NotFoundException('No custom order found for this payment attempt');
      }

      const priceSummary = this.asObject(customOrder.buyerPriceSummaryJson);
      const shippingAddress = this.asObject(customOrder.shippingAddressJson);
      const grandTotal = this.roundMoney(Number(priceSummary?.grandTotal ?? attempt.amount ?? 0));
      const shippingCost = this.roundMoney(Number(priceSummary?.shippingFee ?? 0));
      const discount = this.roundMoney(Number(priceSummary?.discount ?? 0));
      const subtotal = this.roundMoney(Number(priceSummary?.subtotal ?? grandTotal - shippingCost + discount));

      return {
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        subjectType: 'CUSTOM_ORDER',
        customOrderId: customOrder.id,
        gateway: attempt.provider,
        providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
        paymentMethod: attempt.paymentMethod,
        status: attempt.status as PaymentAttemptStatus,
        currency: attempt.currency,
        settlementCurrency: attempt.settlementCurrency,
        settlementAmount: Number(
          attempt.settlementAmount ?? attempt.amount ?? grandTotal,
        ),
        exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
        channel: (attempt.channel as PaymentChannel | null) ?? undefined,
        authorizationUrl: attempt.authorizationUrl ?? undefined,
        callbackUrl: attempt.callbackUrl ?? undefined,
        bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
        paymentData: this.asObject(attempt.requestSnapshot),
        nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
        canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
        canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
        orderIds: [],
        summary: {
          items: [
            {
              name:
                String(customOrder.sourceTitleSnapshot || '').trim() ||
                `Custom order ${customOrder.id.slice(0, 8).toUpperCase()}`,
              quantity: 1,
              price: subtotal,
            },
          ],
          subtotal,
          shippingCost,
          discount,
          grandTotal,
          shippingName: String(customOrder.sourceBrandNameSnapshot ?? 'Custom order'),
          shippingCity: String(shippingAddress.city ?? ''),
          shippingState: String(shippingAddress.state ?? ''),
        },
      };
    }

    const orders = await this.getOwnedOrdersForAttempt(attempt, userId);
    if (!orders.length) {
      throw new NotFoundException('No orders found for this payment attempt');
    }

    const firstOrder = orders[0];
    const shippingAddress = this.asObject(firstOrder.shippingAddress);
    const items = orders.flatMap((order) => this.asOrderItems(order.items));
    const subtotal = items.reduce(
      (sum, item) =>
        sum + Number(item.price ?? item.unitPrice ?? 0) * Number(item.quantity ?? 1),
      0,
    );
    const shippingCost = orders.reduce((sum, order) => sum + Number(order.shippingCost ?? 0), 0);
    const discount = orders.reduce((sum, order) => sum + Number(order.discountAmount ?? 0), 0);
    const grandTotal = orders.reduce((sum, order) => sum + Number(order.totalAmount ?? 0), 0);

    return {
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      subjectType: 'STANDARD_ORDER',
      gateway: attempt.provider,
      providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
      paymentMethod: attempt.paymentMethod,
      status: attempt.status as PaymentAttemptStatus,
      currency: attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(
        attempt.settlementAmount ?? attempt.amount ?? grandTotal,
      ),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      channel: (attempt.channel as PaymentChannel | null) ?? undefined,
      authorizationUrl: attempt.authorizationUrl ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
      paymentData: this.asObject(attempt.requestSnapshot),
      nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
      canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
      canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
      orderIds: orders.map((order) => order.id),
      summary: {
        items: items.map((item) => ({
          name: String(item.name ?? item.productName ?? 'Item'),
          quantity: Number(item.quantity ?? 1),
          price: Number(item.price ?? item.unitPrice ?? 0),
        })),
        subtotal,
        shippingCost,
        discount,
        grandTotal,
        shippingName: String(firstOrder.customerName ?? ''),
        shippingCity: String(shippingAddress.city ?? ''),
        shippingState: String(shippingAddress.state ?? ''),
      },
    };
  }

  private async applyAttemptStatus(
    reference: string,
    userId: string,
    nextStatus: PaymentAttemptStatus,
    source: 'verify' | 'simulation' | 'webhook',
    payload?: AttemptStatusUpdatePayload,
  ) {
    const now = new Date();
    const eventPayload = payload?.eventPayload ?? null;
    const responseSnapshotPatch = payload?.responseSnapshotPatch ?? null;
    const updatedAttempt = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${reference} FOR UPDATE`;
      const attempt = await tx.paymentAttempt.findUnique({
        where: { reference },
      });

      if (!attempt || (attempt.buyerId && userId && attempt.buyerId !== userId)) {
        throw new NotFoundException('Payment attempt not found');
      }

      if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
        return attempt;
      }

      const settlement = await this.fxRateService.resolveSettlement({
        attempt,
        gateway: attempt.provider,
        payload: eventPayload ?? undefined,
      });

      const updated = await tx.paymentAttempt.update({
        where: { reference },
        data: {
          status: nextStatus,
          confirmedAt: nextStatus === 'PAID' ? now : attempt.confirmedAt,
          finalizedAt: this.isTerminalStatus(nextStatus) ? now : attempt.finalizedAt,
          lastVerifiedAt: now,
          providerReference: payload?.providerReference ?? attempt.providerReference,
          providerTransactionId:
            payload?.providerTransactionId ?? attempt.providerTransactionId,
          providerAccessCode: payload?.providerAccessCode ?? attempt.providerAccessCode,
          providerChannel:
            payload?.providerChannel ?? attempt.providerChannel ?? attempt.channel,
          channel: payload?.providerChannel ?? attempt.channel,
          settlementCurrency: settlement.settlementCurrency,
          settlementAmount: settlement.settlementAmount,
          exchangeRateSnapshotId: settlement.exchangeRateSnapshotId,
          responseSnapshot:
            responseSnapshotPatch && Object.keys(responseSnapshotPatch).length > 0
              ? ({
                  ...(this.asObject(attempt.responseSnapshot) ?? {}),
                  ...responseSnapshotPatch,
                } as Prisma.InputJsonValue)
              : attempt.responseSnapshot,
          failureCode:
            nextStatus === 'FAILED'
              ? source === 'simulation'
                ? 'MOCK_FAILURE'
                : 'PAYMENT_FAILED'
              : nextStatus === 'CANCELLED'
                ? 'PAYMENT_CANCELLED'
                : nextStatus === 'EXPIRED'
                  ? 'PAYMENT_EXPIRED'
                  : null,
          failureMessage:
            nextStatus === 'FAILED'
              ? source === 'simulation'
                ? 'Mock payment marked as failed.'
                : 'Payment provider reported the payment as failed.'
              : nextStatus === 'CANCELLED'
                ? source === 'simulation'
                  ? 'Mock payment was cancelled.'
                  : 'Payment provider reported the payment as cancelled.'
                : nextStatus === 'EXPIRED'
                  ? source === 'simulation'
                    ? 'Mock payment expired before completion.'
                    : 'Payment provider reported that the payment expired before completion.'
                  : null,
        },
      });

      await tx.order.updateMany({
        where: { paymentReference: reference, buyerId: attempt.buyerId ?? undefined },
        data: {
          paymentStatus: this.mapAttemptStatusToOrderPaymentStatus(nextStatus),
          paidAt: nextStatus === 'PAID' ? now : null,
        },
      });

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: updated.id,
          type: `STATUS_${nextStatus}`,
          source,
          providerEventType:
            source === 'webhook'
              ? this.extractWebhookEvent(String(attempt.provider || ''), eventPayload ?? {})
              : nextStatus,
          providerEventReceivedAt: source === 'webhook' ? now : null,
          processedAt: now,
          payload: eventPayload,
        },
      });

      return updated;
    });

    const linkedOrders =
      nextStatus === 'PAID'
        ? await this.prisma.order.findMany({
            where: {
              paymentReference: reference,
              ...(updatedAttempt.buyerId ? { buyerId: updatedAttempt.buyerId } : {}),
            },
            select: {
              id: true,
              brandId: true,
              buyerId: true,
            },
            orderBy: { createdAt: 'asc' },
          })
        : [];

    if (nextStatus === 'PAID' && linkedOrders.length > 0) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByReferences([reference]);
      await this.notifyFinanceAdminsOfStandardPayment(updatedAttempt, linkedOrders);
    }

    return updatedAttempt;
  }

  private buildInitResultFromAttempt(
    attempt: NonNullable<PaymentAttemptRecord>,
  ): PaymentInitResult {
    return {
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      gateway: attempt.provider,
      status: attempt.status as PaymentAttemptStatus,
      currency: attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? 0),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      channel: (attempt.channel as PaymentChannel | null) ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      authorizationUrl: attempt.authorizationUrl ?? undefined,
      bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
      nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
    };
  }

  private buildVerifyResult(
    attempt: NonNullable<PaymentAttemptRecord>,
    orders: Array<{
      id: string;
      totalAmount: Prisma.Decimal;
      shippingCost: Prisma.Decimal;
      currency: string;
    }>,
    success: boolean,
  ): PaymentVerifyResult {
    const amount = orders.reduce(
      (sum, order) => sum + Number(order.totalAmount ?? 0),
      0,
    );

    return {
      success,
      status: attempt.status as PaymentAttemptStatus,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      amount,
      currency: orders[0]?.currency ?? attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? amount),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      paidAt: attempt.confirmedAt?.toISOString(),
      channel: attempt.channel ?? undefined,
      gatewayResponse: success
        ? this.getProviderModeForAttempt(attempt) === 'mock'
          ? 'Mock payment verified successfully'
          : 'Payment verified successfully'
        : this.getProviderModeForAttempt(attempt) === 'mock'
          ? 'Mock payment remains unresolved or failed'
          : 'Payment remains unresolved or failed',
      failureMessage: attempt.failureMessage ?? undefined,
      orderIds: orders.map((order) => order.id),
    };
  }

  private async getOwnedOrdersForAttempt(
    attempt: NonNullable<PaymentAttemptRecord>,
    userId: string,
  ) {
    return this.prisma.order.findMany({
      where: {
        id: { in: attempt.orderIds },
        buyerId: userId,
      },
      select: {
        id: true,
        customerName: true,
        items: true,
        shippingAddress: true,
        totalAmount: true,
        shippingCost: true,
        discountAmount: true,
        currency: true,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  private async notifyFinanceAdminsOfStandardPayment(
    attempt: NonNullable<PaymentAttemptRecord>,
    linkedOrders: Array<{ id: string; brandId: string; buyerId: string | null }>,
  ) {
    const recipients = await this.prisma.user.findMany({
      where: {
        role: { in: [Role.SuperAdmin, Role.Admin] },
        OR: [
          { role: Role.SuperAdmin },
          {
            adminPermissionGrants: {
              some: { permissionCode: ADMIN_PERMISSIONS.PAYOUTS_READ },
            },
          },
        ],
      },
      select: { id: true },
    });

    const recipientIds = Array.from(
      new Set(recipients.map((recipient) => recipient.id).filter(Boolean)),
    );
    if (recipientIds.length === 0) {
      return;
    }

    const amount = this.roundMoney(Number(attempt.amount ?? 0)).toFixed(2);
    const orderCount = linkedOrders.length;
    const subjectLabel = orderCount === 1 ? 'standard order' : 'standard orders';

    await Promise.allSettled(
      recipientIds.map((recipientId) =>
        this.notificationsService.create(recipientId, NotificationType.ADMIN_ACTION, {
          actorId: linkedOrders[0]?.buyerId ?? undefined,
          dedupeMs: 5 * 60 * 1000,
          payload: {
            action: 'FINANCE_PAYMENT_RECEIVED',
            paymentAttemptId: attempt.id,
            reference: attempt.reference,
            amount: Number(attempt.amount ?? 0),
            currency: attempt.currency,
            orderIds: linkedOrders.map((order) => order.id),
            message: `Payment received: ${attempt.reference} for ${orderCount} ${subjectLabel} worth ${attempt.currency} ${amount}.`,
            targetUrl: '/admin/finance',
          },
        }),
      ),
    );
  }

  private validatePaymentRequest(
    paymentMethod: PaymentMethod,
    paymentData?: Record<string, any>,
  ): Record<string, any> {
    if (
      this.getProviderMode() === 'live' &&
      paymentMethod !== PaymentMethod.PAYSTACK
    ) {
      throw new BadRequestException(
        'Only Paystack is enabled in live mode for this checkout phase',
      );
    }

    if (!paymentData || typeof paymentData !== 'object') {
      throw new BadRequestException('Payment details are required for the selected method');
    }

    const email = String(paymentData.email ?? '').trim();
    const phone = String(paymentData.phone ?? '').trim();
    const consentAccepted = Boolean(paymentData.consentAccepted);

    if (!email) {
      throw new BadRequestException('Customer email is required');
    }
    if (!phone) {
      throw new BadRequestException('Customer phone is required');
    }
    if (!consentAccepted) {
      throw new BadRequestException('Payment consent must be accepted');
    }

    if (!paymentData.billingSameAsShipping && !paymentData.billingAddress) {
      throw new BadRequestException('Billing address is required when different from shipping');
    }

    if (paymentMethod === PaymentMethod.PAYSTACK) {
      if (!['CARD', 'BANK_TRANSFER'].includes(String(paymentData.channel || '').toUpperCase())) {
        throw new BadRequestException(
          'Paystack requires a supported hosted checkout channel',
        );
      }
      return paymentData;
    }

    if (paymentMethod === PaymentMethod.FLUTTERWAVE) {
      const channel = paymentData.channel as PaymentChannel;
      if (!channel) {
        throw new BadRequestException('Flutterwave payment channel is required');
      }

      if (
        channel === 'BANK_ACCOUNT' &&
        (!paymentData.bankAccount?.bankCode ||
          !paymentData.bankAccount?.accountNumber ||
          !paymentData.bankAccount?.accountName)
      ) {
        throw new BadRequestException(
          'Bank account payments require bank, account number, and account name',
        );
      }

      if (channel === 'USSD') {
        if (!paymentData.ussd?.bankCode || !paymentData.ussd?.bankName) {
          throw new BadRequestException(
            'USSD payments require a supported bank selection',
          );
        }
      }

      if (channel === 'MOBILE_MONEY') {
        if (
          !paymentData.mobileMoney?.countryCode ||
          !paymentData.mobileMoney?.networkId ||
          !paymentData.mobileMoney?.networkName ||
          !paymentData.mobileMoney?.phone
        ) {
          throw new BadRequestException(
            'Mobile money payments require country, network, and phone details',
          );
        }
      }

      return paymentData;
    }

    if (paymentMethod === PaymentMethod.BANK_TRANSFER) {
      if (
        !paymentData.senderName ||
        !paymentData.senderPhone ||
        !paymentData.senderBankName ||
        !paymentData.transferPurpose
      ) {
        throw new BadRequestException(
          'Bank transfer requires sender name, phone, bank name, and payment purpose',
        );
      }
      return paymentData;
    }

    return paymentData;
  }

  private resolveVerificationStatus(
    attempt: NonNullable<PaymentAttemptRecord>,
    dto: VerifyPaymentDto,
  ): PaymentAttemptStatus {
    const authoritative = this.extractAttemptAuthoritativeStatus(attempt);
    const requested = this.normalizeStatusHint(dto.statusHint);

    if (this.getProviderModeForAttempt(attempt) === 'live') {
      if (requested && authoritative && requested !== authoritative) {
        throw new BadRequestException(
          'Payment verification payload does not match the provider-confirmed attempt status',
        );
      }

      if (authoritative) {
        return authoritative;
      }

      return this.isPendingVerificationStatus(attempt.status)
        ? (attempt.status as PaymentAttemptStatus)
        : 'PROCESSING';
    }

    const normalized =
      requested ??
      authoritative ??
      this.normalizeStatusHint(this.asObject(attempt.responseSnapshot)?.mockReturnStatus);

    if (!normalized) {
      return attempt.status as PaymentAttemptStatus;
    }

    return normalized;
  }

  private mapAttemptStatusToOrderPaymentStatus(
    status: PaymentAttemptStatus,
  ): PaymentStatus {
    switch (status) {
      case 'PAID':
        return PaymentStatus.PAID;
      case 'FAILED':
      case 'CANCELLED':
      case 'EXPIRED':
        return PaymentStatus.FAILED;
      default:
        return PaymentStatus.PENDING;
    }
  }

  private resolveCallbackBaseUrl(callbackUrl?: string): string {
    const resolved =
      callbackUrl?.trim() ||
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL?.trim() ||
      'http://localhost:5173/checkout/payment-return';

    return resolved;
  }

  private buildMockReturnUrl(
    callbackBaseUrl: string,
    reference: string,
    gateway: string,
    status: string,
  ): string {
    const url = new URL(callbackBaseUrl);
    url.searchParams.set('reference', reference);
    url.searchParams.set('gateway', gateway);
    url.searchParams.set('status', status);
    url.searchParams.set('mode', 'mock');
    return url.toString();
  }

  private getProviderMode(): 'mock' | 'live' {
    return this.isMockMode() ? 'mock' : 'live';
  }

  private isMockMode(): boolean {
    return (process.env.PAYMENTS_MODE ?? 'mock').trim().toLowerCase() !== 'live';
  }

  private allowPaymentSimulation(): boolean {
    return (process.env.ALLOW_PAYMENT_SIMULATION ?? 'true').trim().toLowerCase() === 'true';
  }

  private resolveMockReturnStatus(paymentData: Record<string, any>): string {
    const hint = String(paymentData.mockScenario ?? paymentData.email ?? '').toLowerCase();
    if (hint.includes('fail')) return 'failed';
    if (hint.includes('cancel')) return 'cancelled';
    if (hint.includes('expire')) return 'expired';
    if (hint.includes('pending') || hint.includes('process')) return 'processing';
    return 'success';
  }

  private normalizeStatusHint(value: unknown): PaymentAttemptStatus | undefined {
    const normalized = String(value ?? '').trim().toLowerCase();
    switch (normalized) {
      case 'success':
      case 'paid':
        return 'PAID';
      case 'failed':
      case 'fail':
        return 'FAILED';
      case 'cancel':
      case 'cancelled':
        return 'CANCELLED';
      case 'expired':
      case 'expire':
        return 'EXPIRED';
      case 'processing':
      case 'pending':
        return 'PROCESSING';
      default:
        return undefined;
    }
  }

  private isTerminalStatus(status: PaymentAttemptStatus): boolean {
    return TERMINAL_ATTEMPT_STATUSES.has(status);
  }

  private isPendingVerificationStatus(status: string | null | undefined) {
    return ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'].includes(
      String(status ?? '').trim().toUpperCase(),
    );
  }

  private extractAttemptAuthoritativeStatus(
    attempt: NonNullable<PaymentAttemptRecord>,
  ): PaymentAttemptStatus | null {
    const snapshot = this.asObject(attempt.responseSnapshot);
    return (
      this.normalizeStatusHint(
        snapshot?.providerVerificationStatus ??
          snapshot?.providerWebhookStatus ??
          snapshot?.providerStatus ??
          snapshot?.status,
      ) ?? null
    );
  }

  private getProviderModeForAttempt(attempt: NonNullable<PaymentAttemptRecord>) {
    return String(attempt.providerMode || '').trim().toLowerCase() === 'live'
      ? 'live'
      : 'mock';
  }

  private buildVerificationUpdatePayload(
    attempt: NonNullable<PaymentAttemptRecord>,
    dto: VerifyPaymentDto,
    nextStatus: PaymentAttemptStatus,
    verifiedAt: Date,
    awaitingProviderConfirmation: boolean,
  ): AttemptStatusUpdatePayload {
    const responseSnapshotPatch = {
      providerVerificationGateway: dto.gateway,
      providerVerificationStatus: nextStatus,
      providerVerificationReference: dto.reference,
      verificationOtpProvided: Boolean(dto.otp),
      verifiedAt: verifiedAt.toISOString(),
      ...(awaitingProviderConfirmation
        ? {
            awaitingProviderConfirmation: true,
            recoveryAction: 'WAIT_FOR_PROVIDER_CONFIRMATION',
            recoveryMessage:
              'Payment is still awaiting provider callback or webhook confirmation. Recheck after returning from the gateway.',
          }
        : {
            awaitingProviderConfirmation: false,
            recoveryAction: null,
            recoveryMessage: null,
          }),
    };

    return {
      eventPayload: {
        gateway: dto.gateway,
        statusHint: dto.statusHint,
        awaitingProviderConfirmation,
      },
      responseSnapshotPatch: {
        ...(this.asObject(attempt.responseSnapshot) ?? {}),
        ...responseSnapshotPatch,
      },
    };
  }

  private verifyWebhookSignature(
    gateway: string,
    payload: Record<string, any>,
    context: WebhookContext,
  ) {
    if (this.isMockMode()) {
      return true;
    }

    if (gateway === 'PAYSTACK') {
      if (!this.isAllowedPaystackWebhookIp(context)) {
        return false;
      }
      const secret = String(process.env.PAYSTACK_SECRET_KEY ?? '').trim();
      const signature = this.getHeader(context.headers, 'x-paystack-signature');
      if (!secret || !signature || !context.rawBody) {
        return false;
      }

      const expected = createHmac('sha512', secret)
        .update(context.rawBody)
        .digest('hex');

      return this.safeCompare(signature, expected);
    }

    if (gateway === 'FLUTTERWAVE') {
      const secret = String(
        process.env.FLUTTERWAVE_WEBHOOK_SECRET_HASH ??
          process.env.FLUTTERWAVE_SECRET_HASH ??
          '',
      ).trim();
      const signature =
        this.getHeader(context.headers, 'verif-hash') ??
        this.getHeader(context.headers, 'x-flutterwave-signature');
      if (!secret || !signature) {
        return false;
      }

      return this.safeCompare(signature, secret);
    }

    this.logger.warn(`Webhook verification not configured for gateway ${gateway}`);
    return false;
  }

  private isAllowedPaystackWebhookIp(context: WebhookContext) {
    const disabled = String(
      process.env.PAYSTACK_WEBHOOK_IP_ALLOWLIST_DISABLED ?? '',
    )
      .trim()
      .toLowerCase();
    if (['1', 'true', 'yes'].includes(disabled)) {
      return true;
    }

    const configuredIps = String(process.env.PAYSTACK_WEBHOOK_IP_ALLOWLIST ?? '')
      .split(',')
      .map((value) => this.normalizeIp(value))
      .filter((value): value is string => Boolean(value));
    const allowlist = new Set<string>(
      configuredIps.length > 0 ? configuredIps : [...PAYSTACK_WEBHOOK_IPS],
    );
    const candidates = this.extractRequestIps(context);
    return candidates.some((candidate) => allowlist.has(candidate));
  }

  private extractRequestIps(context: WebhookContext) {
    const forwarded = this.getHeader(context.headers, 'x-forwarded-for');
    const forwardedIps = String(forwarded ?? '')
      .split(',')
      .map((value) => this.normalizeIp(value))
      .filter((value): value is string => Boolean(value));
    const directIp = this.normalizeIp(context.remoteAddress);
    return Array.from(new Set([...forwardedIps, ...(directIp ? [directIp] : [])]));
  }

  private normalizeIp(value: string | null | undefined) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return null;
    }
    if (normalized.startsWith('::ffff:')) {
      return normalized.slice(7);
    }
    return normalized;
  }

  private extractWebhookReference(gateway: string, payload: Record<string, any>) {
    if (gateway === 'PAYSTACK') {
      return String(payload?.data?.reference ?? '').trim() || null;
    }

    if (gateway === 'FLUTTERWAVE') {
      return (
        String(
          payload?.data?.tx_ref ?? payload?.data?.txRef ?? payload?.txRef ?? payload?.tx_ref ?? '',
        ).trim() || null
      );
    }

    return null;
  }

  private resolveWebhookStatus(
    gateway: string,
    payload: Record<string, any>,
  ): PaymentAttemptStatus | null {
    const rawStatus =
      gateway === 'PAYSTACK'
        ? payload?.data?.status ?? payload?.event
        : payload?.data?.status ?? payload?.status ?? payload?.event;

    return this.normalizeStatusHint(rawStatus) ?? null;
  }

  private extractWebhookAmount(gateway: string, payload: Record<string, any>) {
    const rawAmount =
      gateway === 'PAYSTACK'
        ? Number(payload?.data?.amount ?? 0) / 100
        : Number(payload?.data?.amount ?? payload?.amount ?? 0);

    return Number.isFinite(rawAmount) && rawAmount > 0
      ? this.roundMoney(rawAmount)
      : null;
  }

  private extractWebhookCurrency(payload: Record<string, any>) {
    const currency = String(payload?.data?.currency ?? payload?.currency ?? '')
      .trim()
      .toUpperCase();
    return currency || null;
  }

  private extractWebhookTransactionId(
    gateway: string,
    payload: Record<string, any>,
  ) {
    if (gateway === 'PAYSTACK') {
      const value = payload?.data?.id ?? payload?.data?.transaction_id;
      return value != null ? String(value).trim() || null : null;
    }

    if (gateway === 'FLUTTERWAVE') {
      const value = payload?.data?.id ?? payload?.id;
      return value != null ? String(value).trim() || null : null;
    }

    return null;
  }

  private extractWebhookChannel(payload: Record<string, any>) {
    const value = payload?.data?.channel ?? payload?.channel;
    return value != null ? String(value).trim().toUpperCase() || null : null;
  }

  private extractWebhookEvent(gateway: string, payload: Record<string, any>) {
    return String(
      gateway === 'PAYSTACK'
        ? payload?.event ?? payload?.data?.status ?? ''
        : payload?.event ?? payload?.type ?? payload?.data?.status ?? '',
    ).trim() || null;
  }

  private webhookAmountsMatch(
    attemptAmount: number,
    attemptCurrency: string,
    payloadAmount: number | null,
    payloadCurrency: string | null,
  ) {
    if (payloadCurrency && payloadCurrency !== String(attemptCurrency || '').trim().toUpperCase()) {
      return false;
    }

    if (payloadAmount == null) {
      return true;
    }

    return Math.abs(this.roundMoney(attemptAmount) - this.roundMoney(payloadAmount)) < 0.01;
  }

  private getHeader(
    headers: Record<string, string | string[] | undefined>,
    key: string,
  ) {
    const value = headers[key] ?? headers[key.toLowerCase()] ?? headers[key.toUpperCase()];
    if (Array.isArray(value)) {
      return value[0] ?? null;
    }
    return typeof value === 'string' ? value : null;
  }

  private safeCompare(left: string, right: string) {
    const leftBuffer = Buffer.from(String(left).trim());
    const rightBuffer = Buffer.from(String(right).trim());
    if (leftBuffer.length !== rightBuffer.length) {
      return false;
    }
    return timingSafeEqual(leftBuffer, rightBuffer);
  }

  private computeWebhookEventKey(
    gateway: string,
    payload: Record<string, any>,
    reference: string,
  ) {
    const event = this.extractWebhookEvent(gateway, payload);
    const transactionId = this.extractWebhookTransactionId(gateway, payload);
    const paidAt =
      payload?.data?.paid_at ??
      payload?.data?.created_at ??
      payload?.created_at ??
      payload?.data?.log?.time_spent;
    const parts = [gateway, event, reference, transactionId, paidAt]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean);
    return parts.length > 0 ? parts.join(':') : null;
  }

  private async markProviderEventProcessed(providerEventKey: string) {
    await this.prisma.paymentEvent.updateMany({
      where: { providerEventKey },
      data: { processedAt: new Date() },
    });
  }

  private async parseJsonResponse(response: Response) {
    try {
      return (await response.json()) as Record<string, any>;
    } catch {
      return null;
    }
  }

  private getRequiredEnv(name: string) {
    const value = String(process.env[name] ?? '').trim();
    if (!value) {
      throw new BadRequestException(`${name} is required for live payment processing`);
    }
    return value;
  }

  private async verifyPaystackAttempt(
    attempt: NonNullable<PaymentAttemptRecord>,
  ): Promise<{
    status: PaymentAttemptStatus;
    rawStatus: string;
    reference: string;
    transactionId: string | null;
    amount: number | null;
    currency: string | null;
    channel: string | null;
    paidAt: string | null;
    message: string | null;
  }> {
    const secret = this.getRequiredEnv('PAYSTACK_SECRET_KEY');
    const response = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(attempt.reference)}`,
      {
        headers: {
          Authorization: `Bearer ${secret}`,
          Accept: 'application/json',
        },
      },
    );

    const payload = await this.parseJsonResponse(response);
    if (!response.ok || payload?.status === false || !payload?.data) {
      throw new BadRequestException(
        String(payload?.message || 'Unable to verify Paystack payment'),
      );
    }

    const providerReference = String(payload.data.reference || attempt.reference).trim();
    if (providerReference !== attempt.reference) {
      throw new BadRequestException('Provider verification reference does not match the payment attempt');
    }

    const amount = Number(payload.data.amount ?? 0) / 100;
    const currency = String(payload.data.currency || '').trim().toUpperCase() || null;
    if (
      amount > 0 &&
      Math.abs(this.roundMoney(amount) - this.roundMoney(Number(attempt.amount ?? 0))) >= 0.01
    ) {
      throw new BadRequestException('Provider verification amount does not match the payment attempt');
    }

    if (currency && currency !== String(attempt.currency || '').trim().toUpperCase()) {
      throw new BadRequestException('Provider verification currency does not match the payment attempt');
    }

    const rawStatus = String(payload.data.status || '').trim().toLowerCase();
    const normalizedStatus =
      rawStatus === 'success'
        ? 'PAID'
        : rawStatus === 'failed'
          ? 'FAILED'
          : rawStatus === 'abandoned'
            ? 'CANCELLED'
            : ['pending', 'ongoing', 'processing', 'queued'].includes(rawStatus)
              ? 'PROCESSING'
              : this.normalizeStatusHint(rawStatus) ?? 'PROCESSING';

    return {
      status: normalizedStatus,
      rawStatus,
      reference: providerReference,
      transactionId:
        payload.data.id != null ? String(payload.data.id).trim() || null : null,
      amount: amount > 0 ? this.roundMoney(amount) : null,
      currency,
      channel:
        payload.data.channel != null
          ? String(payload.data.channel).trim().toUpperCase() || null
          : null,
      paidAt:
        payload.data.paid_at != null
          ? String(payload.data.paid_at).trim() || null
          : null,
      message: payload?.message != null ? String(payload.message) : null,
    };
  }

  private ensureSingleCurrency(currencies: string[]) {
    const normalized = Array.from(
      new Set(currencies.map((currency) => String(currency || '').trim().toUpperCase())),
    );

    if (normalized.length > 1) {
      throw new BadRequestException(
        'All orders in a single checkout must use the same currency',
      );
    }
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private asObject(value: unknown): Record<string, any> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : {};
  }

  private asOrderItems(value: unknown): Array<Record<string, any>> {
    return Array.isArray(value) ? (value as Array<Record<string, any>>) : [];
  }
}
