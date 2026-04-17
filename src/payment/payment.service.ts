import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'crypto';
import {
  CheckoutSessionLineStatus,
  CheckoutSessionLineType,
  CheckoutSessionStatus,
  CustomOrderCheckoutStatus,
  CustomOrderProgressStage,
  CustomOrderStatus,
  InventoryReservationStatus,
  NotificationType,
  PaymentMethod,
  PaymentStatus,
  PaymentSubjectType,
  Prisma,
  Role,
  SizingMode,
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
  CardValidationSessionSummary,
  InitializePaymentDto,
  InitializeUnifiedCheckoutDto,
  PaymentClientCheckoutPolicy,
  PaymentAttemptStatus,
  PaymentChannel,
  PaymentInitResult,
  PaymentAttemptSummary,
  PaymentNextAction,
  ReconcileStalePaymentsDto,
  ReconcileStalePaymentsResult,
  SavedPaymentCardSummary,
  PaymentVerifyResult,
  SimulatePaymentAttemptDto,
  ValidatePaymentCardDto,
  VerifyPaymentDto,
} from './payment.types';
import {
  describePaystackSecretEnvKeys,
  resolvePaystackSecret as resolvePaystackSecretFromEnv,
} from 'src/common/utils/paystack-secret';
import { resolveWebAppBaseUrl } from 'src/common/utils/web-app-url';
import {
  PAYMENT_UNIFIED_INIT_LOCK_TTL_MS,
  paymentUnifiedInitLockKey,
} from 'src/common/runtime/payment-runtime.keys';

type PaymentAttemptRecord = Awaited<ReturnType<PrismaService['paymentAttempt']['findUnique']>>;

type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody?: string;
  remoteAddress?: string | null;
  correlationId?: string | null;
};

type AttemptStatusUpdatePayload = {
  eventPayload?: Record<string, any>;
  responseSnapshotPatch?: Record<string, any>;
  providerReference?: string | null;
  providerTransactionId?: string | null;
  providerAccessCode?: string | null;
  providerChannel?: string | null;
  correlationId?: string | null;
};

type WebhookProcessSource =
  | 'QUEUE'
  | 'INLINE_FALLBACK'
  | 'INLINE_DIRECT'
  | 'CRON_REPROCESS';

type WebhookProcessContext = {
  source: WebhookProcessSource;
  correlationId?: string | null;
  queueAttempt?: number | null;
  queueJobId?: string | null;
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

type ExtractedPaystackCard = {
  brand: string | null;
  bank: string | null;
  last4: string;
  expMonth: string | null;
  expYear: string | null;
  reusable: boolean;
  authorizationCode: string | null;
  identityKey: string;
};

type PaymentGatewayContext = {
  buyerId?: string | null;
};

type PaystackCardholderNameMatchMode = 'strict' | 'soft' | 'off';

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

type StoredCardValidationSession = CardValidationSessionSummary & {
  paymentMethod: PaymentMethod;
  paymentDataFingerprint: string;
  storage: 'canonical' | 'idempotency';
};

type CardValidationSessionBinding = {
  sessionId: string;
  savedPaymentMethodId: string | null;
  canonicalSessionId: string | null;
  storage: 'canonical' | 'idempotency';
};

type UnifiedCheckoutStandardLineDraft = {
  cartItemId: string;
  brandId: string;
  productId: string;
  productName: string;
  thumbnail: string | null;
  quantity: number;
  selectedSize: string | null;
  selectedColor: string | null;
  currency: string;
  unitPrice: number;
  lineTotal: number;
  sizingMode: string;
  requiredMeasurementKeys: string[];
  sizeFitData: Record<string, any> | null;
  variantId: string | null;
  reserveInventory: boolean;
  sourceProduct: {
    id: string;
    trackInventory: boolean;
    allowBackorders: boolean;
    totalStock: number;
    sizeStock: Record<string, number> | null;
    sizes: string[];
    colors: string[];
  };
};

type UnifiedCheckoutCustomLineDraft = {
  sessionId: string;
  checkoutIntentId: string;
  sourceTitle: string;
  sourceType: string;
  sourceId: string;
  sourcePrimaryMediaUrl: string | null;
  sourceBrandName: string | null;
  currency: string;
  lineTotal: number;
  unitPrice: number;
};

type UnifiedCheckoutBlockedCustomLine = {
  type: 'CUSTOM_ORDER';
  sessionId: string;
  checkoutIntentId: string;
  sourceTitle: string;
  reason: string;
};

type UnifiedCheckoutFinalizeResult = {
  checkoutSessionId: string;
  orderIds: string[];
  customOrderIds: string[];
  summary: {
    currency: string;
    items: Array<{ name: string; quantity: number; price: number }>;
    subtotal: number;
    shippingCost: number;
    discount: number;
    grandTotal: number;
    shippingName: string;
    shippingCity: string;
    shippingState: string;
  };
};

const CARD_VALIDATION_SESSION_METHOD = 'POST';
const CARD_VALIDATION_SESSION_PATH = '/payment/cards/validate';
const CARD_VALIDATION_SESSION_KEY_PREFIX = 'payment:card-validation:';
const DEFAULT_CARD_VALIDATION_TTL_MINUTES = 20;
const PAYMENT_SAVED_METHODS_FLAG = 'PAYMENT_CANONICAL_SAVED_METHODS_ENABLED';
const PAYMENT_SAVED_METHODS_CANARY_PERCENT =
  'PAYMENT_CANONICAL_SAVED_METHODS_CANARY_PERCENT';
const PAYMENT_VALIDATION_GATE_FLAG = 'PAYMENT_VALIDATION_GATE_ENABLED';
const PAYMENT_SAVED_METHODS_BACKFILL_FLAG =
  'PAYMENT_CANONICAL_SAVED_METHODS_BACKFILL_ENABLED';
const PAYMENT_SAVED_METHODS_BACKFILL_LEGACY_FLAG =
  'PAYMENT_CANONICAL_SAVED_METHODS_BACKFILL_ON_READ';
const PAYMENT_SAVED_METHODS_SECRET = 'PAYMENT_SAVED_METHODS_SECRET';

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

const ACTIVE_UNIFIED_ATTEMPT_STATUSES: PaymentAttemptStatus[] = [
  'PENDING',
  'REQUIRES_ACTION',
  'PROCESSING',
];

const CHECKOUT_SHIPPING_RATES: Record<string, number> = {
  LAGOS: 2500,
  ABUJA: 3500,
  FCT: 3500,
  'PORT HARCOURT': 3500,
  RIVERS: 3500,
};

const CHECKOUT_DEFAULT_SHIPPING_RATE = 4000;

@Injectable()
export class PaymentService implements OnModuleInit {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly fxRateService: FxRateService,
    private readonly standardOrderFinanceSyncService: StandardOrderFinanceSyncService,
    private readonly notificationsService: NotificationsService,
    private readonly webhookEventsQueue: WebhookEventsQueueService,
  ) {}

  onModuleInit(): void {
    const runtimeEnv = String(process.env.NODE_ENV ?? '').trim().toLowerCase();
    const isProduction = runtimeEnv === 'production';

    if (!isProduction) {
      return;
    }

    if (this.isMockMode()) {
      throw new Error('PAYMENTS_MODE must be set to "live" in production.');
    }

    if (this.isLegacyPaystackWebhookAliasEnabled()) {
      throw new Error(
        'PAYMENT_LEGACY_PAYSTACK_WEBHOOK_ALIASES_ENABLED must be false in production.',
      );
    }

    if (this.isLegacyFlutterwaveWebhookAliasEnabled()) {
      throw new Error(
        'PAYMENT_LEGACY_FLUTTERWAVE_WEBHOOK_ALIAS_ENABLED must be false in production.',
      );
    }

    if (!this.resolvePaystackSecret()) {
      throw new Error(
        `A Paystack secret is required in production. Configure one of: ${describePaystackSecretEnvKeys()}`,
      );
    }

    if (!this.hasRedisRuntimeConfiguration()) {
      throw new Error(
        'Redis configuration is required in production for payment queues and reconciliation (set REDIS_URL or REDIS_HOST/REDIS_PORT).',
      );
    }

    this.assertProductionCheckoutCallbackConfiguration();
  }

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

    const gatewayPaymentData = this.preparePaymentGatewayRequest(
      dto.paymentMethod,
      dto.paymentData,
    );
    const paymentData = this.sanitizePaymentDataForStorage(
      dto.paymentMethod,
      gatewayPaymentData,
    );
    const amount = orders.reduce(
      (sum, order) => sum + Number(order.totalAmount ?? 0),
      0,
    );
    const currency = orders[0].currency;
    const callbackBaseUrl = this.resolveCallbackBaseUrl(dto.callbackUrl);
    const providerMode = this.getProviderMode();
    const idempotentAttempt = dto.idempotencyKey
      ? await this.prisma.paymentAttempt.findFirst({
          where: {
            buyerId: userId,
            subjectType: PaymentSubjectType.STANDARD_ORDER,
            idempotencyKey: dto.idempotencyKey,
          },
          orderBy: { createdAt: 'desc' },
        })
      : null;
    let existingAttempt =
      idempotentAttempt ??
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

    if (
      existingAttempt &&
      !idempotentAttempt &&
      !this.canReusePendingAttempt(existingAttempt.requestSnapshot, paymentData)
    ) {
      existingAttempt = null;
    }

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

    const validatedCardSession = await this.resolveCardValidationSessionForInitialize({
      paymentMethod: dto.paymentMethod,
      validationSessionId: dto.validationSessionId,
      userId,
      gatewayPaymentData,
      sanitizedPaymentData: paymentData,
    });

    const settlementQuote = await this.fxRateService.quoteAndPersist({
      from: currency,
      amount,
      actorId: userId,
    });
    const reference = `TH-${Date.now()}-${uuidv4().slice(0, 8)}`;

    const gatewayResult = await this.initializeGateway(
      dto.paymentMethod,
      reference,
      gatewayPaymentData,
      amount,
      currency,
      callbackBaseUrl,
      { buyerId: userId },
    );

    const canonicalSavedPaymentMethodId =
      validatedCardSession?.savedPaymentMethodId ?? null;
    const canonicalCardValidationSessionId = validatedCardSession?.canonicalSessionId ?? null;

    const attempt = await this.prisma.$transaction(async (tx) => {
      await this.consumeCardValidationSessionForInitialize(
        tx,
        userId,
        validatedCardSession,
      );

      const createdAttempt = await tx.paymentAttempt.create({
        data: {
          buyerId: userId,
          savedPaymentMethodId: canonicalSavedPaymentMethodId,
          cardValidationSessionId: canonicalCardValidationSessionId,
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

  async initializeUnifiedCheckout(
    dto: InitializeUnifiedCheckoutDto,
    userId: string,
    requestCorrelationId?: string | null,
  ): Promise<PaymentInitResult> {
    const customerName = String(dto.customerName ?? '').trim();
    if (!customerName) {
      throw new BadRequestException('Customer name is required');
    }

    const shippingAddress = this.asObject(dto.shippingAddress);
    const contactInfo = this.asObject(dto.contactInfo);
    const shippingState = String(shippingAddress.state ?? '').trim();
    if (!shippingState) {
      throw new BadRequestException('Shipping state is required');
    }

    const paymentRequestData = {
      ...(dto.paymentData ?? {}),
      email: dto.email,
    };
    const gatewayPaymentData = this.preparePaymentGatewayRequest(
      dto.paymentMethod,
      paymentRequestData,
    );
    const paymentData = this.preparePaymentRequest(
      dto.paymentMethod,
      paymentRequestData,
    );

    const callbackBaseUrl = this.resolveCallbackBaseUrl(dto.callbackUrl);
    const idempotencyKey = String(dto.idempotencyKey ?? '').trim();
    if (!idempotencyKey) {
      throw new BadRequestException(
        'Idempotency key is required for unified checkout initialization',
      );
    }
    const correlationId = this.resolveCorrelationId(
      requestCorrelationId ?? dto.correlationId ?? idempotencyKey,
      'unified-checkout',
    );
    const providerMode = this.getProviderMode();

    return this.withUnifiedCheckoutInitializationLock(
      userId,
      correlationId,
      async () => {
        const now = new Date();

        const existingSession = await this.prisma.checkoutSession.findFirst({
          where: {
            buyerId: userId,
            idempotencyKey,
          },
          include: {
            paymentAttempt: true,
          },
          orderBy: { createdAt: 'desc' },
        });

    if (existingSession?.paymentAttempt) {
      let existingAttempt = existingSession.paymentAttempt;
      if (
        ACTIVE_UNIFIED_ATTEMPT_STATUSES.includes(
          existingAttempt.status as PaymentAttemptStatus,
        ) &&
        existingAttempt.expiresAt &&
        existingAttempt.expiresAt <= now
      ) {
        existingAttempt = await this.applyAttemptStatus(
          existingAttempt.reference,
          userId,
          'EXPIRED',
          'verify',
          {
            eventPayload: {
              reason: 'UNIFIED_ATTEMPT_REUSED_AFTER_EXPIRY',
            },
            responseSnapshotPatch: {
              expiredAt: new Date().toISOString(),
            },
          },
        );
      }

      this.logger.log(
        `Unified checkout replayed existing idempotent session ${existingSession.id} for ${existingAttempt.reference} (corr=${correlationId})`,
      );

      return {
        ...this.buildInitResultFromAttempt(existingAttempt),
        checkoutSessionId: existingSession.id,
        summary: this.asObject(existingSession.summaryJson) as PaymentInitResult['summary'],
        blockedLines:
          (this.asObject(existingSession.blockedLinesJson).items as PaymentInitResult['blockedLines']) ??
          [],
      };
    }

    const activeSession = await this.prisma.checkoutSession.findFirst({
      where: {
        buyerId: userId,
        status: {
          in: [
            CheckoutSessionStatus.PENDING_PAYMENT,
            CheckoutSessionStatus.PAYMENT_PROCESSING,
          ],
        },
      },
      include: {
        paymentAttempt: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    if (activeSession?.paymentAttempt) {
      let activeAttempt = activeSession.paymentAttempt;
      const isActiveStatus = ACTIVE_UNIFIED_ATTEMPT_STATUSES.includes(
        activeAttempt.status as PaymentAttemptStatus,
      );

      if (isActiveStatus) {
        if (activeAttempt.expiresAt && activeAttempt.expiresAt <= now) {
          activeAttempt = await this.applyAttemptStatus(
            activeAttempt.reference,
            userId,
            'EXPIRED',
            'verify',
            {
              eventPayload: {
                reason: 'UNIFIED_ATTEMPT_REUSED_AFTER_EXPIRY',
              },
              responseSnapshotPatch: {
                expiredAt: new Date().toISOString(),
              },
            },
          );
        } else {
          this.logger.log(
            `Unified checkout reused active session ${activeSession.id} for ${activeAttempt.reference} (corr=${correlationId})`,
          );

          return {
            ...this.buildInitResultFromAttempt(activeAttempt),
            checkoutSessionId: activeSession.id,
            summary: this.asObject(activeSession.summaryJson) as PaymentInitResult['summary'],
            blockedLines:
              (this.asObject(activeSession.blockedLinesJson)
                .items as PaymentInitResult['blockedLines']) ??
              [],
          };
        }
      }
    }

    const [standardLineDrafts, customLineResult] = await Promise.all([
      this.loadUnifiedStandardLineDrafts(userId),
      this.loadUnifiedCustomLineDrafts(userId),
    ]);

    const customLineDrafts = customLineResult.lines;
    const blockedCustomLines = customLineResult.blocked;

    if (standardLineDrafts.length === 0 && customLineDrafts.length === 0) {
      throw new BadRequestException(
        blockedCustomLines.length > 0
          ? 'No payable lines are ready. Re-lock expired custom lines before retrying checkout.'
          : 'Your bag is empty. Add at least one item before checkout.',
      );
    }

    const currencies = [
      ...standardLineDrafts.map((line) => line.currency),
      ...customLineDrafts.map((line) => line.currency),
    ];
    this.ensureSingleCurrency(currencies);
    const currency = String(currencies[0] ?? 'NGN').trim().toUpperCase();

    const standardSubtotal = this.roundMoney(
      standardLineDrafts.reduce((sum, line) => sum + line.lineTotal, 0),
    );
    const customSubtotal = this.roundMoney(
      customLineDrafts.reduce((sum, line) => sum + line.lineTotal, 0),
    );
    const distinctStandardBrands = new Set(
      standardLineDrafts.map((line) => line.brandId),
    ).size;
    const shippingCost =
      distinctStandardBrands > 0
        ? this.roundMoney(
            this.resolveShippingCostForState(shippingState) * distinctStandardBrands,
          )
        : 0;
    const discountAmount = 0;
    const subtotal = this.roundMoney(standardSubtotal + customSubtotal);
    const grandTotal = this.roundMoney(subtotal + shippingCost - discountAmount);

    const validatedCardSession = await this.resolveCardValidationSessionForInitialize({
      paymentMethod: dto.paymentMethod,
      validationSessionId: dto.validationSessionId,
      userId,
      gatewayPaymentData,
      sanitizedPaymentData: paymentData,
    });

    const settlementQuote = await this.fxRateService.quoteAndPersist({
      from: currency,
      amount: grandTotal,
      actorId: userId,
    });
    const reference = `TH-UC-${Date.now()}-${uuidv4().slice(0, 8)}`;
    const gatewayResult = await this.initializeGateway(
      dto.paymentMethod,
      reference,
      gatewayPaymentData,
      grandTotal,
      currency,
      callbackBaseUrl,
      { buyerId: userId },
    );
    const attemptExpiresAt = gatewayResult.expiresAt
      ? new Date(gatewayResult.expiresAt)
      : new Date(Date.now() + 30 * 60 * 1000);

    const created = await this.prisma.$transaction(async (tx) => {
      await this.consumeCardValidationSessionForInitialize(
        tx,
        userId,
        validatedCardSession,
      );

      const checkoutSession = await tx.checkoutSession.create({
        data: {
          buyerId: userId,
          status: CheckoutSessionStatus.PAYMENT_PROCESSING,
          idempotencyKey,
          paymentMethod: dto.paymentMethod,
          shippingAddressJson: shippingAddress as Prisma.InputJsonValue,
          contactInfoJson: contactInfo as Prisma.InputJsonValue,
          customerName,
          currency,
          subtotal: new Prisma.Decimal(subtotal.toFixed(2)),
          shippingCost: new Prisma.Decimal(shippingCost.toFixed(2)),
          discountAmount: new Prisma.Decimal(discountAmount.toFixed(2)),
          grandTotal: new Prisma.Decimal(grandTotal.toFixed(2)),
          summaryJson: {
            items: [
              ...standardLineDrafts.map((line) => ({
                name: line.productName,
                quantity: line.quantity,
                price: line.unitPrice,
              })),
              ...customLineDrafts.map((line) => ({
                name: `${line.sourceTitle} (Custom)`,
                quantity: 1,
                price: line.unitPrice,
              })),
            ],
            subtotal,
            shippingCost,
            discount: discountAmount,
            grandTotal,
            shippingName: customerName,
            shippingCity: String(shippingAddress.city ?? ''),
            shippingState,
          } as Prisma.InputJsonValue,
          blockedLinesJson: {
            items: blockedCustomLines,
          } as Prisma.InputJsonValue,
          expiresAt: attemptExpiresAt,
        },
      });

      for (let index = 0; index < standardLineDrafts.length; index += 1) {
        const line = standardLineDrafts[index];
        const createdLine = await tx.checkoutSessionLine.create({
          data: {
            checkoutSessionId: checkoutSession.id,
            lineType: CheckoutSessionLineType.STANDARD_ITEM,
            status: line.reserveInventory
              ? CheckoutSessionLineStatus.RESERVED
              : CheckoutSessionLineStatus.PENDING,
            lineOrder: index,
            brandId: line.brandId,
            productId: line.productId,
            cartItemId: line.cartItemId,
            quantity: line.quantity,
            unitPrice: new Prisma.Decimal(line.unitPrice.toFixed(2)),
            lineTotal: new Prisma.Decimal(line.lineTotal.toFixed(2)),
            currency: line.currency,
            selectedSize: line.selectedSize,
            selectedColor: line.selectedColor,
            itemSnapshotJson: {
              name: line.productName,
              thumbnail: line.thumbnail,
              sizingMode: line.sizingMode,
              requiredMeasurementKeys: line.requiredMeasurementKeys,
              sizeFitData: line.sizeFitData,
            } as Prisma.InputJsonValue,
          },
        });

        await this.reserveUnifiedStandardLineInventory(
          tx,
          checkoutSession.id,
          createdLine.id,
          line,
          attemptExpiresAt,
        );
      }

      for (let index = 0; index < customLineDrafts.length; index += 1) {
        const line = customLineDrafts[index];
        await tx.checkoutSessionLine.create({
          data: {
            checkoutSessionId: checkoutSession.id,
            lineType: CheckoutSessionLineType.CUSTOM_ORDER,
            status: CheckoutSessionLineStatus.PENDING,
            lineOrder: standardLineDrafts.length + index,
            checkoutIntentId: line.checkoutIntentId,
            quantity: 1,
            unitPrice: new Prisma.Decimal(line.unitPrice.toFixed(2)),
            lineTotal: new Prisma.Decimal(line.lineTotal.toFixed(2)),
            currency: line.currency,
            itemSnapshotJson: {
              sourceType: line.sourceType,
              sourceId: line.sourceId,
              sourceTitle: line.sourceTitle,
              sourcePrimaryMediaUrl: line.sourcePrimaryMediaUrl,
              sourceBrandName: line.sourceBrandName,
            } as Prisma.InputJsonValue,
            metadataJson: {
              sessionId: line.sessionId,
            } as Prisma.InputJsonValue,
          },
        });
      }

      const createdAttempt = await tx.paymentAttempt.create({
        data: {
          buyerId: userId,
          subjectType: PaymentSubjectType.UNIFIED_CHECKOUT,
          correlationId,
          checkoutSessionId: checkoutSession.id,
          savedPaymentMethodId: validatedCardSession?.savedPaymentMethodId ?? null,
          cardValidationSessionId: validatedCardSession?.canonicalSessionId ?? null,
          provider: gatewayResult.gateway,
          providerMode,
          providerReference: gatewayResult.providerReference,
          providerTransactionId: gatewayResult.providerTransactionId,
          providerAccessCode: gatewayResult.providerAccessCode,
          providerChannel: gatewayResult.providerChannel ?? gatewayResult.channel,
          paymentMethod: dto.paymentMethod,
          channel: gatewayResult.channel,
          status: gatewayResult.status,
          reference,
          idempotencyKey,
          callbackUrl: gatewayResult.callbackUrl ?? callbackBaseUrl,
          authorizationUrl: gatewayResult.authorizationUrl,
          amount: grandTotal,
          currency,
          settlementCurrency: this.fxRateService.getBaseCurrency(),
          settlementAmount: settlementQuote.convertedAmount,
          exchangeRateSnapshotId: settlementQuote.snapshot.id,
          orderIds: [],
          unifiedCheckoutManifestJson: {
            standardLineCount: standardLineDrafts.length,
            customLineCount: customLineDrafts.length,
            blockedLines: blockedCustomLines,
          } as Prisma.InputJsonValue,
          requestSnapshot: paymentData as Prisma.InputJsonValue,
          responseSnapshot:
            (gatewayResult.responseSnapshot ?? null) as unknown as Prisma.InputJsonValue,
          nextAction: (gatewayResult.nextAction ?? null) as unknown as Prisma.InputJsonValue,
          bankAccount: (gatewayResult.bankAccount ?? null) as unknown as Prisma.InputJsonValue,
          expiresAt: gatewayResult.expiresAt ? new Date(gatewayResult.expiresAt) : null,
        },
      });

      if (customLineDrafts.length > 0) {
        await tx.customOrderCheckoutSession.updateMany({
          where: {
            buyerId: userId,
            customOrderId: null,
            checkoutIntentId: {
              in: customLineDrafts.map((line) => line.checkoutIntentId),
            },
          },
          data: {
            status: CustomOrderCheckoutStatus.PAYMENT_INITIATED,
            paymentInitiatedAt: new Date(),
            lastAttemptId: createdAttempt.id,
            lastAttemptReference: createdAttempt.reference,
            lastAttemptStatus: createdAttempt.status,
            attemptsCount: { increment: 1 },
            resumePath: this.buildPaymentReturnPath(
              createdAttempt.reference,
              gatewayResult.gateway,
            ),
            abandonedAt: null,
          },
        });
      }

      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: createdAttempt.id,
          type: 'INITIALIZED',
          source: providerMode === 'mock' ? 'mock-initialize' : 'initialize',
          correlationId,
          payload: {
            paymentMethod: dto.paymentMethod,
            gateway: gatewayResult.gateway,
            channel: gatewayResult.channel,
            status: gatewayResult.status,
            subjectType: PaymentSubjectType.UNIFIED_CHECKOUT,
            checkoutSessionId: checkoutSession.id,
            correlationId,
          },
        },
      });

      return {
        attempt: createdAttempt,
        checkoutSession,
      };
    });

        return {
          ...this.buildInitResultFromAttempt(created.attempt),
          checkoutSessionId: created.checkoutSession.id,
          summary: this.asObject(created.checkoutSession.summaryJson) as PaymentInitResult['summary'],
          blockedLines: blockedCustomLines,
        };
      },
    );
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

  async listSavedPaymentCards(userId: string): Promise<SavedPaymentCardSummary[]> {
    if (this.isCanonicalSavedMethodsEnabledForUser(userId)) {
      const canonicalCards = await this.listCanonicalSavedPaymentCards(userId);
      if (canonicalCards.length > 0) {
        return canonicalCards;
      }

      if (this.isSavedPaymentMethodBackfillEnabled()) {
        await this.backfillSavedPaymentMethodsFromAttempts(userId);
        return this.listCanonicalSavedPaymentCards(userId);
      }
    }

    return this.listSavedPaymentCardsFromAttemptHistory(userId);
  }

  private async listSavedPaymentCardsFromAttemptHistory(
    userId: string,
  ): Promise<SavedPaymentCardSummary[]> {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        buyerId: userId,
        provider: 'PAYSTACK',
        status: 'PAID',
      },
      select: {
        id: true,
        reference: true,
        channel: true,
        providerChannel: true,
        requestSnapshot: true,
        responseSnapshot: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 120,
    });

    if (attempts.length === 0) {
      return [];
    }

    const attemptIds = attempts.map((attempt) => attempt.id);
    const events = await this.prisma.paymentEvent.findMany({
      where: {
        paymentAttemptId: { in: attemptIds },
        source: 'webhook',
      },
      select: {
        paymentAttemptId: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 400,
    });

    const webhookPayloadByAttemptId = new Map<string, Record<string, any>>();
    for (const event of events) {
      if (webhookPayloadByAttemptId.has(event.paymentAttemptId)) {
        continue;
      }
      const payload = this.asObject(event.payload);
      if (payload) {
        webhookPayloadByAttemptId.set(event.paymentAttemptId, payload);
      }
    }

    const summariesByIdentity = new Map<string, SavedPaymentCardSummary>();
    for (const attempt of attempts) {
      const requestSnapshot = this.asObject(attempt.requestSnapshot);
      const responseSnapshot = this.asObject(attempt.responseSnapshot);
      if (requestSnapshot?.saveNewCard === false) {
        continue;
      }
      const channelCandidates = [
        attempt.channel,
        attempt.providerChannel,
        responseSnapshot?.providerVerificationChannel,
        responseSnapshot?.providerWebhookChannel,
        requestSnapshot?.channel,
      ];
      const isCardAttempt = channelCandidates.some(
        (value) => String(value ?? '').trim().toUpperCase() === 'CARD',
      );
      if (!isCardAttempt) {
        continue;
      }

      const extracted = this.extractSavedPaystackCard(
        responseSnapshot,
        webhookPayloadByAttemptId.get(attempt.id) ?? null,
      );
      if (!extracted) {
        continue;
      }

      const existing = summariesByIdentity.get(extracted.identityKey);
      const addedAt = attempt.createdAt.toISOString();
      const lastUsedAt = attempt.updatedAt.toISOString();

      if (!existing) {
        summariesByIdentity.set(extracted.identityKey, {
          id: `paystack-${attempt.id}`,
          gateway: 'PAYSTACK',
          brand: extracted.brand,
          bank: extracted.bank,
          last4: extracted.last4,
          expMonth: extracted.expMonth,
          expYear: extracted.expYear,
          reusable: extracted.reusable,
          addedAt,
          lastUsedAt,
        });
        continue;
      }

      summariesByIdentity.set(extracted.identityKey, {
        ...existing,
        brand: existing.brand || extracted.brand,
        bank: existing.bank || extracted.bank,
        expMonth: existing.expMonth || extracted.expMonth,
        expYear: existing.expYear || extracted.expYear,
        reusable: existing.reusable || extracted.reusable,
        addedAt: existing.addedAt < addedAt ? existing.addedAt : addedAt,
        lastUsedAt: existing.lastUsedAt > lastUsedAt ? existing.lastUsedAt : lastUsedAt,
      });
    }

    return Array.from(summariesByIdentity.values()).sort((a, b) =>
      a.lastUsedAt < b.lastUsedAt ? 1 : -1,
    );
  }

  async validatePaymentCardSelection(
    dto: ValidatePaymentCardDto,
    userId: string,
  ): Promise<CardValidationSessionSummary> {
    if (dto.paymentMethod !== PaymentMethod.PAYSTACK) {
      throw new BadRequestException(
        'Card validation sessions are currently supported for Paystack only',
      );
    }

    const gatewayPaymentData = this.preparePaymentGatewayRequest(
      dto.paymentMethod,
      dto.paymentData,
    );
    const channel = String(gatewayPaymentData.channel ?? '').trim().toUpperCase();
    if (channel !== 'CARD') {
      throw new BadRequestException(
        'Only card checkouts require validation sessions',
      );
    }

    const useSavedCard = Boolean(gatewayPaymentData.useSavedCard);
    let savedCardId: string | null = null;
    let savedPaymentMethodId: string | null = null;
    let cardSummary: CardValidationSessionSummary['cardSummary'];

    if (useSavedCard) {
      savedCardId = String(gatewayPaymentData.savedCardId ?? '').trim();
      if (!savedCardId) {
        throw new BadRequestException('Select a saved card before validating');
      }

      // Ensures the selected card is still reusable and belongs to this user.
      await this.resolveSavedPaystackAuthorizationCode(userId, savedCardId);
      const savedCards = await this.listSavedPaymentCards(userId);
      const selectedCard = savedCards.find((card) => card.id === savedCardId);
      if (!selectedCard) {
        throw new BadRequestException('The selected saved card is no longer available');
      }
      savedPaymentMethodId = await this.resolveCanonicalSavedPaymentMethodId(
        userId,
        savedCardId,
      );

      cardSummary = {
        source: 'saved',
        brand: selectedCard.brand,
        bank: selectedCard.bank,
        last4: selectedCard.last4,
        expMonth: selectedCard.expMonth,
        expYear: selectedCard.expYear,
        holderName: null,
      };
    } else {
      if (!this.hasRawPaystackCardDetails(gatewayPaymentData)) {
        throw new BadRequestException(
          'Enter your new card details before continuing',
        );
      }

      this.validatePaystackCardDraft(gatewayPaymentData);
      const draft = this.getNormalizedPaystackCardDraft(gatewayPaymentData);
      cardSummary = {
        source: 'new',
        brand: null,
        bank: null,
        last4: draft.last4,
        expMonth: draft.expiryMonth || null,
        expYear: draft.expiryYear || null,
        holderName: draft.cardHolderName || null,
      };
    }

    const sanitizedPaymentData = this.sanitizePaymentDataForStorage(
      dto.paymentMethod,
      gatewayPaymentData,
    );

    return this.createCardValidationSession({
      userId,
      paymentMethod: dto.paymentMethod,
      sanitizedPaymentData,
      useSavedCard,
      savedPaymentMethodId,
      savedCardId,
      email: String(gatewayPaymentData.email ?? '').trim(),
      cardSummary,
    });
  }

  async getPaymentCardValidationSession(
    sessionId: string,
    userId: string,
  ): Promise<CardValidationSessionSummary> {
    const storedSession = await this.getStoredCardValidationSession(sessionId, userId);
    if (!storedSession) {
      throw new NotFoundException('Card validation session not found');
    }

    if (new Date(storedSession.expiresAt).getTime() <= Date.now()) {
      return {
        ...storedSession,
        status: 'EXPIRED',
      };
    }

    return storedSession;
  }

  getClientCheckoutPolicy(userId: string): PaymentClientCheckoutPolicy {
    return {
      paystack: {
        customCardEntryEnabled: this.isPaystackCustomCardEntryEnabled(),
        cardholderNameMatchMode: this.resolvePaystackCardholderNameMatchMode(),
        validationSessionRequired: this.isValidationGateEnabledForUser(userId),
      },
      savedMethods: {
        canonicalEnabled: this.isCanonicalSavedMethodsEnabledForUser(userId),
      },
    };
  }

  async removeSavedPaymentCard(savedCardId: string, userId: string) {
    if (!this.isCanonicalSavedMethodsEnabledForUser(userId)) {
      throw new BadRequestException(
        'Saved card management is not enabled yet for this environment.',
      );
    }

    const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
    if (!savedPaymentMethodModel) {
      throw new InternalServerErrorException(
        'Saved payment method storage is unavailable on this deployment.',
      );
    }

    const normalizedId = this.normalizeSavedCardIdentifier(savedCardId);
    const existing = await savedPaymentMethodModel.findFirst({
      where: {
        id: normalizedId,
        buyerId: userId,
        status: 'ACTIVE',
      },
    });

    if (!existing) {
      throw new NotFoundException('Saved card not found');
    }

    await this.prisma.$transaction(async (tx) => {
      const model = (tx as any)['savedPaymentMethod'];
      await model.update({
        where: { id: normalizedId },
        data: {
          status: 'DISABLED',
          isDefault: false,
        },
      });

      if (existing.isDefault) {
        const replacement = await model.findFirst({
          where: {
            buyerId: userId,
            status: 'ACTIVE',
            id: { not: normalizedId },
          },
          orderBy: [{ lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
        });

        if (replacement) {
          await model.update({
            where: { id: replacement.id },
            data: { isDefault: true },
          });
        }
      }
    });

    return {
      success: true,
      method: this.mapSavedPaymentMethodToSummary(existing),
    };
  }

  async setDefaultSavedPaymentCard(savedCardId: string, userId: string) {
    if (!this.isCanonicalSavedMethodsEnabledForUser(userId)) {
      throw new BadRequestException(
        'Saved card management is not enabled yet for this environment.',
      );
    }

    const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
    if (!savedPaymentMethodModel) {
      throw new InternalServerErrorException(
        'Saved payment method storage is unavailable on this deployment.',
      );
    }

    const normalizedId = this.normalizeSavedCardIdentifier(savedCardId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const model = (tx as any)['savedPaymentMethod'];
      const existing = await model.findFirst({
        where: {
          id: normalizedId,
          buyerId: userId,
          status: 'ACTIVE',
        },
      });

      if (!existing) {
        throw new NotFoundException('Saved card not found');
      }

      await model.updateMany({
        where: {
          buyerId: userId,
          status: 'ACTIVE',
          isDefault: true,
          id: { not: normalizedId },
        },
        data: {
          isDefault: false,
        },
      });

      return model.update({
        where: { id: normalizedId },
        data: {
          isDefault: true,
          lastUsedAt: new Date(),
        },
      });
    });

    return {
      success: true,
      method: this.mapSavedPaymentMethodToSummary(updated),
    };
  }

  async reconcileStalePaymentAttempts(
    dto: ReconcileStalePaymentsDto,
    _actorUserId: string,
  ): Promise<ReconcileStalePaymentsResult> {
    const olderThanMinutes = dto.olderThanMinutes ?? 30;
    const limit = dto.limit ?? 60;
    const cutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000);

    const staleAttempts = await this.prisma.paymentAttempt.findMany({
      where: {
        subjectType: {
          in: [
            PaymentSubjectType.STANDARD_ORDER,
            PaymentSubjectType.UNIFIED_CHECKOUT,
          ],
        },
        providerMode: 'live',
        status: { in: ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'] },
        updatedAt: { lt: cutoff },
      },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });

    const result: ReconcileStalePaymentsResult = {
      scanned: staleAttempts.length,
      updated: 0,
      skipped: [],
      reconciled: [],
      failed: [],
    };

    const now = new Date();

    for (const attempt of staleAttempts) {
      const gateway = String(attempt.provider || '').trim().toUpperCase();
      if (gateway !== 'PAYSTACK') {
        result.skipped.push(`${attempt.reference}:unsupported-gateway`);
        continue;
      }

      try {
        if (attempt.expiresAt && attempt.expiresAt <= now) {
          const expired = await this.applyAttemptStatus(
            attempt.reference,
            '',
            'EXPIRED',
            'reconcile',
            {
              eventPayload: {
                reason: 'STALE_ATTEMPT_EXPIRED_RECONCILIATION',
              },
              responseSnapshotPatch: {
                ...(this.asObject(attempt.responseSnapshot) ?? {}),
                staleReconciledAt: new Date().toISOString(),
                staleReconcileReason: 'EXPIRED_BEFORE_PROVIDER_CONFIRMATION',
              },
            },
          );

          result.updated += 1;
          result.reconciled.push(
            `${expired.reference}:${attempt.status}->${expired.status}`,
          );
          continue;
        }

        const verification = await this.resolveAttemptVerification(attempt, {
          reference: attempt.reference,
          gateway: gateway,
        });

        if (
          verification.nextStatus === (attempt.status as PaymentAttemptStatus) &&
          verification.awaitingProviderConfirmation
        ) {
          result.skipped.push(`${attempt.reference}:awaiting-provider-confirmation`);
          continue;
        }

        const reconciled = await this.applyAttemptStatus(
          attempt.reference,
          '',
          verification.nextStatus,
          'reconcile',
          {
            ...verification,
            eventPayload: {
              ...(verification.eventPayload ?? {}),
              reason: 'STALE_ATTEMPT_RECONCILIATION',
            },
            responseSnapshotPatch: {
              ...(verification.responseSnapshotPatch ?? {}),
              staleReconciledAt: new Date().toISOString(),
              staleReconcileReason: 'PROVIDER_REVERIFICATION',
            },
          },
        );

        result.updated += 1;
        result.reconciled.push(
          `${reconciled.reference}:${attempt.status}->${reconciled.status}`,
        );
      } catch (error: any) {
        result.failed.push({
          reference: attempt.reference,
          reason: this.extractErrorMessage(error),
        });
      }
    }

    return result;
  }

  async reconcilePaidUnifiedCheckoutFinalization(limit = 80): Promise<{
    scanned: number;
    finalized: number;
    failed: Array<{ reference: string; reason: string }>;
  }> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.trunc(limit)))
      : 80;

    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        subjectType: PaymentSubjectType.UNIFIED_CHECKOUT,
        providerMode: 'live',
        status: 'PAID',
        checkoutSessionId: { not: null },
        checkoutSession: {
          is: {
            status: {
              not: CheckoutSessionStatus.COMPLETED,
            },
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
      take: safeLimit,
      select: {
        reference: true,
        buyerId: true,
      },
    });

    const failed: Array<{ reference: string; reason: string }> = [];
    let finalized = 0;

    for (const attempt of attempts) {
      try {
        const result = await this.finalizeUnifiedCheckoutAttempt(
          attempt.reference,
          String(attempt.buyerId ?? ''),
        );
        if (result) {
          finalized += 1;
        }
      } catch (error) {
        failed.push({
          reference: attempt.reference,
          reason: this.extractErrorMessage(error),
        });
      }
    }

    return {
      scanned: attempts.length,
      finalized,
      failed,
    };
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

    if (attempt.subjectType === PaymentSubjectType.CUSTOM_ORDER) {
      throw new BadRequestException(
        'This payment reference belongs to a custom order. Verify it through /custom-orders/payment/verify (or /custom-orders/:id/payment/verify if the order already exists).',
      );
    }

    if (attempt.subjectType === PaymentSubjectType.UNIFIED_CHECKOUT) {
      if (attempt.status === 'PAID') {
        const finalized = await this.finalizeUnifiedCheckoutAttempt(
          attempt.reference,
          userId,
        );
        return this.buildUnifiedVerifyResult(
          attempt,
          true,
          finalized ?? undefined,
        );
      }

      if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
        return this.buildUnifiedVerifyResult(attempt, false);
      }

      const resolvedVerification = await this.resolveAttemptVerification(attempt, dto);
      const updatedAttempt = await this.applyAttemptStatus(
        attempt.reference,
        userId,
        resolvedVerification.nextStatus,
        'verify',
        resolvedVerification,
      );

      const finalized =
        updatedAttempt.status === 'PAID'
          ? await this.finalizeUnifiedCheckoutAttempt(updatedAttempt.reference, userId)
          : undefined;
      return this.buildUnifiedVerifyResult(
        updatedAttempt,
        updatedAttempt.status === 'PAID',
        finalized,
      );
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
    return this.sanitizePaymentDataForStorage(
      paymentMethod,
      this.validatePaymentRequest(paymentMethod, paymentData),
    );
  }

  preparePaymentGatewayRequest(
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
    context?: PaymentGatewayContext,
  ) {
    return this.initializeGateway(
      paymentMethod,
      reference,
      paymentData,
      amount,
      currency,
      callbackBaseUrl,
      context,
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
          providerVerificationAuthorization: verification.authorization,
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

    try {
      await this.webhookEventsQueue.enqueuePaymentWebhook({
        gateway: receipt.gateway,
        payload,
        providerEventKey: receipt.providerEventKey,
        reference: receipt.reference,
        correlationId: receipt.correlationId,
      });
    } catch (queueError) {
      this.logger.error(
        `Webhook enqueue failed for ${receipt.gateway} (${receipt.reference}) [corr=${receipt.correlationId ?? 'n/a'}]; processing inline fallback`,
        (queueError as Error | undefined)?.stack,
      );
      try {
        await this.processWebhookPayload(
          receipt.gateway,
          payload,
          receipt.reference,
          receipt.providerEventKey,
          {
            source: 'INLINE_FALLBACK',
            correlationId: receipt.correlationId,
          },
        );
      } catch (fallbackError) {
        this.logger.error(
          `Inline webhook fallback failed for ${receipt.gateway} (${receipt.reference}) [corr=${receipt.correlationId ?? 'n/a'}]`,
          (fallbackError as Error | undefined)?.stack,
        );
      }
    }
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
      {
        source: 'INLINE_DIRECT',
        correlationId: receipt.correlationId,
      },
    );
  }

  async processQueuedWebhook(
    job: PaymentWebhookProcessJob,
    context?: { queueAttempt?: number; queueJobId?: string | null },
  ): Promise<void> {
    await this.processWebhookPayload(
      job.gateway,
      job.payload,
      job.reference,
      job.providerEventKey,
      {
        source: 'QUEUE',
        correlationId: job.correlationId,
        queueAttempt: context?.queueAttempt ?? null,
        queueJobId: context?.queueJobId ?? null,
      },
    );
  }

  async reprocessPendingWebhookReceipts(limit = 50): Promise<{
    scanned: number;
    processed: number;
    skipped: number;
    failed: number;
  }> {
    const safeLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(200, Math.trunc(limit)))
      : 50;
    const pendingEvents = await this.prisma.paymentEvent.findMany({
      where: {
        type: 'WEBHOOK_RECEIVED',
        processedAt: null,
        providerEventKey: { not: null },
      },
      orderBy: [
        { providerEventReceivedAt: 'asc' },
        { createdAt: 'asc' },
      ],
      take: safeLimit,
      select: {
        paymentAttemptId: true,
        providerEventKey: true,
        correlationId: true,
        payload: true,
      },
    });

    const attemptIds = Array.from(
      new Set(
        pendingEvents
          .map((event) => String(event.paymentAttemptId ?? '').trim())
          .filter(Boolean),
      ),
    );
    const attempts =
      attemptIds.length > 0
        ? await this.prisma.paymentAttempt.findMany({
            where: {
              id: {
                in: attemptIds,
              },
            },
            select: {
              id: true,
              provider: true,
              reference: true,
              correlationId: true,
            },
          })
        : [];
    const attemptById = new Map(
      attempts.map((attempt) => [attempt.id, attempt]),
    );

    let processed = 0;
    let skipped = 0;
    let failed = 0;

    for (const event of pendingEvents) {
      const providerEventKey = String(event.providerEventKey ?? '').trim();
      const attempt = attemptById.get(String(event.paymentAttemptId ?? '').trim());
      const gateway = String(attempt?.provider ?? '').trim().toUpperCase();
      const reference = String(attempt?.reference ?? '').trim();
      const payload = this.asObject(event.payload);

      if (!providerEventKey || !gateway || !reference || !payload) {
        skipped += 1;
        continue;
      }

      try {
        await this.processWebhookPayload(
          gateway,
          payload,
          reference,
          providerEventKey,
          {
            source: 'CRON_REPROCESS',
            correlationId:
              String(event.correlationId ?? '').trim() ||
              String(attempt?.correlationId ?? '').trim() ||
              null,
          },
        );
        processed += 1;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `Webhook reprocess failed for ${providerEventKey}: ${this.extractErrorMessage(error)}`,
        );
      }
    }

    return {
      scanned: pendingEvents.length,
      processed,
      skipped,
      failed,
    };
  }

  private async recordWebhookReceipt(
    gateway: string,
    payload: Record<string, any>,
    context: WebhookContext,
  ) {
    const normalizedGateway = String(gateway || '').trim().toUpperCase();
    const correlationId = this.resolveCorrelationId(
      context.correlationId ??
        this.getHeader(context.headers, 'x-correlation-id') ??
        this.getHeader(context.headers, 'x-request-id'),
      `webhook-${normalizedGateway.toLowerCase()}`,
    );

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'MALFORMED_PAYLOAD',
        payloadSnapshot: payload,
        context,
        correlationId,
      });
      this.logger.warn(`Rejected ${normalizedGateway} webhook due to malformed payload`);
      return null;
    }

    if (!this.verifyWebhookSignature(normalizedGateway, payload, context)) {
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'INVALID_SIGNATURE',
        payloadSnapshot: payload,
        context,
        correlationId,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
      });
      this.logger.warn(
        `Rejected ${normalizedGateway} webhook due to signature verification failure`,
      );
      return null;
    }

    const reference = this.extractWebhookReference(normalizedGateway, payload);
    if (!reference) {
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'MALFORMED_PAYLOAD',
        payloadSnapshot: payload,
        context,
        correlationId,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
      });
      this.logger.warn(`Webhook from ${normalizedGateway}: missing reference`);
      return null;
    }

    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'UNKNOWN_REFERENCE',
        payloadSnapshot: payload,
        context,
        correlationId,
        reference,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
      });
      this.logger.warn(
        `Webhook from ${normalizedGateway}: unknown reference ${reference}`,
      );
      return null;
    }

    if (String(attempt.provider || '').trim().toUpperCase() !== normalizedGateway) {
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'MALFORMED_PAYLOAD',
        payloadSnapshot: payload,
        context,
        correlationId,
        reference,
        paymentAttemptId: attempt.id,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
      });
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
      await this.recordWebhookIngressRejection({
        provider: normalizedGateway,
        rejectionReason: 'MALFORMED_PAYLOAD',
        payloadSnapshot: payload,
        context,
        correlationId,
        reference,
        paymentAttemptId: attempt.id,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
      });
      this.logger.warn(
        `Webhook from ${normalizedGateway}: unable to compute durable event key for ${reference}`,
      );
      return null;
    }

    const providerEventType = this.extractWebhookEvent(normalizedGateway, payload);

    if (!attempt.correlationId) {
      await this.prisma.paymentAttempt.updateMany({
        where: {
          id: attempt.id,
          correlationId: null,
        },
        data: {
          correlationId,
        },
      });
    }

    try {
      await this.prisma.paymentEvent.create({
        data: {
          paymentAttemptId: attempt.id,
          type: 'WEBHOOK_RECEIVED',
          source: 'webhook-receipt',
          correlationId,
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
          select: { processedAt: true, correlationId: true },
        });
        return {
          gateway: normalizedGateway,
          reference,
          providerEventKey,
          attemptId: attempt.id,
          correlationId: existing?.correlationId ?? attempt.correlationId ?? correlationId,
          processedAt: existing?.processedAt ?? null,
        };
      }
      throw error;
    }

    this.logger.log(
      `Webhook received from ${normalizedGateway}: ${reference} [corr=${attempt.correlationId ?? correlationId}]`,
    );

    return {
      gateway: normalizedGateway,
      reference,
      providerEventKey,
      attemptId: attempt.id,
      correlationId: attempt.correlationId ?? correlationId,
      processedAt: null,
    };
  }

  private async processWebhookPayload(
    normalizedGateway: string,
    payload: Record<string, any>,
    reference: string,
    providerEventKey: string,
    context: WebhookProcessContext,
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

    const correlationId = this.resolveCorrelationId(
      context.correlationId ?? attempt.correlationId ?? providerEventKey,
      'webhook-process',
    );

    if (!attempt.correlationId) {
      await this.prisma.paymentAttempt.updateMany({
        where: {
          id: attempt.id,
          correlationId: null,
        },
        data: {
          correlationId,
        },
      });
    }

    try {
      if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
        if (
          attempt.status === 'PAID' &&
          attempt.subjectType === PaymentSubjectType.UNIFIED_CHECKOUT
        ) {
          await this.finalizeUnifiedCheckoutAttempt(
            attempt.reference,
            String(attempt.buyerId ?? ''),
          );
        }

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

      const webhookAuthorization = this.extractPaystackAuthorizationSnapshot(
        this.asObject(payload?.data)?.authorization ?? payload?.authorization,
      );

      await this.applyAttemptStatus(reference, attempt.buyerId ?? '', nextStatus, 'webhook', {
        eventPayload: payload,
        correlationId,
        responseSnapshotPatch: {
          ...(this.asObject(attempt.responseSnapshot) ?? {}),
          providerWebhookGateway: normalizedGateway,
          providerWebhookStatus: nextStatus,
          providerWebhookSource: context.source,
          providerWebhookQueueAttempt: context.queueAttempt ?? null,
          providerWebhookQueueJobId: context.queueJobId ?? null,
          providerWebhookReceivedAt: new Date().toISOString(),
          providerWebhookAmount: payloadAmount,
          providerWebhookCurrency: payloadCurrency,
          providerWebhookEvent: this.extractWebhookEvent(normalizedGateway, payload),
          providerWebhookVerified: true,
          providerWebhookCorrelationId: correlationId,
          ...(webhookAuthorization
            ? { providerWebhookAuthorization: webhookAuthorization }
            : {}),
        },
        providerReference: this.extractWebhookReference(normalizedGateway, payload),
        providerTransactionId: this.extractWebhookTransactionId(normalizedGateway, payload),
        providerChannel: this.extractWebhookChannel(payload),
      });

      await this.markProviderEventProcessed(providerEventKey);
    } catch (error) {
      await this.recordWebhookRetryAttempt({
        paymentAttemptId: attempt.id,
        reference,
        providerEventKey,
        correlationId,
        source: context.source,
        queueAttempt: context.queueAttempt ?? null,
        queueJobId: context.queueJobId ?? null,
        error,
      });
      await this.recordWebhookProcessingFailure({
        paymentAttemptId: attempt.id,
        gateway: normalizedGateway,
        reference,
        providerEventKey,
        providerEventType: this.extractWebhookEvent(normalizedGateway, payload),
        payload,
        correlationId,
        source: context.source,
        queueAttempt: context.queueAttempt ?? null,
        queueJobId: context.queueJobId ?? null,
        error,
      });
      throw error;
    }
  }

  private async initializeGateway(
    paymentMethod: PaymentMethod,
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
    context?: PaymentGatewayContext,
  ): Promise<GatewayInitializationResult> {
    switch (paymentMethod) {
      case PaymentMethod.PAYSTACK:
        return this.initPaystack(
          reference,
          paymentData,
          amount,
          currency,
          callbackBaseUrl,
          context,
        );
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
    context?: PaymentGatewayContext,
  ): Promise<GatewayInitializationResult> {
    const channel = (paymentData.channel as PaymentChannel | undefined) ?? 'CARD';
    if (this.isMockMode()) {
      throw new BadRequestException(
        'Internal Paystack mock behavior is disabled. Use Paystack test keys so checkout behaves the same way across environments.',
      );
    }

    if (currency !== 'NGN') {
      throw new BadRequestException('Paystack is only enabled for NGN payments in this phase');
    }

    if (channel === 'CARD' && paymentData.useSavedCard && paymentData.savedCardId) {
      return this.chargePaystackSavedAuthorization(
        reference,
        paymentData,
        amount,
        currency,
        callbackBaseUrl,
        context,
      );
    }

    if (channel === 'CARD' && this.hasRawPaystackCardDetails(paymentData)) {
      return this.chargePaystackNewCard(
        reference,
        paymentData,
        amount,
        currency,
        callbackBaseUrl,
      );
    }

    const secret = this.getRequiredPaystackSecret('live payment processing');
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

    const providerAccessCode =
      String(payload.data.access_code || '').trim() || undefined;
    if (!providerAccessCode) {
      throw new BadRequestException(
        'Paystack did not return an inline access code. Threadly only supports in-app secure checkout and will not route buyers out of the product.',
      );
    }

    return {
      gateway: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel,
      callbackUrl: callbackBaseUrl,
      authorizationUrl: String(payload.data.authorization_url || '').trim() || undefined,
      providerReference: String(payload.data.reference || reference),
      providerAccessCode,
      providerChannel: channel,
      nextAction: {
        type: 'INLINE_POPUP',
        title:
          channel === 'BANK_TRANSFER'
            ? 'Open secure transfer instructions'
            : 'Open secure card checkout',
        description:
          channel === 'BANK_TRANSFER'
            ? 'Paystack will show the transfer account details inside Threadly\'s secure checkout window.'
            : 'Card details and any issuer verification steps stay inside Threadly\'s secure checkout window.',
        ctaLabel:
          channel === 'BANK_TRANSFER'
            ? 'Open transfer instructions'
            : 'Open secure checkout',
        instructions: [
          `Use ${paymentData.email} as the payer email if prompted by Paystack.`,
          'Complete the authorization inside the secure payment window that opens over Threadly.',
          'Threadly verifies the transaction by reference before the order is treated as paid.',
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

  private async chargePaystackNewCard(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
  ): Promise<GatewayInitializationResult> {
    const draft = this.getNormalizedPaystackCardDraft(paymentData);

    return this.executePaystackCharge(reference, paymentData, amount, currency, callbackBaseUrl, {
      card: {
        cvv: draft.cvv,
        expiry_month: draft.expiryMonth,
        expiry_year: draft.expiryYear,
        number: draft.cardNumber,
      },
      use_hosted_url: true,
    });
  }

  private async chargePaystackSavedAuthorization(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
    context?: PaymentGatewayContext,
  ): Promise<GatewayInitializationResult> {
    const buyerId = String(context?.buyerId ?? '').trim();
    if (!buyerId) {
      throw new BadRequestException(
        'A buyer context is required before Threadly can charge a saved Paystack card.',
      );
    }

    const savedCardId = String(paymentData.savedCardId ?? '').trim();
    const authorizationCode = await this.resolveSavedPaystackAuthorizationCode(
      buyerId,
      savedCardId,
    );

    return this.executePaystackCharge(reference, paymentData, amount, currency, callbackBaseUrl, {
      authorization_code: authorizationCode,
    });
  }

  private async executePaystackCharge(
    reference: string,
    paymentData: Record<string, any>,
    amount: number,
    currency: string,
    callbackBaseUrl: string,
    extraPayload: Record<string, any>,
  ): Promise<GatewayInitializationResult> {
    const secret = this.getRequiredPaystackSecret('live payment processing');
    const response = await fetch('https://api.paystack.co/charge', {
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
        metadata: {
          threadlyReference: reference,
          threadlyChannel: 'CARD',
          payerPhone: paymentData.phone,
          source: 'threadly-checkout',
          saveNewCard: Boolean(paymentData.saveNewCard ?? true),
        },
        ...extraPayload,
      }),
    });

    const payload = await this.parseJsonResponse(response);
    const data = this.asObject(payload?.data);

    if (!response.ok || payload?.status === false || !data) {
      throw new BadRequestException(
        String(payload?.message || 'Unable to initialize Paystack card charge'),
      );
    }

    const providerReference =
      String(data.reference ?? reference).trim() || reference;
    const rawStatus = String(data.status ?? '').trim().toLowerCase();
    const authorizationUrl =
      String(data.url ?? data.authorization_url ?? '').trim() || undefined;
    const providerMessage =
      String(data.display_text ?? data.gateway_response ?? payload?.message ?? '')
        .trim() || null;

    if (authorizationUrl) {
      return {
        gateway: 'PAYSTACK',
        status: 'REQUIRES_ACTION',
        channel: 'CARD',
        callbackUrl: callbackBaseUrl,
        authorizationUrl,
        providerReference,
        providerChannel: 'CARD',
        nextAction: {
          type: 'INLINE_POPUP',
          title: 'Complete secure card verification',
          description:
            'Threadly validated the card details. Complete the remaining issuer verification in the secure payment window.',
          ctaLabel: 'Open secure verification',
          instructions: [
            `Use ${paymentData.email} as the payer email if prompted by Paystack.`,
            'Complete the card challenge in the secure payment window and Threadly will resume automatically.',
            'The order is not treated as paid until provider verification confirms success.',
          ],
        },
        responseSnapshot: {
          initializedAt: new Date().toISOString(),
          providerStatus: rawStatus || 'OPEN_URL',
          providerMessage,
          providerChannel: 'CARD',
        },
      };
    }

    const mappedStatus =
      rawStatus === 'success'
        ? 'PROCESSING'
        : rawStatus === 'failed' || rawStatus === 'error'
          ? 'FAILED'
          : 'PROCESSING';

    return {
      gateway: 'PAYSTACK',
      status: mappedStatus,
      channel: 'CARD',
      callbackUrl: callbackBaseUrl,
      providerReference,
      providerChannel: 'CARD',
      nextAction:
        mappedStatus === 'FAILED'
          ? undefined
          : {
              type: 'PENDING_CONFIRMATION',
              title: 'Confirming payment',
              description:
                'Threadly is waiting for Paystack to confirm the card charge.',
              instructions: [
                'Keep this window open while Threadly verifies the payment reference.',
              ],
            },
      responseSnapshot: {
        initializedAt: new Date().toISOString(),
        providerStatus: rawStatus || 'PROCESSING',
        providerMessage,
        providerChannel: 'CARD',
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
    if (!this.isMockMode()) {
      throw new BadRequestException(
        'Flutterwave live checkout is not enabled on this deployment. Use Paystack for live checkout.',
      );
    }

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
    if (attempt.subjectType === PaymentSubjectType.UNIFIED_CHECKOUT) {
      if (!attempt.checkoutSessionId) {
        throw new NotFoundException('Unified checkout session is missing for this payment attempt');
      }

      const checkoutSession = await this.prisma.checkoutSession.findFirst({
        where: {
          id: attempt.checkoutSessionId,
          buyerId: userId,
        },
        include: {
          lines: {
            select: {
              orderId: true,
              customOrderId: true,
              quantity: true,
              unitPrice: true,
              itemSnapshotJson: true,
            },
            orderBy: { lineOrder: 'asc' },
          },
        },
      });

      if (!checkoutSession) {
        throw new NotFoundException('Unified checkout session not found for this payment attempt');
      }

      const summarySnapshot = this.asObject(checkoutSession.summaryJson);
      const shippingSnapshot = this.asObject(checkoutSession.shippingAddressJson);
      const summaryItemsFromSnapshot = Array.isArray(summarySnapshot.items)
        ? summarySnapshot.items
            .map((item) => {
              const candidate = this.asObject(item);
              const name = String(candidate.name ?? '').trim();
              const quantity = Number(candidate.quantity ?? 0);
              const price = Number(candidate.price ?? 0);
              if (!name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price)) {
                return null;
              }
              return {
                name,
                quantity,
                price,
              };
            })
            .filter((item): item is { name: string; quantity: number; price: number } => Boolean(item))
        : [];

      const summaryItems =
        summaryItemsFromSnapshot.length > 0
          ? summaryItemsFromSnapshot
          : checkoutSession.lines.map((line) => {
              const itemSnapshot = this.asObject(line.itemSnapshotJson);
              return {
                name: String(itemSnapshot.name ?? itemSnapshot.sourceTitle ?? 'Item'),
                quantity: Number(line.quantity ?? 1),
                price: Number(line.unitPrice ?? 0),
              };
            });

      const subtotal = this.roundMoney(
        Number(
          summarySnapshot.subtotal ??
            summaryItems.reduce(
              (sum, item) => sum + Number(item.price ?? 0) * Number(item.quantity ?? 1),
              0,
            ),
        ),
      );
      const shippingCost = this.roundMoney(Number(summarySnapshot.shippingCost ?? 0));
      const discount = this.roundMoney(Number(summarySnapshot.discount ?? 0));
      const grandTotal = this.roundMoney(
        Number(summarySnapshot.grandTotal ?? subtotal + shippingCost - discount),
      );

      const orderIds = Array.from(
        new Set(
          checkoutSession.lines
            .map((line) => String(line.orderId ?? '').trim())
            .filter(Boolean),
        ),
      );
      const customOrderIds = Array.from(
        new Set(
          checkoutSession.lines
            .map((line) => String(line.customOrderId ?? '').trim())
            .filter(Boolean),
        ),
      );

      return {
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        correlationId: attempt.correlationId ?? undefined,
        subjectType: 'UNIFIED_CHECKOUT',
        customOrderIds,
        checkoutSessionId: checkoutSession.id,
        gateway: attempt.provider,
        providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
        paymentMethod: attempt.paymentMethod,
        status: attempt.status as PaymentAttemptStatus,
        currency: attempt.currency,
        settlementCurrency: attempt.settlementCurrency,
        settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? grandTotal),
        exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
        channel: (attempt.channel as PaymentChannel | null) ?? undefined,
        providerAccessCode: attempt.providerAccessCode ?? undefined,
        authorizationUrl: attempt.authorizationUrl ?? undefined,
        callbackUrl: attempt.callbackUrl ?? undefined,
        bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
        paymentData: this.asObject(attempt.requestSnapshot),
        nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
        canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
        canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
        webhookRetryCount: Number(attempt.webhookRetryCount ?? 0),
        webhookFirstRetriedAt: attempt.webhookFirstRetriedAt?.toISOString(),
        webhookLastRetriedAt: attempt.webhookLastRetriedAt?.toISOString(),
        webhookLastRetryReason: attempt.webhookLastRetryReason ?? undefined,
        orderIds,
        summary: {
          items: summaryItems,
          subtotal,
          shippingCost,
          discount,
          grandTotal,
          shippingName: String(summarySnapshot.shippingName ?? checkoutSession.customerName ?? ''),
          shippingCity: String(summarySnapshot.shippingCity ?? shippingSnapshot.city ?? ''),
          shippingState: String(summarySnapshot.shippingState ?? shippingSnapshot.state ?? ''),
        },
      };
    }

    if (attempt.subjectType === PaymentSubjectType.CUSTOM_ORDER) {
      if (attempt.customOrderId) {
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
            checkoutIntentId: true,
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
        const subtotal = this.roundMoney(
          Number(priceSummary?.subtotal ?? grandTotal - shippingCost + discount),
        );

        return {
          paymentAttemptId: attempt.id,
          reference: attempt.reference,
          correlationId: attempt.correlationId ?? undefined,
          subjectType: 'CUSTOM_ORDER',
          customOrderId: customOrder.id,
          checkoutIntentId: customOrder.checkoutIntentId ?? attempt.checkoutIntentId ?? undefined,
          gateway: attempt.provider,
          providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
          paymentMethod: attempt.paymentMethod,
          status: attempt.status as PaymentAttemptStatus,
          currency: attempt.currency,
          settlementCurrency: attempt.settlementCurrency,
          settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? grandTotal),
          exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
          channel: (attempt.channel as PaymentChannel | null) ?? undefined,
          providerAccessCode: attempt.providerAccessCode ?? undefined,
          authorizationUrl: attempt.authorizationUrl ?? undefined,
          callbackUrl: attempt.callbackUrl ?? undefined,
          bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
          paymentData: this.asObject(attempt.requestSnapshot),
          nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
          canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
          canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
          webhookRetryCount: Number(attempt.webhookRetryCount ?? 0),
          webhookFirstRetriedAt: attempt.webhookFirstRetriedAt?.toISOString(),
          webhookLastRetriedAt: attempt.webhookLastRetriedAt?.toISOString(),
          webhookLastRetryReason: attempt.webhookLastRetryReason ?? undefined,
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

      if (!attempt.checkoutIntentId) {
        throw new NotFoundException(
          'Custom-order payment attempt is missing its checkout intent reference',
        );
      }

      const checkoutIntent = await this.prisma.customOrderCheckoutIntent.findFirst({
        where: { id: attempt.checkoutIntentId, buyerId: userId },
        select: {
          id: true,
          buyerPriceSummaryJson: true,
          requestSnapshotJson: true,
          currency: true,
        },
      });

      if (!checkoutIntent) {
        throw new NotFoundException('Custom order checkout intent not found for this payment attempt');
      }

      const priceSummary = this.asObject(checkoutIntent.buyerPriceSummaryJson);
      const requestSnapshot = this.asObject(checkoutIntent.requestSnapshotJson);
      const shippingAddress = this.asObject(requestSnapshot?.shippingAddress);
      const contactInfo = this.asObject(requestSnapshot?.contactInfo);
      const shippingName = String(contactInfo?.customerName ?? requestSnapshot?.customerName ?? '');
      const grandTotal = this.roundMoney(Number(priceSummary?.grandTotal ?? attempt.amount ?? 0));
      const shippingCost = this.roundMoney(Number(priceSummary?.shippingFee ?? 0));
      const discount = this.roundMoney(Number(priceSummary?.discount ?? 0));
      const subtotal = this.roundMoney(
        Number(priceSummary?.subtotal ?? grandTotal - shippingCost + discount),
      );

      return {
        paymentAttemptId: attempt.id,
        reference: attempt.reference,
        correlationId: attempt.correlationId ?? undefined,
        subjectType: 'CUSTOM_ORDER',
        customOrderId: undefined,
        checkoutIntentId: checkoutIntent.id,
        gateway: attempt.provider,
        providerMode: attempt.providerMode === 'live' ? 'live' : 'mock',
        paymentMethod: attempt.paymentMethod,
        status: attempt.status as PaymentAttemptStatus,
        currency: checkoutIntent.currency,
        settlementCurrency: attempt.settlementCurrency,
        settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? grandTotal),
        exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
        channel: (attempt.channel as PaymentChannel | null) ?? undefined,
        providerAccessCode: attempt.providerAccessCode ?? undefined,
        authorizationUrl: attempt.authorizationUrl ?? undefined,
        callbackUrl: attempt.callbackUrl ?? undefined,
        bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
        paymentData: this.asObject(attempt.requestSnapshot),
        nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
        canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
        canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
        webhookRetryCount: Number(attempt.webhookRetryCount ?? 0),
        webhookFirstRetriedAt: attempt.webhookFirstRetriedAt?.toISOString(),
        webhookLastRetriedAt: attempt.webhookLastRetriedAt?.toISOString(),
        webhookLastRetryReason: attempt.webhookLastRetryReason ?? undefined,
        orderIds: [],
        summary: {
          items: [
            {
              name: 'Custom order checkout',
              quantity: 1,
              price: subtotal,
            },
          ],
          subtotal,
          shippingCost,
          discount,
          grandTotal,
          shippingName,
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
      correlationId: attempt.correlationId ?? undefined,
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
      providerAccessCode: attempt.providerAccessCode ?? undefined,
      authorizationUrl: attempt.authorizationUrl ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      bankAccount: this.asObject(attempt.bankAccount) as PaymentInitResult['bankAccount'],
      paymentData: this.asObject(attempt.requestSnapshot),
      nextAction: this.asObject(attempt.nextAction) as PaymentNextAction | undefined,
      canRetry: ['FAILED', 'CANCELLED', 'EXPIRED'].includes(attempt.status),
      canSimulate: this.isMockMode() && this.allowPaymentSimulation() && attempt.status !== 'PAID',
      webhookRetryCount: Number(attempt.webhookRetryCount ?? 0),
      webhookFirstRetriedAt: attempt.webhookFirstRetriedAt?.toISOString(),
      webhookLastRetriedAt: attempt.webhookLastRetriedAt?.toISOString(),
      webhookLastRetryReason: attempt.webhookLastRetryReason ?? undefined,
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
    source: 'verify' | 'simulation' | 'webhook' | 'reconcile',
    payload?: AttemptStatusUpdatePayload,
  ) {
    const now = new Date();
    const eventPayload = payload?.eventPayload ?? null;
    const responseSnapshotPatch = payload?.responseSnapshotPatch ?? null;
    const transitionResult = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${reference} FOR UPDATE`;
      const attempt = await tx.paymentAttempt.findUnique({
        where: { reference },
      });

      if (!attempt || (attempt.buyerId && userId && attempt.buyerId !== userId)) {
        throw new NotFoundException('Payment attempt not found');
      }

      if (this.isTerminalStatus(attempt.status as PaymentAttemptStatus)) {
        return {
          attempt,
          transitionedToPaid: false,
        };
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
          correlationId: payload?.correlationId ?? attempt.correlationId,
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
          correlationId: payload?.correlationId ?? attempt.correlationId,
          providerEventType:
            source === 'webhook'
              ? this.extractWebhookEvent(String(attempt.provider || ''), eventPayload ?? {})
              : nextStatus,
          providerEventReceivedAt: source === 'webhook' ? now : null,
          processedAt: now,
          payload: eventPayload,
        },
      });

      return {
        attempt: updated,
        transitionedToPaid: nextStatus === 'PAID',
      };
    });

    const updatedAttempt = transitionResult.attempt;

    if (updatedAttempt.subjectType === PaymentSubjectType.UNIFIED_CHECKOUT) {
      if (transitionResult.transitionedToPaid) {
        await this.finalizeUnifiedCheckoutAttempt(updatedAttempt.reference, userId);
      } else if (
        ['FAILED', 'CANCELLED', 'EXPIRED'].includes(updatedAttempt.status)
      ) {
        await this.releaseUnifiedCheckoutAttempt(updatedAttempt.reference, userId, {
          reason: `ATTEMPT_${updatedAttempt.status}`,
        });
      }
    }

    const linkedOrders =
      transitionResult.transitionedToPaid &&
      updatedAttempt.subjectType === PaymentSubjectType.STANDARD_ORDER
        ? await this.prisma.order.findMany({
            where: {
              paymentReference: reference,
              ...(updatedAttempt.buyerId ? { buyerId: updatedAttempt.buyerId } : {}),
            },
            select: {
              id: true,
              brandId: true,
              buyerId: true,
              customerName: true,
              totalAmount: true,
              brand: {
                select: {
                  ownerId: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: 'asc' },
          })
        : [];

    if (transitionResult.transitionedToPaid && linkedOrders.length > 0) {
      await this.standardOrderFinanceSyncService.syncPaidOrdersByReferences([reference]);
      await this.notifyFinanceAdminsOfStandardPayment(updatedAttempt, linkedOrders);
      await this.notifyOrderPlacementAfterPayment(linkedOrders);
    }

    return updatedAttempt;
  }

  private buildInitResultFromAttempt(
    attempt: NonNullable<PaymentAttemptRecord>,
  ): PaymentInitResult {
    return {
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      correlationId: attempt.correlationId ?? undefined,
      gateway: attempt.provider,
      status: attempt.status as PaymentAttemptStatus,
      currency: attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? 0),
      exchangeRateSnapshotId: attempt.exchangeRateSnapshotId ?? undefined,
      channel: (attempt.channel as PaymentChannel | null) ?? undefined,
      callbackUrl: attempt.callbackUrl ?? undefined,
      providerAccessCode: attempt.providerAccessCode ?? undefined,
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
      correlationId: attempt.correlationId ?? undefined,
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

  private buildUnifiedVerifyResult(
    attempt: NonNullable<PaymentAttemptRecord>,
    success: boolean,
    finalized?: UnifiedCheckoutFinalizeResult,
  ): PaymentVerifyResult {
    const summary = finalized?.summary;
    const amount = this.roundMoney(Number(summary?.grandTotal ?? attempt.amount ?? 0));

    return {
      success,
      status: attempt.status as PaymentAttemptStatus,
      paymentAttemptId: attempt.id,
      reference: attempt.reference,
      correlationId: attempt.correlationId ?? undefined,
      amount,
      currency: summary?.currency ?? attempt.currency,
      settlementCurrency: attempt.settlementCurrency,
      settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? amount),
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
      orderIds: finalized?.orderIds ?? [],
      customOrderIds: finalized?.customOrderIds ?? [],
      checkoutSessionId: finalized?.checkoutSessionId ?? attempt.checkoutSessionId ?? undefined,
      summary: summary
        ? {
            items: summary.items,
            subtotal: summary.subtotal,
            shippingCost: summary.shippingCost,
            discount: summary.discount,
            grandTotal: summary.grandTotal,
            shippingName: summary.shippingName,
            shippingCity: summary.shippingCity,
            shippingState: summary.shippingState,
          }
        : undefined,
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

  private async notifyOrderPlacementAfterPayment(
    linkedOrders: Array<{
      id: string;
      brandId: string;
      buyerId: string | null;
      customerName: string | null;
      totalAmount: Prisma.Decimal;
      brand: {
        ownerId: string;
        name: string;
      } | null;
    }>,
  ) {
    const jobs: Array<Promise<unknown>> = [];

    for (const order of linkedOrders) {
      const totalAmount = Number(order.totalAmount ?? 0);
      const brandName = order.brand?.name ?? 'Brand';

      if (order.brand?.ownerId) {
        jobs.push(
          this.notificationsService.create(
            order.brand.ownerId,
            NotificationType.ORDER_PLACED,
            {
              actorId: order.buyerId ?? undefined,
              dedupeMs: 5 * 60 * 1000,
              payload: {
                orderId: order.id,
                totalAmount,
                brandId: order.brandId,
                brandName,
                customerName: order.customerName || 'Customer',
                targetUrl: `/studio?tab=orders&orderId=${order.id}`,
              },
            },
          ),
        );
      }

      if (order.buyerId) {
        jobs.push(
          this.notificationsService.create(order.buyerId, NotificationType.ORDER_PLACED, {
            actorId: null,
            dedupeMs: 5 * 60 * 1000,
            payload: {
              orderId: order.id,
              totalAmount,
              brandId: order.brandId,
              brandName,
              isBuyerCopy: true,
              targetUrl: `/orders/${order.id}`,
            },
          }),
        );
      }
    }

    if (jobs.length === 0) {
      return;
    }

    const results = await Promise.allSettled(jobs);
    const rejected = results.filter((result) => result.status === 'rejected');
    if (rejected.length > 0) {
      this.logger.warn(
        `Failed to send ${rejected.length} order placement notification(s) after payment confirmation`,
      );
    }
  }

  async resolveCardValidationSessionForInitialize(params: {
    paymentMethod: PaymentMethod;
    validationSessionId?: string | null;
    userId: string;
    gatewayPaymentData: Record<string, any>;
    sanitizedPaymentData: Record<string, any>;
  }): Promise<CardValidationSessionBinding | null> {
    const storedSession = await this.assertCardValidationSessionForInitialize(params);
    if (!storedSession) {
      return null;
    }

    return {
      sessionId: storedSession.sessionId,
      savedPaymentMethodId: storedSession.savedPaymentMethodId,
      canonicalSessionId:
        storedSession.storage === 'canonical' ? storedSession.sessionId : null,
      storage: storedSession.storage,
    };
  }

  async consumeCardValidationSessionForInitialize(
    tx: Prisma.TransactionClient,
    userId: string,
    session: CardValidationSessionBinding | null,
  ): Promise<void> {
    if (!session || session.storage !== 'canonical' || !session.canonicalSessionId) {
      return;
    }

    const cardValidationSessionModel = (tx as any)['cardValidationSession'];
    if (!cardValidationSessionModel) {
      return;
    }

    const consumedAt = new Date();
    const updateResult = await cardValidationSessionModel.updateMany({
      where: {
        id: session.canonicalSessionId,
        buyerId: userId,
        status: 'VALIDATED',
        consumedAt: null,
        expiresAt: { gt: consumedAt },
      },
      data: {
        status: 'USED',
        consumedAt,
      },
    });

    if (Number(updateResult?.count ?? 0) === 0) {
      throw new BadRequestException(
        'Card validation session is no longer usable. Validate your payment details again.',
      );
    }
  }

  private async assertCardValidationSessionForInitialize(params: {
    paymentMethod: PaymentMethod;
    validationSessionId?: string | null;
    userId: string;
    gatewayPaymentData: Record<string, any>;
    sanitizedPaymentData: Record<string, any>;
  }): Promise<StoredCardValidationSession | null> {
    if (params.paymentMethod !== PaymentMethod.PAYSTACK) {
      return null;
    }

    const userId = String(params.userId ?? '').trim();
    if (!userId) {
      return null;
    }

    const channel = String(params.gatewayPaymentData.channel ?? '').trim().toUpperCase();
    if (channel !== 'CARD') {
      return null;
    }

    if (!this.isValidationGateEnabledForUser(userId)) {
      return null;
    }

    if (
      !Boolean(params.gatewayPaymentData.useSavedCard) &&
      !this.hasRawPaystackCardDetails(params.gatewayPaymentData)
    ) {
      return null;
    }

    const sessionId = String(params.validationSessionId ?? '').trim();
    if (!sessionId) {
      throw new BadRequestException(
        'Complete card validation on the payment step before placing your order.',
      );
    }

    const storedSession = await this.getStoredCardValidationSession(sessionId, userId);
    if (!storedSession) {
      throw new BadRequestException(
        'Card validation session was not found. Validate your payment details again.',
      );
    }

    if (storedSession.status !== 'VALIDATED') {
      throw new BadRequestException(
        'Card validation session is no longer usable. Validate your payment details again.',
      );
    }

    if (new Date(storedSession.expiresAt).getTime() <= Date.now()) {
      throw new BadRequestException(
        'Your card validation session has expired. Validate your payment details again.',
      );
    }

    if (
      storedSession.paymentMethod !== PaymentMethod.PAYSTACK ||
      storedSession.gateway !== 'PAYSTACK' ||
      storedSession.channel !== 'CARD'
    ) {
      throw new BadRequestException('Card validation session is invalid for this checkout attempt');
    }

    const useSavedCard = Boolean(params.gatewayPaymentData.useSavedCard);
    if (useSavedCard !== storedSession.useSavedCard) {
      throw new BadRequestException(
        'Payment card selection changed after validation. Validate again before placing your order.',
      );
    }

    if (useSavedCard) {
      const savedCardId = String(params.gatewayPaymentData.savedCardId ?? '').trim();
      if (!savedCardId || savedCardId !== String(storedSession.savedCardId ?? '').trim()) {
        throw new BadRequestException(
          'Selected saved card changed after validation. Validate again before placing your order.',
        );
      }
    }

    const fingerprint = this.buildPaymentDataFingerprint(
      params.sanitizedPaymentData,
    );
    if (storedSession.paymentDataFingerprint !== fingerprint) {
      throw new BadRequestException(
        'Payment details changed after validation. Validate again before placing your order.',
      );
    }

    const payerEmail = String(params.gatewayPaymentData.email ?? '')
      .trim()
      .toLowerCase();
    if (payerEmail && storedSession.email.trim().toLowerCase() !== payerEmail) {
      throw new BadRequestException(
        'Payment email changed after validation. Validate again before placing your order.',
      );
    }

    return storedSession;
  }

  private async createCardValidationSession(params: {
    userId: string;
    paymentMethod: PaymentMethod;
    sanitizedPaymentData: Record<string, any>;
    useSavedCard: boolean;
    savedPaymentMethodId: string | null;
    savedCardId: string | null;
    email: string;
    cardSummary: CardValidationSessionSummary['cardSummary'];
  }): Promise<CardValidationSessionSummary> {
    const now = new Date();
    const ttlMinutes = this.getCardValidationSessionTtlMinutes();
    const expiresAt = new Date(now.getTime() + ttlMinutes * 60 * 1000);
    const sessionId = uuidv4();
    const paymentDataFingerprint = this.buildPaymentDataFingerprint(
      params.sanitizedPaymentData,
    );

    const session: StoredCardValidationSession = {
      sessionId,
      status: 'VALIDATED',
      gateway: 'PAYSTACK',
      channel: 'CARD',
      useSavedCard: params.useSavedCard,
      savedPaymentMethodId: params.savedPaymentMethodId,
      savedCardId: params.useSavedCard ? params.savedCardId : null,
      email: params.email,
      validatedAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
      cardSummary: params.cardSummary,
      paymentMethod: params.paymentMethod,
      paymentDataFingerprint,
      storage: 'idempotency',
    };

    const cardValidationSessionModel = this.getCardValidationSessionModel();
    if (cardValidationSessionModel) {
      await cardValidationSessionModel.create({
        data: {
          id: sessionId,
          buyerId: params.userId,
          paymentMethod: params.paymentMethod,
          gateway: 'PAYSTACK',
          channel: 'CARD',
          status: 'VALIDATED',
          email: params.email,
          useSavedCard: params.useSavedCard,
          savedPaymentMethodId: params.savedPaymentMethodId,
          savedCardLegacyId: params.savedCardId,
          paymentDataFingerprint,
          cardSummary: params.cardSummary,
          validatedAt: now,
          expiresAt,
        },
      });

      return this.toCardValidationSessionSummary({
        ...session,
        storage: 'canonical',
      });
    }

    const idempotencyKeyModel = this.getIdempotencyKeyModel();
    const sessionKey = this.buildCardValidationSessionKey(sessionId);

    await idempotencyKeyModel.create({
      data: {
        id: uuidv4(),
        userId: params.userId,
        key: sessionKey,
        method: CARD_VALIDATION_SESSION_METHOD,
        path: CARD_VALIDATION_SESSION_PATH,
        requestHash: createHash('sha256').update(paymentDataFingerprint).digest('hex'),
        responseBody: session,
        statusCode: 201,
        expiresAt,
      },
    });

    if (Math.random() < 0.05) {
      void idempotencyKeyModel.deleteMany({
        where: {
          path: CARD_VALIDATION_SESSION_PATH,
          method: CARD_VALIDATION_SESSION_METHOD,
          expiresAt: { lt: new Date() },
        },
      });
    }

    return this.toCardValidationSessionSummary(session);
  }

  private async getStoredCardValidationSession(
    sessionId: string,
    userId: string,
  ): Promise<StoredCardValidationSession | null> {
    const normalizedSessionId = String(sessionId ?? '').trim();
    if (!normalizedSessionId) {
      return null;
    }

    const cardValidationSessionModel = this.getCardValidationSessionModel();
    if (cardValidationSessionModel) {
      const persistedSession = await cardValidationSessionModel.findFirst({
        where: {
          id: normalizedSessionId,
          buyerId: userId,
        },
        select: {
          id: true,
          paymentMethod: true,
          gateway: true,
          channel: true,
          status: true,
          email: true,
          useSavedCard: true,
          savedPaymentMethodId: true,
          savedCardLegacyId: true,
          paymentDataFingerprint: true,
          cardSummary: true,
          validatedAt: true,
          expiresAt: true,
        },
      });

      if (persistedSession) {
        const cardSummary = this.asObject(persistedSession.cardSummary);
        const cardLast4 = this.normalizeCardLast4(cardSummary.last4);
        if (!cardLast4) {
          return null;
        }

        const normalizedStatus = String(persistedSession.status ?? '')
          .trim()
          .toUpperCase();
        const isExpired =
          normalizedStatus !== 'VALIDATED' ||
          persistedSession.expiresAt.getTime() <= Date.now();

        return {
          sessionId: normalizedSessionId,
          status: isExpired ? 'EXPIRED' : 'VALIDATED',
          gateway: 'PAYSTACK',
          channel: 'CARD',
          useSavedCard: Boolean(persistedSession.useSavedCard),
          savedPaymentMethodId: String(
            persistedSession.savedPaymentMethodId ?? '',
          ).trim() || null,
          savedCardId:
            String(persistedSession.savedCardLegacyId ?? '').trim() ||
            String(persistedSession.savedPaymentMethodId ?? '').trim() ||
            null,
          email: String(persistedSession.email ?? '').trim(),
          validatedAt: persistedSession.validatedAt.toISOString(),
          expiresAt: persistedSession.expiresAt.toISOString(),
          cardSummary: {
            source:
              String(cardSummary.source ?? '').trim().toLowerCase() === 'saved'
                ? 'saved'
                : 'new',
            brand: this.normalizeCardText(cardSummary.brand),
            bank: this.normalizeCardText(cardSummary.bank),
            last4: cardLast4,
            expMonth: this.normalizeCardText(cardSummary.expMonth),
            expYear: this.normalizeCardText(cardSummary.expYear),
            holderName: this.normalizeCardText(cardSummary.holderName),
          },
          paymentMethod: PaymentMethod.PAYSTACK,
          paymentDataFingerprint: String(
            persistedSession.paymentDataFingerprint ?? '',
          ).trim(),
          storage: 'canonical',
        };
      }
    }

    const idempotencyKeyModel = this.getIdempotencyKeyModel();
    const sessionKey = this.buildCardValidationSessionKey(normalizedSessionId);

    const persisted = await idempotencyKeyModel.findUnique({
      where: {
        userId_key_method_path: {
          userId,
          key: sessionKey,
          method: CARD_VALIDATION_SESSION_METHOD,
          path: CARD_VALIDATION_SESSION_PATH,
        },
      },
      select: {
        responseBody: true,
        expiresAt: true,
      },
    });

    if (!persisted) {
      return null;
    }

    const payload = this.asObject(persisted.responseBody);
    const fingerprint = String(payload.paymentDataFingerprint ?? '').trim();
    const email = String(payload.email ?? '').trim();
    const validatedAt = String(payload.validatedAt ?? '').trim();
    const cardSummary = this.asObject(payload.cardSummary);
    const cardLast4 = this.normalizeCardLast4(cardSummary.last4);

    if (!fingerprint || !email || !validatedAt || !cardLast4) {
      return null;
    }

    return {
      sessionId: normalizedSessionId,
      status:
        String(payload.status ?? '').trim().toUpperCase() === 'EXPIRED'
          ? 'EXPIRED'
          : 'VALIDATED',
      gateway: 'PAYSTACK',
      channel: 'CARD',
      useSavedCard: Boolean(payload.useSavedCard),
      savedPaymentMethodId: null,
      savedCardId: String(payload.savedCardId ?? '').trim() || null,
      email,
      validatedAt,
      expiresAt: persisted.expiresAt.toISOString(),
      cardSummary: {
        source: String(cardSummary.source ?? '').trim().toLowerCase() === 'saved' ? 'saved' : 'new',
        brand: this.normalizeCardText(cardSummary.brand),
        bank: this.normalizeCardText(cardSummary.bank),
        last4: cardLast4,
        expMonth: this.normalizeCardText(cardSummary.expMonth),
        expYear: this.normalizeCardText(cardSummary.expYear),
        holderName: this.normalizeCardText(cardSummary.holderName),
      },
      paymentMethod: PaymentMethod.PAYSTACK,
      paymentDataFingerprint: fingerprint,
      storage: 'idempotency',
    };
  }

  private getCardValidationSessionTtlMinutes(): number {
    const parsed = Number.parseInt(
      String(process.env.PAYMENT_CARD_VALIDATION_TTL_MINUTES ?? ''),
      10,
    );

    if (!Number.isFinite(parsed)) {
      return DEFAULT_CARD_VALIDATION_TTL_MINUTES;
    }

    return Math.min(240, Math.max(5, parsed));
  }

  private buildCardValidationSessionKey(sessionId: string): string {
    const normalized = String(sessionId ?? '').trim();
    return `${CARD_VALIDATION_SESSION_KEY_PREFIX}${normalized}`;
  }

  private getIdempotencyKeyModel() {
    const idempotencyKeyModel = (this.prisma as any)['idempotencyKey'];
    if (!idempotencyKeyModel) {
      throw new InternalServerErrorException(
        'Prisma model delegate "idempotencyKey" is not available on PrismaService',
      );
    }

    return idempotencyKeyModel;
  }

  private getSavedPaymentMethodModel() {
    return (this.prisma as any)['savedPaymentMethod'] ?? null;
  }

  private getCardValidationSessionModel() {
    return (this.prisma as any)['cardValidationSession'] ?? null;
  }

  private toCardValidationSessionSummary(
    session: StoredCardValidationSession,
  ): CardValidationSessionSummary {
    return {
      sessionId: session.sessionId,
      status: session.status,
      gateway: session.gateway,
      channel: session.channel,
      useSavedCard: session.useSavedCard,
      savedPaymentMethodId: session.savedPaymentMethodId,
      savedCardId: session.savedCardId,
      email: session.email,
      validatedAt: session.validatedAt,
      expiresAt: session.expiresAt,
      cardSummary: session.cardSummary,
    };
  }

  private parseBooleanEnv(name: string, defaultValue: boolean) {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) {
      return defaultValue;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(raw)) {
      return false;
    }
    return defaultValue;
  }

  private parseBooleanEnvOptional(name: string): boolean | null {
    const raw = String(process.env[name] ?? '').trim().toLowerCase();
    if (!raw) {
      return null;
    }
    if (['1', 'true', 'yes', 'on'].includes(raw)) {
      return true;
    }
    if (['0', 'false', 'no', 'off'].includes(raw)) {
      return false;
    }
    return null;
  }

  private parsePercentEnv(name: string, defaultValue: number) {
    const parsed = Number.parseInt(String(process.env[name] ?? ''), 10);
    if (!Number.isFinite(parsed)) {
      return defaultValue;
    }
    return Math.min(100, Math.max(0, parsed));
  }

  private getUserCanaryBucket(userId: string) {
    const digest = createHash('sha256').update(String(userId ?? '')).digest('hex');
    return Number.parseInt(digest.slice(0, 8), 16) % 100;
  }

  private isCanonicalSavedMethodsEnabledForUser(userId: string) {
    if (!this.parseBooleanEnv(PAYMENT_SAVED_METHODS_FLAG, false)) {
      return false;
    }

    const percent = this.parsePercentEnv(PAYMENT_SAVED_METHODS_CANARY_PERCENT, 100);
    if (percent >= 100) {
      return true;
    }
    if (percent <= 0) {
      return false;
    }

    return this.getUserCanaryBucket(userId) < percent;
  }

  private isValidationGateEnabledForUser(_userId: string) {
    if (!this.parseBooleanEnv(PAYMENT_VALIDATION_GATE_FLAG, true)) {
      return false;
    }

    // Validation-gate behavior must remain deterministic for all users in an environment.
    return true;
  }

  private isSavedPaymentMethodBackfillEnabled() {
    const configured = this.parseBooleanEnvOptional(PAYMENT_SAVED_METHODS_BACKFILL_FLAG);
    if (configured != null) {
      return configured;
    }

    const legacyConfigured = this.parseBooleanEnvOptional(
      PAYMENT_SAVED_METHODS_BACKFILL_LEGACY_FLAG,
    );
    if (legacyConfigured != null) {
      return legacyConfigured;
    }

    return true;
  }

  private normalizeSavedCardIdentifier(value: string) {
    const normalized = String(value ?? '').trim();
    if (!normalized) {
      return '';
    }
    return normalized.startsWith('paystack-')
      ? normalized.slice('paystack-'.length)
      : normalized;
  }

  private mapSavedPaymentMethodToSummary(savedMethod: any): SavedPaymentCardSummary {
    const createdAt = savedMethod?.createdAt
      ? new Date(savedMethod.createdAt).toISOString()
      : new Date().toISOString();
    const updatedAt = savedMethod?.updatedAt
      ? new Date(savedMethod.updatedAt).toISOString()
      : createdAt;
    const lastUsedAt = savedMethod?.lastUsedAt
      ? new Date(savedMethod.lastUsedAt).toISOString()
      : updatedAt;

    return {
      id: String(savedMethod?.id ?? '').trim(),
      gateway: 'PAYSTACK',
      brand: this.normalizeCardText(savedMethod?.brand),
      bank: this.normalizeCardText(savedMethod?.bank),
      last4: this.normalizeCardLast4(savedMethod?.last4) ?? '0000',
      expMonth: this.normalizeCardText(savedMethod?.expMonth),
      expYear: this.normalizeCardText(savedMethod?.expYear),
      reusable: String(savedMethod?.status ?? '').trim().toUpperCase() === 'ACTIVE',
      isDefault: Boolean(savedMethod?.isDefault),
      addedAt: createdAt,
      lastUsedAt,
    };
  }

  private async listCanonicalSavedPaymentCards(
    userId: string,
  ): Promise<SavedPaymentCardSummary[]> {
    const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
    if (!savedPaymentMethodModel) {
      return [];
    }

    const methods = await savedPaymentMethodModel.findMany({
      where: {
        buyerId: userId,
        provider: 'PAYSTACK',
        paymentMethod: PaymentMethod.PAYSTACK,
        status: 'ACTIVE',
      },
      orderBy: [{ isDefault: 'desc' }, { lastUsedAt: 'desc' }, { updatedAt: 'desc' }],
      take: 50,
    });

    return methods.map((method: any) => this.mapSavedPaymentMethodToSummary(method));
  }

  private async resolveCanonicalSavedPaymentMethodId(
    userId: string,
    savedCardId: string,
  ): Promise<string | null> {
    const normalizedId = this.normalizeSavedCardIdentifier(savedCardId);
    if (!normalizedId || !this.isCanonicalSavedMethodsEnabledForUser(userId)) {
      return null;
    }

    const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
    if (!savedPaymentMethodModel) {
      return null;
    }

    const method = await savedPaymentMethodModel.findFirst({
      where: {
        id: normalizedId,
        buyerId: userId,
        provider: 'PAYSTACK',
        paymentMethod: PaymentMethod.PAYSTACK,
        status: 'ACTIVE',
      },
      select: { id: true },
    });

    return method?.id ?? null;
  }

  private getSavedPaymentMethodEncryptionKey(): Buffer | null {
    const secret = String(process.env[PAYMENT_SAVED_METHODS_SECRET] ?? '').trim();
    if (!secret) {
      return null;
    }
    return createHash('sha256').update(secret).digest();
  }

  private encryptSavedPaymentMethodAuthorizationCode(value: string | null): string | null {
    const raw = String(value ?? '').trim();
    if (!raw) {
      return null;
    }

    const key = this.getSavedPaymentMethodEncryptionKey();
    if (!key) {
      this.logger.warn(
        `${PAYMENT_SAVED_METHODS_SECRET} is not configured. Skipping authorization-code encryption for saved method migration.`,
      );
      return null;
    }

    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(raw, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decryptSavedPaymentMethodAuthorizationCode(value?: string | null): string | null {
    const payload = String(value ?? '').trim();
    if (!payload) {
      return null;
    }

    const key = this.getSavedPaymentMethodEncryptionKey();
    if (!key) {
      return null;
    }

    try {
      const [ivText, tagText, encryptedText] = payload.split('.');
      if (!ivText || !tagText || !encryptedText) {
        return null;
      }

      const decipher = createDecipheriv(
        'aes-256-gcm',
        key,
        Buffer.from(ivText, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      return null;
    }
  }

  private async collectLegacySavedPaystackCardsWithAuthorization(userId: string) {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        buyerId: userId,
        provider: 'PAYSTACK',
        status: 'PAID',
      },
      select: {
        id: true,
        channel: true,
        providerChannel: true,
        requestSnapshot: true,
        responseSnapshot: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { updatedAt: 'desc' },
      take: 240,
    });

    if (attempts.length === 0) {
      return [] as Array<{
        summary: SavedPaymentCardSummary;
        sourcePaymentAttemptId: string;
        authorizationCode: string | null;
        identityKey: string;
      }>;
    }

    const events = await this.prisma.paymentEvent.findMany({
      where: {
        paymentAttemptId: { in: attempts.map((attempt) => attempt.id) },
        source: 'webhook',
      },
      select: {
        paymentAttemptId: true,
        payload: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 600,
    });

    const webhookPayloadByAttemptId = new Map<string, Record<string, any>>();
    for (const event of events) {
      if (webhookPayloadByAttemptId.has(event.paymentAttemptId)) {
        continue;
      }
      const payload = this.asObject(event.payload);
      if (payload) {
        webhookPayloadByAttemptId.set(event.paymentAttemptId, payload);
      }
    }

    const results: Array<{
      summary: SavedPaymentCardSummary;
      sourcePaymentAttemptId: string;
      authorizationCode: string | null;
      identityKey: string;
    }> = [];
    const seenIdentityKeys = new Set<string>();

    for (const attempt of attempts) {
      const requestSnapshot = this.asObject(attempt.requestSnapshot);
      const responseSnapshot = this.asObject(attempt.responseSnapshot);
      if (requestSnapshot?.saveNewCard === false) {
        continue;
      }

      const channelCandidates = [
        attempt.channel,
        attempt.providerChannel,
        responseSnapshot?.providerVerificationChannel,
        responseSnapshot?.providerWebhookChannel,
        requestSnapshot?.channel,
      ];
      const isCardAttempt = channelCandidates.some(
        (value) => String(value ?? '').trim().toUpperCase() === 'CARD',
      );
      if (!isCardAttempt) {
        continue;
      }

      const extracted = this.extractSavedPaystackCard(
        responseSnapshot,
        webhookPayloadByAttemptId.get(attempt.id) ?? null,
      );
      if (!extracted || seenIdentityKeys.has(extracted.identityKey)) {
        continue;
      }

      seenIdentityKeys.add(extracted.identityKey);
      results.push({
        sourcePaymentAttemptId: attempt.id,
        authorizationCode: extracted.authorizationCode,
        identityKey: extracted.identityKey,
        summary: {
          id: attempt.id,
          gateway: 'PAYSTACK',
          brand: extracted.brand,
          bank: extracted.bank,
          last4: extracted.last4,
          expMonth: extracted.expMonth,
          expYear: extracted.expYear,
          reusable: extracted.reusable,
          addedAt: attempt.createdAt.toISOString(),
          lastUsedAt: attempt.updatedAt.toISOString(),
        },
      });
    }

    return results;
  }

  private async backfillSavedPaymentMethodsFromAttempts(userId: string) {
    const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
    if (!savedPaymentMethodModel) {
      return 0;
    }

    const inferredCards = await this.collectLegacySavedPaystackCardsWithAuthorization(userId);
    if (inferredCards.length === 0) {
      return 0;
    }

    let hasDefault = Boolean(
      await savedPaymentMethodModel.findFirst({
        where: {
          buyerId: userId,
          status: 'ACTIVE',
          isDefault: true,
        },
        select: { id: true },
      }),
    );

    let processed = 0;
    for (const card of inferredCards) {
      const encryptedAuthorizationCode = this.encryptSavedPaymentMethodAuthorizationCode(
        card.authorizationCode,
      );

      const upserted = await savedPaymentMethodModel.upsert({
        where: {
          buyerId_providerAuthorizationSignature: {
            buyerId: userId,
            providerAuthorizationSignature: card.identityKey,
          },
        },
        update: {
          status: 'ACTIVE',
          brand: card.summary.brand,
          bank: card.summary.bank,
          last4: card.summary.last4,
          expMonth: card.summary.expMonth,
          expYear: card.summary.expYear,
          lastUsedAt: new Date(card.summary.lastUsedAt),
          providerAuthorizationCodeEncrypted:
            encryptedAuthorizationCode ?? undefined,
          providerAuthorizationMeta: {
            reusable: card.summary.reusable,
            migratedFromAttemptId: card.sourcePaymentAttemptId,
          },
        },
        create: {
          id: uuidv4(),
          buyerId: userId,
          provider: 'PAYSTACK',
          paymentMethod: PaymentMethod.PAYSTACK,
          status: 'ACTIVE',
          isDefault: !hasDefault,
          brand: card.summary.brand,
          bank: card.summary.bank,
          last4: card.summary.last4,
          expMonth: card.summary.expMonth,
          expYear: card.summary.expYear,
          holderName: null,
          providerAuthorizationCodeEncrypted:
            encryptedAuthorizationCode ?? undefined,
          providerAuthorizationSignature: card.identityKey,
          providerAuthorizationMeta: {
            reusable: card.summary.reusable,
            migratedFromAttemptId: card.sourcePaymentAttemptId,
          },
          sourcePaymentAttemptId: card.sourcePaymentAttemptId,
          lastUsedAt: new Date(card.summary.lastUsedAt),
        },
      });

      if (!hasDefault && upserted) {
        hasDefault = true;
      }
      processed += 1;
    }

    return processed;
  }

  private extractErrorMessage(error: any): string {
    if (Array.isArray(error?.response?.message)) {
      return error.response.message.map((entry: unknown) => String(entry)).join('; ');
    }

    if (typeof error?.response?.message === 'string') {
      return error.response.message;
    }

    return String(error?.message || 'Unknown reconciliation failure');
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

      if (
        String(paymentData.channel || '').toUpperCase() === 'CARD' &&
        paymentData.useSavedCard
      ) {
        if (!String(paymentData.savedCardId ?? '').trim()) {
          throw new BadRequestException('Select a saved card or switch to a new card');
        }
        return paymentData;
      }

      if (this.hasRawPaystackCardDetails(paymentData)) {
        if (!this.isPaystackCustomCardEntryEnabled()) {
          throw new BadRequestException(
            'Do not send raw card details to Threadly. Enter card number, CVV, PIN, and OTP on the hosted secure checkout screen.',
          );
        }

        this.validatePaystackCardDraft(paymentData);
        return paymentData;
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

  private resolveCallbackBaseUrl(_callbackUrl?: string): string {
    // SECURITY: The caller-supplied callbackUrl parameter is intentionally ignored.
    // Accepting arbitrary redirect URLs from clients is an open-redirect vulnerability —
    // an attacker could redirect buyers to a phishing page after Paystack checkout.
    // The callback URL is always resolved from the server environment only.
    return (
      process.env.FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL?.trim() ||
      `${resolveWebAppBaseUrl()}/bag/payment-return`
    );
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
    // Default is 'live'. To use mock/test mode, explicitly set PAYMENTS_MODE=mock in your .env.
    // We do NOT default to mock to prevent accidental mock-mode deploys in production.
    return (process.env.PAYMENTS_MODE ?? 'live').trim().toLowerCase() !== 'live';
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

  private hasRedisRuntimeConfiguration(): boolean {
    const redisUrl = String(process.env.REDIS_URL ?? '').trim();
    if (redisUrl) {
      return true;
    }

    const redisHost = String(process.env.REDIS_HOST ?? '').trim();
    const redisPort = String(process.env.REDIS_PORT ?? '').trim();
    return Boolean(redisHost && redisPort);
  }

  private resolveUnifiedInitLockTtlMs(): number {
    const configured = Number(
      String(process.env.PAYMENT_UNIFIED_INIT_LOCK_TTL_MS ?? '').trim(),
    );
    if (!Number.isFinite(configured) || configured <= 0) {
      return PAYMENT_UNIFIED_INIT_LOCK_TTL_MS;
    }

    return Math.max(5_000, Math.min(120_000, Math.trunc(configured)));
  }

  private resolveCorrelationId(candidate: unknown, prefix = 'payment'): string {
    const normalized = String(candidate ?? '').trim();
    if (normalized) {
      return normalized.slice(0, 128);
    }

    return `${prefix}-${uuidv4()}`;
  }

  private async withUnifiedCheckoutInitializationLock<T>(
    userId: string,
    correlationId: string,
    callback: () => Promise<T>,
  ): Promise<T> {
    const normalizedUserId = String(userId ?? '').trim();
    if (!normalizedUserId) {
      throw new BadRequestException('Unable to resolve buyer identity for checkout initialization');
    }

    const redis = await this.webhookEventsQueue.getRedisClient().catch((error) => {
      this.logger.error(
        `Failed to resolve Redis client for checkout initialization lock [corr=${correlationId}]: ${this.extractErrorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        'Unable to enforce checkout initialization concurrency lock.',
      );
    });

    const lockKey = paymentUnifiedInitLockKey(normalizedUserId);
    const ownerToken = uuidv4();
    const ttlMs = this.resolveUnifiedInitLockTtlMs();

    let acquired = false;
    try {
      const result = await redis.set(lockKey, ownerToken, 'NX', 'PX', ttlMs);
      acquired = result === 'OK';
    } catch (error) {
      this.logger.error(
        `Checkout initialization lock acquisition failed for user=${normalizedUserId} [corr=${correlationId}]: ${this.extractErrorMessage(error)}`,
      );
      throw new InternalServerErrorException(
        'Unable to enforce checkout initialization concurrency lock.',
      );
    }

    if (!acquired) {
      throw new ConflictException(
        'A checkout initialization is already in progress for this account. Please retry in a few seconds.',
      );
    }

    try {
      return await callback();
    } finally {
      try {
        await redis.eval(
          'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end',
          1,
          lockKey,
          ownerToken,
        );
      } catch (error) {
        this.logger.warn(
          `Checkout initialization lock release failed for user=${normalizedUserId} [corr=${correlationId}]: ${this.extractErrorMessage(error)}`,
        );
      }
    }
  }

  private assertProductionCheckoutCallbackConfiguration(): void {
    const callbackUrl = this.resolveCallbackBaseUrl();

    let parsed: URL;
    try {
      parsed = new URL(callbackUrl);
    } catch {
      throw new Error(
        'FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL (or WEB_APP_URL) must be a valid absolute URL in production.',
      );
    }

    if (parsed.protocol !== 'https:') {
      throw new Error(
        'Checkout callback URL must use HTTPS in production (set FRONTEND_PUBLIC_CHECKOUT_CALLBACK_URL).',
      );
    }

    if (this.isPrivateOrLoopbackHostname(parsed.hostname)) {
      throw new Error(
        'Checkout callback URL cannot point to loopback/private network hosts in production.',
      );
    }
  }

  private isPrivateOrLoopbackHostname(hostname: string): boolean {
    const normalized = String(hostname ?? '').trim().toLowerCase();
    if (!normalized) {
      return true;
    }

    if (
      normalized === 'localhost' ||
      normalized === '127.0.0.1' ||
      normalized === '::1'
    ) {
      return true;
    }

    if (/^10\./.test(normalized)) {
      return true;
    }
    if (/^192\.168\./.test(normalized)) {
      return true;
    }
    if (/^169\.254\./.test(normalized)) {
      return true;
    }

    const octets = normalized.split('.');
    if (octets.length === 4 && octets.every((part) => /^\d+$/.test(part))) {
      const first = Number(octets[0]);
      const second = Number(octets[1]);
      if (first === 172 && second >= 16 && second <= 31) {
        return true;
      }
    }

    return false;
  }

  private allowPaymentSimulation(): boolean {
    // Default is false. Simulation must be explicitly enabled for dev/staging only.
    return (process.env.ALLOW_PAYMENT_SIMULATION ?? 'false').trim().toLowerCase() === 'true';
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
      const secret = this.resolvePaystackSecret();
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
    // SECURITY: Only use the resolved remoteAddress (req.ip from NestJS).
    //
    // We do NOT read X-Forwarded-For here. Any HTTP client can inject arbitrary
    // IPs into that header, including real Paystack IPs, which would allow
    // bypassing the allowlist entirely. Using candidates.some() against a combined
    // list of all forwarded IPs is the vulnerability — one spoofed Paystack IP
    // in the chain would pass the check regardless of where the request actually came from.
    //
    // When TRUST_PROXY is configured in main.ts, Express resolves req.ip to the
    // actual client IP after the trusted proxy hop, so this is both safe and correct
    // behind a load balancer.
    const directIp = this.normalizeIp(context.remoteAddress);
    return directIp ? [directIp] : [];
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

  private async recordWebhookIngressRejection(params: {
    provider: string;
    rejectionReason: 'INVALID_SIGNATURE' | 'UNKNOWN_REFERENCE' | 'MALFORMED_PAYLOAD';
    payloadSnapshot: unknown;
    context: WebhookContext;
    correlationId: string;
    reference?: string | null;
    paymentAttemptId?: string | null;
    providerEventType?: string | null;
    providerEventKey?: string | null;
  }): Promise<void> {
    try {
      await (this.prisma as any).webhookIngressAudit.create({
        data: {
          domain: 'PAYMENT',
          provider: params.provider,
          rejectionReason: params.rejectionReason,
          correlationId: params.correlationId,
          paymentAttemptId: params.paymentAttemptId ?? null,
          reference: params.reference ?? null,
          providerEventType: params.providerEventType ?? null,
          providerEventKey: params.providerEventKey ?? null,
          remoteAddress: params.context.remoteAddress ?? null,
          headersSnapshot: this.buildWebhookHeadersSnapshot(params.context.headers),
          payloadSnapshot: params.payloadSnapshot as Prisma.InputJsonValue,
          receivedAt: new Date(),
        },
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist webhook ingress rejection audit for ${params.provider}: ${this.extractErrorMessage(error)}`,
      );
    }
  }

  private async recordWebhookRetryAttempt(params: {
    paymentAttemptId: string;
    reference: string;
    providerEventKey: string;
    correlationId: string;
    source: WebhookProcessSource;
    queueAttempt: number | null;
    queueJobId: string | null;
    error: unknown;
  }): Promise<void> {
    const now = new Date();
    const reason = this.extractErrorMessage(params.error);

    try {
      await this.prisma.$transaction(async (tx) => {
        const current = await tx.paymentAttempt.findUnique({
          where: { id: params.paymentAttemptId },
          select: {
            id: true,
            webhookFirstRetriedAt: true,
          },
        });
        if (!current) {
          return;
        }

        await tx.paymentAttempt.update({
          where: { id: params.paymentAttemptId },
          data: {
            webhookRetryCount: {
              increment: 1,
            },
            webhookFirstRetriedAt: current.webhookFirstRetriedAt ?? now,
            webhookLastRetriedAt: now,
            webhookLastRetryReason: reason,
          },
        });

        await tx.paymentEvent.create({
          data: {
            paymentAttemptId: params.paymentAttemptId,
            type: 'WEBHOOK_RETRY',
            source: 'webhook-retry',
            correlationId: params.correlationId,
            processedAt: now,
            payload: {
              reference: params.reference,
              providerEventKey: params.providerEventKey,
              source: params.source,
              queueAttempt: params.queueAttempt,
              queueJobId: params.queueJobId,
              reason,
              recordedAt: now.toISOString(),
            },
          },
        });
      });
    } catch (error) {
      this.logger.error(
        `Failed to persist webhook retry metadata for ${params.reference}: ${this.extractErrorMessage(error)}`,
      );
    }
  }

  private async recordWebhookProcessingFailure(params: {
    paymentAttemptId: string;
    gateway: string;
    reference: string;
    providerEventKey: string;
    providerEventType: string | null;
    payload: Record<string, any>;
    correlationId: string;
    source: WebhookProcessSource;
    queueAttempt: number | null;
    queueJobId: string | null;
    error: unknown;
  }): Promise<void> {
    const now = new Date();
    const errorMessage = this.extractErrorMessage(params.error);

    this.logger.error(
      `Webhook processing failure for ${params.gateway} ${params.reference}: ${errorMessage}`,
    );

    try {
      await this.prisma.paymentEvent.create({
        data: {
          paymentAttemptId: params.paymentAttemptId,
          type: 'WEBHOOK_PROCESS_FAILED',
          source: 'webhook-processor',
          correlationId: params.correlationId,
          providerEventType: params.providerEventType,
          providerEventReceivedAt: now,
          payload: {
            gateway: params.gateway,
            reference: params.reference,
            providerEventKey: params.providerEventKey,
            source: params.source,
            queueAttempt: params.queueAttempt,
            queueJobId: params.queueJobId,
            correlationId: params.correlationId,
            failedAt: now.toISOString(),
            error: errorMessage,
            providerPayload: params.payload,
          },
        },
      });
    } catch (persistError) {
      this.logger.error(
        `Failed to persist webhook processing failure event for ${params.gateway} ${params.reference}: ${this.extractErrorMessage(
          persistError,
        )}`,
      );
    }
  }

  private buildWebhookHeadersSnapshot(
    headers: Record<string, string | string[] | undefined>,
  ): Record<string, string | string[]> {
    const snapshot: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (value == null) {
        continue;
      }

      if (Array.isArray(value)) {
        snapshot[key.toLowerCase()] = value
          .map((entry) => String(entry ?? '').trim())
          .filter(Boolean);
        continue;
      }

      const normalized = String(value).trim();
      if (normalized) {
        snapshot[key.toLowerCase()] = normalized;
      }
    }

    return snapshot;
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

  private resolvePaystackSecret() {
    return resolvePaystackSecretFromEnv();
  }

  private getRequiredPaystackSecret(contextLabel: string) {
    const secret = this.resolvePaystackSecret();
    if (!secret) {
      throw new BadRequestException(
        `Paystack secret is required for ${contextLabel}. Configure one of: ${describePaystackSecretEnvKeys()}`,
      );
    }
    return secret;
  }

  private isPaystackCustomCardEntryEnabled(): boolean {
    return (
      String(process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED ?? 'false')
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  private resolvePaystackCardholderNameMatchMode(): PaystackCardholderNameMatchMode {
    const configured = String(
      process.env.PAYSTACK_CARDHOLDER_NAME_MATCH_MODE ?? '',
    )
      .trim()
      .toLowerCase();

    if (configured === 'strict' || configured === 'soft' || configured === 'off') {
      return configured;
    }

    const envMarker = String(
      process.env.APP_ENV ?? process.env.DEPLOY_ENV ?? process.env.NODE_ENV ?? '',
    )
      .trim()
      .toLowerCase();

    return ['development', 'dev', 'test', 'qa', 'uat', 'local'].includes(envMarker)
      ? 'soft'
      : 'strict';
  }

  private sanitizePaymentDataForStorage(
    paymentMethod: PaymentMethod,
    paymentData: Record<string, any>,
  ): Record<string, any> {
    if (paymentMethod !== PaymentMethod.PAYSTACK) {
      return paymentData;
    }

    const next = { ...paymentData };
    delete next.cardNumber;
    delete next.cvv;
    delete next.expiry;
    delete next.cardHolderName;
    delete next.pin;
    delete next.otp;
    delete next.phoneOtp;
    delete next.pan;
    delete next.cvc;
    delete next.validationSessionId;

    if (this.hasRawPaystackCardDetails(paymentData)) {
      const draft = this.getNormalizedPaystackCardDraft(paymentData);
      next.newCardDraft = {
        cardHolderName: draft.cardHolderName,
        expiry: `${draft.expiryMonth}/${draft.expiryYear}`,
        last4: draft.last4,
        maskedCardNumber: draft.maskedCardNumber,
      };
    } else {
      const storedDraft = this.asObject(paymentData.newCardDraft);
      const storedLast4 = this.normalizeCardLast4(storedDraft.last4);
      if (!storedLast4) {
        next.newCardDraft = null;
      } else {
        const storedMasked =
          this.normalizeCardText(storedDraft.maskedCardNumber) ??
          `******${storedLast4}`;
        next.newCardDraft = {
          cardHolderName: this.normalizeCardText(storedDraft.cardHolderName) ?? '',
          expiry: this.normalizeCardText(storedDraft.expiry) ?? '',
          last4: storedLast4,
          maskedCardNumber: storedMasked,
        };
      }
    }

    next.saveNewCard = Boolean(paymentData.saveNewCard ?? true);
    return next;
  }

  private normalizeNameTokens(value: string): string[] {
    return String(value ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, ' ')
      .split(' ')
      .map((token) => token.trim())
      .filter(Boolean)
      .sort();
  }

  private namesMatch(left: string, right: string): boolean {
    const leftTokens = this.normalizeNameTokens(left);
    const rightTokens = this.normalizeNameTokens(right);
    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return true;
    }
    if (leftTokens.length !== rightTokens.length) {
      return false;
    }
    return leftTokens.every((token, index) => token === rightTokens[index]);
  }

  private namesSoftMatch(left: string, right: string): boolean {
    const leftTokens = this.normalizeNameTokens(left);
    const rightTokens = this.normalizeNameTokens(right);
    if (leftTokens.length === 0 || rightTokens.length === 0) {
      return true;
    }

    const rightTokenSet = new Set(rightTokens);
    return leftTokens.some((token) => rightTokenSet.has(token));
  }

  private isLuhnValid(value: string): boolean {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length < 12) {
      return false;
    }

    let sum = 0;
    let shouldDouble = false;
    for (let index = digits.length - 1; index >= 0; index -= 1) {
      let digit = Number(digits[index]);
      if (shouldDouble) {
        digit *= 2;
        if (digit > 9) {
          digit -= 9;
        }
      }
      sum += digit;
      shouldDouble = !shouldDouble;
    }

    return sum % 10 === 0;
  }

  private getNormalizedPaystackCardDraft(paymentData: Record<string, any>) {
    const draft = this.asObject(paymentData.newCardDraft) ?? {};
    const cardNumber = String(draft.cardNumber ?? paymentData.cardNumber ?? '')
      .replace(/\D/g, '')
      .trim();
    const cvv = String(draft.cvv ?? paymentData.cvv ?? '')
      .replace(/\D/g, '')
      .trim();
    const expiry = String(draft.expiry ?? paymentData.expiry ?? '').trim();
    const expiryMatch = expiry.match(/^(\d{2})\/(\d{2})$/);
    const expiryMonth = expiryMatch?.[1] ?? '';
    const expiryYear = expiryMatch?.[2] ?? '';
    const last4 = cardNumber.length >= 4 ? cardNumber.slice(-4) : '';
    const maskedCardNumber =
      cardNumber.length >= 4
        ? `${'*'.repeat(Math.max(cardNumber.length - 4, 6))}${last4}`
        : '';

    return {
      cardHolderName: String(
        draft.cardHolderName ?? paymentData.cardHolderName ?? '',
      ).trim(),
      cardNumber,
      cvv,
      expiry,
      expiryMonth,
      expiryYear,
      last4,
      maskedCardNumber,
    };
  }

  private validatePaystackCardDraft(paymentData: Record<string, any>) {
    const draft = this.getNormalizedPaystackCardDraft(paymentData);

    if (!draft.cardHolderName) {
      throw new BadRequestException('Card holder name is required');
    }

    if (
      draft.cardNumber.length < 12 ||
      draft.cardNumber.length > 19 ||
      !this.isLuhnValid(draft.cardNumber)
    ) {
      throw new BadRequestException('Enter a valid card number');
    }

    if (!draft.expiryMonth || !draft.expiryYear) {
      throw new BadRequestException('Expiry must be in MM/YY format');
    }

    const expiryMonth = Number(draft.expiryMonth);
    const expiryYear = Number(draft.expiryYear);
    if (expiryMonth < 1 || expiryMonth > 12) {
      throw new BadRequestException('Enter a valid expiry month');
    }

    const expiryDate = new Date(2000 + expiryYear, expiryMonth, 0, 23, 59, 59, 999);
    if (Number.isNaN(expiryDate.getTime()) || expiryDate.getTime() < Date.now()) {
      throw new BadRequestException('Card expiry date has passed');
    }

    if (draft.cvv.length < 3 || draft.cvv.length > 4) {
      throw new BadRequestException('CVV must be 3 or 4 digits');
    }

    const cardholderMode = this.resolvePaystackCardholderNameMatchMode();
    if (cardholderMode === 'strict' || cardholderMode === 'soft') {
      const billingAddress = this.asObject(paymentData.billingAddress);
      const billingName = `${String(billingAddress?.firstName ?? '').trim()} ${String(
        billingAddress?.lastName ?? '',
      ).trim()}`.trim();

      if (billingName) {
        const nameMatches =
          cardholderMode === 'strict'
            ? this.namesMatch(draft.cardHolderName, billingName)
            : this.namesSoftMatch(draft.cardHolderName, billingName);

        if (!nameMatches) {
          throw new BadRequestException(
            cardholderMode === 'strict'
              ? 'Card holder name must match the billing name for this order'
              : 'Card holder name must closely match the billing name for this order',
          );
        }
      }
    }
  }

  private async resolveSavedPaystackAuthorizationCode(
    buyerId: string,
    savedCardId: string,
  ): Promise<string> {
    const normalizedSavedCardId = this.normalizeSavedCardIdentifier(savedCardId);
    if (!normalizedSavedCardId) {
      throw new BadRequestException('Select a valid saved card before continuing');
    }

    if (this.isCanonicalSavedMethodsEnabledForUser(buyerId)) {
      const savedPaymentMethodModel = this.getSavedPaymentMethodModel();
      if (savedPaymentMethodModel) {
        const canonicalMethod = await savedPaymentMethodModel.findFirst({
          where: {
            id: normalizedSavedCardId,
            buyerId,
            provider: 'PAYSTACK',
            paymentMethod: PaymentMethod.PAYSTACK,
            status: 'ACTIVE',
          },
          select: {
            id: true,
            providerAuthorizationCodeEncrypted: true,
          },
        });

        if (canonicalMethod) {
          const authorizationCode = this.decryptSavedPaymentMethodAuthorizationCode(
            canonicalMethod.providerAuthorizationCodeEncrypted,
          );
          if (!authorizationCode) {
            throw new BadRequestException(
              'This saved card can no longer be used. Remove it and add a new reusable card.',
            );
          }

          await savedPaymentMethodModel.update({
            where: { id: canonicalMethod.id },
            data: { lastUsedAt: new Date() },
          });

          return authorizationCode;
        }
      }
    }

    const attemptId = normalizedSavedCardId;

    // Legacy migration fallback: infer reusable authorization from historical paid attempts.

    const attempt = await this.prisma.paymentAttempt.findFirst({
      where: {
        id: attemptId,
        buyerId,
        provider: 'PAYSTACK',
        status: 'PAID',
      },
      select: {
        id: true,
        requestSnapshot: true,
        responseSnapshot: true,
      },
    });

    if (!attempt) {
      throw new BadRequestException('The selected saved card is no longer available');
    }

    const requestSnapshot = this.asObject(attempt.requestSnapshot);
    if (requestSnapshot?.saveNewCard === false) {
      throw new BadRequestException('This card was not saved for reuse');
    }

    const event = await this.prisma.paymentEvent.findFirst({
      where: {
        paymentAttemptId: attempt.id,
        source: 'webhook',
      },
      select: { payload: true },
      orderBy: { createdAt: 'desc' },
    });

    const extracted = this.extractSavedPaystackCard(
      this.asObject(attempt.responseSnapshot),
      this.asObject(event?.payload),
    );

    if (!extracted?.reusable || !extracted.authorizationCode) {
      throw new BadRequestException(
        'This saved card is not reusable yet. Complete a fresh card payment first.',
      );
    }

    return extracted.authorizationCode;
  }

  private hasRawPaystackCardDetails(paymentData: Record<string, any>) {
    const sensitiveFields = [
      'cardNumber',
      'cvv',
      'expiry',
      'cardHolderName',
      'pin',
      'otp',
      'phoneOtp',
      'pan',
      'cvc',
    ];
    const draft = this.asObject(paymentData.newCardDraft);

    return sensitiveFields.some((field) =>
      this.hasMeaningfulCardDetailValue(draft[field] ?? paymentData[field]),
    );
  }

  private hasMeaningfulCardDetailValue(value: unknown) {
    if (typeof value === 'string') {
      return value.trim().length > 0;
    }

    return typeof value === 'number';
  }

  private normalizeCardText(value: unknown): string | null {
    const normalized = String(value ?? '').trim();
    return normalized.length > 0 ? normalized : null;
  }

  private normalizeCardLast4(value: unknown): string | null {
    const digits = String(value ?? '').replace(/\D/g, '');
    if (digits.length < 4) {
      return null;
    }
    return digits.slice(-4);
  }

  private extractPaystackAuthorizationSnapshot(raw: unknown): Record<string, any> | null {
    const authorization = this.asObject(raw);
    if (!authorization) {
      return null;
    }

    const last4 = this.normalizeCardLast4(
      authorization.last4 ?? authorization.last_4 ?? authorization.lastDigits,
    );
    if (!last4) {
      return null;
    }

    return {
      brand: this.normalizeCardText(
        authorization.brand ?? authorization.card_type ?? authorization.cardType,
      ),
      bank: this.normalizeCardText(authorization.bank),
      last4,
      expMonth: this.normalizeCardText(
        authorization.exp_month ?? authorization.expMonth,
      ),
      expYear: this.normalizeCardText(
        authorization.exp_year ?? authorization.expYear,
      ),
      reusable: Boolean(authorization.reusable),
      signature: this.normalizeCardText(authorization.signature),
      authorizationCode: this.normalizeCardText(
        authorization.authorization_code ?? authorization.authorizationCode,
      ),
    };
  }

  private buildPaystackCardIdentityKey(snapshot: Record<string, any>): string {
    const signature = this.normalizeCardText(snapshot.signature);
    if (signature) {
      return `sig:${signature}`;
    }

    const authorizationCode = this.normalizeCardText(snapshot.authorizationCode);
    if (authorizationCode) {
      return `auth:${authorizationCode}`;
    }

    const brand = this.normalizeCardText(snapshot.brand) ?? 'CARD';
    const bank = this.normalizeCardText(snapshot.bank) ?? 'BANK';
    const last4 = this.normalizeCardLast4(snapshot.last4) ?? '0000';
    const expMonth = this.normalizeCardText(snapshot.expMonth) ?? '--';
    const expYear = this.normalizeCardText(snapshot.expYear) ?? '----';

    return `${brand}|${bank}|${last4}|${expMonth}|${expYear}`.toUpperCase();
  }

  private extractSavedPaystackCard(
    responseSnapshot: Record<string, any> | null,
    webhookPayload: Record<string, any> | null,
  ): ExtractedPaystackCard | null {
    const webhookData = this.asObject(webhookPayload?.data);
    const verificationPayload = this.asObject(responseSnapshot?.providerVerificationPayload);

    const candidates: unknown[] = [
      responseSnapshot?.providerAuthorization,
      responseSnapshot?.providerVerificationAuthorization,
      responseSnapshot?.providerWebhookAuthorization,
      responseSnapshot?.authorization,
      verificationPayload?.authorization,
      webhookData?.authorization,
      webhookPayload?.authorization,
    ];

    for (const candidate of candidates) {
      const snapshot = this.extractPaystackAuthorizationSnapshot(candidate);
      if (!snapshot) {
        continue;
      }

      const last4 = this.normalizeCardLast4(snapshot.last4);
      if (!last4) {
        continue;
      }

      return {
        brand: this.normalizeCardText(snapshot.brand),
        bank: this.normalizeCardText(snapshot.bank),
        last4,
        expMonth: this.normalizeCardText(snapshot.expMonth),
        expYear: this.normalizeCardText(snapshot.expYear),
        reusable: Boolean(snapshot.reusable),
        authorizationCode: this.normalizeCardText(snapshot.authorizationCode),
        identityKey: this.buildPaystackCardIdentityKey(snapshot),
      };
    }

    return null;
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
    authorization: Record<string, any> | null;
  }> {
    const secret = this.getRequiredPaystackSecret('Paystack payment verification');
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

    const rawAmount = payload?.data?.amount;
    if (rawAmount == null) {
      throw new BadRequestException(
        'Provider verification payload is missing the amount field',
      );
    }

    const amountMinor = Number(rawAmount);
    if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
      throw new BadRequestException(
        'Provider verification payload returned an invalid amount',
      );
    }

    const amount = amountMinor / 100;
    const currency = String(payload.data.currency || '').trim().toUpperCase() || null;
    if (
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
      const authorization = this.extractPaystackAuthorizationSnapshot(
        payload?.data?.authorization,
      );

    return {
      status: normalizedStatus,
      rawStatus,
      reference: providerReference,
      transactionId:
        payload.data.id != null ? String(payload.data.id).trim() || null : null,
      amount: this.roundMoney(amount),
      currency,
      channel:
        payload.data.channel != null
          ? String(payload.data.channel).trim().toUpperCase() || null
          : null,
      paidAt:
        payload.data.paid_at != null
          ? String(payload.data.paid_at).trim() || null
          : null,
      message:
        payload?.data?.gateway_response != null
          ? String(payload.data.gateway_response)
          : payload?.data?.message != null
            ? String(payload.data.message)
            : payload?.message != null
              ? String(payload.message)
              : null,
      authorization,
    };
  }

  private resolveShippingCostForState(state: string): number {
    const normalizedState = String(state ?? '').trim().toUpperCase();
    if (!normalizedState) {
      return CHECKOUT_DEFAULT_SHIPPING_RATE;
    }

    return CHECKOUT_SHIPPING_RATES[normalizedState] ?? CHECKOUT_DEFAULT_SHIPPING_RATE;
  }

  private buildPaymentReturnPath(reference: string, gateway: string) {
    const safeGateway = String(gateway || 'PAYSTACK').trim() || 'PAYSTACK';
    return `/bag/payment-return?reference=${encodeURIComponent(reference)}&gateway=${encodeURIComponent(safeGateway)}`;
  }

  private async loadUnifiedStandardLineDrafts(
    userId: string,
  ): Promise<UnifiedCheckoutStandardLineDraft[]> {
    const cartItems = await this.prisma.cartItem.findMany({
      where: { userId },
      include: {
        product: {
          select: {
            id: true,
            brandId: true,
            name: true,
            thumbnail: true,
            currency: true,
            price: true,
            salePrice: true,
            saleStartAt: true,
            saleEndAt: true,
            isActive: true,
            deletedAt: true,
            standardCheckoutEnabled: true,
            sizes: true,
            colors: true,
            totalStock: true,
            sizeStock: true,
            trackInventory: true,
            allowBackorders: true,
            sizingMode: true,
            customMeasurementKeys: true,
            brand: {
              select: {
                ownerId: true,
                isStoreOpen: true,
              },
            },
            variants: {
              select: {
                id: true,
                size: true,
                color: true,
                price: true,
                stock: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });

    if (cartItems.length === 0) {
      return [];
    }

    const selfOwned = cartItems.find((item) => item.product?.brand?.ownerId === userId);
    if (selfOwned) {
      throw new BadRequestException('You cannot place orders on your own products');
    }

    return cartItems.map((item) => {
      const product = item.product;
      if (!product || !product.isActive || product.deletedAt) {
        throw new BadRequestException('One or more cart products are no longer available');
      }
      if (product.standardCheckoutEnabled === false) {
        throw new BadRequestException(`Product is not available for checkout: ${product.name}`);
      }
      if (!product.brand?.isStoreOpen) {
        throw new BadRequestException(`Store is closed for product: ${product.name}`);
      }

      const variants = Array.isArray(product.variants) ? product.variants : [];
      const hasVariantSizes = variants.some((variant) => Boolean(variant.size));
      const hasVariantColors = variants.some((variant) => Boolean(variant.color));

      if ((hasVariantSizes || product.sizes.length > 0) && !item.selectedSize) {
        throw new BadRequestException(`Please select a size for ${product.name}`);
      }
      if (
        item.selectedSize &&
        product.sizes.length > 0 &&
        !product.sizes.includes(item.selectedSize)
      ) {
        throw new BadRequestException(`Invalid size selected for ${product.name}`);
      }

      if ((hasVariantColors || product.colors.length > 0) && !item.selectedColor) {
        throw new BadRequestException(`Please select a color for ${product.name}`);
      }
      if (
        item.selectedColor &&
        product.colors.length > 0 &&
        !product.colors.includes(item.selectedColor)
      ) {
        throw new BadRequestException(`Invalid color selected for ${product.name}`);
      }

      const selectedVariant =
        variants.length > 0
          ? variants.find(
              (variant) =>
                (variant.size || null) === (item.selectedSize || null) &&
                (variant.color || null) === (item.selectedColor || null),
            )
          : null;

      if (variants.length > 0 && !selectedVariant) {
        throw new BadRequestException(
          `Selected variant is not available for ${product.name}`,
        );
      }

      const quantity = Number(item.quantity ?? 0);
      if (!Number.isFinite(quantity) || quantity <= 0) {
        throw new BadRequestException(`Invalid quantity selected for ${product.name}`);
      }

      const baseUnitPrice = selectedVariant?.price
        ? Number(selectedVariant.price)
        : Number(product.price);
      const onSale = this.isProductOnSale(product);
      const unitPrice = selectedVariant?.price
        ? baseUnitPrice
        : onSale && product.salePrice
          ? Number(product.salePrice)
          : baseUnitPrice;

      if (!Number.isFinite(unitPrice) || unitPrice < 0) {
        throw new BadRequestException(`Invalid pricing detected for ${product.name}`);
      }

      const reserveInventory = Boolean(product.trackInventory) && !product.allowBackorders;
      if (reserveInventory) {
        if (selectedVariant) {
          if (Number(selectedVariant.stock ?? 0) < quantity) {
            throw new BadRequestException(
              `Insufficient stock for ${product.name} (${item.selectedSize || ''} ${item.selectedColor || ''})`,
            );
          }
        } else {
          const sizeStock = this.parseSizeStock(product.sizeStock);
          if (item.selectedSize && sizeStock && sizeStock[item.selectedSize] !== undefined) {
            if (Number(sizeStock[item.selectedSize] ?? 0) < quantity) {
              throw new BadRequestException(
                `Only ${sizeStock[item.selectedSize] || 0} left for ${product.name} (${item.selectedSize})`,
              );
            }
          } else if (Number(product.totalStock ?? 0) < quantity) {
            throw new BadRequestException(
              `Only ${product.totalStock} left for ${product.name}`,
            );
          }
        }
      }

      const sizingMode = this.normalizeSizingModeValue(item.sizingMode ?? product.sizingMode ?? null);
      const requiredMeasurementKeys = this.normalizeRequiredMeasurementKeys(
        item.requiredMeasurementKeys,
      );
      const sizeFitData = this.asObject(item.sizeFitData);

      return {
        cartItemId: item.id,
        brandId: product.brandId,
        productId: product.id,
        productName: product.name,
        thumbnail: product.thumbnail ?? null,
        quantity,
        selectedSize: item.selectedSize ?? null,
        selectedColor: item.selectedColor ?? null,
        currency: String(product.currency || 'NGN').trim().toUpperCase(),
        unitPrice: this.roundMoney(unitPrice),
        lineTotal: this.roundMoney(unitPrice * quantity),
        sizingMode,
        requiredMeasurementKeys,
        sizeFitData: Object.keys(sizeFitData).length > 0 ? sizeFitData : null,
        variantId: selectedVariant?.id ?? null,
        reserveInventory,
        sourceProduct: {
          id: product.id,
          trackInventory: Boolean(product.trackInventory),
          allowBackorders: Boolean(product.allowBackorders),
          totalStock: Number(product.totalStock ?? 0),
          sizeStock: this.parseSizeStock(product.sizeStock),
          sizes: Array.isArray(product.sizes) ? product.sizes : [],
          colors: Array.isArray(product.colors) ? product.colors : [],
        },
      };
    });
  }

  private async loadUnifiedCustomLineDrafts(userId: string): Promise<{
    lines: UnifiedCheckoutCustomLineDraft[];
    blocked: UnifiedCheckoutBlockedCustomLine[];
  }> {
    const sessions = await this.prisma.customOrderCheckoutSession.findMany({
      where: {
        buyerId: userId,
        customOrderId: null,
      },
      include: {
        checkoutIntent: {
          select: {
            id: true,
            configurationId: true,
            currency: true,
            requestSnapshotJson: true,
            buyerPriceSummaryJson: true,
            expiresAt: true,
            consumedAt: true,
          },
        },
      },
      orderBy: { submittedAt: 'asc' },
    });

    if (sessions.length === 0) {
      return {
        lines: [],
        blocked: [],
      };
    }

    const configurationIds = Array.from(
      new Set(sessions.map((session) => session.checkoutIntent.configurationId)),
    );
    const configurations = await this.prisma.customOrderConfiguration.findMany({
      where: {
        id: {
          in: configurationIds,
        },
      },
      select: {
        id: true,
        sourceType: true,
        sourceId: true,
        title: true,
        brand: {
          select: {
            name: true,
          },
        },
      },
    });
    const configurationById = new Map(
      configurations.map((configuration) => [configuration.id, configuration]),
    );

    const now = Date.now();
    const lines: UnifiedCheckoutCustomLineDraft[] = [];
    const blocked: UnifiedCheckoutBlockedCustomLine[] = [];

    for (const session of sessions) {
      const configuration = configurationById.get(session.checkoutIntent.configurationId);
      if (!configuration) {
        blocked.push({
          type: 'CUSTOM_ORDER',
          sessionId: session.id,
          checkoutIntentId: session.checkoutIntent.id,
          sourceTitle: 'Custom order item',
          reason: 'CONFIGURATION_NOT_FOUND',
        });
        continue;
      }

      const sourceTitle = String(configuration.title || 'Custom order item');
      if (session.checkoutIntent.consumedAt) {
        blocked.push({
          type: 'CUSTOM_ORDER',
          sessionId: session.id,
          checkoutIntentId: session.checkoutIntent.id,
          sourceTitle,
          reason: 'INTENT_ALREADY_CONSUMED',
        });
        continue;
      }

      if (session.checkoutIntent.expiresAt.getTime() <= now) {
        blocked.push({
          type: 'CUSTOM_ORDER',
          sessionId: session.id,
          checkoutIntentId: session.checkoutIntent.id,
          sourceTitle,
          reason: 'PRICE_LOCK_EXPIRED',
        });
        continue;
      }

      const requestSnapshot = this.asObject(session.checkoutIntent.requestSnapshotJson);
      const chartLock = this.asObject(requestSnapshot.chartLock);
      const quoteStatus = String(chartLock.quoteStatus || '').trim().toUpperCase();
      if (quoteStatus === 'MANUAL_QUOTE_REQUIRED') {
        blocked.push({
          type: 'CUSTOM_ORDER',
          sessionId: session.id,
          checkoutIntentId: session.checkoutIntent.id,
          sourceTitle,
          reason: 'MANUAL_QUOTE_REQUIRED',
        });
        continue;
      }

      const summary = this.asObject(session.checkoutIntent.buyerPriceSummaryJson);
      const grandTotal = this.roundMoney(Number(summary.grandTotal ?? 0));
      if (!Number.isFinite(grandTotal) || grandTotal <= 0) {
        blocked.push({
          type: 'CUSTOM_ORDER',
          sessionId: session.id,
          checkoutIntentId: session.checkoutIntent.id,
          sourceTitle,
          reason: 'INVALID_PRICE_LOCK',
        });
        continue;
      }

      lines.push({
        sessionId: session.id,
        checkoutIntentId: session.checkoutIntent.id,
        sourceTitle,
        sourceType: configuration.sourceType,
        sourceId: configuration.sourceId,
        sourcePrimaryMediaUrl: null,
        sourceBrandName: configuration.brand?.name ?? null,
        currency: String(session.checkoutIntent.currency || 'NGN').trim().toUpperCase(),
        lineTotal: grandTotal,
        unitPrice: grandTotal,
      });
    }

    return {
      lines,
      blocked,
    };
  }

  private normalizeSizingModeValue(value: unknown): SizingMode {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (
      normalized === 'RTW' ||
      normalized === 'CUSTOM' ||
      normalized === 'RTW_PLUS_CUSTOM' ||
      normalized === 'RTW_PLUS_FITTINGS'
    ) {
      return normalized as SizingMode;
    }
    return SizingMode.NONE;
  }

  private normalizeRequiredMeasurementKeys(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
      return [];
    }
    return Array.from(
      new Set(
        raw
          .map((entry) => String(entry ?? '').trim())
          .filter((entry) => entry.length > 0),
      ),
    );
  }

  private parseSizeStock(value: unknown): Record<string, number> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }

    const parsed: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      const numeric = Number(raw);
      if (Number.isFinite(numeric)) {
        parsed[key] = numeric;
      }
    }

    return Object.keys(parsed).length > 0 ? parsed : null;
  }

  private isProductOnSale(product: {
    salePrice: Prisma.Decimal | null;
    saleStartAt: Date | null;
    saleEndAt: Date | null;
  }) {
    if (!product.salePrice) {
      return false;
    }

    const now = Date.now();
    if (product.saleStartAt && product.saleStartAt.getTime() > now) {
      return false;
    }
    if (product.saleEndAt && product.saleEndAt.getTime() < now) {
      return false;
    }
    return true;
  }

  private buildUnifiedSummaryFromSession(
    checkoutSession: {
      id: string;
      currency: string;
      customerName: string | null;
      shippingAddressJson: unknown;
      summaryJson: unknown;
      lines?: Array<{
        quantity: number;
        unitPrice: Prisma.Decimal;
        itemSnapshotJson: unknown;
      }>;
    },
  ): UnifiedCheckoutFinalizeResult['summary'] {
    const summarySnapshot = this.asObject(checkoutSession.summaryJson);
    const shippingSnapshot = this.asObject(checkoutSession.shippingAddressJson);

    const itemsFromSnapshot = Array.isArray(summarySnapshot.items)
      ? summarySnapshot.items
          .map((entry) => {
            const item = this.asObject(entry);
            const name = String(item.name ?? '').trim();
            const quantity = Number(item.quantity ?? 0);
            const price = Number(item.price ?? 0);
            if (!name || !Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(price)) {
              return null;
            }
            return {
              name,
              quantity,
              price,
            };
          })
          .filter((entry): entry is { name: string; quantity: number; price: number } =>
            Boolean(entry),
          )
      : [];

    const fallbackItems = Array.isArray(checkoutSession.lines)
      ? checkoutSession.lines.map((line) => {
          const snapshot = this.asObject(line.itemSnapshotJson);
          return {
            name: String(snapshot.name ?? snapshot.sourceTitle ?? 'Item'),
            quantity: Number(line.quantity ?? 1),
            price: Number(line.unitPrice ?? 0),
          };
        })
      : [];

    const items = itemsFromSnapshot.length > 0 ? itemsFromSnapshot : fallbackItems;
    const subtotal = this.roundMoney(
      Number(
        summarySnapshot.subtotal ??
          items.reduce(
            (sum, item) => sum + Number(item.price ?? 0) * Number(item.quantity ?? 1),
            0,
          ),
      ),
    );
    const shippingCost = this.roundMoney(Number(summarySnapshot.shippingCost ?? 0));
    const discount = this.roundMoney(Number(summarySnapshot.discount ?? 0));
    const grandTotal = this.roundMoney(
      Number(summarySnapshot.grandTotal ?? subtotal + shippingCost - discount),
    );

    return {
      currency: checkoutSession.currency,
      items,
      subtotal,
      shippingCost,
      discount,
      grandTotal,
      shippingName: String(summarySnapshot.shippingName ?? checkoutSession.customerName ?? ''),
      shippingCity: String(summarySnapshot.shippingCity ?? shippingSnapshot.city ?? ''),
      shippingState: String(summarySnapshot.shippingState ?? shippingSnapshot.state ?? ''),
    };
  }

  private async reserveUnifiedStandardLineInventory(
    tx: Prisma.TransactionClient,
    checkoutSessionId: string,
    checkoutSessionLineId: string,
    line: UnifiedCheckoutStandardLineDraft,
    expiresAt: Date,
  ): Promise<void> {
    if (!line.reserveInventory) {
      return;
    }

    await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${line.productId}::uuid FOR UPDATE`;
    const lockedProduct = await tx.product.findUnique({
      where: { id: line.productId },
      select: {
        id: true,
        name: true,
        totalStock: true,
        sizeStock: true,
        trackInventory: true,
        allowBackorders: true,
      },
    });

    if (!lockedProduct) {
      throw new BadRequestException(`Product is no longer available: ${line.productName}`);
    }

    if (!lockedProduct.trackInventory || lockedProduct.allowBackorders) {
      return;
    }

    let nextSizeStock = this.parseSizeStock(lockedProduct.sizeStock);

    if (line.variantId) {
      await tx.$queryRaw`SELECT "id" FROM "ProductVariant" WHERE "id" = ${line.variantId}::uuid FOR UPDATE`;
      const updatedVariant = await tx.productVariant.updateMany({
        where: {
          id: line.variantId,
          productId: line.productId,
          stock: { gte: line.quantity },
        },
        data: {
          stock: {
            decrement: line.quantity,
          },
        },
      });

      if (updatedVariant.count === 0) {
        throw new BadRequestException(
          `Insufficient stock for ${line.productName} (${line.selectedSize || ''} ${line.selectedColor || ''})`,
        );
      }

      if (line.selectedSize && nextSizeStock && nextSizeStock[line.selectedSize] !== undefined) {
        const available = Number(nextSizeStock[line.selectedSize] ?? 0);
        if (available < line.quantity) {
          throw new BadRequestException(
            `Only ${available} left for ${line.productName} (${line.selectedSize})`,
          );
        }
        nextSizeStock[line.selectedSize] = available - line.quantity;
      }

      if (Number(lockedProduct.totalStock ?? 0) < line.quantity) {
        throw new BadRequestException(`Only ${lockedProduct.totalStock} left for ${line.productName}`);
      }

      await tx.product.update({
        where: { id: line.productId },
        data: {
          totalStock: {
            decrement: line.quantity,
          },
          ...(nextSizeStock ? { sizeStock: nextSizeStock } : {}),
        },
      });

      await tx.inventoryReservation.create({
        data: {
          checkoutSessionId,
          checkoutSessionLineId,
          productId: line.productId,
          productVariantId: line.variantId,
          quantity: line.quantity,
          reservedSize: line.selectedSize,
          reservedColor: line.selectedColor,
          status: InventoryReservationStatus.RESERVED,
          expiresAt,
        },
      });
      return;
    }

    if (line.selectedSize && nextSizeStock && nextSizeStock[line.selectedSize] !== undefined) {
      const available = Number(nextSizeStock[line.selectedSize] ?? 0);
      if (available < line.quantity) {
        throw new BadRequestException(
          `Only ${available} left for ${line.productName} (${line.selectedSize})`,
        );
      }
      nextSizeStock[line.selectedSize] = available - line.quantity;
    }

    if (Number(lockedProduct.totalStock ?? 0) < line.quantity) {
      throw new BadRequestException(`Only ${lockedProduct.totalStock} left for ${line.productName}`);
    }

    await tx.product.update({
      where: { id: line.productId },
      data: {
        totalStock: {
          decrement: line.quantity,
        },
        ...(nextSizeStock ? { sizeStock: nextSizeStock } : {}),
      },
    });

    await tx.inventoryReservation.create({
      data: {
        checkoutSessionId,
        checkoutSessionLineId,
        productId: line.productId,
        quantity: line.quantity,
        reservedSize: line.selectedSize,
        reservedColor: line.selectedColor,
        status: InventoryReservationStatus.RESERVED,
        expiresAt,
      },
    });
  }

  private async releaseUnifiedCheckoutAttempt(
    reference: string,
    userId: string,
    options?: { reason?: string },
  ): Promise<void> {
    const reason = String(options?.reason ?? 'ATTEMPT_FAILED').trim() || 'ATTEMPT_FAILED';
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${reference} FOR UPDATE`;
      const attempt = await tx.paymentAttempt.findUnique({
        where: { reference },
      });

      if (
        !attempt ||
        attempt.subjectType !== PaymentSubjectType.UNIFIED_CHECKOUT ||
        !attempt.checkoutSessionId
      ) {
        return;
      }

      if (attempt.buyerId && userId && attempt.buyerId !== userId) {
        throw new NotFoundException('Payment attempt not found');
      }

      await tx.$queryRaw`SELECT "id" FROM "CheckoutSession" WHERE "id" = ${attempt.checkoutSessionId}::uuid FOR UPDATE`;
      const checkoutSession = await tx.checkoutSession.findUnique({
        where: { id: attempt.checkoutSessionId },
        include: {
          lines: {
            select: {
              id: true,
              lineType: true,
              status: true,
              checkoutIntentId: true,
            },
          },
          inventoryReservations: {
            where: {
              status: InventoryReservationStatus.RESERVED,
            },
            select: {
              id: true,
              productId: true,
              productVariantId: true,
              quantity: true,
              reservedSize: true,
            },
          },
        },
      });

      if (!checkoutSession || checkoutSession.status === CheckoutSessionStatus.COMPLETED) {
        return;
      }

      for (const reservation of checkoutSession.inventoryReservations) {
        await tx.$queryRaw`SELECT "id" FROM "Product" WHERE "id" = ${reservation.productId}::uuid FOR UPDATE`;

        const product = await tx.product.findUnique({
          where: { id: reservation.productId },
          select: {
            id: true,
            sizeStock: true,
          },
        });

        if (!product) {
          continue;
        }

        const nextSizeStock = this.parseSizeStock(product.sizeStock);
        if (
          reservation.reservedSize &&
          nextSizeStock &&
          nextSizeStock[reservation.reservedSize] !== undefined
        ) {
          nextSizeStock[reservation.reservedSize] =
            Number(nextSizeStock[reservation.reservedSize] ?? 0) + reservation.quantity;
        }

        if (reservation.productVariantId) {
          await tx.productVariant.updateMany({
            where: {
              id: reservation.productVariantId,
              productId: reservation.productId,
            },
            data: {
              stock: {
                increment: reservation.quantity,
              },
            },
          });
        }

        await tx.product.update({
          where: { id: reservation.productId },
          data: {
            totalStock: {
              increment: reservation.quantity,
            },
            ...(nextSizeStock ? { sizeStock: nextSizeStock } : {}),
          },
        });

        await tx.inventoryReservation.update({
          where: { id: reservation.id },
          data: {
            status: InventoryReservationStatus.RELEASED,
            releasedAt: now,
            releaseReason: reason,
          },
        });
      }

      const standardLineIdsToCancel = checkoutSession.lines
        .filter((line) => line.lineType === CheckoutSessionLineType.STANDARD_ITEM)
        .map((line) => line.id);
      if (standardLineIdsToCancel.length > 0) {
        await tx.checkoutSessionLine.updateMany({
          where: {
            id: {
              in: standardLineIdsToCancel,
            },
          },
          data: {
            status: CheckoutSessionLineStatus.CANCELLED,
          },
        });
      }

      const customLineIdsToCancel = checkoutSession.lines
        .filter((line) => line.lineType === CheckoutSessionLineType.CUSTOM_ORDER)
        .map((line) => line.id);
      if (customLineIdsToCancel.length > 0) {
        await tx.checkoutSessionLine.updateMany({
          where: {
            id: {
              in: customLineIdsToCancel,
            },
          },
          data: {
            status: CheckoutSessionLineStatus.CANCELLED,
          },
        });
      }

      const customCheckoutIntentIds = Array.from(
        new Set(
          checkoutSession.lines
            .map((line) => String(line.checkoutIntentId ?? '').trim())
            .filter(Boolean),
        ),
      );
      if (customCheckoutIntentIds.length > 0) {
        await tx.customOrderCheckoutSession.updateMany({
          where: {
            checkoutIntentId: {
              in: customCheckoutIntentIds,
            },
            customOrderId: null,
          },
          data: {
            status: CustomOrderCheckoutStatus.ABANDONED,
            abandonedAt: now,
            lastAttemptId: attempt.id,
            lastAttemptReference: attempt.reference,
            lastAttemptStatus: attempt.status,
          },
        });
      }

      const failedStatus =
        reason.includes('EXPIRED')
          ? CheckoutSessionStatus.EXPIRED
          : reason.includes('CANCELLED')
            ? CheckoutSessionStatus.CANCELLED
            : CheckoutSessionStatus.FAILED;

      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          status: failedStatus,
          failedAt: now,
          failureReason: reason,
        },
      });
    });
  }

  private async finalizeUnifiedCheckoutAttempt(
    reference: string,
    userId: string,
  ): Promise<UnifiedCheckoutFinalizeResult | null> {
    const now = new Date();

    const finalized = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "reference" FROM "PaymentAttempt" WHERE "reference" = ${reference} FOR UPDATE`;
      const attempt = await tx.paymentAttempt.findUnique({
        where: { reference },
      });

      if (
        !attempt ||
        attempt.subjectType !== PaymentSubjectType.UNIFIED_CHECKOUT ||
        !attempt.checkoutSessionId
      ) {
        return null;
      }

      if (attempt.buyerId && userId && attempt.buyerId !== userId) {
        throw new NotFoundException('Payment attempt not found');
      }

      if (attempt.status !== 'PAID') {
        return null;
      }

      await tx.$queryRaw`SELECT "id" FROM "CheckoutSession" WHERE "id" = ${attempt.checkoutSessionId}::uuid FOR UPDATE`;
      const checkoutSession = await tx.checkoutSession.findUnique({
        where: { id: attempt.checkoutSessionId },
        include: {
          lines: {
            orderBy: { lineOrder: 'asc' },
          },
        },
      });

      if (!checkoutSession) {
        return null;
      }

      if (checkoutSession.buyerId && attempt.buyerId && checkoutSession.buyerId !== attempt.buyerId) {
        throw new NotFoundException('Checkout session not found for this payment attempt');
      }

      const summary = this.buildUnifiedSummaryFromSession(checkoutSession);

      const existingOrderIds = Array.from(
        new Set(
          checkoutSession.lines
            .map((line) => String(line.orderId ?? '').trim())
            .filter(Boolean),
        ),
      );
      const existingCustomOrderIds = Array.from(
        new Set(
          checkoutSession.lines
            .map((line) => String(line.customOrderId ?? '').trim())
            .filter(Boolean),
        ),
      );

      if (checkoutSession.status === CheckoutSessionStatus.COMPLETED) {
        return {
          checkoutSessionId: checkoutSession.id,
          orderIds: existingOrderIds,
          customOrderIds: existingCustomOrderIds,
          summary,
        } satisfies UnifiedCheckoutFinalizeResult;
      }

      const standardPendingLines = checkoutSession.lines.filter(
        (line) =>
          line.lineType === CheckoutSessionLineType.STANDARD_ITEM &&
          !line.orderId &&
          line.status !== CheckoutSessionLineStatus.CANCELLED,
      );
      const customPendingLines = checkoutSession.lines.filter(
        (line) =>
          line.lineType === CheckoutSessionLineType.CUSTOM_ORDER &&
          !line.customOrderId &&
          line.status !== CheckoutSessionLineStatus.CANCELLED,
      );

      const shippingAddress = this.asObject(checkoutSession.shippingAddressJson);
      const contactInfo = this.asObject(checkoutSession.contactInfoJson);
      const shippingState = String(shippingAddress.state ?? '').trim();
      const perBrandShippingCost = this.resolveShippingCostForState(shippingState);

      const standardLinesByBrand = new Map<string, typeof standardPendingLines>();
      for (const line of standardPendingLines) {
        const brandId = String(line.brandId ?? '').trim();
        if (!brandId) {
          throw new BadRequestException('Standard checkout line is missing brand information');
        }
        if (!line.productId) {
          throw new BadRequestException('Standard checkout line is missing product information');
        }

        const group = standardLinesByBrand.get(brandId) ?? [];
        group.push(line);
        standardLinesByBrand.set(brandId, group);
      }

      const createdOrderIds: string[] = [];

      for (const [brandId, brandLines] of standardLinesByBrand.entries()) {
        const subtotal = this.roundMoney(
          brandLines.reduce((sum, line) => sum + Number(line.lineTotal ?? 0), 0),
        );
        const shippingCost = this.roundMoney(perBrandShippingCost);
        const totalAmount = this.roundMoney(subtotal + shippingCost);

        const orderItemsPayload = brandLines.map((line) => {
          const snapshot = this.asObject(line.itemSnapshotJson);
          const sizingMode = this.normalizeSizingModeValue(snapshot.sizingMode);
          return {
            productId: line.productId,
            name: String(snapshot.name ?? 'Item'),
            thumbnail: snapshot.thumbnail ? String(snapshot.thumbnail) : null,
            price: this.roundMoney(Number(line.unitPrice ?? 0)),
            quantity: Number(line.quantity ?? 1),
            selectedSize: line.selectedSize ?? null,
            selectedColor: line.selectedColor ?? null,
            sizingMode,
            requiredMeasurementKeys: this.normalizeRequiredMeasurementKeys(
              snapshot.requiredMeasurementKeys,
            ),
            sizeFitSnapshot: this.asObject(snapshot.sizeFitData),
          };
        });

        const order = await tx.order.create({
          data: {
            id: uuidv4(),
            brandId,
            buyerId: attempt.buyerId,
            customerName:
              String(checkoutSession.customerName ?? '').trim() ||
              String(contactInfo.customerName ?? 'Customer').trim() ||
              'Customer',
            shippingAddress: shippingAddress as Prisma.InputJsonValue,
            contactInfo: contactInfo as Prisma.InputJsonValue,
            items: orderItemsPayload as Prisma.InputJsonValue,
            totalAmount: new Prisma.Decimal(totalAmount.toFixed(2)),
            shippingCost: new Prisma.Decimal(shippingCost.toFixed(2)),
            discountAmount: new Prisma.Decimal('0.00'),
            currency: checkoutSession.currency,
            status: 'PENDING',
            paymentStatus: PaymentStatus.PAID,
            paymentMethod: attempt.paymentMethod,
            paymentReference: attempt.reference,
            paymentGateway: attempt.provider,
            unifiedCheckoutSessionId: checkoutSession.id,
            paidAt: attempt.confirmedAt ?? now,
          },
        });

        if (orderItemsPayload.length > 0) {
          await tx.orderItem.createMany({
            data: orderItemsPayload.map((item) => ({
              id: uuidv4(),
              orderId: order.id,
              productId: String(item.productId ?? ''),
              brandId,
              buyerId: attempt.buyerId,
              quantity: Number(item.quantity ?? 1),
              currency: checkoutSession.currency,
              unitPrice: new Prisma.Decimal(Number(item.price ?? 0).toFixed(2)),
              totalPrice: new Prisma.Decimal(
                this.roundMoney(Number(item.price ?? 0) * Number(item.quantity ?? 1)).toFixed(2),
              ),
              selectedSize: item.selectedSize,
              selectedColor: item.selectedColor,
              sizingMode: item.sizingMode,
              requiredMeasurementKeys: item.requiredMeasurementKeys,
              sizeFitSnapshot:
                Object.keys(item.sizeFitSnapshot).length > 0
                  ? (item.sizeFitSnapshot as Prisma.InputJsonValue)
                  : null,
              thumbnailAtPurchase: item.thumbnail,
              nameAtPurchase: item.name,
            })),
          });
        }

        await tx.checkoutSessionLine.updateMany({
          where: {
            id: {
              in: brandLines.map((line) => line.id),
            },
          },
          data: {
            orderId: order.id,
            status: CheckoutSessionLineStatus.COMMITTED,
          },
        });

        createdOrderIds.push(order.id);
      }

      const customOrderIds: string[] = [];
      const customIntentIds = Array.from(
        new Set(
          customPendingLines
            .map((line) => String(line.checkoutIntentId ?? '').trim())
            .filter(Boolean),
        ),
      );

      const intents = customIntentIds.length
        ? await tx.customOrderCheckoutIntent.findMany({
            where: {
              id: {
                in: customIntentIds,
              },
            },
          })
        : [];
      const intentById = new Map(intents.map((intent) => [intent.id, intent]));

      const configIds = Array.from(new Set(intents.map((intent) => intent.configurationId)));
      const configurations = configIds.length
        ? await tx.customOrderConfiguration.findMany({
            where: {
              id: {
                in: configIds,
              },
            },
            select: {
              id: true,
              brandId: true,
              sourceType: true,
              sourceId: true,
            },
          })
        : [];
      const configurationById = new Map(
        configurations.map((configuration) => [configuration.id, configuration]),
      );

      const versionIds = Array.from(
        new Set(intents.map((intent) => intent.configurationVersionId)),
      );
      const versions = versionIds.length
        ? await tx.customOrderConfigurationVersion.findMany({
            where: {
              id: {
                in: versionIds,
              },
            },
            select: {
              id: true,
              snapshotJson: true,
            },
          })
        : [];
      const versionById = new Map(versions.map((version) => [version.id, version]));

      for (const line of customPendingLines) {
        const checkoutIntentId = String(line.checkoutIntentId ?? '').trim();
        if (!checkoutIntentId) {
          continue;
        }

        const existingOrder = await tx.customOrder.findUnique({
          where: { checkoutIntentId },
          select: { id: true },
        });

        let customOrderId = existingOrder?.id ?? null;
        if (!customOrderId) {
          const intent = intentById.get(checkoutIntentId);
          if (!intent) {
            throw new BadRequestException('Custom checkout intent no longer exists');
          }

          const configuration = configurationById.get(intent.configurationId);
          const version = versionById.get(intent.configurationVersionId);
          if (!configuration || !version) {
            throw new BadRequestException('Custom checkout configuration is no longer available');
          }

          await tx.customOrderCheckoutIntent.updateMany({
            where: {
              id: intent.id,
              consumedAt: null,
            },
            data: {
              consumedAt: now,
            },
          });

          const createData = this.buildUnifiedCustomOrderCreateData({
            checkoutSession,
            line,
            attempt,
            intent,
            configuration,
            versionSnapshot: this.asObject(version.snapshotJson),
            acceptedAt: attempt.confirmedAt ?? now,
          });

          try {
            const created = await tx.customOrder.create({
              data: createData,
              select: {
                id: true,
              },
            });
            customOrderId = created.id;
          } catch (error) {
            if (
              error instanceof Prisma.PrismaClientKnownRequestError &&
              error.code === 'P2002'
            ) {
              const duplicate = await tx.customOrder.findUnique({
                where: { checkoutIntentId },
                select: { id: true },
              });
              customOrderId = duplicate?.id ?? null;
            } else {
              throw error;
            }
          }
        }

        if (!customOrderId) {
          continue;
        }

        await tx.checkoutSessionLine.update({
          where: { id: line.id },
          data: {
            customOrderId,
            status: CheckoutSessionLineStatus.COMMITTED,
          },
        });

        await tx.customOrderCheckoutSession.updateMany({
          where: {
            checkoutIntentId,
          },
          data: {
            customOrderId,
            status: CustomOrderCheckoutStatus.PAID_CONFIRMED,
            paidConfirmedAt: attempt.confirmedAt ?? now,
            lastAttemptId: attempt.id,
            lastAttemptReference: attempt.reference,
            lastAttemptStatus: attempt.status,
            abandonedAt: null,
          },
        });

        customOrderIds.push(customOrderId);
      }

      await tx.inventoryReservation.updateMany({
        where: {
          checkoutSessionId: checkoutSession.id,
          status: InventoryReservationStatus.RESERVED,
        },
        data: {
          status: InventoryReservationStatus.COMMITTED,
          committedAt: attempt.confirmedAt ?? now,
        },
      });

      const cartItemIdsToDelete = Array.from(
        new Set(
          standardPendingLines
            .map((line) => String(line.cartItemId ?? '').trim())
            .filter(Boolean),
        ),
      );
      if (cartItemIdsToDelete.length > 0 && attempt.buyerId) {
        await tx.cartItem.deleteMany({
          where: {
            userId: attempt.buyerId,
            id: {
              in: cartItemIdsToDelete,
            },
          },
        });
      }

      const finalOrderIds = Array.from(new Set([...existingOrderIds, ...createdOrderIds]));
      const finalCustomOrderIds = Array.from(
        new Set([...existingCustomOrderIds, ...customOrderIds]),
      );

      await tx.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          orderIds: finalOrderIds,
        },
      });

      await tx.checkoutSession.update({
        where: { id: checkoutSession.id },
        data: {
          status: CheckoutSessionStatus.COMPLETED,
          completedAt: attempt.confirmedAt ?? now,
          failedAt: null,
          failureReason: null,
        },
      });

      return {
        checkoutSessionId: checkoutSession.id,
        orderIds: finalOrderIds,
        customOrderIds: finalCustomOrderIds,
        summary,
      } satisfies UnifiedCheckoutFinalizeResult;
    });

    if (finalized && finalized.orderIds.length > 0) {
      const linkedOrders = await this.prisma.order.findMany({
        where: {
          id: {
            in: finalized.orderIds,
          },
        },
        select: {
          id: true,
          brandId: true,
          buyerId: true,
          customerName: true,
          totalAmount: true,
          brand: {
            select: {
              ownerId: true,
              name: true,
            },
          },
        },
      });

      if (linkedOrders.length > 0) {
        await this.standardOrderFinanceSyncService.syncPaidOrdersByReferences([reference]);
        const attemptForNotification = await this.prisma.paymentAttempt.findUnique({
          where: { reference },
        });
        if (attemptForNotification) {
          await this.notifyFinanceAdminsOfStandardPayment(attemptForNotification, linkedOrders);
        }
        await this.notifyOrderPlacementAfterPayment(linkedOrders);
      }
    }

    return finalized;
  }

  private buildUnifiedCustomOrderCreateData(params: {
    checkoutSession: {
      id: string;
      buyerId: string;
      customerName: string | null;
      shippingAddressJson: unknown;
    };
    line: {
      id: string;
      itemSnapshotJson: unknown;
    };
    attempt: {
      paymentMethod: PaymentMethod;
      reference: string;
      confirmedAt: Date | null;
    };
    intent: {
      id: string;
      requestSnapshotJson: Prisma.JsonValue;
      buyerPriceSummaryJson: Prisma.JsonValue;
      configurationId: string;
      configurationVersionId: string;
      currency: string;
    };
    configuration: {
      id: string;
      brandId: string;
      sourceType: any;
      sourceId: string;
    };
    versionSnapshot: Record<string, any>;
    acceptedAt: Date;
  }): Prisma.CustomOrderUncheckedCreateInput {
    const lineSnapshot = this.asObject(params.line.itemSnapshotJson);
    const requestSnapshot = this.asObject(params.intent.requestSnapshotJson);
    const buyerSummary = this.asObject(params.intent.buyerPriceSummaryJson);
    const contactInfo = this.asObject(requestSnapshot.contactInfo);
    const shippingAddress = this.asObject(
      Object.keys(this.asObject(requestSnapshot.shippingAddress)).length > 0
        ? requestSnapshot.shippingAddress
        : params.checkoutSession.shippingAddressJson,
    );
    const measurementSnapshot = this.asObject(requestSnapshot.measurementValues);

    const baseProductionCharge = this.roundMoney(
      Number(params.versionSnapshot.baseProductionCharge ?? 0),
    );
    const fabricCostPerYard = this.roundMoney(
      Number(params.versionSnapshot.fabricCostPerYard ?? 0),
    );
    const deliveryMinDays = Math.max(0, Number(params.versionSnapshot.deliveryMinDays ?? 0));
    const deliveryMaxDays = Math.max(
      deliveryMinDays,
      Number(params.versionSnapshot.deliveryMaxDays ?? deliveryMinDays),
    );
    const productionLeadDays = Math.max(
      0,
      Number(params.versionSnapshot.productionLeadDays ?? 0),
    );

    const fabricCharge = this.roundMoney(Number(buyerSummary.fabricCharge ?? 0));
    const computedYards = this.roundMoney(
      Number(
        buyerSummary.computedYards ??
          buyerSummary.fabricYards ??
          (fabricCostPerYard > 0 ? fabricCharge / fabricCostPerYard : 0),
      ),
    );

    const rushFee = this.roundMoney(Number(buyerSummary.rushFee ?? 0));
    const customerName =
      String(requestSnapshot.customerName ?? '').trim() ||
      String(contactInfo.customerName ?? '').trim() ||
      String(params.checkoutSession.customerName ?? '').trim() ||
      'Customer';
    const acceptedAt = params.acceptedAt;
    const promisedProductionAt = new Date(
      acceptedAt.getTime() + productionLeadDays * 24 * 60 * 60 * 1000,
    );
    const promisedDispatchAt = promisedProductionAt;
    const promisedDeliveryAt = new Date(
      promisedDispatchAt.getTime() + deliveryMaxDays * 24 * 60 * 60 * 1000,
    );
    const retentionUntil = new Date(acceptedAt.getTime() + 180 * 24 * 60 * 60 * 1000);

    return {
      brandId: params.configuration.brandId,
      buyerId: params.checkoutSession.buyerId,
      sourceType: params.configuration.sourceType,
      sourceId: params.configuration.sourceId,
      sourceTitleSnapshot:
        String(lineSnapshot.sourceTitle ?? '').trim() || 'Custom order item',
      sourceSlugSnapshot: null,
      sourcePrimaryMediaUrlSnapshot:
        lineSnapshot.sourcePrimaryMediaUrl != null
          ? String(lineSnapshot.sourcePrimaryMediaUrl)
          : null,
      sourceBrandNameSnapshot:
        lineSnapshot.sourceBrandName != null ? String(lineSnapshot.sourceBrandName) : null,
      configurationId: params.configuration.id,
      configurationVersionId: params.intent.configurationVersionId,
      status: CustomOrderStatus.ACCEPTED,
      paymentStatus: PaymentStatus.PAID,
      paymentMethod: params.attempt.paymentMethod,
      paymentReference: params.attempt.reference,
      unifiedCheckoutSessionId: params.checkoutSession.id,
      currency: params.intent.currency,
      checkoutIntentId: params.intent.id,
      baseProductionChargeSnapshot: new Prisma.Decimal(baseProductionCharge.toFixed(2)),
      fabricCostPerYardSnapshot: new Prisma.Decimal(fabricCostPerYard.toFixed(2)),
      computedYards: new Prisma.Decimal(computedYards.toFixed(2)),
      matchedFabricRuleId:
        typeof requestSnapshot.matchedFabricRuleId === 'string'
          ? requestSnapshot.matchedFabricRuleId
          : null,
      internalPriceBreakdownJson: {
        source: 'UNIFIED_CHECKOUT',
        checkoutSessionId: params.checkoutSession.id,
        checkoutSessionLineId: params.line.id,
        chartLock: this.asObject(requestSnapshot.chartLock),
        fabricCharge,
        rushFee,
      } as Prisma.InputJsonValue,
      buyerPriceSummaryJson: params.intent.buyerPriceSummaryJson,
      measurementSnapshotJson:
        Object.keys(measurementSnapshot).length > 0
          ? (measurementSnapshot as Prisma.InputJsonValue)
          : ({ } as Prisma.InputJsonValue),
      measurementConfirmedAt:
        typeof requestSnapshot.submittedAt === 'string' && requestSnapshot.submittedAt.trim().length > 0
          ? new Date(requestSnapshot.submittedAt)
          : acceptedAt,
      rushSelected: Boolean(requestSnapshot.rushSelected),
      rushFeeSnapshot:
        Number.isFinite(rushFee) && rushFee > 0
          ? new Prisma.Decimal(rushFee.toFixed(2))
          : null,
      productionLeadDaysSnapshot: productionLeadDays,
      deliveryMinDaysSnapshot: deliveryMinDays,
      deliveryMaxDaysSnapshot: deliveryMaxDays,
      shippingAddressJson: shippingAddress as Prisma.InputJsonValue,
      contactInfoJson: {
        ...contactInfo,
        customerName,
      } as Prisma.InputJsonValue,
      idempotencyKey:
        typeof requestSnapshot.submissionIdempotencyKey === 'string'
          ? requestSnapshot.submissionIdempotencyKey
          : null,
      measurementRetentionUntil: retentionUntil,
      acceptedAt,
      promisedProductionAt,
      promisedDispatchAt,
      promisedDeliveryAt,
      currentProgressStage: CustomOrderProgressStage.ORDER_RECEIVED,
      currentProgressStageEnteredAt: acceptedAt,
      lastBrandProgressUpdateAt: acceptedAt,
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

  private canReusePendingAttempt(
    existingSnapshot: unknown,
    nextPaymentData: Record<string, any>,
  ) {
    return (
      this.buildPaymentDataFingerprint(existingSnapshot) ===
      this.buildPaymentDataFingerprint(nextPaymentData)
    );
  }

  private buildPaymentDataFingerprint(value: unknown) {
    return JSON.stringify(this.normalizePaymentDataForFingerprint(value));
  }

  private normalizePaymentDataForFingerprint(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((entry) => this.normalizePaymentDataForFingerprint(entry));
    }

    if (value && typeof value === 'object') {
      const source = value as Record<string, unknown>;
      const output: Record<string, unknown> = {};
      const keys = Object.keys(source)
        .filter((key) => !['consentAccepted', 'mockScenario'].includes(key))
        .sort();

      for (const key of keys) {
        output[key] = this.normalizePaymentDataForFingerprint(source[key]);
      }

      return output;
    }

    if (typeof value === 'string') {
      return value.trim();
    }

    if (
      value === null ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      return value;
    }

    return null;
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
