import { ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { ReconciliationService } from './reconciliation.service';

describe('ReconciliationService', () => {
  let service: ReconciliationService;
  let prisma: any;

  beforeEach(() => {
    prisma = {
      paymentAttempt: {
        findMany: jest.fn(),
      },
      ledgerTransaction: {
        findMany: jest.fn(),
      },
      ledgerAccount: {
        findMany: jest.fn(),
      },
      payout: {
        findMany: jest.fn(),
      },
      reconciliationRun: {
        create: jest.fn(),
        update: jest.fn(),
        findMany: jest.fn(),
      },
      reconciliationItem: {
        create: jest.fn(),
        findMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
    };

    service = new ReconciliationService(prisma);
  });

  it('creates a completed payment reconciliation run with matched summary', async () => {
    prisma.reconciliationRun.create.mockResolvedValue({ id: 'run-1' });
    prisma.paymentAttempt.findMany.mockResolvedValue([
      {
        id: 'attempt-1',
        reference: 'REF-123',
        settlementAmount: new Prisma.Decimal('100.00'),
        amount: new Prisma.Decimal('100.00'),
        settlementCurrency: 'NGN',
        currency: 'NGN',
        subjectType: 'ORDER',
        customOrderId: null,
        orderIds: ['order-1'],
      },
    ]);
    prisma.ledgerTransaction.findMany.mockResolvedValue([
      { id: 'ledger-1', totalAmount: new Prisma.Decimal('100.00') },
    ]);
    prisma.reconciliationItem.create.mockResolvedValue({ id: 'item-1' });
    prisma.reconciliationRun.update.mockResolvedValue({
      id: 'run-1',
      status: 'COMPLETED',
      summaryJson: {
        totalItems: 1,
        matchedCount: 1,
        unresolvedCount: 0,
        discrepancyCount: 0,
        unmatchedCount: 0,
      },
    });

    const result = await service.createRun({
      scope: 'PAYMENTS',
      actorId: 'admin-1',
    });

    expect(prisma.reconciliationItem.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          runId: 'run-1',
          status: 'MATCHED',
          referenceType: 'PaymentAttempt',
          referenceId: 'attempt-1',
        }),
      }),
    );
    expect(prisma.reconciliationRun.update).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { id: 'run-1' },
        data: expect.objectContaining({
          status: 'COMPLETED',
          summaryJson: expect.objectContaining({
            totalItems: 1,
            matchedCount: 1,
          }),
        }),
      }),
    );
    expect(result.status).toBe('COMPLETED');
  });

  it('prevents a non-superadmin from claiming an item owned by another admin', async () => {
    prisma.reconciliationItem.findUnique.mockResolvedValue({
      id: 'item-1',
      assignedAdminId: 'admin-2',
      assignedAt: new Date('2026-03-24T10:00:00.000Z'),
    });

    await expect(
      service.claimItem('item-1', 'admin-1', Role.Admin),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires ownership before resolving an item for a non-superadmin', async () => {
    prisma.reconciliationItem.findUnique.mockResolvedValue({
      id: 'item-1',
      assignedAdminId: null,
    });

    await expect(
      service.resolveItem('item-1', 'admin-1', Role.Admin, 'resolved'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
