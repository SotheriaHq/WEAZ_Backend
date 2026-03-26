import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminAuditAction, PayoutStatus, Role } from '@prisma/client';
import { AdminPayoutsService } from './admin-payouts.service';
import { LedgerService } from 'src/finance/ledger.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';

describe('AdminPayoutsService', () => {
  const prisma = {
    payout: {
      findUnique: jest.fn(),
      update: jest.fn(),
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

  const service = new AdminPayoutsService(
    prisma,
    ledgerService as LedgerService,
    financialDocumentsService as FinancialDocumentsService,
  );
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'jest' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
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
      status: PayoutStatus.PENDING_APPROVAL,
      assignedAdminId: 'admin_1',
      statusReason: null,
    });

    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        payout: {
          update: jest.fn().mockResolvedValue({
            id: 'p_1',
            status: PayoutStatus.APPROVED,
          }),
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
      status: PayoutStatus.APPROVED,
    });
  });
});
