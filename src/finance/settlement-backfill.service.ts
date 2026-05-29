import { Injectable } from '@nestjs/common';
import {
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  EscrowHoldStatus,
  EscrowReleaseCondition,
  PaymentStatus,
  Prisma,
  SettlementFinalReleaseTrigger,
  SettlementOrderType,
  SettlementReleaseMode,
} from '@prisma/client';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { PrismaService } from 'src/prisma/prisma.service';

type BackfillOrderType = 'standard' | 'custom' | 'all';

export type SettlementBackfillOptions = {
  orderType?: BackfillOrderType;
  limit?: number;
  write?: boolean;
};

type BackfillSnapshotData = Prisma.SettlementSnapshotCreateInput;

export type StandardSettlementAuditRecord = {
  escrowHoldId: string;
  orderId: string;
  brandId: string;
  status: EscrowHoldStatus;
  totalAmount: number;
  commissionRate: number;
  commissionAmount: number;
  netBrandAmount: number;
  firstReleaseAmount: number;
  firstReleasedAt: Date | null;
  secondReleaseAmount: number;
  secondReleasedAt: Date | null;
  refundedAt: Date | null;
  frozenAt: Date | null;
  refundReason: string | null;
  frozenReason: string | null;
  releaseMode: SettlementReleaseMode | null;
  backfillSafe: boolean;
  recommendedAction: string;
  unsafeReasons: string[];
};

export type CustomSettlementAuditRecord = {
  customOrderId: string;
  brandId: string;
  paymentStatus: PaymentStatus;
  orderStatus: CustomOrderStatus;
  grossAmount: number | null;
  allocationCount: number;
  allocationTypes: CustomOrderLedgerAllocationType[];
  allocationState: string;
  releasedOrHeldState: {
    held: boolean;
    payoutEligible: boolean;
    paidOut: boolean;
    refundedOrReversed: boolean;
    disputed: boolean;
  };
  backfillSafe: boolean;
  recommendedAction: string;
  unsafeReasons: string[];
};

export type DuplicateAllocationAuditGroup = {
  customOrderId: string;
  allocationType: CustomOrderLedgerAllocationType;
  count: number;
  statuses: CustomOrderLedgerAllocationStatus[];
  amounts: number[];
  createdAtValues: Date[];
  hasPayoutOrReleaseMarkers: boolean;
};

export type SettlementBackfillReport = {
  mode: 'dry-run' | 'write';
  options: {
    orderType: BackfillOrderType;
    limit: number;
  };
  standard: {
    records: StandardSettlementAuditRecord[];
    summary: BackfillSummary;
  };
  custom: {
    records: CustomSettlementAuditRecord[];
    summary: BackfillSummary;
  };
  duplicateAllocations: {
    groups: DuplicateAllocationAuditGroup[];
    recommendation: string;
  };
};

type BackfillSummary = {
  scanned: number;
  missingSnapshots: number;
  safe: number;
  unsafe: number;
  created: number;
  skippedExisting: number;
};

const DEFAULT_LIMIT = 500;

@Injectable()
export class SettlementBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  async auditAndBackfill(
    options: SettlementBackfillOptions = {},
  ): Promise<SettlementBackfillReport> {
    const normalized = this.normalizeOptions(options);
    const standard =
      normalized.orderType === 'custom'
        ? this.emptySummary()
        : await this.auditStandardOrders(normalized);
    const custom =
      normalized.orderType === 'standard'
        ? this.emptySummary()
        : await this.auditCustomOrders(normalized);
    const duplicateAllocations =
      normalized.orderType === 'standard'
        ? {
            groups: [],
            recommendation: this.uniqueConstraintRecommendation([]),
          }
        : await this.auditDuplicateAllocations();

    return {
      mode: normalized.write ? 'write' : 'dry-run',
      options: {
        orderType: normalized.orderType,
        limit: normalized.limit,
      },
      standard: {
        ...standard,
        records: this.stripSnapshotData(standard.records),
      },
      custom: {
        ...custom,
        records: this.stripSnapshotData(custom.records),
      },
      duplicateAllocations,
    };
  }

  private async auditStandardOrders(
    options: Required<SettlementBackfillOptions>,
  ) {
    const [settlementDelayHours, autoReleaseDays, existingSnapshots] =
      await Promise.all([
        this.systemConfigService.getNumber(
          'finance.standardEscrow.settlementHours',
        ),
        this.systemConfigService.getNumber(
          'finance.standardEscrow.autoReleaseDays',
        ),
        this.prisma.settlementSnapshot.findMany({
          where: { orderId: { not: null } },
          select: { orderId: true },
        }),
      ]);
    const existingOrderIds = new Set(
      existingSnapshots
        .map((snapshot) => snapshot.orderId)
        .filter((orderId): orderId is string => Boolean(orderId)),
    );
    const holds = await this.prisma.escrowHold.findMany({
      where: {
        orderId: {
          not: null,
          notIn: [...existingOrderIds],
        },
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
    });

    const records = holds
      .filter((hold) => Boolean(hold.orderId))
      .map((hold) =>
        this.classifyStandardHold(hold, {
          settlementDelayHours,
          autoReleaseDays,
        }),
      );

    const summary = this.summarize(records);
    if (options.write) {
      const writeSummary = await this.writeStandardSnapshots(records);
      summary.created = writeSummary.created;
      summary.skippedExisting = writeSummary.skippedExisting;
    }

    return { records, summary };
  }

  private async auditCustomOrders(
    options: Required<SettlementBackfillOptions>,
  ) {
    const existingSnapshots = await this.prisma.settlementSnapshot.findMany({
      where: { customOrderId: { not: null } },
      select: { customOrderId: true },
    });
    const existingCustomOrderIds = new Set(
      existingSnapshots
        .map((snapshot) => snapshot.customOrderId)
        .filter((customOrderId): customOrderId is string =>
          Boolean(customOrderId),
        ),
    );
    const orders = await this.prisma.customOrder.findMany({
      where: {
        id: { notIn: [...existingCustomOrderIds] },
        OR: [
          { paymentStatus: PaymentStatus.PAID },
          { ledgerAllocations: { some: {} } },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: options.limit,
      include: {
        ledgerAllocations: { orderBy: { createdAt: 'asc' } },
        disputes: {
          select: { status: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    const records = orders.map((order) => this.classifyCustomOrder(order));
    const summary = this.summarize(records);
    if (options.write) {
      const writeSummary = await this.writeCustomSnapshots(records);
      summary.created = writeSummary.created;
      summary.skippedExisting = writeSummary.skippedExisting;
    }

    return { records, summary };
  }

  private async auditDuplicateAllocations() {
    const allocations = await this.prisma.customOrderLedgerAllocation.findMany({
      orderBy: [{ customOrderId: 'asc' }, { allocationType: 'asc' }],
    });
    const grouped = new Map<string, typeof allocations>();

    for (const allocation of allocations) {
      const key = `${allocation.customOrderId}:${allocation.allocationType}`;
      grouped.set(key, [...(grouped.get(key) ?? []), allocation]);
    }

    const groups = [...grouped.values()]
      .filter((group) => group.length > 1)
      .map((group) => ({
        customOrderId: group[0].customOrderId,
        allocationType: group[0].allocationType,
        count: group.length,
        statuses: group.map((allocation) => allocation.status),
        amounts: group.map((allocation) => this.money(allocation.amount)),
        createdAtValues: group.map((allocation) => allocation.createdAt),
        hasPayoutOrReleaseMarkers: group.some(
          (allocation) =>
            Boolean(allocation.payoutId) ||
            Boolean(allocation.eligibleAt) ||
            Boolean(allocation.paidOutAt) ||
            Boolean(allocation.reversedAt) ||
            allocation.status !== CustomOrderLedgerAllocationStatus.HELD,
        ),
      }));

    return {
      groups,
      recommendation: this.uniqueConstraintRecommendation(groups),
    };
  }

  private classifyStandardHold(
    hold: Prisma.EscrowHoldGetPayload<Record<string, never>>,
    config: { settlementDelayHours: number; autoReleaseDays: number },
  ): StandardSettlementAuditRecord {
    const totalAmount = this.money(hold.totalAmount);
    const commissionAmount = this.money(hold.commissionAmount);
    const netBrandAmount = this.money(hold.netBrandAmount);
    const firstReleaseAmount = this.money(hold.firstReleaseAmount);
    const firstReleaseCommissionAmount = this.money(
      hold.firstReleaseCommissionAmount,
    );
    const firstReleaseNetAmount = this.money(hold.firstReleaseNetAmount);
    const secondReleaseAmount = this.money(hold.secondReleaseAmount);
    const secondReleaseCommissionAmount = this.money(
      hold.secondReleaseCommissionAmount,
    );
    const secondReleaseNetAmount = this.money(hold.secondReleaseNetAmount);
    const unsafeReasons: string[] = [];

    if (!hold.orderId) {
      unsafeReasons.push('EscrowHold has no orderId');
    }
    if (totalAmount <= 0) {
      unsafeReasons.push('EscrowHold totalAmount is not positive');
    }
    if (
      !this.sameMoney(firstReleaseAmount + secondReleaseAmount, totalAmount)
    ) {
      unsafeReasons.push('Release gross amounts do not sum to totalAmount');
    }
    if (
      !this.sameMoney(
        firstReleaseCommissionAmount + secondReleaseCommissionAmount,
        commissionAmount,
      )
    ) {
      unsafeReasons.push(
        'Release commission amounts do not sum to commissionAmount',
      );
    }
    if (
      !this.sameMoney(
        firstReleaseNetAmount + secondReleaseNetAmount,
        netBrandAmount,
      )
    ) {
      unsafeReasons.push('Release net amounts do not sum to netBrandAmount');
    }
    if (!this.sameMoney(totalAmount - commissionAmount, netBrandAmount)) {
      unsafeReasons.push(
        'EscrowHold netBrandAmount does not equal total minus commission',
      );
    }
    if (hold.status === EscrowHoldStatus.PARTIALLY_RELEASED) {
      if (!hold.firstReleasedAt || firstReleaseAmount <= 0) {
        unsafeReasons.push(
          'PARTIALLY_RELEASED hold is missing first release amount or timestamp',
        );
      }
      if (hold.secondReleasedAt) {
        unsafeReasons.push(
          'PARTIALLY_RELEASED hold already has secondReleasedAt',
        );
      }
    }
    if (hold.status === EscrowHoldStatus.RELEASED && !hold.secondReleasedAt) {
      unsafeReasons.push('RELEASED hold is missing secondReleasedAt');
    }
    if (hold.status === EscrowHoldStatus.REFUNDED && !hold.refundedAt) {
      unsafeReasons.push('REFUNDED hold is missing refundedAt');
    }
    if (hold.status === EscrowHoldStatus.FROZEN && !hold.frozenAt) {
      unsafeReasons.push('FROZEN hold is missing frozenAt');
    }
    if (hold.firstReleasedAt && firstReleaseAmount <= 0) {
      unsafeReasons.push(
        'firstReleasedAt exists but firstReleaseAmount is zero',
      );
    }

    const releaseMode =
      firstReleaseAmount > 0 || hold.firstReleasedAt
        ? SettlementReleaseMode.SPLIT_RELEASE
        : SettlementReleaseMode.HOLD_UNTIL_DELIVERY;
    const backfillSafe = unsafeReasons.length === 0;

    return {
      escrowHoldId: hold.id,
      orderId: hold.orderId ?? '',
      brandId: hold.brandId,
      status: hold.status,
      totalAmount,
      commissionRate: this.money(hold.commissionRate),
      commissionAmount,
      netBrandAmount,
      firstReleaseAmount,
      firstReleasedAt: hold.firstReleasedAt,
      secondReleaseAmount,
      secondReleasedAt: hold.secondReleasedAt,
      refundedAt: hold.refundedAt,
      frozenAt: hold.frozenAt,
      refundReason: hold.refundReason,
      frozenReason: hold.frozenReason,
      releaseMode,
      backfillSafe,
      recommendedAction: backfillSafe
        ? 'BACKFILL_SNAPSHOT_FROM_ESCROW_HOLD'
        : 'SKIP_UNSAFE_ESCROW_HOLD',
      unsafeReasons,
      ...this.standardSnapshotDraft(hold, releaseMode, config),
    } as StandardSettlementAuditRecord & {
      snapshotData: BackfillSnapshotData;
    };
  }

  private classifyCustomOrder(
    order: Prisma.CustomOrderGetPayload<{
      include: {
        ledgerAllocations: true;
        disputes: { select: { status: true } };
      };
    }>,
  ): CustomSettlementAuditRecord {
    const allocations = order.ledgerAllocations;
    const grouped = new Map<
      CustomOrderLedgerAllocationType,
      typeof allocations
    >();
    for (const allocation of allocations) {
      grouped.set(allocation.allocationType, [
        ...(grouped.get(allocation.allocationType) ?? []),
        allocation,
      ]);
    }

    const grossAmount = this.extractCustomOrderGrossAmount(order);
    const allocationTypes = allocations.map(
      (allocation) => allocation.allocationType,
    );
    const duplicateTypes = [...grouped.entries()]
      .filter(([, group]) => group.length > 1)
      .map(([type]) => type);
    const acceptance = grouped.get(
      CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
    )?.[0];
    const final = grouped.get(
      CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
    )?.[0];
    const unsafeReasons: string[] = [];

    if (allocations.length === 0) {
      unsafeReasons.push('CustomOrder has no ledger allocations');
    }
    if (duplicateTypes.length > 0) {
      unsafeReasons.push(
        `Duplicate allocation types exist: ${duplicateTypes.join(', ')}`,
      );
    }
    if (!acceptance) {
      unsafeReasons.push('Missing BRAND_ACCEPTANCE_PORTION allocation');
    }
    if (!final) {
      unsafeReasons.push('Missing FINAL_COMPLETION_PORTION allocation');
    }
    for (const allocation of allocations) {
      const amount = this.money(allocation.amount);
      const commissionAmount = this.money(allocation.commissionAmount);
      const netBrandAmount = this.money(allocation.netBrandAmount);
      if (amount < 0 || commissionAmount < 0 || netBrandAmount < 0) {
        unsafeReasons.push(`Allocation ${allocation.id} has a negative amount`);
      }
      if (!this.sameMoney(amount - commissionAmount, netBrandAmount)) {
        unsafeReasons.push(
          `Allocation ${allocation.id} net amount does not equal amount minus commission`,
        );
      }
    }
    if (acceptance && final) {
      const allocationGross = this.money(
        this.money(acceptance.amount) + this.money(final.amount),
      );
      if (
        grossAmount !== null &&
        !this.sameMoney(allocationGross, grossAmount)
      ) {
        unsafeReasons.push(
          'Allocation gross amounts do not match persisted custom-order gross amount',
        );
      }
      if (
        this.money(acceptance.commissionRate) !==
        this.money(final.commissionRate)
      ) {
        unsafeReasons.push('Allocation commission rates do not match');
      }
    }

    const allocationState = this.describeAllocationState(grouped);
    const backfillSafe = unsafeReasons.length === 0;

    return {
      customOrderId: order.id,
      brandId: order.brandId,
      paymentStatus: order.paymentStatus,
      orderStatus: order.status,
      grossAmount,
      allocationCount: allocations.length,
      allocationTypes,
      allocationState,
      releasedOrHeldState: {
        held: allocations.some(
          (allocation) =>
            allocation.status === CustomOrderLedgerAllocationStatus.HELD,
        ),
        payoutEligible: allocations.some(
          (allocation) =>
            allocation.status ===
            CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
        ),
        paidOut: allocations.some(
          (allocation) =>
            allocation.status === CustomOrderLedgerAllocationStatus.PAID_OUT,
        ),
        refundedOrReversed:
          order.paymentStatus === PaymentStatus.REFUNDED ||
          allocations.some(
            (allocation) =>
              allocation.status ===
                CustomOrderLedgerAllocationStatus.REVERSED ||
              allocation.status === CustomOrderLedgerAllocationStatus.FORFEITED,
          ),
        disputed:
          order.status === CustomOrderStatus.DISPUTED ||
          order.disputes.some((dispute) =>
            ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'].includes(
              String(dispute.status),
            ),
          ),
      },
      backfillSafe,
      recommendedAction: backfillSafe
        ? 'BACKFILL_SNAPSHOT_FROM_CUSTOM_ALLOCATIONS'
        : 'SKIP_UNSAFE_CUSTOM_ORDER',
      unsafeReasons,
      ...(backfillSafe && acceptance && final
        ? {
            snapshotData: this.customSnapshotDraft(order, acceptance, final),
          }
        : {}),
    } as CustomSettlementAuditRecord & {
      snapshotData?: BackfillSnapshotData;
    };
  }

  private async writeStandardSnapshots(
    records: StandardSettlementAuditRecord[],
  ) {
    return this.writeSnapshots(
      records
        .filter((record) => record.backfillSafe)
        .map(
          (record) =>
            record as StandardSettlementAuditRecord & {
              snapshotData: BackfillSnapshotData;
            },
        ),
      'orderId',
    );
  }

  private async writeCustomSnapshots(records: CustomSettlementAuditRecord[]) {
    return this.writeSnapshots(
      records
        .filter((record) => record.backfillSafe)
        .map(
          (record) =>
            record as CustomSettlementAuditRecord & {
              snapshotData: BackfillSnapshotData;
            },
        ),
      'customOrderId',
    );
  }

  private async writeSnapshots(
    records: Array<{
      orderId?: string;
      customOrderId?: string;
      snapshotData: BackfillSnapshotData;
    }>,
    key: 'orderId' | 'customOrderId',
  ) {
    let created = 0;
    let skippedExisting = 0;

    for (const record of records) {
      const targetId = record[key];
      if (!targetId) {
        continue;
      }

      const result = await this.prisma.$transaction(async (tx) => {
        const existing = await tx.settlementSnapshot.findFirst({
          where: { [key]: targetId },
        });
        if (existing) {
          return 'existing';
        }

        try {
          await tx.settlementSnapshot.create({ data: record.snapshotData });
          return 'created';
        } catch (error) {
          if (this.isUniqueViolation(error)) {
            return 'existing';
          }
          throw error;
        }
      });

      if (result === 'created') {
        created += 1;
      } else {
        skippedExisting += 1;
      }
    }

    return { created, skippedExisting };
  }

  private standardSnapshotDraft(
    hold: Prisma.EscrowHoldGetPayload<Record<string, never>>,
    releaseMode: SettlementReleaseMode,
    config: { settlementDelayHours: number; autoReleaseDays: number },
  ) {
    const totalAmount = this.money(hold.totalAmount);
    const firstReleaseAmount = this.money(hold.firstReleaseAmount);
    return {
      snapshotData: {
        orderType: SettlementOrderType.STANDARD_ORDER,
        orderId: hold.orderId,
        customOrderId: null,
        brandId: hold.brandId,
        grossAmount: this.decimal(totalAmount),
        currency: hold.currency,
        commissionRuleId: null,
        commissionSource: 'LEGACY_BACKFILL',
        commissionRate: this.decimal(hold.commissionRate),
        commissionAmount: this.decimal(hold.commissionAmount),
        brandNetAmount: this.decimal(hold.netBrandAmount),
        settlementPolicyId: null,
        releaseMode,
        upfrontReleaseEnabled:
          releaseMode === SettlementReleaseMode.SPLIT_RELEASE,
        upfrontReleasePercent: this.decimal(
          totalAmount > 0 ? (firstReleaseAmount / totalAmount) * 100 : 0,
        ),
        upfrontReleaseGrossAmount: this.decimal(hold.firstReleaseAmount),
        upfrontReleaseCommissionAmount: this.decimal(
          hold.firstReleaseCommissionAmount,
        ),
        upfrontReleaseNetBrandAmount: this.decimal(hold.firstReleaseNetAmount),
        finalReleaseGrossAmount: this.decimal(hold.secondReleaseAmount),
        finalReleaseCommissionAmount: this.decimal(
          hold.secondReleaseCommissionAmount,
        ),
        finalReleaseNetBrandAmount: this.decimal(hold.secondReleaseNetAmount),
        settlementDelayHours: config.settlementDelayHours,
        autoReleaseDays: config.autoReleaseDays,
        finalReleaseTrigger: this.mapFinalReleaseTrigger(
          hold.secondReleaseCondition,
        ),
        calculatedAt: hold.createdAt,
      },
    };
  }

  private customSnapshotDraft(
    order: Prisma.CustomOrderGetPayload<{
      include: { ledgerAllocations: true };
    }>,
    acceptance: Prisma.CustomOrderLedgerAllocationGetPayload<
      Record<string, never>
    >,
    final: Prisma.CustomOrderLedgerAllocationGetPayload<Record<string, never>>,
  ): BackfillSnapshotData {
    const acceptanceAmount = this.money(acceptance.amount);
    const finalAmount = this.money(final.amount);
    const grossAmount = this.money(acceptanceAmount + finalAmount);
    const commissionAmount = this.money(
      this.money(acceptance.commissionAmount) +
        this.money(final.commissionAmount),
    );
    const brandNetAmount = this.money(
      this.money(acceptance.netBrandAmount) + this.money(final.netBrandAmount),
    );
    const releaseMode =
      acceptanceAmount > 0
        ? SettlementReleaseMode.SPLIT_RELEASE
        : SettlementReleaseMode.HOLD_UNTIL_DELIVERY;

    return {
      orderType: SettlementOrderType.CUSTOM_ORDER,
      orderId: null,
      customOrderId: order.id,
      brandId: order.brandId,
      grossAmount: this.decimal(grossAmount),
      currency: acceptance.currency,
      commissionRuleId: null,
      commissionSource: 'LEGACY_BACKFILL',
      commissionRate: this.decimal(acceptance.commissionRate),
      commissionAmount: this.decimal(commissionAmount),
      brandNetAmount: this.decimal(brandNetAmount),
      settlementPolicyId: null,
      releaseMode,
      upfrontReleaseEnabled:
        releaseMode === SettlementReleaseMode.SPLIT_RELEASE,
      upfrontReleasePercent: this.decimal(
        grossAmount > 0 ? (acceptanceAmount / grossAmount) * 100 : 0,
      ),
      upfrontReleaseGrossAmount: this.decimal(acceptance.amount),
      upfrontReleaseCommissionAmount: this.decimal(acceptance.commissionAmount),
      upfrontReleaseNetBrandAmount: this.decimal(acceptance.netBrandAmount),
      finalReleaseGrossAmount: this.decimal(final.amount),
      finalReleaseCommissionAmount: this.decimal(final.commissionAmount),
      finalReleaseNetBrandAmount: this.decimal(final.netBrandAmount),
      settlementDelayHours: 0,
      autoReleaseDays: 0,
      finalReleaseTrigger: SettlementFinalReleaseTrigger.BUYER_CONFIRMATION,
      calculatedAt: order.acceptedAt ?? order.createdAt,
    };
  }

  private describeAllocationState(
    grouped: Map<CustomOrderLedgerAllocationType, unknown[]>,
  ) {
    const hasAcceptance = grouped.has(
      CustomOrderLedgerAllocationType.BRAND_ACCEPTANCE_PORTION,
    );
    const hasFinal = grouped.has(
      CustomOrderLedgerAllocationType.FINAL_COMPLETION_PORTION,
    );
    const hasDuplicate = [...grouped.values()].some(
      (group) => group.length > 1,
    );

    if (hasDuplicate) {
      return 'duplicate allocation types exist';
    }
    if (hasAcceptance && hasFinal) {
      return 'both allocation types exist';
    }
    if (hasAcceptance) {
      return 'only BRAND_ACCEPTANCE_PORTION exists';
    }
    if (hasFinal) {
      return 'only FINAL_COMPLETION_PORTION exists';
    }
    return 'no allocations';
  }

  private extractCustomOrderGrossAmount(order: {
    buyerPriceSummaryJson: Prisma.JsonValue;
  }) {
    const summary = this.asObject(order.buyerPriceSummaryJson);
    const amount = Number(summary?.grandTotal ?? summary?.total ?? NaN);
    return Number.isFinite(amount) && amount > 0 ? this.money(amount) : null;
  }

  private mapFinalReleaseTrigger(condition: EscrowReleaseCondition | null) {
    switch (condition) {
      case EscrowReleaseCondition.BUYER_TIMEOUT:
        return SettlementFinalReleaseTrigger.BUYER_TIMEOUT;
      case EscrowReleaseCondition.MANUAL_ADMIN:
        return SettlementFinalReleaseTrigger.ADMIN_APPROVAL;
      case EscrowReleaseCondition.DISPUTE_RESOLVED:
        return SettlementFinalReleaseTrigger.DISPUTE_RESOLUTION;
      default:
        return SettlementFinalReleaseTrigger.BUYER_CONFIRMATION;
    }
  }

  private summarize(
    records: Array<{ backfillSafe: boolean }>,
  ): BackfillSummary {
    return {
      scanned: records.length,
      missingSnapshots: records.length,
      safe: records.filter((record) => record.backfillSafe).length,
      unsafe: records.filter((record) => !record.backfillSafe).length,
      created: 0,
      skippedExisting: 0,
    };
  }

  private emptySummary() {
    return {
      records: [],
      summary: {
        scanned: 0,
        missingSnapshots: 0,
        safe: 0,
        unsafe: 0,
        created: 0,
        skippedExisting: 0,
      },
    };
  }

  private uniqueConstraintRecommendation(groups: unknown[]) {
    return groups.length === 0
      ? 'No duplicate allocation groups found. A future unique constraint on (customOrderId, allocationType) is data-safe from this audit result.'
      : 'Duplicate allocation groups exist. Run a cleanup phase before adding a unique constraint on (customOrderId, allocationType).';
  }

  private stripSnapshotData<T>(records: T[]): T[] {
    return records.map((record) => {
      const { snapshotData: _snapshotData, ...publicRecord } = record as T & {
        snapshotData?: BackfillSnapshotData;
      };
      void _snapshotData;
      return publicRecord as T;
    });
  }

  private normalizeOptions(
    options: SettlementBackfillOptions,
  ): Required<SettlementBackfillOptions> {
    const orderType = options.orderType ?? 'all';
    if (!['standard', 'custom', 'all'].includes(orderType)) {
      throw new Error(`Invalid orderType: ${orderType}`);
    }
    const limit = Number(options.limit ?? DEFAULT_LIMIT);
    return {
      orderType,
      limit:
        Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : DEFAULT_LIMIT,
      write: Boolean(options.write),
    };
  }

  private money(value: Prisma.Decimal | number | string | null | undefined) {
    return this.roundMoney(Number(value ?? 0));
  }

  private decimal(value: Prisma.Decimal | number | string | null | undefined) {
    return new Prisma.Decimal(this.money(value).toFixed(2));
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private sameMoney(left: number, right: number) {
    return Math.abs(this.roundMoney(left) - this.roundMoney(right)) < 0.01;
  }

  private asObject(value: Prisma.JsonValue | null) {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  }

  private isUniqueViolation(error: unknown) {
    return Boolean(
      error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: string }).code === 'P2002',
    );
  }
}
