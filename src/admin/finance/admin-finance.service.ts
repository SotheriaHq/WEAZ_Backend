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
  Prisma,
  Role,
} from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { CommissionService } from 'src/finance/commission.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';
import { LedgerService } from 'src/finance/ledger.service';
import { ReconciliationService } from 'src/finance/reconciliation.service';
import { StandardOrderEscrowService } from 'src/finance/standard-order-escrow.service';
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
    private readonly reconciliationService: ReconciliationService,
    private readonly financialDocumentsService: FinancialDocumentsService,
    private readonly standardOrderEscrowService: StandardOrderEscrowService,
    private readonly ledgerService: LedgerService,
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
      events,
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
          firstReleaseNetAmount: true,
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
        releasedNetAmount: hold.firstReleasedAt ? Number(hold.firstReleaseNetAmount ?? 0) : 0,
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
          grossAmount: Number(allocation.amount ?? 0),
          releasedNetAmount: 0,
          heldNetAmount: Number(allocation.netBrandAmount ?? 0),
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
