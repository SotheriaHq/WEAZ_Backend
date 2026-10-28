import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  AdminAuditAction,
  CustomOrderActorType,
  CustomOrderLane,
  CustomOrderLedgerAllocationStatus,
  CustomOrderLedgerAllocationType,
  CustomOrderStatus,
  LedgerAccountType,
  LedgerEntryDirection,
  LedgerTransactionType,
  NotificationType,
  Prisma,
  Role,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { LedgerService } from 'src/finance/ledger.service';
import {
  canRetainPosition,
  preActiveRefund,
  QUEUE_WAIT_MS,
  RETAIN_CLOSE_MS,
  RETAIN_OPEN_MS,
  retainedExpiry,
  selectQueueCandidate,
} from './subscription-queue.policy';
import { getCachedActiveAdminIds } from '../custom-order-admin-attention';
import { BrandBalanceService } from 'src/finance/brand-balance.service';
import { reserveFullOrderRefund } from './queue-refund-reservation';
import { refundSettlement } from './queue-refund-settlement';
import { allocatePartialRefund } from './partial-refund-allocation';
import { loadQueueCapacityContext } from './queue-capacity-query';
import {
  loadQueueCancellationOrder,
  QueueCancellationOrder,
} from './queue-cancellation-query';

type Tx = Prisma.TransactionClient;
const WAITING: CustomOrderLane[] = ['PENDING', 'UP_NEXT'];
const reminderStages = [48, 24, 5].map((hours) => `QUEUE_EXPIRY_${hours}`);
const money = (value: unknown) => {
  const amount = Number(value ?? 0);
  if (
    !Number.isFinite(amount) ||
    amount < 0 ||
    !Number.isSafeInteger(Math.round(amount * 100))
  )
    throw new BadRequestException('CUSTOM_ORDER_INVALID_MONEY_SNAPSHOT');
  return Math.round(amount * 100);
};
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

@Injectable()
export class CustomOrderQueueService {
  private readonly logger = new Logger(CustomOrderQueueService.name);
  private brandCursor = '';
  private expiryCursor: { at: Date; id: string } | null = null;
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: BrandPermissionService,
    private readonly finance: CustomOrderFinanceSyncService,
    private readonly ledger: LedgerService,
    @Optional() private readonly brandBalance?: BrandBalanceService,
  ) {}

  async lockBrand(tx: Tx, brandId: string): Promise<Date> {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT "_id" AS id FROM "Brand" WHERE "_id" = ${brandId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Brand not found');
    const clock = await tx.$queryRaw<
      Array<{ now: Date }>
    >`SELECT clock_timestamp() AS now`;
    return clock[0].now;
  }

  async capacity(tx: Tx | PrismaService, brandId: string, now = new Date()) {
    const context = await loadQueueCapacityContext(tx, brandId, now);
    if (!context) throw new NotFoundException('Brand not found');
    const { brand, agreement, tier } = context;
    if (!tier)
      throw new ConflictException('CUSTOM_ORDER_TIER_CONFIGURATION_MISSING');
    const override =
      brand.activeOrderCapOverride !== null &&
      (!brand.activeOrderCapOverrideUntil ||
        brand.activeOrderCapOverrideUntil > now)
        ? brand.activeOrderCapOverride
        : null;
    const active =
      override ??
      (tier.maxActive === null
        ? null
        : Math.max(0, tier.maxActive + context.deltaActive));
    const safetyAllowed =
      brand.verificationStatus === 'APPROVED' &&
      brand.owner.status === 'ACTIVE';
    const entitled =
      Boolean(
        agreement?.status === 'ACTIVE' && agreement.currentPeriodEnd > now,
      );
    return {
      brand,
      agreement,
      tierKey: tier.key,
      active,
      inDelivery: tier.maxInDelivery,
      queueJumpAllowed:
        ['ARU', 'IGWE'].includes(tier.key) && tier.queueJumpAllowed,
      intakeAllowed:
        entitled && safetyAllowed && !brand.customOrderIntakeBlockedAt,
      safetyAllowed,
    };
  }

  async assertIntake(
    buyerId: string,
    brandId: string,
    tx: Tx | PrismaService = this.prisma,
  ) {
    const [buyer, cap] = await Promise.all([
      tx.user.findUnique({
        where: { id: buyerId },
        select: { type: true, status: true },
      }),
      this.capacity(tx, brandId),
    ]);
    if (
      !buyer ||
      buyer.type !== 'REGULAR' ||
      buyer.status !== 'ACTIVE' ||
      cap.brand.ownerId === buyerId
    )
      throw new ForbiddenException(
        'Only an eligible shopper may order from this brand',
      );
    if (!cap.intakeAllowed)
      throw new ForbiddenException('CUSTOM_ORDER_INTAKE_UNAVAILABLE');
    return cap;
  }

  /** Checkout preview needs eligibility only; capacity is rechecked under lock on capture. */
  async assertIntakeForBrands(buyerId: string, brandIds: readonly string[]) {
    const ids = [...new Set(brandIds)].sort();
    if (!ids.length) return;
    const buyer = await this.prisma.user.findUnique({ where: { id: buyerId }, select: { type: true, status: true } });
    if (!buyer || buyer.type !== 'REGULAR' || buyer.status !== 'ACTIVE') {
      throw new ForbiddenException('Only an eligible shopper may order from this brand');
    }
    const now = new Date();
    for (let offset = 0; offset < ids.length; offset += 500) {
      const batch = ids.slice(offset, offset + 500);
      const rows = await this.prisma.$queryRaw<Array<{ id: string; ownerId: string; tierConfigured: boolean; intakeAllowed: boolean }>>(Prisma.sql`
        SELECT brand."_id" AS id, brand."ownerId", tier.key IS NOT NULL AS "tierConfigured",
          COALESCE(agreement.status = 'ACTIVE' AND agreement."currentPeriodEnd" > ${now}
            AND brand."verificationStatus" = 'APPROVED' AND owner.status = 'ACTIVE'
            AND brand."customOrderIntakeBlockedAt" IS NULL, FALSE) AS "intakeAllowed"
        FROM "Brand" brand JOIN "User" owner ON owner."_id" = brand."ownerId"
        LEFT JOIN LATERAL (
          SELECT subscription."tierKey", subscription.status, subscription."currentPeriodEnd"
          FROM "BrandSubscription" subscription WHERE subscription."brandId" = brand."_id"
            AND subscription.status IN ('ACTIVE', 'PAST_DUE', 'CANCELLED')
          ORDER BY subscription."createdAt" DESC LIMIT 1
        ) agreement ON TRUE
        LEFT JOIN "SubscriptionTier" tier ON tier.key = COALESCE(agreement."tierKey", 'THREAD')
        WHERE brand."_id" = ANY(${batch}::uuid[])
      `);
      const byId = new Map(rows.map((row) => [row.id, row]));
      for (const id of batch) {
        const row = byId.get(id);
        if (!row) throw new NotFoundException('Brand not found');
        if (!row.tierConfigured) throw new ConflictException('CUSTOM_ORDER_TIER_CONFIGURATION_MISSING');
        if (row.ownerId === buyerId) throw new ForbiddenException('Only an eligible shopper may order from this brand');
        if (!row.intakeAllowed) throw new ForbiddenException('CUSTOM_ORDER_INTAKE_UNAVAILABLE');
      }
    }
  }

  async summary(brandId: string, buyerId?: string) {
    const [cap, counts, openOrderCount] = await Promise.all([
      this.capacity(this.prisma, brandId),
      this.prisma.customOrder.groupBy({
        by: ['lane'],
        where: { brandId, lane: { not: null } },
        _count: true,
      }),
      buyerId
        ? this.prisma.customOrder.count({
            where: {
              brandId,
              buyerId,
              lane: { in: ['PENDING', 'UP_NEXT', 'ACTIVE', 'IN_DELIVERY'] },
            },
          })
        : Promise.resolve(0),
    ]);
    const lanes = { PENDING: 0, UP_NEXT: 0, ACTIVE: 0, IN_DELIVERY: 0 };
    counts.forEach((row) => {
      if (row.lane && row.lane in lanes)
        lanes[row.lane as keyof typeof lanes] = row._count;
    });
    return {
      brandId,
      counts: lanes,
      capacity:
        !buyerId || buyerId === cap.brand.ownerId
          ? {
              tierKey: cap.tierKey,
              active: cap.active,
              inDelivery: cap.inDelivery,
              queueJumpAllowed: cap.queueJumpAllowed,
            }
          : {},
      queueJumpEnabled: cap.brand.queueJumpEnabled,
      jumpAvailable:
        cap.queueJumpAllowed &&
        cap.brand.queueJumpEnabled &&
        cap.intakeAllowed &&
        (lanes.PENDING + lanes.UP_NEXT > 0 ||
          (cap.active !== null && lanes.ACTIVE >= cap.active)),
      intakeAllowed: cap.intakeAllowed,
      intakeBlocked: Boolean(cap.brand.customOrderIntakeBlockedAt),
      ...(buyerId && buyerId !== cap.brand.ownerId
        ? {}
        : {
            intakeBlockReason: cap.brand.customOrderIntakeBlockReason,
            activeOrderCapOverride: cap.brand.activeOrderCapOverride,
            activeOrderCapOverrideUntil: cap.brand.activeOrderCapOverrideUntil,
            massCancelAttentionAt: cap.brand.massCancelAttentionAt,
            assignedTierKey: cap.brand.assignedSubscriptionTierKey,
          }),
      openOrderCount,
      buyerOpenOrderCount: openOrderCount,
      serverNow: new Date().toISOString(),
    };
  }

  private async assertParticipant(
    userId: string,
    orderId: string,
    write = false,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id: orderId },
    });
    if (!order) throw new NotFoundException('Custom order not found');
    if (order.buyerId === userId) return order;
    await this.permissions.assertPermission(
      userId,
      order.brandId,
      write ? BRAND_PERMISSIONS.ORDERS_UPDATE : BRAND_PERMISSIONS.ORDERS_READ,
    );
    return order;
  }

  async get(userId: string, orderId: string) {
    await this.assertParticipant(userId, orderId);
    return (await this.present([orderId]))[orderId];
  }

  async batch(userId: string, orderIds: string[]) {
    const ids = [...new Set(orderIds)];
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });
    const rows = await this.prisma.customOrder.findMany({
      where: { id: { in: ids } },
      select: { id: true, buyerId: true, brandId: true },
    });
    if (user?.type === 'REGULAR') {
      if (rows.some((row) => row.buyerId !== userId))
        throw new ForbiddenException('Not authorized for these orders');
    } else {
      const brands = [...new Set(rows.map((row) => row.brandId))];
      const allowed = await this.permissions.getPermittedBrandIds(userId, brands, BRAND_PERMISSIONS.ORDERS_READ);
      if (brands.some((brandId) => !allowed.has(brandId))) {
        throw new ForbiddenException('You do not have permission for this brand action');
      }
    }
    return {
      orders: await this.present(rows.map((row) => row.id)),
      serverNow: new Date().toISOString(),
    };
  }

  async present(ids: string[], tx: Tx | PrismaService = this.prisma) {
    if (!ids.length) return {};
    const rows = await tx.customOrder.findMany({
      where: { id: { in: ids.slice(0, 100) } },
      include: { queueRefunds: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    const brands = [...new Set(rows.map((row) => row.brandId))];
    const ranks = brands.length
      ? await tx.$queryRaw<
          Array<{ id: string; position: bigint; waitingCount: bigint }>
        >(
          Prisma.sql`SELECT "id", ROW_NUMBER() OVER (PARTITION BY "brandId" ORDER BY CASE WHEN "lane" = 'UP_NEXT' THEN 0 ELSE 1 END, "queuePriority" DESC, "queuePosition" ASC NULLS LAST, "queuedAt", "id") AS position, COUNT(*) OVER (PARTITION BY "brandId") AS "waitingCount" FROM "CustomOrder" WHERE "brandId" IN (${Prisma.join(brands.map((id) => Prisma.sql`${id}::uuid`))}) AND "lane" IN ('PENDING','UP_NEXT')`,
        )
      : [];
    const byId = new Map(ranks.map((row) => [row.id, row]));
    const now = new Date();
    return Object.fromEntries(
      rows.map((row) => {
        const queueRefund =
          row.queueRefunds.find((refund) => refund.status !== 'SETTLED') ??
          row.queueRefunds[0];
        const waiting = row.lane !== null && WAITING.includes(row.lane);
        const rank = byId.get(row.id);
        return [
          row.id,
          {
            refundHistory: row.queueRefunds.map((refund) => ({
              id: refund.id,
              kind: refund.kind,
              status: refund.status,
              amount: Number(refund.amount),
              currency: refund.currency,
              createdAt: refund.createdAt.toISOString(),
            })),
            lane: row.lane,
            orderRevision: row.orderRevision,
            queueExpiresAt: row.queueExpiresAt?.toISOString() ?? null,
            serverNow: now.toISOString(),
            retainOpensAt: row.queueExpiresAt
              ? new Date(+row.queueExpiresAt - RETAIN_OPEN_MS).toISOString()
              : null,
            retainClosesAt: row.queueExpiresAt
              ? new Date(+row.queueExpiresAt - RETAIN_CLOSE_MS).toISOString()
              : null,
            canRetain: Boolean(
              waiting &&
                row.queueExpiresAt &&
                canRetainPosition({
                  now,
                  queueExpiresAt: row.queueExpiresAt,
                  retainCount: row.retainCount,
                }),
            ),
            canCancel: waiting && row.paymentStatus === 'PAID',
            canResubmit: Boolean(row.cancelledAt),
            adminPromotionHeld: row.adminPromotionHeld,
            position: rank ? Number(rank.position) : null,
            waitingCount: rank ? Number(rank.waitingCount) : 0,
            activatedAt: row.activatedAt?.toISOString() ?? null,
            captureSummary: {
              amount: Number(object(row.buyerPriceSummaryJson).grandTotal ?? 0),
              currency: row.currency,
              held: waiting,
              heldAmount: waiting
                ? Number(object(row.buyerPriceSummaryJson).grandTotal ?? 0)
                : 0,
              status: queueRefund
                ? queueRefund.status === 'SETTLED'
                  ? row.cancelledAt
                    ? 'REFUNDED'
                    : 'PARTIALLY_REFUNDED'
                  : 'REFUND_PROCESSING'
                : waiting
                  ? 'HELD'
                  : 'RELEASED',
            },
            refundSummary: queueRefund
              ? {
                  id: queueRefund.id,
                  kind: queueRefund.kind,
                  status: queueRefund.status,
                  amount: Number(queueRefund.amount),
                  currency: queueRefund.currency,
                  settlement:
                    object(queueRefund.breakdownJson).settlement ?? null,
                  lastError: queueRefund.lastError,
                }
              : null,
          },
        ];
      }),
    );
  }

  private async invalidateReminders(tx: Tx, orderId: string) {
    await tx.customOrderNotificationOutbox.updateMany({
      where: {
        customOrderId: orderId,
        status: { in: ['PENDING', 'FAILED'] },
        OR: reminderStages.map((stage) => ({
          payloadJson: { path: ['stage'], equals: stage },
        })),
      },
      data: { status: 'SKIPPED' },
    });
  }

  private async record(
    tx: Tx,
    order: { id: string; buyerId: string; brandId: string },
    kind: string,
    message: string,
    actorType: CustomOrderActorType = 'SYSTEM',
    actorId?: string,
    knownBrandOwnerId?: string,
  ) {
    await tx.customOrderTimelineEvent.create({
      data: {
        customOrderId: order.id,
        eventType: 'QUEUE_UPDATED',
        actorType,
        actorId,
        payloadJson: { kind, message },
      },
    });
    const brand = knownBrandOwnerId === undefined ? await tx.brand.findUnique({
      where: { id: order.brandId },
      select: { ownerId: true },
    }) : { ownerId: knownBrandOwnerId };
    await tx.customOrderNotificationOutbox.createMany({
      data: [
        ...new Set(
          [order.buyerId, brand?.ownerId].filter((id): id is string =>
            Boolean(id),
          ),
        ),
      ].map((recipientId) => ({
        customOrderId: order.id,
        recipientId,
        actorId,
        notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
        payloadJson: {
          customOrderId: order.id,
          stage: kind,
          message,
          targetUrl:
            recipientId === order.buyerId
              ? `/profile?tab=orders&customOrderId=${order.id}`
              : `/studio/custom-orders/${order.id}`,
        },
        targetJson: { type: 'CUSTOM_ORDER', id: order.id },
        dedupeMs: 0,
      })),
    });
  }

  private async schedule(
    tx: Tx,
    order: {
      id: string;
      buyerId: string;
      brandId: string;
      queueExpiresAt: Date | null;
    },
    knownBrandOwnerId?: string,
  ) {
    if (!order.queueExpiresAt) return;
    const brand =
      knownBrandOwnerId === undefined
        ? await tx.brand.findUnique({
            where: { id: order.brandId },
            select: { ownerId: true },
          })
        : { ownerId: knownBrandOwnerId };
    await tx.customOrderNotificationOutbox.createMany({
      data: [48, 24, 5].flatMap((hours) =>
        [
          ...new Set(
            [order.buyerId, brand?.ownerId].filter((id): id is string =>
              Boolean(id),
            ),
          ),
        ].map((recipientId) => ({
          customOrderId: order.id,
          recipientId,
          notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
          availableAt: new Date(+order.queueExpiresAt! - hours * 3600000),
          payloadJson: {
            customOrderId: order.id,
            stage: `QUEUE_EXPIRY_${hours}`,
            note: order.queueExpiresAt!.toISOString(),
            message:
              hours === 5
                ? 'Your waiting custom order is scheduled to cancel in 5 hours. The retain window is closed. Cancellation deductions apply; delivery is refunded in full.'
                : `Your waiting custom order is scheduled to cancel in ${hours} hours. The shopper can retain the position once until 12 hours before expiry, adding 42 days to the current deadline.`,
            targetUrl:
              recipientId === order.buyerId
                ? `/profile?tab=orders&customOrderId=${order.id}`
                : `/studio/custom-orders/${order.id}`,
          },
          targetJson: { type: 'CUSTOM_ORDER', id: order.id },
          dedupeMs: 0,
        })),
      ),
    });
  }

  /** Called within every successful payment finalization transaction. */
  async admitPaid(tx: Tx, orderId: string) {
    const source = await tx.customOrder.findUniqueOrThrow({
      where: { id: orderId },
      select: { brandId: true },
    });
    const now = await this.lockBrand(tx, source.brandId);
    let order = await tx.customOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.lane !== null || order.paymentStatus !== 'PAID') return;
    const summary = object(order.buyerPriceSummaryJson);
    const jumpFee = Number(summary.queueJumpFee ?? 0);
    const max = await tx.customOrder.aggregate({
      where: { brandId: order.brandId },
      _max: { queuePosition: true },
    });
    order = await tx.customOrder.update({
      where: { id: orderId },
      data: {
        status: 'QUEUED',
        lane: 'PENDING',
        queuePosition: (max._max.queuePosition ?? 0) + 1,
        queuedAt: now,
        queueExpiresAt: new Date(+now + QUEUE_WAIT_MS),
        queuePolicyVersion: 1,
        queuePriority: jumpFee > 0 ? 1 : 0,
        jumpFeeAmount: jumpFee,
        acceptedAt: null,
        activatedAt: null,
        promisedProductionAt: null,
        promisedDispatchAt: null,
        promisedDeliveryAt: null,
        lastBrandProgressUpdateAt: null,
        currentProgressStage: 'ORDER_PLACED',
        orderRevision: { increment: 1 },
      },
    });
    await this.finance.applyPaidSettlement(tx, {
      customOrderId: order.id,
      brandId: order.brandId,
      grossAmount: Number(summary.grandTotal) - jumpFee,
      currency: order.currency,
      effectiveAt: now,
      releaseEligibleAt: now,
      queueHold: true,
    });
    const cap = await this.capacity(tx, order.brandId, now);
    await this.record(
      tx,
      order,
      'QUEUE_PLACED',
      'Payment captured. Your custom order has entered the queue; its funds remain held until work becomes Active.',
      'SYSTEM',
      undefined,
      cap.brand.ownerId,
    );
    await this.schedule(tx, order, cap.brand.ownerId);
    const buyer = await tx.user.findUnique({
      where: { id: order.buyerId },
      select: { type: true, status: true },
    });
    if (
      !cap.intakeAllowed ||
      buyer?.type !== 'REGULAR' ||
      buyer.status !== 'ACTIVE' ||
      cap.brand.ownerId === order.buyerId ||
      (jumpFee > 0 && (!cap.queueJumpAllowed || !cap.brand.queueJumpEnabled))
    ) {
      await this.cancelLocked(
        tx,
        order,
        now,
        'Eligibility changed before payment finalization',
        'SYSTEM',
        undefined,
        cap.brand.ownerId,
      );
      return;
    }
    await this.drain(tx, order.brandId, now);
  }

  async drain(tx: Tx, brandId: string, now: Date) {
    const cap = await this.capacity(tx, brandId, now);
    if (!cap.safetyAllowed) return;
    let active = await tx.customOrder.count({
      where: { brandId, lane: 'ACTIVE' },
    });
    let streak = cap.brand.queuePriorityStreak;
    // Every queue writer holds this brand's lock. Read bounded FIFO heads once;
    // financial transitions and per-order outbox effects remain transactional.
    let up = await tx.customOrder.findFirst({ where: { brandId, lane: 'UP_NEXT' } });
    let pending: Awaited<ReturnType<typeof tx.customOrder.findMany>>[] | null = null;
    const candidateLimit = Math.min(50, Math.max(1, cap.active === null ? 50 : cap.active - active + 1));
    for (let turns = 0; turns < 50; turns++) {
      if (!up) {
        pending ??= await Promise.all(
          [1, 0].map((queuePriority) =>
            tx.customOrder.findMany({
              where: {
                brandId,
                lane: 'PENDING',
                queuePriority,
                adminPromotionHeld: false,
                queueExpiresAt: { gt: now },
                paymentStatus: 'PAID',
              },
              orderBy: [
                { queuePosition: 'asc' },
                { createdAt: 'asc' },
                { id: 'asc' },
              ],
              take: candidateLimit,
            }),
          ),
        );
        const candidate = selectQueueCandidate(
          pending.map((rows) => rows[0] ?? null).filter(
            (row): row is NonNullable<typeof row> => row !== null,
          ),
          streak,
        );
        if (!candidate) break;
        pending.find((rows) => rows[0]?.id === candidate.id)?.shift();
        up = await tx.customOrder.update({
          where: { id: candidate.id },
          data: { lane: 'UP_NEXT', orderRevision: { increment: 1 } },
        });
        await this.record(
          tx,
          up,
          'QUEUE_UP_NEXT',
          'Your custom order is Up Next. No additional garment payment is required.',
          'SYSTEM', undefined, cap.brand.ownerId,
        );
      }
      if (
        (cap.active !== null && active >= cap.active) ||
        up.adminPromotionHeld ||
        !up.queueExpiresAt ||
        up.queueExpiresAt <= now
      )
        break;
      const production = new Date(
        +now + up.productionLeadDaysSnapshot * 86400000,
      );
      const activated = await tx.customOrder.update({
        where: { id: up.id },
        data: {
          lane: 'ACTIVE',
          status: 'ACCEPTED',
          activatedAt: now,
          acceptedAt: now,
          queueExpiresAt: null,
          promisedProductionAt: production,
          promisedDispatchAt: production,
          promisedDeliveryAt: new Date(
            +production + up.deliveryMaxDaysSnapshot * 86400000,
          ),
          currentProgressStage: 'ORDER_RECEIVED',
          currentProgressStageEnteredAt: now,
          lastBrandProgressUpdateAt: now,
          orderRevision: { increment: 1 },
        },
      });
      await this.invalidateReminders(tx, up.id);
      await this.finance.applyPaidSettlement(tx, {
        customOrderId: up.id,
        brandId,
        grossAmount:
          Number(object(up.buyerPriceSummaryJson).grandTotal) -
          Number(up.jumpFeeAmount),
        currency: up.currency,
        effectiveAt: up.queuedAt ?? up.createdAt,
        releaseEligibleAt: now,
      });
      if (Number(up.jumpFeeAmount) > 0) await this.releaseJump(tx, activated);
      await this.record(
        tx,
        activated,
        'QUEUE_ACTIVE',
        'Your custom order is now Active. Production dates start today; the brand acceptance portion is available under the settlement policy.',
        'SYSTEM', undefined, cap.brand.ownerId,
      );
      streak = up.queuePriority > 0 ? streak + 1 : 0;
      active++;
      up = null;
    }
    await tx.brand.update({
      where: { id: brandId },
      data: { queuePriorityStreak: streak },
    });
  }

  private async releaseJump(
    tx: Tx,
    order: {
      id: string;
      brandId: string;
      currency: string;
      jumpFeeAmount: Prisma.Decimal;
    },
  ) {
    const gross = Number(order.jumpFeeAmount),
      commission = Math.round(gross * 10) / 100,
      net = Math.round((gross - commission) * 100) / 100;
    await tx.customOrderLedgerAllocation.createMany({
      skipDuplicates: true,
      data: {
        customOrderId: order.id,
        allocationType: 'JUMP_FEE',
        amount: gross,
        commissionRate: 10,
        commissionAmount: commission,
        netBrandAmount: net,
        currency: order.currency,
        status: 'PAYOUT_ELIGIBLE',
        eligibleAt: new Date(),
      },
    });
    await this.ledger.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${order.id}:jump_release`,
      type: LedgerTransactionType.ESCROW_RELEASE,
      description: 'Custom-order queue priority fee released at activation',
      referenceType: 'CustomOrder',
      referenceId: order.id,
      totalAmount: gross,
      currency: order.currency,
      lines: [
        {
          code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
          name: 'Custom Order Escrow',
          type: LedgerAccountType.LIABILITY,
          subType: 'CUSTOM_ORDER_ESCROW',
          isSystemAccount: true,
          direction: LedgerEntryDirection.DEBIT,
          amount: gross,
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: LedgerAccountType.REVENUE,
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: LedgerEntryDirection.CREDIT,
          amount: commission,
        },
        {
          code: `BRAND_WALLET:${order.brandId}`,
          name: `Brand Wallet ${order.brandId}`,
          type: LedgerAccountType.LIABILITY,
          subType: 'BRAND_AVAILABLE',
          entityType: 'BRAND',
          entityId: order.brandId,
          direction: LedgerEntryDirection.CREDIT,
          amount: net,
        },
      ],
    });
  }

  async retain(userId: string, id: string, expectedRevision?: number) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id, buyerId: userId },
    });
    if (!order) throw new NotFoundException('Custom order not found');
    await this.prisma.$transaction(async (tx) => {
      const now = await this.lockBrand(tx, order.brandId);
      const current = await tx.customOrder.findUniqueOrThrow({ where: { id } });
      this.checkRevision(current.orderRevision, expectedRevision);
      if (
        !current.lane ||
        !WAITING.includes(current.lane) ||
        !current.queueExpiresAt ||
        !canRetainPosition({
          now,
          queueExpiresAt: current.queueExpiresAt,
          retainCount: current.retainCount,
        })
      )
        throw new ConflictException('CUSTOM_ORDER_RETAIN_WINDOW_CLOSED');
      const updated = await tx.customOrder.update({
        where: { id },
        data: {
          queueExpiresAt: retainedExpiry(current.queueExpiresAt),
          retainCount: 1,
          retainedAt: now,
          orderRevision: { increment: 1 },
        },
      });
      await this.invalidateReminders(tx, id);
      await this.schedule(tx, updated);
      await this.record(
        tx,
        updated,
        'QUEUE_RETAINED',
        'Your queue position is retained. Your previous cancellation deadline has been extended by 42 days.',
        'BUYER',
        userId,
      );
    });
    return { queue: (await this.present([id]))[id] };
  }

  private checkRevision(actual: number, expected?: number) {
    if (expected !== undefined && actual !== expected)
      throw new ConflictException('CUSTOM_ORDER_CHANGED_REFRESH_REQUIRED');
  }

  quote(order: {
    buyerPriceSummaryJson: unknown;
    currency: string;
    orderRevision: number;
  }) {
    const summary = object(order.buyerPriceSummaryJson);
    const captureKobo = money(summary.grandTotal);
    const vatKobo = money(summary.vatAmount ?? summary.vat);
    const deliveryKobo = money(summary.delivery ?? summary.shippingFee);
    const jumpFeeKobo = money(summary.queueJumpFee);
    const garmentSubtotalKobo = money(
      summary.outfitTotal ??
        summary.subtotal ??
        (captureKobo - vatKobo - deliveryKobo - jumpFeeKobo) / 100,
    );
    let refund: ReturnType<typeof preActiveRefund>;
    try {
      refund = preActiveRefund({
        captureKobo,
        vatKobo,
        deliveryKobo,
        jumpFeeKobo,
        garmentSubtotalKobo,
      });
    } catch {
      throw new ConflictException(
        'CUSTOM_ORDER_REFUND_SNAPSHOT_REQUIRES_REVIEW',
      );
    }
    return {
      currency: order.currency,
      captureAmount: captureKobo / 100,
      capturedAmount: captureKobo / 100,
      garmentSubtotal: garmentSubtotalKobo / 100,
      vatAmount: vatKobo / 100,
      vatWithheld: vatKobo / 100,
      deliveryAmount: deliveryKobo / 100,
      deliveryRefund: deliveryKobo / 100,
      jumpFeeAmount: jumpFeeKobo / 100,
      garmentCharge: refund.systemChargeKobo / 100,
      garmentFeeWithheld: refund.systemChargeKobo / 100,
      jumpCharge: refund.jumpChargeKobo / 100,
      jumpFeeWithheld: refund.jumpChargeKobo / 100,
      withheldAmount: refund.withheldKobo / 100,
      totalWithheld: refund.withheldKobo / 100,
      refundAmount: refund.refundKobo / 100,
      orderRevision: order.orderRevision,
    };
  }

  async refundQuote(userId: string, id: string) {
    const order = await this.assertParticipant(userId, id);
    if (!order.lane || !WAITING.includes(order.lane))
      throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
    return this.quoteWithSettlement(order);
  }

  async quoteWithSettlement(order: Prisma.CustomOrderGetPayload<object>) {
    const quote = this.quote(order);
    const attempt = order.paymentReference
      ? await this.prisma.paymentAttempt.findUnique({
          where: { reference: order.paymentReference },
          include: { exchangeRateSnapshot: true },
        })
      : await this.prisma.paymentAttempt.findFirst({
          where: { customOrderId: order.id, status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          include: { exchangeRateSnapshot: true },
        });
    const previous = attempt
      ? await this.prisma.customOrderQueueRefund.findMany({
          where: { paymentAttemptId: attempt.id },
          select: { amount: true, breakdownJson: true },
        })
      : [];
    return {
      ...quote,
      settlement: attempt
        ? refundSettlement(attempt, quote.refundAmount, previous)
        : {
            status: 'REQUIRES_RECONCILIATION' as const,
            reason: 'REFUND_CAPTURE_MISSING',
          },
      settlementIsEstimate: true,
    };
  }

  private async settlementForRequest(
    tx: Tx,
    attempt: Prisma.PaymentAttemptGetPayload<{
      include: { exchangeRateSnapshot: true };
    }>,
    amount: number,
  ) {
    const previous = await tx.customOrderQueueRefund.findMany({
      where: { paymentAttemptId: attempt.id },
      select: { amount: true, breakdownJson: true },
    });
    return refundSettlement(attempt, amount, previous);
  }

  async cancel(
    userId: string | undefined,
    id: string,
    reason: string,
    expectedRevision?: number,
    actorType?: CustomOrderActorType,
  ) {
    await this.cancelCommand(userId, id, reason, expectedRevision, actorType);
    return { queue: (await this.present([id]))[id] };
  }

  private async cancelCommand(
    userId: string | undefined,
    id: string,
    reason: string,
    expectedRevision?: number,
    actorType?: CustomOrderActorType,
  ) {
    const source =
      actorType === 'SYSTEM' || actorType === 'ADMIN'
        ? await this.prisma.customOrder.findUniqueOrThrow({ where: { id } })
        : await this.assertParticipant(userId!, id, true);
    const actor = actorType ?? (source.buyerId === userId ? 'BUYER' : 'BRAND');
    await this.prisma.$transaction(
      async (tx) => {
        // Parent capture first, then brand: matches payment finalization lock order.
        await this.lockCapture(tx, source);
        const now = await this.lockBrand(tx, source.brandId);
        const current = await loadQueueCancellationOrder(tx, id);
        if (!current) throw new NotFoundException('Custom order not found');
        if (current.cancelledAt) return;
        if (
          actor === 'SYSTEM' &&
          (!current.queueExpiresAt ||
            current.queueExpiresAt > now ||
            !current.lane ||
            !WAITING.includes(current.lane))
        )
          return;
        this.checkRevision(current.orderRevision, expectedRevision);
        await this.cancelLocked(
          tx,
          current,
          now,
          reason,
          actor,
          userId,
          current.brandOwnerId,
        );
        await this.drain(tx, current.brandId, now);
      },
      { timeout: 15000 },
    );
    if (actor === 'BRAND') await this.flagMassCancellation(source.brandId);
  }

  async requestCancellationInTransaction(
    tx: Tx,
    id: string,
    reason: string,
    actor: CustomOrderActorType,
    actorId?: string,
  ) {
    const source = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    await this.lockCapture(tx, source);
    const now = await this.lockBrand(tx, source.brandId);
    const current = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    if (!current.cancelledAt)
      await this.cancelLocked(tx, current, now, reason, actor, actorId);
    await this.drain(tx, current.brandId, now);
    return tx.customOrderQueueRefund.findFirstOrThrow({
      where: { customOrderId: id, kind: 'CANCELLATION' },
    });
  }

  private async lockCapture(
    tx: Tx,
    source: { id: string; paymentReference: string | null },
  ) {
    if (source.paymentReference)
      await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "reference" = ${source.paymentReference} FOR UPDATE`;
    else
      await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "customOrderId" = ${source.id}::uuid AND "status" = 'PAID' ORDER BY "createdAt" DESC LIMIT 1 FOR UPDATE`;
  }

  async requestFullRefundInTransaction(
    tx: Tx,
    id: string,
    reason: string,
    actor: CustomOrderActorType,
    actorId?: string,
  ) {
    const source = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    const attempt = source.paymentReference
      ? await tx.paymentAttempt.findUnique({
          where: { reference: source.paymentReference },
          include: { exchangeRateSnapshot: true },
        })
      : await tx.paymentAttempt.findFirst({
          where: { customOrderId: id, status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          include: { exchangeRateSnapshot: true },
        });
    if (!attempt)
      throw new ConflictException('CUSTOM_ORDER_CAPTURE_REQUIRES_REVIEW');
    await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
    const now = await this.lockBrand(tx, source.brandId);
    const order = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    const existing = await tx.customOrderQueueRefund.findFirst({
      where: { customOrderId: id, kind: 'CANCELLATION' },
    });
    if (existing) return existing;
    if (
      order.paymentStatus !== 'PAID' ||
      !['PAID', 'PARTIALLY_REFUNDED'].includes(attempt.status) ||
      attempt.currency !== order.currency
    )
      throw new ConflictException('CUSTOM_ORDER_CAPTURE_REQUIRES_REVIEW');
    if (order.lane && WAITING.includes(order.lane)) {
      await this.cancelLocked(tx, order, now, reason, actor, actorId);
      await this.drain(tx, order.brandId, now);
      return tx.customOrderQueueRefund.findFirstOrThrow({
        where: { customOrderId: id, kind: 'CANCELLATION' },
      });
    }
    const previous = await tx.customOrderQueueRefund.aggregate({
      where: { customOrderId: id },
      _sum: { amount: true },
    });
    const captureKobo =
      money(object(order.buyerPriceSummaryJson).grandTotal) -
      money(previous._sum.amount);
    if (captureKobo <= 0)
      throw new ConflictException(
        'CUSTOM_ORDER_REFUND_SNAPSHOT_REQUIRES_REVIEW',
      );
    const reserved = await tx.customOrderQueueRefund.aggregate({
      where: { paymentAttemptId: attempt.id },
      _sum: { amount: true },
    });
    if (money(reserved._sum.amount) + captureKobo > money(attempt.amount))
      throw new ConflictException('CUSTOM_ORDER_REFUND_EXCEEDS_CAPTURE');
    const allocations = await tx.customOrderLedgerAllocation.findMany({
      where: {
        customOrderId: id,
        allocationType: { not: 'PLACEMENT_CAPTURE' },
      },
    });
    const released = allocations.filter(
      (row) =>
        ['PAYOUT_ELIGIBLE', 'PAID_OUT'].includes(row.status) ||
        row.eligibleAt ||
        row.paidOutAt,
    );
    const releasedNet = released.reduce(
      (sum, row) => sum + money(row.netBrandAmount),
      0,
    );
    const releasedCommission = released.reduce(
      (sum, row) => sum + money(row.commissionAmount),
      0,
    );
    const unreleasedGross = captureKobo - releasedNet - releasedCommission;
    if (unreleasedGross < 0 || (releasedNet > 0 && !this.brandBalance))
      throw new ConflictException(
        'CUSTOM_ORDER_REFUND_RELEASE_RECONCILIATION_REQUIRED',
      );
    const settlement = await this.settlementForRequest(
      tx,
      attempt,
      captureKobo / 100,
    );
    const breakdown = {
      settlement,
      refundKind: 'POST_ACTIVE_FULL',
      currency: order.currency,
      captureAmount: captureKobo / 100,
      refundAmount: captureKobo / 100,
      vatAmount: 0,
      garmentCharge: 0,
      jumpCharge: 0,
      releasedNet: releasedNet / 100,
      releasedCommission: releasedCommission / 100,
      unreleasedGross: unreleasedGross / 100,
      actorId: actorId ?? null,
    };
    const refund = await tx.customOrderQueueRefund.create({
      data: {
        requestKey: `custom-order:${id}:cancellation`,
        customOrderId: id,
        paymentAttemptId: attempt.id,
        amount: captureKobo / 100,
        currency: order.currency,
        breakdownJson: breakdown,
      },
    });
    await reserveFullOrderRefund(tx, this.ledger, {
      id: refund.id,
      customOrderId: id,
      brandId: order.brandId,
      ...breakdown,
    });
    await this.recordRefundDebt(
      tx,
      order.brandId,
      id,
      refund.id,
      releasedNet / 100,
      order.currency,
      reason,
    );
    await tx.customOrderLedgerAllocation.updateMany({
      where: {
        customOrderId: id,
        status: { in: ['HELD', 'PAYOUT_ELIGIBLE', 'PAID_OUT'] },
      },
      data: { status: 'REVERSED', reversedAt: now, reversalReason: reason },
    });
    await tx.customOrder.update({
      where: { id },
      data: {
        lane: 'TERMINAL',
        status: 'REFUND_IN_PROGRESS',
        cancelledAt: now,
        cancellationReason: reason,
        cancellationActorType: actor,
        orderRevision: { increment: 1 },
      },
    });
    await this.invalidateReminders(tx, id);
    await this.record(
      tx,
      order,
      'ORDER_REFUND_REQUESTED',
      `An order-scoped refund of ${order.currency} ${(captureKobo / 100).toFixed(2)} has been reserved. Provider confirmation is pending.`,
      actor,
      actorId,
    );
    await this.drain(tx, order.brandId, now);
    return refund;
  }

  async requestPartialRefundInTransaction(
    tx: Tx,
    id: string,
    amount: number,
    disputeId: string,
    reason: string,
    actorId: string,
  ) {
    const source = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    await this.lockCapture(tx, source);
    const now = await this.lockBrand(tx, source.brandId);
    const requestKey = `custom-order:${id}:dispute:${disputeId}`;
    const existing = await tx.customOrderQueueRefund.findUnique({
      where: { requestKey },
    });
    if (existing) return existing;
    const order = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    const attempt = order.paymentReference
      ? await tx.paymentAttempt.findUnique({
          where: { reference: order.paymentReference },
          include: { exchangeRateSnapshot: true },
        })
      : await tx.paymentAttempt.findFirst({
          where: { customOrderId: id, status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          include: { exchangeRateSnapshot: true },
        });
    if (
      !attempt ||
      attempt.currency !== order.currency ||
      !['PAID', 'PARTIALLY_REFUNDED'].includes(attempt.status) ||
      order.paymentStatus !== 'PAID' ||
      order.cancelledAt ||
      !['ACTIVE', 'IN_DELIVERY'].includes(order.lane ?? '')
    )
      throw new ConflictException('CUSTOM_ORDER_PARTIAL_REFUND_NOT_AVAILABLE');
    const previous = await tx.customOrderQueueRefund.aggregate({
      where: { customOrderId: id },
      _sum: { amount: true },
    });
    const remaining =
      money(object(order.buyerPriceSummaryJson).grandTotal) -
      money(previous._sum.amount);
    const refundCents = money(amount);
    if (refundCents <= 0 || refundCents >= remaining)
      throw new BadRequestException(
        'Partial refund must be positive and less than the order remaining refundable amount',
      );
    const parentReserved = await tx.customOrderQueueRefund.aggregate({
      where: { paymentAttemptId: attempt.id },
      _sum: { amount: true },
    });
    if (money(parentReserved._sum.amount) + refundCents > money(attempt.amount))
      throw new ConflictException('CUSTOM_ORDER_REFUND_EXCEEDS_CAPTURE');
    const allocations = await tx.customOrderLedgerAllocation.findMany({
      where: {
        customOrderId: id,
        allocationType: { not: 'PLACEMENT_CAPTURE' },
        status: { in: ['HELD', 'PAYOUT_ELIGIBLE', 'PAID_OUT'] },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const reductions = allocatePartialRefund(
      allocations,
      refundCents,
      remaining,
    );
    const releasedNet = reductions
      .filter((row) => row.released)
      .reduce((sum, row) => sum + row.refundNet, 0);
    const releasedCommission = reductions
      .filter((row) => row.released)
      .reduce((sum, row) => sum + row.refundCommission, 0);
    const refundId = randomUUID();
    const settlement = await this.settlementForRequest(tx, attempt, amount);
    const breakdown = {
      refundKind: 'POST_ACTIVE_PARTIAL',
      disputeId,
      reservationKey: `ledger:custom-order:${id}:partial-refund:${refundId}:reserved`,
      currency: order.currency,
      captureAmount: amount,
      refundAmount: amount,
      vatAmount: 0,
      garmentCharge: 0,
      jumpCharge: 0,
      releasedNet: releasedNet / 100,
      releasedCommission: releasedCommission / 100,
      unreleasedGross: (refundCents - releasedNet - releasedCommission) / 100,
      settlement,
      reductions,
    };
    const refund = await tx.customOrderQueueRefund.create({
      data: {
        id: refundId,
        requestKey,
        kind: 'PARTIAL',
        customOrderId: id,
        paymentAttemptId: attempt.id,
        amount,
        currency: order.currency,
        breakdownJson: breakdown,
      },
    });
    await reserveFullOrderRefund(tx, this.ledger, {
      id: refund.id,
      customOrderId: id,
      brandId: order.brandId,
      ...breakdown,
    });
    for (const reduction of reductions)
      await tx.customOrderLedgerAllocation.update({
        where: { id: reduction.id },
        data: {
          amount: reduction.amount,
          netBrandAmount: reduction.netBrandAmount,
          commissionAmount: reduction.commissionAmount,
        },
      });
    await this.recordRefundDebt(
      tx,
      order.brandId,
      id,
      refund.id,
      releasedNet / 100,
      order.currency,
      reason,
    );
    await tx.customOrder.update({
      where: { id },
      data: { orderRevision: { increment: 1 } },
    });
    await this.record(
      tx,
      order,
      'ORDER_PARTIAL_REFUND_REQUESTED',
      `An agreed partial refund of ${order.currency} ${amount.toFixed(2)} has been reserved. Your order continues in its existing fulfilment stage; provider processing is separate.`,
      'ADMIN',
      actorId,
    );
    return refund;
  }

  /** One immutable clawback row per refund; replays converge on its source key. */
  private async recordRefundDebt(
    tx: Tx,
    brandId: string,
    customOrderId: string,
    refundId: string,
    amount: number,
    currency: string,
    reason: string,
  ) {
    if (amount <= 0) return;
    if (!this.brandBalance)
      throw new ConflictException(
        'CUSTOM_ORDER_REFUND_RELEASE_RECONCILIATION_REQUIRED',
      );
    await this.brandBalance.raiseAdjustment(tx, {
      brandId,
      customOrderId,
      type: 'REFUND_CLAWBACK',
      amount: amount.toFixed(2),
      currency,
      reason: `Order refund reserved (${reason})`,
      sourceKey: `custom-order-refund:${refundId}`,
    });
  }

  private async cancelLocked(
    tx: Tx,
    order: QueueCancellationOrder,
    now: Date,
    reason: string,
    actor: CustomOrderActorType,
    actorId?: string,
    knownBrandOwnerId?: string,
  ) {
    if (
      !order.lane ||
      !WAITING.includes(order.lane) ||
      order.paymentStatus !== 'PAID'
    )
      throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
    const quote = this.quote(order);
    const attempt = order.paymentReference
      ? await tx.paymentAttempt.findUnique({
          where: { reference: order.paymentReference },
          include: { exchangeRateSnapshot: true },
        })
      : await tx.paymentAttempt.findFirst({
          where: { customOrderId: order.id, status: 'PAID' },
          orderBy: { createdAt: 'desc' },
          include: { exchangeRateSnapshot: true },
        });
    if (
      !attempt ||
      attempt.currency !== order.currency ||
      !['PAID', 'PARTIALLY_REFUNDED'].includes(attempt.status)
    )
      throw new ConflictException('CUSTOM_ORDER_CAPTURE_REQUIRES_REVIEW');
    await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
    const existing = await tx.customOrderQueueRefund.aggregate({
      where: { paymentAttemptId: attempt.id },
      _sum: { amount: true },
    });
    if (
      money(existing._sum.amount) + money(quote.refundAmount) >
      money(attempt.amount)
    )
      throw new ConflictException('CUSTOM_ORDER_REFUND_EXCEEDS_CAPTURE');
    await tx.customOrderQueueRefund.create({
      data: {
        requestKey: `custom-order:${order.id}:cancellation`,
        customOrderId: order.id,
        paymentAttemptId: attempt.id,
        amount: quote.refundAmount,
        currency: order.currency,
        breakdownJson: {
          ...quote,
          settlement: await this.settlementForRequest(
            tx,
            attempt,
            quote.refundAmount,
          ),
        },
      },
    });
    await tx.customOrder.update({
      where: { id: order.id },
      data: {
        lane: 'TERMINAL',
        status: 'REFUND_IN_PROGRESS',
        cancelledAt: now,
        cancellationReason: reason,
        cancellationActorType: actor,
        orderRevision: { increment: 1 },
        adminPromotionHeld: false,
      },
    });
    await tx.customOrderLedgerAllocation.updateMany({
      where: { customOrderId: order.id, allocationType: 'PLACEMENT_CAPTURE' },
      data: { status: 'REVERSED', reversedAt: now, reversalReason: reason },
    });
    await this.invalidateReminders(tx, order.id);
    await this.record(
      tx,
      order,
      'QUEUE_CANCELLED',
      `Your waiting custom order was cancelled. Refund requested: ${order.currency} ${quote.refundAmount.toFixed(2)}. VAT ${quote.vatAmount.toFixed(2)}, garment charge ${quote.garmentCharge.toFixed(2)}, and priority charge ${quote.jumpCharge.toFixed(2)} are retained; delivery is refunded in full.`,
      actor,
      actorId,
      knownBrandOwnerId,
    );
  }

  async cancelMany(
    userId: string,
    brandId: string,
    ids: string[],
    reason: string,
  ) {
    await this.permissions.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.ORDERS_UPDATE,
    );
    const orders = await this.prisma.customOrder.findMany({
      where: { id: { in: ids }, brandId },
      select: { id: true },
    });
    if (orders.length !== new Set(ids).size)
      throw new NotFoundException(
        'One or more orders do not belong to this brand',
      );
    const results: Array<{ id: string; cancelled: boolean; message?: string }> =
      [];
    for (const row of orders) {
      try {
        await this.cancelCommand(userId, row.id, reason);
        results.push({ id: row.id, cancelled: true });
      } catch (error) {
        results.push({
          id: row.id,
          cancelled: false,
          message: error instanceof Error ? error.message : 'Unable to cancel',
        });
      }
    }
    return { results };
  }

  private async flagMassCancellation(brandId: string) {
    const count = await this.prisma.customOrder.count({
      where: {
        brandId,
        cancellationActorType: 'BRAND',
        cancelledAt: { gte: new Date(Date.now() - 86400000) },
      },
    });
    if (count <= 5) return;
    const claimed = await this.prisma.brand.updateMany({
      where: {
        id: brandId,
        OR: [
          { massCancelAttentionAt: null },
          { massCancelAttentionAt: { lt: new Date(Date.now() - 86400000) } },
        ],
      },
      data: {
        massCancelAttentionAt: new Date(),
        massCancelAttentionReason: `${count} waiting orders cancelled by this brand within 24 hours`,
      },
    });
    if (!claimed.count) return;
    await this.prisma.operationalAlert.create({
      data: {
        category: 'CUSTOM_ORDER_QUEUE',
        severity: 'WARNING',
        event: 'BRAND_MASS_CANCEL',
        message: `Brand ${brandId}: ${count} waiting custom orders cancelled within 24 hours`,
      },
    });
    const order = await this.prisma.customOrder.findFirst({
      where: { brandId, cancelledAt: { not: null } },
      orderBy: { cancelledAt: 'desc' },
      select: { id: true },
    });
    const admins = await getCachedActiveAdminIds(this.prisma);
    if (order && admins.length)
      await this.prisma.customOrderNotificationOutbox.createMany({
        data: admins.map((recipientId) => ({
          customOrderId: order.id,
          recipientId,
          notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
          payloadJson: {
            customOrderId: order.id,
            stage: 'BRAND_MASS_CANCEL',
            message: `Brand ${brandId} cancelled ${count} waiting orders within 24 hours. Review is required; intake has not been suspended automatically.`,
            targetUrl: `/admin/custom-orders?brandId=${brandId}`,
          },
          targetJson: { type: 'CUSTOM_ORDER', id: order.id },
        })),
      });
  }

  async resubmit(userId: string, id: string) {
    const order = await this.prisma.customOrder.findFirst({
      where: { id, buyerId: userId },
      include: { queueRefunds: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    if (!order?.cancelledAt)
      throw new NotFoundException('Cancelled order not found');
    await this.assertIntake(userId, order.brandId);
    return {
      sourceType: order.sourceType,
      sourceId: order.sourceId,
      configurationId: order.configurationId,
      previousOrderId: id,
      refundPending: order.queueRefunds.some(
        (refund) => refund.status !== 'SETTLED',
      ),
      requiresNewPayment: true,
    };
  }

  async reorder(
    id: string,
    action: 'promote' | 'demote' | 'release-hold',
    actorId: string,
    reason: string,
    expectedRevision?: number,
  ) {
    const source = await this.prisma.customOrder.findUniqueOrThrow({
      where: { id },
    });
    await this.prisma.$transaction(async (tx) => {
      const now = await this.lockBrand(tx, source.brandId);
      const row = await tx.customOrder.findUniqueOrThrow({ where: { id } });
      this.checkRevision(row.orderRevision, expectedRevision);
      if (
        !row.lane ||
        !WAITING.includes(row.lane) ||
        !row.queueExpiresAt ||
        row.queueExpiresAt <= now
      )
        throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
      if (action === 'release-hold')
        await tx.customOrder.update({
          where: { id },
          data: { adminPromotionHeld: false, orderRevision: { increment: 1 } },
        });
      else if (action === 'promote') {
        await tx.customOrder.updateMany({
          where: { brandId: row.brandId, lane: 'UP_NEXT', id: { not: id } },
          data: { lane: 'PENDING', orderRevision: { increment: 1 } },
        });
        await tx.customOrder.update({
          where: { id },
          data: {
            lane: 'UP_NEXT',
            adminPromotionHeld: false,
            orderRevision: { increment: 1 },
          },
        });
      } else {
        if (row.lane !== 'UP_NEXT')
          throw new ConflictException('Only Up Next can be demoted');
        const candidate = await tx.customOrder.findFirst({
          where: {
            brandId: row.brandId,
            lane: 'PENDING',
            adminPromotionHeld: false,
            queueExpiresAt: { gt: now },
          },
          orderBy: [{ queuePriority: 'desc' }, { queuePosition: 'asc' }],
        });
        await tx.customOrder.update({
          where: { id },
          data: {
            lane: 'PENDING',
            adminPromotionHeld: !candidate,
            orderRevision: { increment: 1 },
          },
        });
        if (candidate)
          await tx.customOrder.update({
            where: { id: candidate.id },
            data: { lane: 'UP_NEXT', orderRevision: { increment: 1 } },
          });
      }
      await this.record(
        tx,
        row,
        `ADMIN_QUEUE_${action.toUpperCase()}`,
        `An admin updated this order's queue placement (${action}). ${reason}`,
        'ADMIN',
        actorId,
      );
      await this.audit(tx, actorId, `queue.${action}`, id, { reason });
      await this.drain(tx, row.brandId, now);
    });
    return { queue: (await this.present([id]))[id] };
  }

  async audit(
    tx: Tx,
    actorId: string,
    operation: string,
    targetId: string,
    metadata: Record<string, unknown>,
  ) {
    await tx.adminAuditLog.create({
      data: {
        id: randomUUID(),
        actorUserId: actorId,
        action: AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE,
        targetType: operation,
        targetId,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }

  async settings(userId: string, brandId: string, enabled: boolean) {
    await this.permissions.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.SETTINGS_UPDATE,
    );
    await this.prisma.$transaction(async (tx) => {
      const now = await this.lockBrand(tx, brandId);
      const cap = await this.capacity(tx, brandId, now);
      if (enabled && !cap.queueJumpAllowed)
        throw new ForbiddenException(
          'Paid queue priority is available only on Aru and Igwe',
        );
      await tx.brand.update({
        where: { id: brandId },
        data: { queueJumpEnabled: enabled },
      });
    });
    return this.summary(brandId);
  }

  async notices(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { type: true },
    });
    const now = new Date();
    const notices =
      user?.type === 'BRAND'
        ? await this.prisma.runwayBrandNotice.findMany({
            where: {
              publishedAt: { not: null },
              endedAt: null,
              startsAt: { lte: now },
              endsAt: { gt: now },
            },
            orderBy: { publishedAt: 'desc' },
            take: 1,
          })
        : [];
    return { notices, serverNow: now.toISOString() };
  }

  async sweep() {
    const due = await this.prisma.customOrder.findMany({
      where: {
        lane: { in: WAITING },
        queueExpiresAt: { lte: new Date() },
        ...(this.expiryCursor
          ? {
              OR: [
                { queueExpiresAt: { gt: this.expiryCursor.at } },
                {
                  queueExpiresAt: this.expiryCursor.at,
                  id: { gt: this.expiryCursor.id },
                },
              ],
            }
          : {}),
      },
      orderBy: [{ queueExpiresAt: 'asc' }, { id: 'asc' }],
      take: 100,
      select: { id: true, queueExpiresAt: true },
    });
    for (const row of due) {
      try {
        await this.cancelCommand(
          undefined,
          row.id,
          'Waiting period expired after 42 days',
          undefined,
          'SYSTEM',
        );
      } catch (error) {
        this.logger.error(
          `Queue expiry requires review for ${row.id}: ${error instanceof Error ? error.message : 'Unknown failure'}`,
        );
      }
    }
    const last = due.at(-1);
    this.expiryCursor =
      due.length === 100 && last?.queueExpiresAt
        ? { at: last.queueExpiresAt, id: last.id }
        : null;
    const brands = await this.prisma.$queryRaw<
      Array<{ brandId: string }>
    >`SELECT DISTINCT "brandId" FROM "CustomOrder" WHERE "lane" IN ('PENDING','UP_NEXT') AND "brandId"::text > ${this.brandCursor} ORDER BY "brandId" LIMIT 100`;
    for (const row of brands) {
      try {
        await this.prisma.$transaction(async (tx) => {
          const now = await this.lockBrand(tx, row.brandId);
          await this.drain(tx, row.brandId, now);
        });
      } catch (error) {
        this.logger.error(
          `Queue promotion requires review for brand ${row.brandId}: ${error instanceof Error ? error.message : 'Unknown failure'}`,
        );
      }
    }
    this.brandCursor =
      brands.length === 100 ? brands[brands.length - 1].brandId : '';
  }
}
