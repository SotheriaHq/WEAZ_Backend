import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { PayoutStatus, Role } from '@prisma/client';
import { createHmac } from 'crypto';
import { AdminPayoutsService } from './admin-payouts.service';
import { LedgerService } from 'src/finance/ledger.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';

describe('AdminPayoutsService', () => {
  const prisma = {
    payout: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    payoutEvent: {
      create: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    storePaymentAccount: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;

  const ledgerService = {
    postPayoutDisbursed: jest.fn(),
  } as any;

  const financialDocumentsService = {
    issuePayoutSettlementStatement: jest.fn(),
    issueCommissionInvoice: jest.fn(),
  } as any;

  const webhookEventsQueue = {
    enqueuePayoutWebhook: jest.fn(),
  } as any;

  const service = new AdminPayoutsService(
    prisma,
    ledgerService as LedgerService,
    financialDocumentsService as FinancialDocumentsService,
    webhookEventsQueue,
  );

  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'jest' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.PAYSTACK_SECRET_KEY = 'sk_test_123';
    (global as any).fetch = jest.fn();
  });

  it('blocks non-superadmin claim when payout is owned by another admin', async () => {
    prisma.payout.findUnique.mockResolvedValue({
      id: 'p_1',
      status: PayoutStatus.PENDING_APPROVAL,
      assignedAdminId: 'admin_1',
    });

    await expect(
      service.claim('p_1', 'admin_2', Role.Admin, req),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires ownership before non-superadmin status updates', async () => {
    prisma.payout.findUnique.mockResolvedValue({
      id: 'p_1',
      status: PayoutStatus.PENDING_APPROVAL,
      assignedAdminId: null,
      statusReason: null,
    });

    await expect(
      service.updateStatus(
        'p_1',
        { status: PayoutStatus.APPROVED },
        'admin_1',
        Role.Admin,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updates payout status when owned by actor', async () => {
    prisma.payout.findUnique.mockResolvedValue({
      id: 'p_1',
      brandId: 'brand_1',
      amount: 2500,
      currency: 'NGN',
      status: PayoutStatus.PENDING_APPROVAL,
      assignedAdminId: 'admin_1',
      statusReason: null,
      failureReason: null,
      paidAt: null,
      processedAt: null,
      approvedAt: null,
      providerTransferFinalizedAt: null,
      providerTransferReversedAt: null,
    });

    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        payout: {
          update: jest.fn().mockResolvedValue({
            id: 'p_1',
            brandId: 'brand_1',
            amount: 2500,
            currency: 'NGN',
            status: PayoutStatus.APPROVED,
            brand: { id: 'brand_1', name: 'Brand One' },
          }),
        },
        payoutEvent: {
          create: jest.fn().mockResolvedValue(undefined),
        },
        adminAuditLog: {
          create: jest.fn().mockResolvedValue(undefined),
        },
      }),
    );

    const result = await service.updateStatus(
      'p_1',
      { status: PayoutStatus.APPROVED, reason: 'Approved for payout' },
      'admin_1',
      Role.Admin,
      req,
    );

    expect(result).toEqual({
      id: 'p_1',
      brandId: 'brand_1',
      amount: 2500,
      currency: 'NGN',
      status: PayoutStatus.APPROVED,
      brand: { id: 'brand_1', name: 'Brand One' },
    });
  });

  it('requires an active payment account before transfer initiation', async () => {
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: jest.fn().mockResolvedValue(undefined),
        payout: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'p_1',
            brandId: 'brand_1',
            amount: 2500,
            currency: 'NGN',
            status: PayoutStatus.APPROVED,
            assignedAdminId: 'admin_1',
            providerTransferCode: null,
            providerTransferReference: null,
          }),
        },
        storePaymentAccount: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
      }),
    );

    await expect(
      service.initiateTransfer('p_1', 'admin_1', Role.Admin, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('rejects transfer initiation after the locked payout has already moved to processing', async () => {
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: jest.fn().mockResolvedValue(undefined),
        payout: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'p_1',
            brandId: 'brand_1',
            amount: 2500,
            currency: 'NGN',
            status: PayoutStatus.PROCESSING,
            assignedAdminId: 'admin_1',
            providerTransferCode: 'TRF_locked',
            providerTransferReference: 'threadly-payout-locked',
          }),
        },
      }),
    );

    await expect(
      service.initiateTransfer('p_1', 'admin_1', Role.Admin, req),
    ).rejects.toBeInstanceOf(ConflictException);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('requires a payout to remain in otp state before transfer finalization', async () => {
    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        $queryRaw: jest.fn().mockResolvedValue(undefined),
        payout: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'p_1',
            brandId: 'brand_1',
            amount: 2500,
            currency: 'NGN',
            status: PayoutStatus.PROCESSING,
            assignedAdminId: 'admin_1',
            providerTransferCode: 'TRF_pending',
            providerTransferStatus: 'PENDING',
          }),
        },
      }),
    );

    await expect(
      service.finalizeTransferOtp('p_1', '123456', 'admin_1', Role.Admin, req),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('ignores duplicate payout webhook events after durable receipt is recorded', async () => {
    const rawBody = JSON.stringify({
      event: 'transfer.success',
      data: {
        transfer_code: 'TRF_123',
        reference: 'threadly-payout-ref',
        status: 'success',
      },
    });
    const signature = createHmac('sha512', process.env.PAYSTACK_SECRET_KEY as string)
      .update(rawBody)
      .digest('hex');

    prisma.payout.findFirst.mockResolvedValue({
      id: 'p_1',
      brandId: 'brand_1',
      amount: 2500,
      currency: 'NGN',
      status: PayoutStatus.PROCESSING,
      assignedAdminId: 'admin_1',
      providerTransferCode: 'TRF_123',
      providerTransferReference: 'threadly-payout-ref',
      gatewayReference: 'threadly-payout-ref',
    });
    prisma.payoutEvent.create.mockRejectedValue(
      new Error('Unique constraint failed on the fields: (`providerEventKey`)'),
    );
    prisma.payoutEvent.findFirst.mockResolvedValue({ processedAt: new Date() });

    await expect(
      service.handlePaystackWebhook(
        {
          event: 'transfer.success',
          data: {
            transfer_code: 'TRF_123',
            reference: 'threadly-payout-ref',
            status: 'success',
          },
        },
        {
          headers: { 'x-paystack-signature': signature },
          rawBody,
        },
      ),
    ).resolves.toBeUndefined();

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
