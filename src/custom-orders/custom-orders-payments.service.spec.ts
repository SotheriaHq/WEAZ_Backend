import { Test, TestingModule } from '@nestjs/testing';
import { PaymentMethod, PaymentStatus, PaymentSubjectType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentService } from 'src/payment/payment.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import { CustomOrdersPaymentsService } from './custom-orders-payments.service';

describe('CustomOrdersPaymentsService', () => {
  let service: CustomOrdersPaymentsService;
  let prisma: any;
  let paymentService: any;

  beforeEach(async () => {
    prisma = {
      brand: {
        findUnique: jest.fn(),
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
      },
      $transaction: jest.fn(),
    };

    paymentService = {
      validatePaymentRequest: jest.fn(),
      resolveCallbackBaseUrl: jest.fn(),
      initializeGateway: jest.fn(),
      getProviderMode: jest.fn(),
      resolveVerificationStatus: jest.fn(),
      isTerminalStatus: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomOrdersPaymentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: PaymentService, useValue: paymentService },
        {
          provide: CustomOrderSideEffectsService,
          useValue: {
            enqueueNotification: jest.fn(),
            recordAnalyticsEvent: jest.fn(),
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
      status: 'success',
      data: {
        paymentAttemptId: 'attempt_1',
        reference: 'TH-CO-existing',
        gateway: 'mockpay',
        status: 'PENDING',
        channel: 'CARD',
        callbackUrl: 'https://callback.test',
        authorizationUrl: 'https://authorize.test',
        bankAccount: undefined,
        nextAction: { type: 'REDIRECT' },
      },
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
    expect(result.data.reference).toBe('TH-CO-active');
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
      paymentAttempt: {
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
      data: {
        paymentStatus: PaymentStatus.PAID,
        status: 'PENDING_BRAND_ACCEPTANCE',
      },
    });
    expect(tx.customOrderLedgerAllocation.createMany).toHaveBeenCalledTimes(1);
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
    expect(String(createManyArg.data[1].amount)).toBe('400');
    expect(result).toEqual({
      status: 'success',
      data: {
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
      },
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
      status: 'success',
      data: {
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
      },
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
      paymentAttempt: {
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
      status: 'success',
      data: {
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
      },
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
      paymentAttempt: {
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
    expect(result.data.success).toBe(true);
    expect(result.data.customOrderId).toBe('co_4');
  });
});