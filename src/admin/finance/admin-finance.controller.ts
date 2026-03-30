import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminFinanceService } from './admin-finance.service';

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

@Controller('admin/finance')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminFinanceController {
  constructor(private readonly financeService: AdminFinanceService) {}

  @Get('overview')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  getOverview() {
    return this.financeService.getOverview();
  }

  @Get('payments')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listPayments(
    @Query('status') status?: string,
    @Query('gateway') gateway?: string,
    @Query('subjectType') subjectType?: string,
    @Query('q') q?: string,
    @Query('brandId') brandId?: string,
    @Query('take') take?: string,
  ) {
    return this.financeService.listPaymentAttempts({
      status,
      gateway,
      subjectType,
      q,
      brandId,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('payments/:reference')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  getPayment(@Param('reference') reference: string) {
    return this.financeService.getPaymentAttempt(reference);
  }

  @Get('transactions')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listTransactions(
    @Query('type') type?: string,
    @Query('referenceType') referenceType?: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
    @Query('take') take?: string,
  ) {
    return this.financeService.listTransactionsDetailed({
      type,
      referenceType,
      dateFrom,
      dateTo,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('escrow-holds')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listEscrowHolds(
    @Query('status') status?: string,
    @Query('brandId') brandId?: string,
    @Query('take') take?: string,
  ) {
    return this.financeService.listEscrowHolds({
      status,
      brandId,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post('escrow-holds/:id/release')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  releaseEscrowHold(
    @Param('id') id: string,
    @Body() dto: { holdType: 'STANDARD_ORDER' | 'CUSTOM_ORDER'; note?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.releaseEscrowHold(id, actorId, req, dto);
  }

  @Post('escrow-holds/:id/freeze')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  freezeEscrowHold(
    @Param('id') id: string,
    @Body() dto: { reason: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.freezeEscrowHold(id, actorId, req, dto.reason);
  }

  @Post('escrow-holds/:id/unfreeze')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  unfreezeEscrowHold(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.unfreezeEscrowHold(id, actorId, req);
  }

  @Get('commission-rules')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listCommissionRules() {
    return this.financeService.listCommissionRules();
  }

  @Post('commission-rules')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  createCommissionRule(
    @Body()
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
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.createCommissionRule(actorId, req, dto);
  }

  @Patch('commission-rules/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  updateCommissionRule(
    @Param('id') id: string,
    @Body()
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
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.updateCommissionRule(id, actorId, req, dto);
  }

  @Post('reconciliation-runs')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  createReconciliationRun(
    @Body() dto: { scope: ReconciliationScope },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.financeService.createReconciliationRun(actorId, req, dto);
  }

  @Get('reconciliation-runs')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listReconciliationRuns(
    @Query('scope') scope?: ReconciliationScope,
    @Query('status') status?: ReconciliationRunStatus,
    @Query('take') take?: string,
  ) {
    return this.financeService.listReconciliationRuns({
      scope,
      status,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('reconciliation-items')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listReconciliationItems(
    @Query('runId') runId?: string,
    @Query('status') status?: ReconciliationItemStatus,
    @Query('take') take?: string,
  ) {
    return this.financeService.listReconciliationItems({
      runId,
      status,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Post('reconciliation-items/:id/claim')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  claimReconciliationItem(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.financeService.claimReconciliationItem(id, actorId, actorRole, req);
  }

  @Post('reconciliation-items/:id/release')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  releaseReconciliationItem(
    @Param('id') id: string,
    @Body() dto: { reason?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.financeService.releaseReconciliationItem(
      id,
      actorId,
      actorRole,
      req,
      dto.reason,
    );
  }

  @Post('reconciliation-items/:id/resolve')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  resolveReconciliationItem(
    @Param('id') id: string,
    @Body() dto: { note: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    const actorRole = (req as any).user.role as Role;
    return this.financeService.resolveReconciliationItem(
      id,
      actorId,
      actorRole,
      req,
      dto.note,
    );
  }

  @Get('documents')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  listDocuments(
    @Query('type') type?: FinancialDocumentType,
    @Query('payoutId') payoutId?: string,
    @Query('paymentAttemptId') paymentAttemptId?: string,
    @Query('take') take?: string,
  ) {
    return this.financeService.listDocuments({
      type,
      payoutId,
      paymentAttemptId,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Get('documents/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  getDocument(@Param('id') id: string) {
    return this.financeService.getDocument(id);
  }
}
