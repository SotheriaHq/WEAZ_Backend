import { Test, TestingModule } from '@nestjs/testing';
import { PaymentMethod, PaymentStatus, PaymentSubjectType } from '@prisma/client';
import { CommissionService } from 'src/finance/commission.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { LedgerService } from 'src/finance/ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from 'src/payment/payment.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';
import { CustomOrderThreadBootstrapService } from 'src/messaging/custom-order-thread-bootstrap.service';
import { CustomOrdersService } from './custom-orders.service';

describe('CustomOrdersPaymentsService', () => {
  let service: CustomOrdersPaymentsService;
  let prisma: any;
  let paymentService: any;
  let commissionService: any;
  let ledgerService: any;
  let financialDocumentsService: any;

  beforeEach(async () => {
    prisma = {
      brand: {
        findUnique: jest.fn(),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      customOrder: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
      paymentAttempt: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      paymentEvent: {
        create: jest.fn(),
      },
      customOrderTimelineEvent: {
        create: jest.fn(),
      },
      customOrderLedgerAllocation: {
        count: jest.fn(),
        createMany: jest.fn(),
        updateMany: jest.fn(),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(),
    };

    const preparePaymentRequest = jest.fn();
    const preparePaymentGatewayRequest = jest.fn();
    const resolveCardValidationSessionForInitialize = jest.fn();
    const consumeCardValidationSessionForInitialize = jest.fn();
    const resolvePaymentCallbackUrl = jest.fn();
    const initializeGatewayForAttempt = jest.fn();
    const getAttemptProviderMode = jest.fn();
    const resolveAttemptVerification = jest.fn();
    const isAttemptTerminalStatus = jest.fn();

    preparePaymentRequest.mockImplementation((_paymentMethod: PaymentMethod, paymentData?: Record<string, unknown>) => paymentData ?? {});
    preparePaymentGatewayRequest.mockImplementation(
      (_paymentMethod: PaymentMethod, paymentData?: Record<string, unknown>) =>
        paymentData ?? {},
    );
    resolveCardValidationSessionForInitialize.mockResolvedValue(null);
    consumeCardValidationSessionForInitialize.mockResolvedValue(undefined);
    resolvePaymentCallbackUrl.mockImplementation((callbackUrl?: string) => callbackUrl ?? 'https://callback.test');
    initializeGatewayForAttempt.mockResolvedValue({
      gateway: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel: 'CARD',
      callbackUrl: 'https://callback.test',
      authorizationUrl: 'https://authorize.test',
      nextAction: { type: 'REDIRECT' },
      bankAccount: null,
      responseSnapshot: { mockReturnStatus: 'success' },
    });
    getAttemptProviderMode.mockReturnValue('mock');
    resolveAttemptVerification.mockImplementation((attempt: any, dto: { statusHint?: string }) => {
      const normalize = (value?: string | null) => {
        const normalized = String(value ?? '').trim().toUpperCase();
        if (!normalized) return undefined;
        if (normalized === 'SUCCESS' || normalized === 'PAID') return 'PAID';
        if (normalized === 'PENDING' || normalized === 'PROCESSING') return 'PENDING';
        if (normalized === 'FAILED' || normalized === 'FAIL') return 'FAILED';
        if (normalized === 'CANCELLED' || normalized === 'CANCEL') return 'CANCELLED';
        if (normalized === 'EXPIRED' || normalized === 'EXPIRE') return 'EXPIRED';
        return normalized;
      };

      const storedStatus = normalize(attempt?.responseSnapshot?.mockReturnStatus);
      const hintedStatus = normalize(dto?.statusHint);
      if (storedStatus && hintedStatus && storedStatus !== hintedStatus) {
        throw new Error('Payment verification payload does not match the provider-confirmed attempt status');
      }

      const nextStatus = storedStatus ?? hintedStatus ?? normalize(attempt?.status) ?? 'PENDING';
      const awaitingProviderConfirmation =
        String(attempt?.providerMode || '').trim().toLowerCase() === 'live' &&
        nextStatus === 'PENDING';

      return {
        nextStatus,
        awaitingProviderConfirmation,
        responseSnapshotPatch: awaitingProviderConfirmation
          ? {
              awaitingProviderConfirmation: true,
              recoveryAction: 'WAIT_FOR_PROVIDER_CONFIRMATION',
              recoveryMessage:
                'Payment is still awaiting provider callback or webhook confirmation. Recheck in a moment or after returning from the gateway.',
            }
          : {},
      };
    });

    paymentService = {
      validatePaymentRequest: jest.fn(),
      resolveCallbackBaseUrl: jest.fn(),
      initializeGateway: jest.fn(),
      getProviderMode: jest.fn(),
      resolveVerificationStatus: jest.fn(),
      isTerminalStatus: isAttemptTerminalStatus,
      preparePaymentRequest,
      preparePaymentGatewayRequest,
      resolveCardValidationSessionForInitialize,
      consumeCardValidationSessionForInitialize,
      resolvePaymentCallbackUrl,
      initializeGatewayForAttempt,
      getAttemptProviderMode,
      resolveAttemptVerification,
      isAttemptTerminalStatus,
    };

    commissionService = {
      resolveRule: jest.fn().mockResolvedValue({ ratePercent: 10 }),
    };

    ledgerService = {
      postCustomOrderPaymentReceived: jest.fn().mockResolvedValue(undefined),
      postCustomOrderImmediateRelease: jest.fn().mockResolvedValue(undefined),
    };

    financialDocumentsService = {
      issueBuyerReceipt: jest.fn().mockResolvedValue(undefined),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrdersPaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentService, useValue: paymentService },
        { provide: CustomOrdersService, useValue: { buildPaidOrderCreateInput: jest.fn() } },
        { provide: CommissionService, useValue: commissionService },
        { provide: LedgerService, useValue: ledgerService },
        { provide: FinancialDocumentsService, useValue: financialDocumentsService },
        {
          provide: CustomOrderSideEffectsService,
          useValue: {
            enqueueNotification: jest.fn(),
            recordAnalyticsEvent: jest.fn(),
          },
        },
        {
          provide: CustomOrderThreadBootstrapService,
          useValue: {
            ensureOrderPlacedThread: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CustomOrdersPaymentsService>(CustomOrdersPaymentsService);
  });

  it('returns an existing payment attempt for the same idempotency key', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_1',
      buyerId: 'buyer_1',
      status: 'DRAFT',
      paymentStatus: PaymentStatus.PENDING,
      buyerPriceSummaryJson: { grandTotal: 1500 },
      currency: 'NGN',
    });
    prisma.paymentAttempt.findFirst.mockResolvedValue({
      id: 'attempt_1',
      reference: 'TH-CO-existing',
      provider: 'mockpay',
      status: 'PENDING',
      channel: 'CARD',
      callbackUrl: 'https://callback.test',
      authorizationUrl: 'https://authorize.test',
      bankAccount: null,
      nextAction: { type: 'REDIRECT' },
    });

    const result = await service.initializePayment('buyer_1', 'co_1', {
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'buyer@example.com',
      idempotencyKey: 'idem-1',
    });

    expect(result).toEqual({
      paymentAttemptId: 'attempt_1',
      reference: 'TH-CO-existing',
      gateway: 'mockpay',
      status: 'PENDING',
      channel: 'CARD',
      callbackUrl: 'https://callback.test',
      authorizationUrl: 'https://authorize.test',
      bankAccount: undefined,
      nextAction: { type: 'REDIRECT' },
    });
    expect(paymentService.validatePaymentRequest).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.paymentAttempt.findFirst).toHaveBeenCalledWith({
      where: {
        buyerId: 'buyer_1',
        subjectType: PaymentSubjectType.CUSTOM_ORDER,
        customOrderId: 'co_1',
        idempotencyKey: 'idem-1',
      },
      orderBy: { createdAt: 'desc' },
    });
  });

  it('reuses a still-active payment attempt for the same unpaid custom order', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_reuse',
      buyerId: 'buyer_1',
      status: 'PENDING_PAYMENT',
      paymentStatus: PaymentStatus.PENDING,
      buyerPriceSummaryJson: { grandTotal: 1500 },
      currency: 'NGN',
    });
    const activeAttemptExpiry = new Date(Date.now() + 60 * 60 * 1000);

    prisma.paymentAttempt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'attempt_active',
        reference: 'TH-CO-active',
        provider: 'PAYSTACK',
        providerMode: 'mock',
        paymentMethod: PaymentMethod.PAYSTACK,
        status: 'REQUIRES_ACTION',
        channel: 'CARD',
        callbackUrl: 'https://callback.test',
        authorizationUrl: 'https://authorize.test',
        bankAccount: null,
        nextAction: { type: 'REDIRECT' },
        expiresAt: activeAttemptExpiry,
      });

    const result = await service.initializePayment('buyer_1', 'co_reuse', {
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'buyer@example.com',
      idempotencyKey: 'idem-2',
    });

    expect(prisma.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_reuse' },
      data: {
        paymentMethod: PaymentMethod.PAYSTACK,
        paymentReference: 'TH-CO-active',
        paymentStatus: PaymentStatus.PENDING,
        status: 'PENDING_PAYMENT',
      },
    });
    expect(paymentService.validatePaymentRequest).not.toHaveBeenCalled();
    expect(result.reference).toBe('TH-CO-active');
  });

  it('creates a new custom-order attempt after a terminal attempt', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_refresh',
      buyerId: 'buyer_1',
      status: 'PENDING_PAYMENT',
      paymentStatus: PaymentStatus.PENDING,
      buyerPriceSummaryJson: { grandTotal: 1900 },
      currency: 'NGN',
    });

    prisma.paymentAttempt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    const createdAttempt = {
      id: 'attempt_new',
      reference: 'TH-CO-refresh',
      provider: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel: 'CARD',
      callbackUrl: 'https://callback.test',
      authorizationUrl: 'https://authorize.test',
      bankAccount: null,
      nextAction: { type: 'REDIRECT' },
    };

    const tx = {
      paymentAttempt: {
        update: jest.fn(),
        create: jest.fn().mockResolvedValue(createdAttempt),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    const result = await service.initializePayment('buyer_1', 'co_refresh', {
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'buyer@example.com',
      idempotencyKey: 'idem-refresh',
    });

    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customOrderId: 'co_refresh',
          idempotencyKey: 'idem-refresh',
          reference: expect.stringMatching(/^TH-CO-/),
        }),
      }),
    );
    expect(tx.paymentAttempt.update).not.toHaveBeenCalled();
    expect(result.reference).toBe('TH-CO-refresh');
  });

  it('binds and consumes canonical card validation sessions during custom-order initialize', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_validated',
      buyerId: 'buyer_1',
      status: 'PENDING_PAYMENT',
      paymentStatus: PaymentStatus.PENDING,
      buyerPriceSummaryJson: { grandTotal: 2100 },
      currency: 'NGN',
      checkoutIntentId: 'intent_validated',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      productionLeadDaysSnapshot: 5,
      deliveryMaxDaysSnapshot: 4,
    });

    prisma.paymentAttempt.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);

    paymentService.resolveCardValidationSessionForInitialize.mockResolvedValue({
      sessionId: 'session_custom_1',
      savedPaymentMethodId: 'saved_method_1',
      canonicalSessionId: 'session_custom_1',
      storage: 'canonical',
    });

    const createdAttempt = {
      id: 'attempt_validated',
      reference: 'TH-CO-validated',
      provider: 'PAYSTACK',
      status: 'REQUIRES_ACTION',
      channel: 'CARD',
      callbackUrl: 'https://callback.test',
      authorizationUrl: 'https://authorize.test',
      bankAccount: null,
      nextAction: { type: 'REDIRECT' },
    };

    const tx = {
      paymentAttempt: {
        update: jest.fn(),
        create: jest.fn().mockResolvedValue(createdAttempt),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );

    await service.initializePayment('buyer_1', 'co_validated', {
      paymentMethod: PaymentMethod.PAYSTACK,
      email: 'buyer@example.com',
      idempotencyKey: 'idem-validated',
      validationSessionId: 'session_custom_1',
    });

    expect(paymentService.resolveCardValidationSessionForInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        paymentMethod: PaymentMethod.PAYSTACK,
        validationSessionId: 'session_custom_1',
        userId: 'buyer_1',
      }),
    );
    expect(paymentService.consumeCardValidationSessionForInitialize).toHaveBeenCalledWith(
      tx,
      'buyer_1',
      expect.objectContaining({
        canonicalSessionId: 'session_custom_1',
      }),
    );
    expect(tx.paymentAttempt.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          savedPaymentMethodId: 'saved_method_1',
          cardValidationSessionId: 'session_custom_1',
        }),
      }),
    );
  });

  it('verifies a successful payment and creates ledger allocations once', async () => {
    const updatedAttempt = {
      id: 'attempt_2',
      buyerId: 'buyer_1',
      customOrderId: 'co_2',
      reference: 'TH-CO-paid',
      amount: 1000,
      currency: 'NGN',
      status: 'PAID',
      confirmedAt: new Date('2026-03-12T10:00:00.000Z'),
      channel: 'CARD',
      failureMessage: null,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt_2',
          buyerId: 'buyer_1',
          customOrderId: 'co_2',
          reference: 'TH-CO-paid',
          status: 'PENDING',
          confirmedAt: null,
          finalizedAt: null,
          providerReference: null,
          providerTransactionId: null,
          providerAccessCode: null,
          providerChannel: null,
          channel: 'CARD',
          responseSnapshot: { mockReturnStatus: 'success' },
          settlementCurrency: 'NGN',
          settlementAmount: 1000,
        }),
        update: jest.fn().mockResolvedValue(updatedAttempt),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_2',
      buyerId: 'buyer_1',
      brandId: 'brand_1',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      productionLeadDaysSnapshot: 5,
      deliveryMaxDaysSnapshot: 4,
      buyerPriceSummaryJson: { grandTotal: 1000 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_2',
      buyerId: 'buyer_1',
      customOrderId: 'co_2',
      reference: 'TH-CO-paid',
      provider: 'mockpay',
      providerMode: 'mock',
      amount: 1000,
      currency: 'NGN',
      status: 'PENDING',
      responseSnapshot: { mockReturnStatus: 'success' },
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
    });
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'brand-owner-1' });
    paymentService.isTerminalStatus.mockReturnValue(false);

    const result = await service.verifyPayment('buyer_1', 'co_2', {
      reference: 'TH-CO-paid',
      gateway: 'mockpay',
      statusHint: 'success',
    });

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_2' },
      data: expect.objectContaining({
        paymentStatus: PaymentStatus.PAID,
        status: 'ACCEPTED',
        currentProgressStage: 'ORDER_RECEIVED',
      }),
    });
    expect(tx.customOrderLedgerAllocation.createMany).toHaveBeenCalledTimes(1);
    expect(tx.customOrderLedgerAllocation.updateMany).toHaveBeenCalledWith({
      where: {
        customOrderId: 'co_2',
        allocationType: 'BRAND_ACCEPTANCE_PORTION',
        status: 'HELD',
      },
      data: {
        status: 'PAYOUT_ELIGIBLE',
        eligibleAt: expect.any(Date),
      },
    });
    const createManyArg = tx.customOrderLedgerAllocation.createMany.mock.calls[0][0];
    expect(createManyArg.data).toHaveLength(2);
    expect(createManyArg.data[0]).toMatchObject({
      customOrderId: 'co_2',
      allocationType: 'BRAND_ACCEPTANCE_PORTION',
      currency: 'NGN',
      status: 'HELD',
    });
    expect(createManyArg.data[1]).toMatchObject({
      customOrderId: 'co_2',
      allocationType: 'FINAL_COMPLETION_PORTION',
      currency: 'NGN',
      status: 'HELD',
    });
    expect(String(createManyArg.data[0].amount)).toBe('600');
    expect(String(createManyArg.data[0].commissionRate)).toBe('10');
    expect(String(createManyArg.data[0].commissionAmount)).toBe('60');
    expect(String(createManyArg.data[0].netBrandAmount)).toBe('540');
    expect(String(createManyArg.data[1].amount)).toBe('400');
    expect(String(createManyArg.data[1].commissionRate)).toBe('10');
    expect(String(createManyArg.data[1].commissionAmount)).toBe('40');
    expect(String(createManyArg.data[1].netBrandAmount)).toBe('360');
    expect(commissionService.resolveRule).toHaveBeenCalledWith(
      expect.objectContaining({
        brandId: 'brand_1',
        currency: 'NGN',
        orderType: 'CUSTOM_ORDER',
      }),
      tx,
    );
    expect(ledgerService.postCustomOrderPaymentReceived).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_2',
      totalAmount: 1000,
      currency: 'NGN',
    });
    expect(ledgerService.postCustomOrderImmediateRelease).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_2',
      brandId: 'brand_1',
      currency: 'NGN',
      amount: 600,
      commissionAmount: 60,
      netBrandAmount: 540,
    });
    expect(financialDocumentsService.issueBuyerReceipt).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        paymentAttemptId: 'attempt_2',
        customOrderId: 'co_2',
        currency: 'NGN',
        grossAmount: 1000,
      }),
    );
    expect(result).toEqual({
      success: true,
      status: 'PAID',
      paymentAttemptId: 'attempt_2',
      reference: 'TH-CO-paid',
      amount: 1000,
      currency: 'NGN',
      paidAt: '2026-03-12T10:00:00.000Z',
      channel: 'CARD',
      failureMessage: undefined,
      customOrderId: 'co_2',
    });
  });

  it('returns terminal payment attempts without mutating state', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_3',
      buyerId: 'buyer_1',
      brandId: 'brand_2',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      buyerPriceSummaryJson: { grandTotal: 825 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_3',
      buyerId: 'buyer_1',
      customOrderId: 'co_3',
      reference: 'TH-CO-failed',
      provider: 'mockpay',
      providerMode: 'mock',
      amount: 825,
      currency: 'NGN',
      status: 'FAILED',
      responseSnapshot: { mockReturnStatus: 'failed' },
      confirmedAt: null,
      channel: 'BANK_TRANSFER',
      failureMessage: 'Mock payment marked as failed.',
    });
    paymentService.isTerminalStatus.mockReturnValue(true);

    const result = await service.verifyPayment('buyer_1', 'co_3', {
      reference: 'TH-CO-failed',
      gateway: 'mockpay',
      statusHint: 'failed',
    });

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      status: 'FAILED',
      paymentAttemptId: 'attempt_3',
      reference: 'TH-CO-failed',
      amount: 825,
      currency: 'NGN',
      paidAt: undefined,
      channel: 'BANK_TRANSFER',
      failureMessage: 'Mock payment marked as failed.',
      customOrderId: 'co_3',
    });
  });

  it('rejects verification when the gateway does not match the initialized payment attempt', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_9',
      buyerId: 'buyer_1',
      brandId: 'brand_2',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      buyerPriceSummaryJson: { grandTotal: 825 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_9',
      buyerId: 'buyer_1',
      customOrderId: 'co_9',
      reference: 'TH-CO-mismatch',
      amount: 825,
      currency: 'NGN',
      status: 'PENDING',
      provider: 'paystack',
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
    });

    await expect(
      service.verifyPayment('buyer_1', 'co_9', {
        reference: 'TH-CO-mismatch',
        gateway: 'flutterwave',
        statusHint: 'success',
      }),
    ).rejects.toThrow('Payment verification gateway does not match the initialized payment attempt');
  });

  it('rejects verification when the provided status hint conflicts with the stored provider result', async () => {
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_conflict',
      buyerId: 'buyer_1',
      brandId: 'brand_2',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      buyerPriceSummaryJson: { grandTotal: 825 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_conflict',
      buyerId: 'buyer_1',
      customOrderId: 'co_conflict',
      reference: 'TH-CO-conflict',
      amount: 825,
      currency: 'NGN',
      status: 'PENDING',
      provider: 'paystack',
      providerMode: 'mock',
      responseSnapshot: { mockReturnStatus: 'success' },
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
    });
    paymentService.isTerminalStatus.mockReturnValue(false);

    await expect(
      service.verifyPayment('buyer_1', 'co_conflict', {
        reference: 'TH-CO-conflict',
        gateway: 'paystack',
        statusHint: 'failed',
      }),
    ).rejects.toThrow('Payment verification payload does not match the provider-confirmed attempt status');
  });

  it('returns a recoverable pending state for live payments awaiting provider confirmation', async () => {
    const updatedAttempt = {
      id: 'attempt_live_pending',
      buyerId: 'buyer_1',
      customOrderId: 'co_live_pending',
      reference: 'TH-CO-live-pending',
      amount: 825,
      currency: 'NGN',
      status: 'PENDING',
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
      responseSnapshot: {
        awaitingProviderConfirmation: true,
        recoveryAction: 'WAIT_FOR_PROVIDER_CONFIRMATION',
        recoveryMessage:
          'Payment is still awaiting provider callback or webhook confirmation. Recheck in a moment or after returning from the gateway.',
      },
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt_live_pending',
          buyerId: 'buyer_1',
          customOrderId: 'co_live_pending',
          reference: 'TH-CO-live-pending',
          status: 'PENDING',
          confirmedAt: null,
          finalizedAt: null,
          providerReference: null,
          providerTransactionId: null,
          providerAccessCode: null,
          providerChannel: null,
          channel: 'CARD',
          responseSnapshot: null,
          settlementCurrency: 'NGN',
          settlementAmount: 825,
        }),
        update: jest.fn().mockResolvedValue(updatedAttempt),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        count: jest.fn(),
        createMany: jest.fn(),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_live_pending',
      buyerId: 'buyer_1',
      brandId: 'brand_2',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      productionLeadDaysSnapshot: 5,
      deliveryMaxDaysSnapshot: 4,
      buyerPriceSummaryJson: { grandTotal: 825 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_live_pending',
      buyerId: 'buyer_1',
      customOrderId: 'co_live_pending',
      reference: 'TH-CO-live-pending',
      amount: 825,
      currency: 'NGN',
      status: 'PENDING',
      provider: 'paystack',
      providerMode: 'live',
      responseSnapshot: null,
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
    });
    paymentService.isTerminalStatus.mockReturnValue(false);

    const result = await service.verifyPayment('buyer_1', 'co_live_pending', {
      reference: 'TH-CO-live-pending',
      gateway: 'paystack',
    });

    expect(tx.customOrder.update).toHaveBeenCalledWith({
      where: { id: 'co_live_pending' },
      data: {
        paymentStatus: PaymentStatus.PENDING,
        status: 'PENDING_PAYMENT',
      },
    });
    expect(tx.paymentEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'VERIFICATION_PENDING_PROVIDER_CONFIRMATION',
        source: 'verify',
      }),
    });
    expect(tx.customOrderLedgerAllocation.createMany).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      status: 'PENDING',
      paymentAttemptId: 'attempt_live_pending',
      reference: 'TH-CO-live-pending',
      amount: 825,
      currency: 'NGN',
      paidAt: undefined,
      channel: 'CARD',
      failureMessage: undefined,
      customOrderId: 'co_live_pending',
      awaitingProviderConfirmation: true,
      recoveryAction: 'WAIT_FOR_PROVIDER_CONFIRMATION',
      recoveryMessage:
        'Payment is still awaiting provider callback or webhook confirmation. Recheck in a moment or after returning from the gateway.',
    });
  });

  it('does not create duplicate ledger allocations when they already exist', async () => {
    const updatedAttempt = {
      id: 'attempt_4',
      buyerId: 'buyer_1',
      customOrderId: 'co_4',
      reference: 'TH-CO-paid-existing-alloc',
      amount: 2000,
      currency: 'NGN',
      status: 'PAID',
      confirmedAt: new Date('2026-03-12T12:00:00.000Z'),
      channel: 'CARD',
      failureMessage: null,
    };
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue(undefined),
      paymentAttempt: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'attempt_4',
          buyerId: 'buyer_1',
          customOrderId: 'co_4',
          reference: 'TH-CO-paid-existing-alloc',
          status: 'PENDING',
          confirmedAt: null,
          finalizedAt: null,
          providerReference: null,
          providerTransactionId: null,
          providerAccessCode: null,
          providerChannel: null,
          channel: 'CARD',
          responseSnapshot: { mockReturnStatus: 'success' },
          settlementCurrency: 'NGN',
          settlementAmount: 2000,
        }),
        update: jest.fn().mockResolvedValue(updatedAttempt),
      },
      customOrder: {
        update: jest.fn().mockResolvedValue(undefined),
      },
      paymentEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderTimelineEvent: {
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderLedgerAllocation: {
        count: jest.fn().mockResolvedValue(2),
        createMany: jest.fn().mockResolvedValue({ count: 0 }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      customOrderCheckoutSession: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue(undefined),
      },
      customOrderCheckoutIntent: {
        findUnique: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (innerTx: typeof tx) => Promise<unknown>) =>
      callback(tx),
    );
    prisma.customOrder.findFirst.mockResolvedValue({
      id: 'co_4',
      buyerId: 'buyer_1',
      brandId: 'brand_4',
      currency: 'NGN',
      sourceBrandNameSnapshot: 'Threadly Atelier',
      productionLeadDaysSnapshot: 5,
      deliveryMaxDaysSnapshot: 4,
      buyerPriceSummaryJson: { grandTotal: 2000 },
    });
    prisma.paymentAttempt.findUnique.mockResolvedValue({
      id: 'attempt_4',
      buyerId: 'buyer_1',
      customOrderId: 'co_4',
      reference: 'TH-CO-paid-existing-alloc',
      provider: 'mockpay',
      providerMode: 'mock',
      amount: 2000,
      currency: 'NGN',
      status: 'PENDING',
      responseSnapshot: { mockReturnStatus: 'success' },
      confirmedAt: null,
      channel: 'CARD',
      failureMessage: null,
    });
    prisma.brand.findUnique.mockResolvedValue({ ownerId: 'brand-owner-4' });
    paymentService.isTerminalStatus.mockReturnValue(false);

    const result = await service.verifyPayment('buyer_1', 'co_4', {
      reference: 'TH-CO-paid-existing-alloc',
      gateway: 'mockpay',
      statusHint: 'success',
    });

    expect(tx.customOrderLedgerAllocation.count).toHaveBeenCalledWith({
      where: { customOrderId: 'co_4' },
    });
    expect(tx.customOrderLedgerAllocation.createMany).not.toHaveBeenCalled();
    expect(ledgerService.postCustomOrderPaymentReceived).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_4',
      totalAmount: 2000,
      currency: 'NGN',
    });
    expect(ledgerService.postCustomOrderImmediateRelease).toHaveBeenCalledWith(tx, {
      customOrderId: 'co_4',
      brandId: 'brand_4',
      currency: 'NGN',
      amount: 1200,
      commissionAmount: 120,
      netBrandAmount: 1080,
    });
    expect(financialDocumentsService.issueBuyerReceipt).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        paymentAttemptId: 'attempt_4',
        customOrderId: 'co_4',
        currency: 'NGN',
        grossAmount: 2000,
      }),
    );
    expect(result.success).toBe(true);
    expect(result.customOrderId).toBe('co_4');
  });
});
