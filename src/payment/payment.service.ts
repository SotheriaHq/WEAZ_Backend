import {
  BadRequestException,
  InternalServerErrorException,
  Injectable,
  Logger,
  NotFoundException,
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
  CardValidationSessionSummary,
  InitializePaymentDto,
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
        subjectType: PaymentSubjectType.STANDARD_ORDER,
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

    const webhookAuthorization = this.extractPaystackAuthorizationSnapshot(
      this.asObject(payload?.data)?.authorization ?? payload?.authorization,
    );

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
        ...(webhookAuthorization
          ? { providerWebhookAuthorization: webhookAuthorization }
          : {}),
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

      return {
        attempt: updated,
        transitionedToPaid: nextStatus === 'PAID',
      };
    });

    const updatedAttempt = transitionResult.attempt;

    const linkedOrders =
      transitionResult.transitionedToPaid
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
      const hasValidationSessionId =
        String(paymentData.validationSessionId ?? '').trim().length > 0;

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

      if (
        String(paymentData.channel || '').toUpperCase() === 'CARD' &&
        !paymentData.useSavedCard &&
        this.isPaystackCustomCardEntryEnabled() &&
        !hasValidationSessionId
      ) {
        throw new BadRequestException(
          'Enter the new card details on the payment step or choose a saved card before continuing.',
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
      String(process.env.PAYSTACK_CUSTOM_CARD_ENTRY_ENABLED ?? 'true')
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
