import { Injectable, NotFoundException } from '@nestjs/common';
import { AdminAuditAction, Prisma, Role } from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CommissionService } from 'src/finance/commission.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { ReconciliationService } from 'src/finance/reconciliation.service';
import { PrismaService } from 'src/prisma/prisma.service';

const COMMISSION_RULE_SCOPE = {
  PLATFORM: 'PLATFORM',
  BRAND: 'BRAND',
} as const;

type CommissionRuleScope =
  (typeof COMMISSION_RULE_SCOPE)[keyof typeof COMMISSION_RULE_SCOPE];

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

const FINANCIAL_DOCUMENT_TYPE = {
  BUYER_RECEIPT: 'BUYER_RECEIPT',
  BRAND_SETTLEMENT_STATEMENT: 'BRAND_SETTLEMENT_STATEMENT',
  PLATFORM_COMMISSION_INVOICE: 'PLATFORM_COMMISSION_INVOICE',
  CREDIT_NOTE: 'CREDIT_NOTE',
} as const;

type FinancialDocumentType =
  (typeof FINANCIAL_DOCUMENT_TYPE)[keyof typeof FINANCIAL_DOCUMENT_TYPE];

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commissionService: CommissionService,
    private readonly reconciliationService: ReconciliationService,
    private readonly financialDocumentsService: FinancialDocumentsService,
  ) {}

  async getOverview() {
    const [
      paidAttempts,
      paidPayouts,
      refundTransactions,
      commissionEntries,
      activeRules,
      unresolvedItems,
      recentRuns,
      recentDocuments,
    ] = await Promise.all([
      this.prisma.paymentAttempt.aggregate({
        where: { status: 'PAID' },
        _sum: { settlementAmount: true, amount: true },
      }),
      this.prisma.payout.aggregate({
        where: { status: 'PAID' },
        _sum: { amount: true },
      }),
      this.prisma.ledgerTransaction.aggregate({
        where: { type: 'REFUND_ISSUED' },
        _sum: { totalAmount: true },
      }),
      this.prisma.ledgerEntry.findMany({
        where: {
          account: { subType: 'PLATFORM_COMMISSION' },
        },
        select: { direction: true, amount: true },
      }),
      (this.prisma as any).commissionRule.count({ where: { isActive: true } }),
      (this.prisma as any).reconciliationItem.count({
        where: {
          status: {
            in: [
              RECONCILIATION_ITEM_STATUS.UNMATCHED_INTERNAL,
              RECONCILIATION_ITEM_STATUS.DISCREPANCY,
            ],
          },
        },
      }),
      this.reconciliationService.listRuns({ take: 5 }),
      this.financialDocumentsService.listDocuments({ take: 6 }),
    ]);

    const totalCommissions = this.roundMoney(
      commissionEntries.reduce((sum, entry) => {
        const amount = Number(entry.amount);
        return sum + (entry.direction === 'CREDIT' ? amount : -amount);
      }, 0),
    );

    const gmv = this.roundMoney(
      Number(paidAttempts._sum.settlementAmount ?? paidAttempts._sum.amount ?? 0),
    );

    return {
      currency: 'NGN',
      gmv,
      totalCommissions,
      totalPayouts: this.roundMoney(Number(paidPayouts._sum.amount ?? 0)),
      totalRefunds: this.roundMoney(Number(refundTransactions._sum.totalAmount ?? 0)),
      activeCommissionRules: activeRules,
      unresolvedReconciliationItems: unresolvedItems,
      recentRuns,
      recentDocuments,
    };
  }

  async listCommissionRules() {
    return this.commissionService.listRules();
  }

  async createCommissionRule(
    actorId: string,
    req: Request,
    dto: {
      name: string;
      scope?: CommissionRuleScope;
      brandId?: string | null;
      currency?: string | null;
      ratePercent: number;
      minFeeAmount?: number | null;
      maxFeeAmount?: number | null;
      isDefault?: boolean;
      isActive?: boolean;
      effectiveFrom?: string;
      effectiveTo?: string | null;
    },
  ) {
    const created = await this.commissionService.createRule({
      name: dto.name.trim(),
      scope: dto.scope ?? COMMISSION_RULE_SCOPE.PLATFORM,
      brandId: dto.brandId ?? null,
      currency: dto.currency?.trim() || null,
      ratePercent: new Prisma.Decimal(dto.ratePercent.toFixed(2)),
      minFeeAmount:
        dto.minFeeAmount != null
          ? new Prisma.Decimal(dto.minFeeAmount.toFixed(2))
          : null,
      maxFeeAmount:
        dto.maxFeeAmount != null
          ? new Prisma.Decimal(dto.maxFeeAmount.toFixed(2))
          : null,
      isDefault: Boolean(dto.isDefault),
      isActive: dto.isActive !== false,
      effectiveFrom: dto.effectiveFrom ? new Date(dto.effectiveFrom) : new Date(),
      effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null,
      createdById: actorId,
      updatedById: actorId,
    });

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_COMMISSION_RULE_CREATE, {
      targetId: created.id,
      newState: created,
    });

    return created;
  }

  async updateCommissionRule(
    ruleId: string,
    actorId: string,
    req: Request,
    dto: {
      name?: string;
      currency?: string | null;
      ratePercent?: number;
      minFeeAmount?: number | null;
      maxFeeAmount?: number | null;
      isDefault?: boolean;
      isActive?: boolean;
      effectiveFrom?: string;
      effectiveTo?: string | null;
    },
  ) {
    const existing = await (this.prisma as any).commissionRule.findUnique({
      where: { id: ruleId },
    });
    if (!existing) {
      throw new NotFoundException('Commission rule not found');
    }

    const updated = await this.commissionService.updateRule(ruleId, {
      ...(dto.name ? { name: dto.name.trim() } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency?.trim() || null } : {}),
      ...(dto.ratePercent !== undefined
        ? { ratePercent: new Prisma.Decimal(dto.ratePercent.toFixed(2)) }
        : {}),
      ...(dto.minFeeAmount !== undefined
        ? {
            minFeeAmount:
              dto.minFeeAmount != null
                ? new Prisma.Decimal(dto.minFeeAmount.toFixed(2))
                : null,
          }
        : {}),
      ...(dto.maxFeeAmount !== undefined
        ? {
            maxFeeAmount:
              dto.maxFeeAmount != null
                ? new Prisma.Decimal(dto.maxFeeAmount.toFixed(2))
                : null,
          }
        : {}),
      ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
      ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
      ...(dto.effectiveFrom !== undefined
        ? { effectiveFrom: new Date(dto.effectiveFrom) }
        : {}),
      ...(dto.effectiveTo !== undefined
        ? { effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null }
        : {}),
      updatedById: actorId,
    });

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_COMMISSION_RULE_UPDATE, {
      targetId: updated.id,
      previousState: existing,
      newState: updated,
    });

    return updated;
  }

  async createReconciliationRun(
    actorId: string,
    req: Request,
    dto: { scope: ReconciliationScope },
  ) {
    const run = await this.reconciliationService.createRun({
      scope: dto.scope,
      actorId,
    });

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RUN, {
      targetId: run.id,
      newState: { scope: dto.scope, status: run.status },
    });

    return run;
  }

  async listReconciliationRuns(params?: {
    scope?: ReconciliationScope;
    status?: ReconciliationRunStatus;
    take?: number;
  }) {
    return this.reconciliationService.listRuns(params);
  }

  async listReconciliationItems(params: {
    runId?: string;
    status?: ReconciliationItemStatus;
    take?: number;
  }) {
    return this.reconciliationService.listItems(params);
  }

  async claimReconciliationItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const item = await this.reconciliationService.claimItem(itemId, actorId, actorRole);
    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_CLAIM, {
      targetId: item.id,
      newState: { assignedAdminId: actorId },
    });
    return item;
  }

  async releaseReconciliationItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
    reason?: string,
  ) {
    const item = await this.reconciliationService.releaseItem(
      itemId,
      actorId,
      actorRole,
      reason,
    );
    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RELEASE, {
      targetId: item.id,
      newState: { assignedAdminId: null, reason: reason ?? null },
    });
    return item;
  }

  async resolveReconciliationItem(
    itemId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
    note: string,
  ) {
    const item = await this.reconciliationService.resolveItem(
      itemId,
      actorId,
      actorRole,
      note,
    );
    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RESOLVE, {
      targetId: item.id,
      newState: { status: item.status, resolutionNote: item.resolutionNote },
    });
    return item;
  }

  async listDocuments(params?: {
    type?: FinancialDocumentType;
    payoutId?: string;
    paymentAttemptId?: string;
    take?: number;
  }) {
    return this.financialDocumentsService.listDocuments(params);
  }

  async getDocument(id: string) {
    const document = await this.financialDocumentsService.getDocument(id);
    if (!document) {
      throw new NotFoundException('Financial document not found');
    }
    return document;
  }

  private async recordAudit(
    req: Request,
    actorId: string,
    action: AdminAuditAction,
    params: {
      targetId: string;
      previousState?: unknown;
      newState?: unknown;
    },
  ) {
    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: actorId,
        action,
        targetType: 'Finance',
        targetId: params.targetId,
        previousState: params.previousState ?? null,
        newState: params.newState ?? null,
        ipAddress: req.socket?.remoteAddress ?? null,
        userAgent: req.headers['user-agent'] ?? null,
      },
    });
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }
}
