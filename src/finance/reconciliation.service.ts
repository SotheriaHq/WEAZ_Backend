import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { LedgerAccountType, LedgerEntryDirection, Prisma, Role } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

const RECONCILIATION_SCOPE = {
  PAYMENTS: 'PAYMENTS',
  PAYOUTS: 'PAYOUTS',
  LEDGER_INTEGRITY: 'LEDGER_INTEGRITY',
} as const;

type ReconciliationScope =
  (typeof RECONCILIATION_SCOPE)[keyof typeof RECONCILIATION_SCOPE];

const RECONCILIATION_RUN_STATUS = {
  RUNNING: 'RUNNING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;

type ReconciliationRunStatus =
  (typeof RECONCILIATION_RUN_STATUS)[keyof typeof RECONCILIATION_RUN_STATUS];

const RECONCILIATION_ITEM_STATUS = {
  MATCHED: 'MATCHED',
  DISCREPANCY: 'DISCREPANCY',
  UNMATCHED_INTERNAL: 'UNMATCHED_INTERNAL',
  RESOLVED: 'RESOLVED',
} as const;

type ReconciliationItemStatus =
  (typeof RECONCILIATION_ITEM_STATUS)[keyof typeof RECONCILIATION_ITEM_STATUS];

@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async createRun(params: {
    scope: ReconciliationScope;
    actorId?: string | null;
    filtersJson?: Prisma.InputJsonValue;
  }) {
    const run = await (this.prisma as any).reconciliationRun.create({
      data: {
        scope: params.scope,
        status: RECONCILIATION_RUN_STATUS.RUNNING,
        startedById: params.actorId ?? null,
        filtersJson: params.filtersJson ?? Prisma.JsonNull,
      },
    });

    try {
      const summary =
        params.scope === RECONCILIATION_SCOPE.PAYMENTS
          ? await this.reconcilePayments(run.id)
          : params.scope === RECONCILIATION_SCOPE.PAYOUTS
            ? await this.reconcilePayouts(run.id)
            : await this.reconcileLedgerIntegrity(run.id);

      return (this.prisma as any).reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: RECONCILIATION_RUN_STATUS.COMPLETED,
          summaryJson: summary as Prisma.InputJsonValue,
          completedAt: new Date(),
        },
        include: {
          items: {
            take: 50,
            orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
          },
        },
      });
    } catch (error) {
      await (this.prisma as any).reconciliationRun.update({
        where: { id: run.id },
        data: {
          status: RECONCILIATION_RUN_STATUS.FAILED,
          errorMessage: (error as Error).message,
          failedAt: new Date(),
        },
      });
      throw error;
    }
  }

  async listRuns(params?: {
    scope?: ReconciliationScope;
    status?: ReconciliationRunStatus;
    take?: number;
  }) {
    return (this.prisma as any).reconciliationRun.findMany({
      where: {
        ...(params?.scope ? { scope: params.scope } : {}),
        ...(params?.status ? { status: params.status } : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.min(params?.take ?? 20, 100),
      include: {
        _count: {
          select: { items: true },
        },
      },
    });
  }

  async listItems(params: {
    runId?: string;
    status?: ReconciliationItemStatus;
    take?: number;
  }) {
    return (this.prisma as any).reconciliationItem.findMany({
      where: {
        ...(params.runId ? { runId: params.runId } : {}),
        ...(params.status ? { status: params.status } : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: Math.min(params.take ?? 50, 200),
    });
  }

  async claimItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
  ) {
    const item = await (this.prisma as any).reconciliationItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new NotFoundException('Reconciliation item not found');
    }

    if (
      item.assignedAdminId &&
      item.assignedAdminId !== actorId &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ConflictException('Reconciliation item is already assigned to another admin');
    }

    return (this.prisma as any).reconciliationItem.update({
      where: { id: itemId },
      data: {
        assignedAdminId: actorId,
        assignedAt: item.assignedAdminId ? item.assignedAt : new Date(),
        releasedAt: null,
      },
    });
  }

  async releaseItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
    resolutionNote?: string,
  ) {
    const item = await (this.prisma as any).reconciliationItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new NotFoundException('Reconciliation item not found');
    }

    this.assertOwnership(item.assignedAdminId, actorId, actorRole);

    return (this.prisma as any).reconciliationItem.update({
      where: { id: itemId },
      data: {
        assignedAdminId: null,
        releasedAt: new Date(),
        resolutionNote: resolutionNote?.trim() || item.resolutionNote,
      },
    });
  }

  async resolveItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
    resolutionNote: string,
  ) {
    const item = await (this.prisma as any).reconciliationItem.findUnique({
      where: { id: itemId },
    });
    if (!item) {
      throw new NotFoundException('Reconciliation item not found');
    }

    this.assertOwnership(item.assignedAdminId, actorId, actorRole);

    return (this.prisma as any).reconciliationItem.update({
      where: { id: itemId },
      data: {
        status: RECONCILIATION_ITEM_STATUS.RESOLVED,
        resolvedById: actorId,
        resolvedAt: new Date(),
        resolutionNote: resolutionNote.trim(),
      },
    });
  }

  private async reconcilePayments(runId: string) {
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: { status: 'PAID' },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });

    const createdStatuses: ReconciliationItemStatus[] = [];
    for (const attempt of attempts) {
      const expectedAmount = Number(attempt.settlementAmount ?? attempt.amount ?? 0);
      const ledgerTransactions =
        attempt.subjectType === 'CUSTOM_ORDER' && attempt.customOrderId
          ? await this.prisma.ledgerTransaction.findMany({
              where: {
                type: 'PAYMENT_RECEIVED',
                referenceType: 'CustomOrder',
                referenceId: attempt.customOrderId,
              },
              select: { totalAmount: true, id: true },
            })
          : await this.prisma.ledgerTransaction.findMany({
              where: {
                type: 'PAYMENT_RECEIVED',
                referenceType: 'Order',
                referenceId: { in: attempt.orderIds },
              },
              select: { totalAmount: true, id: true },
            });

      const actualAmount = this.roundMoney(
        ledgerTransactions.reduce((sum, tx) => sum + Number(tx.totalAmount), 0),
      );
      const status =
        actualAmount === 0
          ? RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL
          : expectedAmount === actualAmount
            ? RECONCILIATION_ITEM_STATUS.MATCHED
            : RECONCILIATION_ITEM_STATUS.DISCREPANCY;

      createdStatuses.push(status);
      await (this.prisma as any).reconciliationItem.create({
        data: {
          runId,
          status,
          referenceType: 'PaymentAttempt',
          referenceId: attempt.id,
          expectedAmount: new Prisma.Decimal(expectedAmount.toFixed(2)),
          actualAmount: new Prisma.Decimal(actualAmount.toFixed(2)),
          currency: attempt.settlementCurrency || attempt.currency,
          summary:
            status === RECONCILIATION_ITEM_STATUS.MATCHED
              ? `Payment attempt ${attempt.reference} matched ledger receipts.`
              : status === RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL
                ? `Payment attempt ${attempt.reference} has no matching ledger receipt.`
                : `Payment attempt ${attempt.reference} amount differs from ledger receipts.`,
          detailsJson: {
            paymentAttemptId: attempt.id,
            paymentReference: attempt.reference,
            orderIds: attempt.orderIds,
            customOrderId: attempt.customOrderId,
            ledgerTransactionIds: ledgerTransactions.map((tx) => tx.id),
          },
        },
      });
    }

    return this.buildSummary(createdStatuses);
  }

  private async reconcilePayouts(runId: string) {
    const payouts = await this.prisma.payout.findMany({
      where: {
        status: {
          in: ['PAID', 'PROCESSING', 'RECONCILIATION_REVIEW'],
        },
      },
      orderBy: { updatedAt: 'desc' },
      take: 500,
    });

    const createdStatuses: ReconciliationItemStatus[] = [];
    for (const payout of payouts) {
      const ledgerTransactions = await this.prisma.ledgerTransaction.findMany({
        where: {
          type: 'PAYOUT_DISBURSED',
          referenceType: 'Payout',
          referenceId: payout.id,
        },
        select: { totalAmount: true, id: true },
      });

      const actualAmount = this.roundMoney(
        ledgerTransactions.reduce((sum, tx) => sum + Number(tx.totalAmount), 0),
      );
      const expectedAmount = Number(payout.amount);
      const status =
        payout.status === 'PAID' && actualAmount === 0
          ? RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL
          : payout.status === 'PAID' && actualAmount === expectedAmount
            ? RECONCILIATION_ITEM_STATUS.MATCHED
            : payout.status !== 'PAID' && actualAmount > 0
              ? RECONCILIATION_ITEM_STATUS.DISCREPANCY
              : actualAmount === expectedAmount
                ? RECONCILIATION_ITEM_STATUS.MATCHED
                : RECONCILIATION_ITEM_STATUS.DISCREPANCY;

      createdStatuses.push(status);
      await (this.prisma as any).reconciliationItem.create({
        data: {
          runId,
          status,
          referenceType: 'Payout',
          referenceId: payout.id,
          expectedAmount: new Prisma.Decimal(expectedAmount.toFixed(2)),
          actualAmount: new Prisma.Decimal(actualAmount.toFixed(2)),
          currency: payout.currency,
          summary:
            status === RECONCILIATION_ITEM_STATUS.MATCHED
              ? `Payout ${payout.id} matched payout ledger disbursement.`
              : status === RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL
                ? `Paid payout ${payout.id} has no ledger disbursement entry.`
                : `Payout ${payout.id} status and ledger disbursement are inconsistent.`,
          detailsJson: {
            payoutId: payout.id,
            payoutStatus: payout.status,
            ledgerTransactionIds: ledgerTransactions.map((tx) => tx.id),
          },
        },
      });
    }

    return this.buildSummary(createdStatuses);
  }

  private async reconcileLedgerIntegrity(runId: string) {
    const accounts = await this.prisma.ledgerAccount.findMany({
      include: {
        entries: {
          select: {
            direction: true,
            amount: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
      take: 1000,
    });

    const createdStatuses: ReconciliationItemStatus[] = [];
    for (const account of accounts) {
      const recalculatedBalance = this.roundMoney(
        account.entries.reduce((sum, entry) => {
          const amount = Number(entry.amount);
          return sum + this.getBalanceDelta(account.type, entry.direction, amount);
        }, 0),
      );
      const actualAmount = this.roundMoney(Number(account.currentBalance));
      const status =
        recalculatedBalance === actualAmount
          ? RECONCILIATION_ITEM_STATUS.MATCHED
          : RECONCILIATION_ITEM_STATUS.DISCREPANCY;

      createdStatuses.push(status);
      await (this.prisma as any).reconciliationItem.create({
        data: {
          runId,
          status,
          referenceType: 'LedgerAccount',
          referenceId: account.id,
          expectedAmount: new Prisma.Decimal(recalculatedBalance.toFixed(2)),
          actualAmount: new Prisma.Decimal(actualAmount.toFixed(2)),
          currency: account.currency,
          summary:
            status === RECONCILIATION_ITEM_STATUS.MATCHED
              ? `Ledger account ${account.code} matches recalculated balance.`
              : `Ledger account ${account.code} drifted from recalculated balance.`,
          detailsJson: {
            accountCode: account.code,
            accountType: account.type,
            entryCount: account.entries.length,
          },
        },
      });
    }

    return this.buildSummary(createdStatuses);
  }

  private buildSummary(statuses: ReconciliationItemStatus[]) {
    return {
      totalItems: statuses.length,
      matchedCount: statuses.filter((status) => status === RECONCILIATION_ITEM_STATUS.MATCHED)
        .length,
      unresolvedCount: statuses.filter(
        (status) =>
          status !== RECONCILIATION_ITEM_STATUS.MATCHED &&
          status !== RECONCILIATION_ITEM_STATUS.RESOLVED,
      ).length,
      discrepancyCount: statuses.filter(
        (status) => status === RECONCILIATION_ITEM_STATUS.DISCREPANCY,
      ).length,
      unmatchedCount: statuses.filter(
        (status) => status === RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL,
      ).length,
    };
  }

  private assertOwnership(
    assignedAdminId: string | null,
    actorId: string,
    actorRole: Role,
  ) {
    if (actorRole === Role.SuperAdmin) {
      return;
    }

    if (!assignedAdminId) {
      throw new ForbiddenException(
        'Reconciliation item must be claimed before it can be updated',
      );
    }

    if (assignedAdminId !== actorId) {
      throw new ForbiddenException('Reconciliation item is assigned to another admin');
    }
  }

  private getBalanceDelta(
    accountType: LedgerAccountType,
    direction: LedgerEntryDirection,
    amount: number,
  ) {
    const isDebitIncrease =
      accountType === LedgerAccountType.ASSET || accountType === LedgerAccountType.EXPENSE;

    if (direction === LedgerEntryDirection.DEBIT) {
      return isDebitIncrease ? amount : -amount;
    }

    return isDebitIncrease ? -amount : amount;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
