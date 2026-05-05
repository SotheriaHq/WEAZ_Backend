import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AdminAuditAction,
  CustomOrderActorType,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  EscrowReleaseCondition,
  EscrowHoldStatus,
  LedgerEntryDirection,
  PayoutStatus,
  Prisma,
  Role,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementPolicyScope,
  SettlementReleaseMode,
} from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CommissionService } from 'src/finance/commission.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { LedgerService } from 'src/finance/ledger.service';
import { ReconciliationService } from 'src/finance/reconciliation.service';
import { SettlementCalculatorService } from 'src/finance/settlement-calculator.service';
import {
  SettlementPolicyAdminInput,
  SettlementPolicyService,
} from 'src/finance/settlement-policy.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { resolveWebAppBaseUrl } from 'src/common/utils/web-app-url';
import { SystemConfigService } from '../system-config/system-config.service';

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

type FinanceBuyerSummary = {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
};

@Injectable()
export class AdminFinanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly commissionService: CommissionService,
    private readonly systemConfigService: SystemConfigService,
    private readonly reconciliationService: ReconciliationService,
    private readonly financialDocumentsService: FinancialDocumentsService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly ledgerService: LedgerService,
    private readonly settlementPolicyService: SettlementPolicyService,
    private readonly settlementCalculatorService: SettlementCalculatorService,
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
      pendingPayouts,
      activeEscrowHolds,
      settlementState,
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
      this.prisma.payout.count({
        where: {
          status: {
            in: ['PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'ON_HOLD', 'RECONCILIATION_REVIEW'] as any,
          },
        },
      }),
      this.prisma.escrowHold.count({
        where: {
          status: { in: [EscrowHoldStatus.HELD, EscrowHoldStatus.PARTIALLY_RELEASED, EscrowHoldStatus.FROZEN] },
        },
      }),
      this.getSettlementStateSummary(),
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
      pendingPayouts,
      activeEscrowHolds,
      settlementState,
      recentRuns,
      recentDocuments,
    };
  }

  async listSettlementPolicies(params?: {
    orderType?: SettlementOrderType;
    scope?: SettlementPolicyScope;
    brandId?: string | null;
    currency?: string | null;
    isActive?: boolean;
    take?: number;
  }) {
    return this.settlementPolicyService.listPolicies(params);
  }

  async getSettlementPolicy(id: string) {
    return this.settlementPolicyService.getPolicy(id);
  }

  async createSettlementPolicy(
    actorId: string,
    req: Request,
    dto: SettlementPolicyAdminInput,
  ) {
    const created = await this.settlementPolicyService.createPolicy(
      actorId,
      this.normalizeSettlementPolicyDto(dto),
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE, {
      targetType: 'SettlementPolicy',
      targetId: created.id,
      newState: created,
    });

    return created;
  }

  async updateSettlementPolicy(
    id: string,
    actorId: string,
    req: Request,
    dto: Partial<SettlementPolicyAdminInput>,
  ) {
    const existing = await this.settlementPolicyService.getPolicy(id);
    const updated = await this.settlementPolicyService.updatePolicy(
      id,
      actorId,
      this.normalizeSettlementPolicyDto({
        ...dto,
        orderType: dto.orderType ?? existing.orderType,
      }),
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE, {
      targetType: 'SettlementPolicy',
      targetId: updated.id,
      previousState: existing,
      newState: updated,
    });

    return updated;
  }

  async deactivateSettlementPolicy(id: string, actorId: string, req: Request) {
    const existing = await this.settlementPolicyService.getPolicy(id);
    const updated = await this.settlementPolicyService.deactivatePolicy(
      id,
      actorId,
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE, {
      targetType: 'SettlementPolicy',
      targetId: updated.id,
      previousState: existing,
      newState: updated,
    });

    return updated;
  }

  async activateSettlementPolicy(id: string, actorId: string, req: Request) {
    const existing = await this.settlementPolicyService.getPolicy(id);
    const updated = await this.settlementPolicyService.activatePolicy(
      id,
      actorId,
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE, {
      targetType: 'SettlementPolicy',
      targetId: updated.id,
      previousState: existing,
      newState: updated,
    });

    return updated;
  }

  async previewSettlementPolicy(dto: {
    orderType: SettlementOrderType;
    brandId: string;
    currency: string;
    amount: number;
    effectiveAt?: string | Date;
  }) {
    const orderType = dto.orderType;
    const brandId = String(dto.brandId ?? '').trim();
    const currency = String(dto.currency ?? '').trim().toUpperCase();
    const grossAmount = Number(dto.amount);
    const effectiveAt = dto.effectiveAt ? new Date(dto.effectiveAt) : new Date();

    if (!Object.values(SettlementOrderType).includes(orderType)) {
      throw new BadRequestException('orderType is invalid');
    }
    if (!brandId) {
      throw new BadRequestException('brandId is required');
    }
    if (!currency) {
      throw new BadRequestException('currency is required');
    }
    if (!Number.isFinite(grossAmount) || grossAmount <= 0) {
      throw new BadRequestException('amount must be greater than 0');
    }
    if (Number.isNaN(effectiveAt.getTime())) {
      throw new BadRequestException('effectiveAt must be a valid date');
    }

    const [resolvedPolicy, calculation] = await Promise.all([
      this.settlementPolicyService.resolveActivePolicy({
        orderType,
        brandId,
        currency,
        at: effectiveAt,
      }),
      this.settlementCalculatorService.calculate({
        orderType,
        brandId,
        grossAmount,
        currency,
        effectiveAt,
      }),
    ]);

    return {
      writesSnapshot: false,
      writesLedger: false,
      resolvedSettlementPolicy: resolvedPolicy,
      settlementBreakdown: calculation,
      commissionBreakdown: {
        commissionRuleId: calculation.commissionRuleId,
        commissionSource: calculation.commissionSource,
        commissionScope: calculation.commissionScope,
        commissionRate: calculation.commissionRate,
        commissionAmount: calculation.commissionAmount,
      },
    };
  }

  async listCommissionRules() {
    const rules = await this.commissionService.listRules();
    if (Array.isArray(rules) && rules.length > 0) {
      return rules;
    }

    const [defaultRate, standardRate, customRate] = await Promise.all([
      this.systemConfigService.getNumber('finance.commission.defaultPercent'),
      this.systemConfigService.getNumber('finance.commission.standardOrderPercent'),
      this.systemConfigService.getNumber('finance.commission.customOrderPercent'),
    ]);

    const nowIso = new Date().toISOString();
    return [
      this.buildSystemCommissionFallbackRule({
        idSuffix: 'default',
        name: 'System default commission',
        ratePercent: defaultRate,
        isDefault: true,
        createdAt: nowIso,
      }),
      this.buildSystemCommissionFallbackRule({
        idSuffix: 'standard-order',
        name: 'System standard-order commission',
        ratePercent: standardRate,
        isDefault: false,
        createdAt: nowIso,
      }),
      this.buildSystemCommissionFallbackRule({
        idSuffix: 'custom-order',
        name: 'System custom-order commission',
        ratePercent: customRate,
        isDefault: false,
        createdAt: nowIso,
      }),
    ];
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

  async listPaymentAttempts(params?: {
    status?: string;
    gateway?: string;
    subjectType?: string;
    q?: string;
    brandId?: string;
    take?: number;
  }) {
    const take = Math.min(params?.take ?? 50, 100);
    const attempts = await this.prisma.paymentAttempt.findMany({
      where: {
        ...(params?.status ? { status: params.status } : {}),
        ...(params?.gateway ? { provider: params.gateway } : {}),
        ...(params?.subjectType ? { subjectType: params.subjectType as any } : {}),
        ...(params?.q
          ? {
              OR: [
                { reference: { contains: params.q, mode: 'insensitive' } },
                { provider: { contains: params.q, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      take,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        provider: true,
        providerMode: true,
        paymentMethod: true,
        channel: true,
        status: true,
        amount: true,
        currency: true,
        settlementAmount: true,
        settlementCurrency: true,
        subjectType: true,
        customOrderId: true,
        orderIds: true,
        confirmedAt: true,
        lastVerifiedAt: true,
        createdAt: true,
        buyerId: true,
      },
    });

    const orderIds = Array.from(
      new Set(attempts.flatMap((attempt) => attempt.orderIds ?? []).filter(Boolean)),
    );
    const customOrderIds = Array.from(
      new Set(
        attempts
          .map((attempt) => attempt.customOrderId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const attemptBuyerIds = Array.from(
      new Set(
        attempts
          .map((attempt) => attempt.buyerId)
          .filter((value): value is string => Boolean(value)),
      ),
    );

    const [orders, customOrders] = await Promise.all([
      orderIds.length > 0
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: {
              id: true,
              customerName: true,
              brandId: true,
              brand: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      customOrderIds.length > 0
        ? this.prisma.customOrder.findMany({
            where: { id: { in: customOrderIds } },
            select: {
              id: true,
              sourceTitleSnapshot: true,
              brandId: true,
              buyerId: true,
              brand: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const buyerIds = Array.from(
      new Set([
        ...attemptBuyerIds,
        ...customOrders
          .map((order) => order.buyerId)
          .filter((value): value is string => Boolean(value)),
      ]),
    );
    const buyers = buyerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        })
      : [];

    const ordersById = new Map(orders.map((order) => [order.id, order]));
    const customOrdersById = new Map(customOrders.map((order) => [String(order.id), order]));
    const buyersById = new Map(buyers.map((buyer) => [buyer.id, buyer]));

    const items = attempts
      .map((attempt) => {
        const linkedOrders = (attempt.orderIds ?? [])
          .map((orderId) => ordersById.get(orderId))
          .filter((order): order is NonNullable<typeof order> => Boolean(order));
        const linkedCustomOrder = attempt.customOrderId
          ? customOrdersById.get(attempt.customOrderId)
          : null;

        const brands = linkedCustomOrder
          ? [linkedCustomOrder.brand]
          : Array.from(
              new Map(
                linkedOrders
                  .filter((order) => order.brand?.id)
                  .map((order) => [String(order.brand?.id), order.brand]),
              ).values(),
            );

        const buyer =
          (linkedCustomOrder?.buyerId
            ? buyersById.get(linkedCustomOrder.buyerId)
            : null) ??
          (attempt.buyerId ? buyersById.get(attempt.buyerId) : null) ??
          null;

        return {
          id: attempt.id,
          reference: attempt.reference,
          gateway: attempt.provider,
          providerMode: attempt.providerMode,
          paymentMethod: attempt.paymentMethod,
          channel: attempt.channel,
          status: attempt.status,
          amount: Number(attempt.amount ?? 0),
          currency: attempt.currency,
          settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? 0),
          settlementCurrency: attempt.settlementCurrency,
          subjectType: attempt.subjectType,
          createdAt: attempt.createdAt,
          confirmedAt: attempt.confirmedAt,
          lastVerifiedAt: attempt.lastVerifiedAt,
          buyer: this.toBuyerSummary(buyer),
          brands: brands
            .filter((brand): brand is { id: string; name: string | null } => Boolean(brand?.id))
            .map((brand) => ({
              id: brand.id,
              name: brand.name,
            })),
          orderCount: linkedOrders.length + (linkedCustomOrder ? 1 : 0),
          orders: linkedCustomOrder
              ? [
                {
                  id: linkedCustomOrder.id,
                  type: 'CUSTOM_ORDER',
                  title: this.formatCustomOrderTitle(linkedCustomOrder),
                },
              ]
            : linkedOrders.map((order) => ({
                id: order.id,
                type: 'ORDER',
                title: `Order #${order.id.slice(0, 8).toUpperCase()}`,
              })),
        };
      })
      .filter((item) => {
        if (!params?.brandId) {
          return true;
        }
        return item.brands.some((brand) => brand.id === params.brandId);
      });

    return {
      items,
      total: items.length,
    };
  }

  async getPaymentAttempt(reference: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      throw new NotFoundException('Payment attempt not found');
    }

    const [orders, customOrder, events] = await Promise.all([
      attempt.orderIds?.length
        ? this.prisma.order.findMany({
            where: { id: { in: attempt.orderIds } },
            select: {
              id: true,
              customerName: true,
              totalAmount: true,
              currency: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      attempt.customOrderId
        ? this.prisma.customOrder.findUnique({
            where: { id: attempt.customOrderId },
            select: {
              id: true,
              sourceTitleSnapshot: true,
              buyerId: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve(null),
      this.prisma.paymentEvent.findMany({
        where: { paymentAttemptId: attempt.id },
        orderBy: { createdAt: 'desc' },
        take: 20,
      }),
    ]);
    const buyerIds = Array.from(
      new Set(
        [attempt.buyerId, customOrder?.buyerId].filter(
          (value): value is string => Boolean(value),
        ),
      ),
    );
    const buyers = buyerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        })
      : [];
    const buyersById = new Map(buyers.map((buyer) => [buyer.id, buyer]));
    const settlementDetails = await this.buildPaymentSettlementDetails(
      attempt,
      orders,
      customOrder,
    );

    return {
      id: attempt.id,
      reference: attempt.reference,
      gateway: attempt.provider,
      providerMode: attempt.providerMode,
      paymentMethod: attempt.paymentMethod,
      channel: attempt.channel,
      status: attempt.status,
      amount: Number(attempt.amount ?? 0),
      currency: attempt.currency,
      settlementAmount: Number(attempt.settlementAmount ?? attempt.amount ?? 0),
      settlementCurrency: attempt.settlementCurrency,
      subjectType: attempt.subjectType,
      createdAt: attempt.createdAt,
      confirmedAt: attempt.confirmedAt,
      lastVerifiedAt: attempt.lastVerifiedAt,
      requestSnapshot: attempt.requestSnapshot,
      responseSnapshot: attempt.responseSnapshot,
      nextAction: attempt.nextAction,
      bankAccount: attempt.bankAccount,
      failureCode: attempt.failureCode,
      failureMessage: attempt.failureMessage,
      buyer: attempt.buyerId ? buyersById.get(attempt.buyerId) ?? null : null,
      orders,
      customOrder: customOrder
        ? {
            ...customOrder,
            buyer: buyersById.get(customOrder.buyerId) ?? null,
          }
        : null,
      settlementDetails,
      events,
    };
  }

  async getPaymentAttemptTimeline(reference: string) {
    const attempt = await this.prisma.paymentAttempt.findUnique({
      where: { reference },
    });

    if (!attempt) {
      throw new NotFoundException('Payment attempt not found');
    }

    const [events, checkoutSession] = await Promise.all([
      this.prisma.paymentEvent.findMany({
        where: { paymentAttemptId: attempt.id },
        orderBy: { createdAt: 'asc' },
      }),
      attempt.checkoutIntentId
        ? this.prisma.customOrderCheckoutSession.findUnique({
            where: { checkoutIntentId: attempt.checkoutIntentId },
            select: {
              id: true,
              status: true,
              checkoutIntentId: true,
              customOrderId: true,
              lastAttemptReference: true,
              lastAttemptStatus: true,
              attemptsCount: true,
              resumeToken: true,
              resumePath: true,
              submittedAt: true,
              paymentInitiatedAt: true,
              paidConfirmedAt: true,
              abandonedAt: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const timeline = [
      {
        type: 'ATTEMPT_CREATED',
        source: 'system',
        createdAt: attempt.createdAt,
        status: attempt.status,
      },
      ...events.map((event) => ({
        type: event.type,
        source: event.source,
        providerEventType: event.providerEventType,
        providerEventReceivedAt: event.providerEventReceivedAt,
        processedAt: event.processedAt,
        createdAt: event.createdAt,
        payload: event.payload,
      })),
    ];

    if (attempt.finalizedAt) {
      timeline.push({
        type: 'ATTEMPT_FINALIZED',
        source: 'system',
        createdAt: attempt.finalizedAt,
        status: attempt.status,
      });
    }

    const responseSnapshot = this.asObject(attempt.responseSnapshot);
    const webhookSummary = responseSnapshot?.providerWebhookVerified
      ? {
          gateway: responseSnapshot.providerWebhookGateway ?? attempt.provider,
          status: responseSnapshot.providerWebhookStatus,
          event: responseSnapshot.providerWebhookEvent,
          receivedAt: responseSnapshot.providerWebhookReceivedAt,
          amount: responseSnapshot.providerWebhookAmount,
          currency: responseSnapshot.providerWebhookCurrency,
        }
      : null;

    return {
      reference: attempt.reference,
      gateway: attempt.provider,
      status: attempt.status,
      amount: Number(attempt.amount ?? 0),
      currency: attempt.currency,
      subjectType: attempt.subjectType,
      buyerId: attempt.buyerId ?? null,
      checkoutIntentId: attempt.checkoutIntentId ?? null,
      customOrderId: attempt.customOrderId ?? null,
      createdAt: attempt.createdAt,
      confirmedAt: attempt.confirmedAt,
      finalizedAt: attempt.finalizedAt,
      lastVerifiedAt: attempt.lastVerifiedAt,
      failureCode: attempt.failureCode,
      failureMessage: attempt.failureMessage,
      timeline,
      webhookSummary,
      checkoutSession: checkoutSession
        ? {
            ...checkoutSession,
            resumeUrl: this.buildCheckoutResumeUrl(checkoutSession.resumeToken),
          }
        : null,
    };
  }

  async listTransactionsDetailed(params?: {
    type?: string;
    referenceType?: string;
    dateFrom?: string;
    dateTo?: string;
    take?: number;
  }) {
    const take = Math.min(params?.take ?? 50, 100);
    const transactions = await this.prisma.ledgerTransaction.findMany({
      where: {
        ...(params?.type ? { type: params.type as any } : {}),
        ...(params?.referenceType ? { referenceType: params.referenceType } : {}),
        ...(params?.dateFrom || params?.dateTo
          ? {
              createdAt: {
                ...(params?.dateFrom ? { gte: new Date(params.dateFrom) } : {}),
                ...(params?.dateTo ? { lte: new Date(params.dateTo) } : {}),
              },
            }
          : {}),
      },
      orderBy: { createdAt: 'desc' },
      take,
      include: {
        entries: {
          include: {
            account: true,
          },
        },
      },
    });

    const orderIds = Array.from(
      new Set(
        transactions
          .filter((transaction) => transaction.referenceType === 'Order' && transaction.referenceId)
          .map((transaction) => String(transaction.referenceId)),
      ),
    );
    const customOrderIds = Array.from(
      new Set(
        transactions
          .filter(
            (transaction) =>
              transaction.referenceType === 'CustomOrder' && transaction.referenceId,
          )
          .map((transaction) => String(transaction.referenceId)),
      ),
    );
    const payoutIds = Array.from(
      new Set(
        transactions
          .filter((transaction) => transaction.referenceType === 'Payout' && transaction.referenceId)
          .map((transaction) => String(transaction.referenceId)),
      ),
    );

    const [orders, customOrders, payouts] = await Promise.all([
      orderIds.length > 0
        ? this.prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: {
              id: true,
              customerName: true,
              brand: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      customOrderIds.length > 0
        ? this.prisma.customOrder.findMany({
            where: { id: { in: customOrderIds } },
            select: {
              id: true,
              sourceTitleSnapshot: true,
              buyerId: true,
              brand: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
      payoutIds.length > 0
        ? this.prisma.payout.findMany({
            where: { id: { in: payoutIds } },
            select: {
              id: true,
              brand: { select: { id: true, name: true } },
            },
          })
        : Promise.resolve([]),
    ]);
    const buyerIds = Array.from(
      new Set(
        customOrders
          .map((order) => order.buyerId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const buyers = buyerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        })
      : [];

    const orderById = new Map(orders.map((order) => [order.id, order]));
    const customOrderById = new Map(customOrders.map((order) => [String(order.id), order]));
    const payoutById = new Map(payouts.map((payout) => [payout.id, payout]));
    const buyersById = new Map(buyers.map((buyer) => [buyer.id, buyer]));

    return {
      items: transactions.map((transaction) => {
        const customOrder =
          transaction.referenceType === 'CustomOrder' && transaction.referenceId
            ? customOrderById.get(String(transaction.referenceId))
            : null;
        const order =
          transaction.referenceType === 'Order' && transaction.referenceId
            ? orderById.get(String(transaction.referenceId))
            : null;
        const payout =
          transaction.referenceType === 'Payout' && transaction.referenceId
            ? payoutById.get(String(transaction.referenceId))
            : null;
        const buyer =
          customOrder?.buyerId ? buyersById.get(customOrder.buyerId) ?? null : null;

        const buyerName = customOrder
          ? this.formatBuyerName(buyer)
          : order?.customerName ?? null;

        return {
          ...transaction,
          brand:
            customOrder?.brand ??
            order?.brand ??
            payout?.brand ??
            null,
          buyerName,
          referenceTitle:
            customOrder?.sourceTitleSnapshot ||
            (order ? `Order #${order.id.slice(0, 8).toUpperCase()}` : null),
        };
      }),
      total: transactions.length,
    };
  }

  private asObject(value: unknown) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, any>)
      : null;
  }

  private buildCheckoutResumeUrl(token: string) {
    const baseUrl = resolveWebAppBaseUrl();
    return `${baseUrl}/custom-orders/resume/${encodeURIComponent(token)}`;
  }

  private async getSettlementStateSummary() {
    const now = new Date();
    const [
      standardHolds,
      customAllocations,
      brandWalletEntries,
      pendingPayouts,
      paidPayouts,
    ] = await Promise.all([
      this.prisma.escrowHold.findMany({
        select: {
          status: true,
          totalAmount: true,
          firstReleaseAmount: true,
          secondReleaseAmount: true,
          firstReleasedAt: true,
          secondReleasedAt: true,
          secondReleaseEligibleAt: true,
        },
      }),
      this.prisma.customOrderLedgerAllocation.findMany({
        select: {
          allocationType: true,
          amount: true,
          status: true,
        },
      }),
      this.prisma.ledgerEntry.findMany({
        where: { account: { subType: 'BRAND_AVAILABLE' } },
        select: {
          direction: true,
          amount: true,
        },
      }),
      this.prisma.payout.aggregate({
        where: {
          status: {
            in: [
              PayoutStatus.PENDING_APPROVAL,
              PayoutStatus.APPROVED,
              PayoutStatus.PROCESSING,
              PayoutStatus.ON_HOLD,
              PayoutStatus.RECONCILIATION_REVIEW,
            ],
          },
        },
        _sum: { amount: true },
      }),
      this.prisma.payout.aggregate({
        where: { status: PayoutStatus.PAID },
        _sum: { amount: true },
      }),
    ]);

    let standardHeld = 0;
    let standardUpfrontReleased = 0;
    let standardFinalPending = 0;
    let standardFinalEligible = 0;
    let standardFrozen = 0;
    let standardRefunded = 0;

    for (const hold of standardHolds) {
      const firstAmount = Number(hold.firstReleaseAmount ?? 0);
      const secondAmount = Number(hold.secondReleaseAmount ?? 0);
      const totalAmount = Number(hold.totalAmount ?? 0);
      const firstUnreleased = hold.firstReleasedAt ? 0 : firstAmount;
      const secondUnreleased = hold.secondReleasedAt ? 0 : secondAmount;

      if (hold.firstReleasedAt) {
        standardUpfrontReleased += firstAmount;
      }
      if (hold.status === EscrowHoldStatus.REFUNDED) {
        standardRefunded += totalAmount;
        continue;
      }
      if (hold.status === EscrowHoldStatus.FROZEN) {
        standardFrozen += firstUnreleased + secondUnreleased;
        continue;
      }
      if (
        hold.status === EscrowHoldStatus.HELD ||
        hold.status === EscrowHoldStatus.PARTIALLY_RELEASED
      ) {
        standardHeld += firstUnreleased + secondUnreleased;
        if (secondUnreleased > 0) {
          if (hold.secondReleaseEligibleAt && hold.secondReleaseEligibleAt <= now) {
            standardFinalEligible += secondUnreleased;
          } else {
            standardFinalPending += secondUnreleased;
          }
        }
      }
    }

    let customHeld = 0;
    let customUpfrontReleased = 0;
    let customFinalPending = 0;
    let customFinalEligible = 0;
    let customRefunded = 0;

    for (const allocation of customAllocations) {
      const amount = Number(allocation.amount ?? 0);
      if (allocation.status === CustomOrderLedgerAllocationStatus.HELD) {
        customHeld += amount;
        if (
          allocation.allocationType ===
          CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION
        ) {
          customFinalPending += amount;
        }
      }
      if (
        allocation.status === CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
        allocation.status === CustomOrderLedgerAllocationStatus.PAID_OUT
      ) {
        if (
          allocation.allocationType ===
          CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION
        ) {
          customUpfrontReleased += amount;
        } else {
          customFinalEligible +=
            allocation.status === CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE
              ? amount
              : 0;
        }
      }
      if (allocation.status === CustomOrderLedgerAllocationStatus.REVERSED) {
        customRefunded += amount;
      }
    }

    const availableBrandWalletFunds = brandWalletEntries.reduce(
      (sum, entry) =>
        sum +
        (entry.direction === LedgerEntryDirection.CREDIT
          ? Number(entry.amount ?? 0)
          : -Number(entry.amount ?? 0)),
      0,
    );

    return {
      currency: 'NGN',
      totalHeldFunds: this.roundMoney(standardHeld + customHeld),
      upfrontReleasedFunds: this.roundMoney(
        standardUpfrontReleased + customUpfrontReleased,
      ),
      finalReleasePendingFunds: this.roundMoney(
        standardFinalPending + customFinalPending,
      ),
      finalReleaseEligibleFunds: this.roundMoney(
        standardFinalEligible + customFinalEligible,
      ),
      frozenFunds: this.roundMoney(standardFrozen),
      refundedFunds: this.roundMoney(standardRefunded + customRefunded),
      availableBrandWalletFunds: this.roundMoney(availableBrandWalletFunds),
      payoutPendingFunds: this.roundMoney(
        Number(pendingPayouts._sum.amount ?? 0),
      ),
      paidOutFunds: this.roundMoney(Number(paidPayouts._sum.amount ?? 0)),
    };
  }

  async listEscrowHolds(params?: {
    status?: string;
    brandId?: string;
    take?: number;
  }) {
    const take = Math.min(params?.take ?? 100, 200);
    const [standardHolds, customHeldAllocations] = await Promise.all([
      this.prisma.escrowHold.findMany({
        where: {
          ...(params?.brandId ? { brandId: params.brandId } : {}),
          ...(params?.status ? { status: params.status as EscrowHoldStatus } : {}),
          status: params?.status
            ? (params.status as EscrowHoldStatus)
            : { in: [EscrowHoldStatus.HELD, EscrowHoldStatus.PARTIALLY_RELEASED, EscrowHoldStatus.FROZEN] },
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          orderId: true,
          brandId: true,
          currency: true,
          totalAmount: true,
          commissionAmount: true,
          netBrandAmount: true,
          firstReleaseAmount: true,
          firstReleaseNetAmount: true,
          secondReleaseAmount: true,
          secondReleaseNetAmount: true,
          firstReleasedAt: true,
          secondReleaseEligibleAt: true,
          secondReleaseCondition: true,
          status: true,
          frozenReason: true,
          createdAt: true,
          brand: { select: { id: true, name: true } },
          order: { select: { id: true, customerName: true } },
        },
      }),
      this.prisma.customOrderLedgerAllocation.findMany({
        where: {
          allocationType: CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
          status: CustomOrderLedgerAllocationStatus.HELD,
          ...(params?.brandId ? { customOrder: { brandId: params.brandId } } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take,
        select: {
          id: true,
          customOrderId: true,
          amount: true,
          commissionAmount: true,
          netBrandAmount: true,
          currency: true,
          createdAt: true,
          customOrder: {
            select: {
              id: true,
              sourceTitleSnapshot: true,
              buyerId: true,
              brand: { select: { id: true, name: true } },
              ledgerAllocations: {
                where: {
                  allocationType: CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
                },
                orderBy: { createdAt: 'asc' },
                take: 1,
                select: {
                  amount: true,
                  commissionAmount: true,
                  netBrandAmount: true,
                  status: true,
                },
              },
            },
          },
        },
      }),
    ]);
    const buyerIds = Array.from(
      new Set(
        customHeldAllocations
          .map((allocation) => allocation.customOrder?.buyerId)
          .filter((value): value is string => Boolean(value)),
      ),
    );
    const buyers = buyerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: buyerIds } },
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        })
      : [];
    const buyersById = new Map(buyers.map((buyer) => [buyer.id, buyer]));

    const items = [
      ...standardHolds.map((hold) => ({
        id: hold.id,
        holdType: 'STANDARD_ORDER',
        referenceId: hold.orderId,
        title: hold.order?.id
          ? `Order #${hold.order.id.slice(0, 8).toUpperCase()}`
          : 'Standard order hold',
        brand: hold.brand,
        buyerName: hold.order?.customerName ?? 'Buyer',
        currency: hold.currency,
        grossAmount: Number(hold.totalAmount ?? 0),
        commissionAmount: Number(hold.commissionAmount ?? 0),
        netBrandAmount: Number(hold.netBrandAmount ?? 0),
        releasedGrossAmount: hold.firstReleasedAt ? Number(hold.firstReleaseAmount ?? 0) : 0,
        releasedNetAmount: hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount ?? 0) : 0,
        heldGrossAmount: Number(hold.secondReleaseAmount ?? 0),
        heldNetAmount: Number(hold.secondReleaseNetAmount ?? 0),
        status: hold.status,
        nextReleaseAt: hold.secondReleaseEligibleAt,
        releaseCondition: hold.secondReleaseCondition,
        frozenReason: hold.frozenReason ?? null,
        canManualRelease:
          hold.status !== EscrowHoldStatus.RELEASED &&
          hold.status !== EscrowHoldStatus.REFUNDED &&
          Boolean(hold.orderId),
        createdAt: hold.createdAt,
      })),
      ...customHeldAllocations.map((allocation) => {
        const buyer =
          allocation.customOrder?.buyerId
            ? buyersById.get(allocation.customOrder.buyerId) ?? null
            : null;
        const acceptanceAllocation = allocation.customOrder?.ledgerAllocations?.[0] ?? null;
        const acceptanceStatus = acceptanceAllocation?.status ?? null;
        const acceptanceGrossAmount = Number(acceptanceAllocation?.amount ?? 0);
        const acceptanceCommissionAmount = Number(
          acceptanceAllocation?.commissionAmount ?? 0,
        );
        const acceptanceNetAmount = Number(acceptanceAllocation?.netBrandAmount ?? 0);
        const acceptanceIsReleased =
          acceptanceStatus === CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
          acceptanceStatus === CustomOrderLedgerAllocationStatus.PAID_OUT;
        const acceptanceIsHeld = acceptanceStatus === CustomOrderLedgerAllocationStatus.HELD;
        const finalGrossAmount = Number(allocation.amount ?? 0);
        const finalCommissionAmount = Number(allocation.commissionAmount ?? 0);
        const finalNetAmount = Number(allocation.netBrandAmount ?? 0);
        const releasedGrossAmount = acceptanceIsReleased ? acceptanceGrossAmount : 0;
        const releasedNetAmount = acceptanceIsReleased ? acceptanceNetAmount : 0;
        const heldGrossAmount = finalGrossAmount + (acceptanceIsHeld ? acceptanceGrossAmount : 0);
        const heldNetAmount = finalNetAmount + (acceptanceIsHeld ? acceptanceNetAmount : 0);
        const grossAmount = acceptanceGrossAmount + finalGrossAmount;
        const commissionAmount = acceptanceCommissionAmount + finalCommissionAmount;
        const netBrandAmount = this.roundMoney(releasedNetAmount + heldNetAmount);

        return {
          id: allocation.id,
          holdType: 'CUSTOM_ORDER',
          referenceId: allocation.customOrderId,
          title: this.formatCustomOrderTitle(
            allocation.customOrder
              ? {
                  id: allocation.customOrder.id,
                  sourceTitleSnapshot: allocation.customOrder.sourceTitleSnapshot,
                }
              : {
                  id: allocation.customOrderId,
                  sourceTitleSnapshot: null,
                },
          ),
          brand: allocation.customOrder?.brand ?? null,
          buyerName: this.formatBuyerName(buyer),
          currency: allocation.currency,
          grossAmount: this.roundMoney(grossAmount),
          commissionAmount: this.roundMoney(commissionAmount),
          netBrandAmount,
          releasedGrossAmount: this.roundMoney(releasedGrossAmount),
          releasedNetAmount: this.roundMoney(releasedNetAmount),
          heldGrossAmount: this.roundMoney(heldGrossAmount),
          heldNetAmount: this.roundMoney(heldNetAmount),
          status: 'HELD',
          nextReleaseAt: null,
          releaseCondition: 'BUYER_DELIVERY_CONFIRMED',
          frozenReason: null,
          canManualRelease: true,
          createdAt: allocation.createdAt,
        };
      }),
    ].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    return {
      items,
      total: items.length,
    };
  }

  async releaseEscrowHold(
    id: string,
    actorId: string,
    req: Request,
    params: { holdType: 'STANDARD_ORDER' | 'CUSTOM_ORDER'; note?: string },
  ) {
    const now = new Date();

    if (params.holdType === 'STANDARD_ORDER') {
      const hold = await this.prisma.escrowHold.findUnique({
        where: { id },
        select: { id: true, orderId: true, status: true },
      });
      if (!hold?.orderId) {
        throw new NotFoundException('Escrow hold not found');
      }

      const updated = await this.prisma.$transaction(async (tx) => {
        const released = await this.standardOrderEscrowService.releaseFinalPortionNow(
          tx,
          hold.orderId!,
          EscrowReleaseCondition.MANUAL_ADMIN,
        );
        if (!released) {
          throw new BadRequestException('Escrow hold could not be released');
        }
        return released;
      });

      await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RESOLVE, {
        targetId: id,
        newState: {
          holdType: params.holdType,
          releasedAt: now.toISOString(),
          note: params.note ?? null,
        },
      });

      return updated;
    }

    const allocation = await this.prisma.customOrderLedgerAllocation.findUnique({
      where: { id },
      select: {
        id: true,
        customOrderId: true,
        allocationType: true,
        amount: true,
        commissionAmount: true,
        netBrandAmount: true,
        currency: true,
        status: true,
        customOrder: {
          select: {
            brandId: true,
          },
        },
      },
    });

    if (
      !allocation ||
      allocation.allocationType !== CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION ||
      allocation.status !== CustomOrderLedgerAllocationStatus.HELD
    ) {
      throw new NotFoundException('Custom-order held allocation not found');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const released = await tx.customOrderLedgerAllocation.update({
        where: { id },
        data: {
          status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
          eligibleAt: now,
        },
      });

      await this.ledgerService.postCustomOrderFinalRelease(tx, {
        customOrderId: allocation.customOrderId,
        brandId: allocation.customOrder.brandId,
        currency: allocation.currency,
        amount: Number(allocation.amount ?? 0),
        commissionAmount: Number(allocation.commissionAmount ?? 0),
        netBrandAmount: Number(allocation.netBrandAmount ?? 0),
      });

      await tx.customOrderTimelineEvent.create({
        data: {
          customOrderId: allocation.customOrderId,
          actorType: CustomOrderActorType.ADMIN,
          actorId,
          eventType: 'ADMIN_ESCALATED',
          payloadJson: {
            action: 'MANUAL_FINAL_ESCROW_RELEASE',
            note: params.note?.trim() || null,
          } as Prisma.InputJsonValue,
        },
      });

      return released;
    });

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RESOLVE, {
      targetId: id,
      newState: {
        holdType: params.holdType,
        releasedAt: now.toISOString(),
        note: params.note ?? null,
      },
    });

    return updated;
  }

  async freezeEscrowHold(
    id: string,
    actorId: string,
    req: Request,
    reason: string,
  ) {
    const hold = await this.prisma.escrowHold.findUnique({
      where: { id },
      select: { id: true, orderId: true },
    });
    if (!hold?.orderId) {
      throw new NotFoundException('Escrow hold not found');
    }
    if (!reason.trim()) {
      throw new BadRequestException('Freeze reason is required');
    }

    const updated = await this.prisma.$transaction((tx) =>
      this.standardOrderEscrowService.freezeHold(tx, hold.orderId!, actorId, reason),
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_CLAIM, {
      targetId: id,
      newState: {
        status: EscrowHoldStatus.FROZEN,
        reason,
      },
    });

    return updated;
  }

  async unfreezeEscrowHold(id: string, actorId: string, req: Request) {
    const hold = await this.prisma.escrowHold.findUnique({
      where: { id },
      select: { id: true, orderId: true },
    });
    if (!hold?.orderId) {
      throw new NotFoundException('Escrow hold not found');
    }

    const updated = await this.prisma.$transaction((tx) =>
      this.standardOrderEscrowService.unfreezeHold(tx, hold.orderId!),
    );

    await this.recordAudit(req, actorId, AdminAuditAction.ADMIN_FINANCE_RECONCILIATION_RELEASE, {
      targetId: id,
      newState: {
        status: updated?.status ?? null,
      },
    });

    return updated;
  }

  private toBuyerSummary(buyer: FinanceBuyerSummary | null | undefined) {
    if (!buyer) {
      return null;
    }

    return {
      id: buyer.id,
      name: this.formatBuyerName(buyer),
      username: buyer.username,
    };
  }

  private formatBuyerName(
    buyer:
      | Pick<FinanceBuyerSummary, 'firstName' | 'lastName' | 'username'>
      | null
      | undefined,
  ) {
    if (!buyer) {
      return 'Buyer';
    }

    const fullName = [buyer.firstName, buyer.lastName]
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .join(' ');

    return fullName || String(buyer.username || 'Buyer');
  }

  private formatCustomOrderTitle(
    customOrder:
      | {
          id: string;
          sourceTitleSnapshot?: string | null;
        }
      | null
      | undefined,
  ) {
    if (!customOrder) {
      return 'Custom order';
    }

    return (
      customOrder.sourceTitleSnapshot ||
      `Custom Order #${String(customOrder.id).slice(0, 8).toUpperCase()}`
    );
  }

  private buildSystemCommissionFallbackRule(params: {
    idSuffix: string;
    name: string;
    ratePercent: number;
    isDefault: boolean;
    createdAt: string;
  }) {
    const ratePercent = this.roundMoney(Number(params.ratePercent) || 0).toFixed(2);
    return {
      id: `system-config-${params.idSuffix}`,
      name: params.name,
      scope: COMMISSION_RULE_SCOPE.PLATFORM,
      brandId: null,
      currency: null,
      ratePercent,
      minFeeAmount: null,
      maxFeeAmount: null,
      isDefault: params.isDefault,
      isActive: true,
      effectiveFrom: params.createdAt,
      effectiveTo: null,
      createdById: null,
      updatedById: null,
      createdAt: params.createdAt,
      updatedAt: params.createdAt,
    };
  }

  private normalizeSettlementPolicyDto(
    dto: Partial<SettlementPolicyAdminInput>,
  ): SettlementPolicyAdminInput {
    return {
      ...(dto as SettlementPolicyAdminInput),
      ...(dto.effectiveFrom !== undefined
        ? { effectiveFrom: new Date(dto.effectiveFrom) }
        : {}),
      ...(dto.effectiveTo !== undefined
        ? { effectiveTo: dto.effectiveTo ? new Date(dto.effectiveTo) : null }
        : {}),
    };
  }

  private async buildPaymentSettlementDetails(
    attempt: {
      orderIds: string[] | null;
      customOrderId: string | null;
    },
    orders: Array<{
      id: string;
      totalAmount: Prisma.Decimal;
      currency: string;
      brand: { id: string; name: string | null } | null;
    }>,
    customOrder: {
      id: string;
      brand: { id: string; name: string | null } | null;
    } | null,
  ) {
    const orderIds = attempt.orderIds ?? [];
    const customOrderId = attempt.customOrderId;

    const [standardSnapshots, standardHolds, customSnapshot, customAllocations] =
      await Promise.all([
        orderIds.length
          ? this.prisma.settlementSnapshot.findMany({
              where: { orderId: { in: orderIds } },
            })
          : Promise.resolve([]),
        orderIds.length
          ? this.prisma.escrowHold.findMany({
              where: { orderId: { in: orderIds } },
            })
          : Promise.resolve([]),
        customOrderId
          ? this.prisma.settlementSnapshot.findFirst({
              where: { customOrderId },
            })
          : Promise.resolve(null),
        customOrderId
          ? this.prisma.customOrderLedgerAllocation.findMany({
              where: { customOrderId },
              orderBy: { createdAt: 'asc' },
            })
          : Promise.resolve([]),
      ]);

    const snapshotsByOrderId = new Map(
      standardSnapshots
        .filter((snapshot) => snapshot.orderId)
        .map((snapshot) => [snapshot.orderId as string, snapshot]),
    );
    const holdsByOrderId = new Map(
      standardHolds
        .filter((hold) => hold.orderId)
        .map((hold) => [hold.orderId as string, hold]),
    );

    const standardDetails = orders.map((order) => {
      const snapshot = snapshotsByOrderId.get(order.id) ?? null;
      const hold = holdsByOrderId.get(order.id) ?? null;
      const upfrontReleasedAmount = hold?.firstReleasedAt
        ? Number(hold.firstReleaseAmount ?? 0)
        : 0;
      const finalHeldAmount = hold?.secondReleasedAt
        ? 0
        : Number(hold?.secondReleaseAmount ?? snapshot?.finalReleaseGrossAmount ?? 0);

      return {
        orderType: SettlementOrderType.STANDARD_ORDER,
        orderId: order.id,
        customOrderId: null,
        brand: order.brand,
        grossAmount: Number(snapshot?.grossAmount ?? hold?.totalAmount ?? order.totalAmount ?? 0),
        commissionAmount: Number(snapshot?.commissionAmount ?? hold?.commissionAmount ?? 0),
        brandNetAmount: Number(snapshot?.brandNetAmount ?? hold?.netBrandAmount ?? 0),
        releaseMode: snapshot?.releaseMode ?? null,
        upfrontReleasePercent: Number(snapshot?.upfrontReleasePercent ?? 0),
        upfrontReleasedAmount,
        finalHeldAmount,
        snapshotId: snapshot?.id ?? null,
        settlementPolicyId: snapshot?.settlementPolicyId ?? null,
        commissionRuleId: snapshot?.commissionRuleId ?? null,
        releaseStatus: hold?.status ?? 'NO_HOLD',
      };
    });

    if (!customOrderId) {
      return standardDetails;
    }

    const acceptanceAllocation =
      customAllocations.find(
        (allocation) =>
          allocation.allocationType ===
          CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
      ) ?? null;
    const finalAllocation =
      customAllocations.find(
        (allocation) =>
          allocation.allocationType ===
          CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
      ) ?? null;

    return [
      ...standardDetails,
      {
        orderType: SettlementOrderType.CUSTOM_ORDER,
        orderId: null,
        customOrderId,
        brand: customOrder?.brand ?? null,
        grossAmount: Number(
          customSnapshot?.grossAmount ??
            customAllocations.reduce(
              (sum, allocation) => sum + Number(allocation.amount ?? 0),
              0,
            ),
        ),
        commissionAmount: Number(
          customSnapshot?.commissionAmount ??
            customAllocations.reduce(
              (sum, allocation) => sum + Number(allocation.commissionAmount ?? 0),
              0,
            ),
        ),
        brandNetAmount: Number(
          customSnapshot?.brandNetAmount ??
            customAllocations.reduce(
              (sum, allocation) => sum + Number(allocation.netBrandAmount ?? 0),
              0,
            ),
        ),
        releaseMode: customSnapshot?.releaseMode ?? null,
        upfrontReleasePercent: Number(customSnapshot?.upfrontReleasePercent ?? 0),
        upfrontReleasedAmount:
          acceptanceAllocation &&
          (acceptanceAllocation.status ===
            CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE ||
            acceptanceAllocation.status === CustomOrderLedgerAllocationStatus.PAID_OUT)
            ? Number(acceptanceAllocation.amount ?? 0)
            : 0,
        finalHeldAmount:
          finalAllocation?.status === CustomOrderLedgerAllocationStatus.HELD
            ? Number(finalAllocation.amount ?? 0)
            : 0,
        snapshotId: customSnapshot?.id ?? null,
        settlementPolicyId: customSnapshot?.settlementPolicyId ?? null,
        commissionRuleId: customSnapshot?.commissionRuleId ?? null,
        releaseStatus: finalAllocation?.status ?? 'NO_ALLOCATION',
      },
    ];
  }

  private async recordAudit(
    req: Request,
    actorId: string,
    action: AdminAuditAction,
    params: {
      targetId: string;
      targetType?: string;
      previousState?: unknown;
      newState?: unknown;
    },
  ) {
    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: actorId,
        action,
        targetType: params.targetType ?? 'Finance',
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
