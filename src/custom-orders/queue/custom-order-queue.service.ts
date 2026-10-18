import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { AdminAuditAction, CustomOrderActorType, CustomOrderLane, CustomOrderLedgerAllocationStatus, CustomOrderLedgerAllocationType, CustomOrderStatus, LedgerAccountType, LedgerEntryDirection, LedgerTransactionType, NotificationType, Prisma, Role } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';
import { CustomOrderFinanceSyncService } from 'src/finance/custom-order-finance-sync.service';
import { LedgerService } from 'src/finance/ledger.service';
import { canRetainPosition, preActiveRefund, QUEUE_WAIT_MS, RETAIN_CLOSE_MS, RETAIN_OPEN_MS, retainedExpiry, selectQueueCandidate } from './subscription-queue.policy';
import { getCachedActiveAdminIds } from '../custom-order-admin-attention';

type Tx = Prisma.TransactionClient;
const WAITING: CustomOrderLane[] = ['PENDING', 'UP_NEXT'];
const reminderStages = [48, 24, 5].map(hours => `QUEUE_EXPIRY_${hours}`);
const money = (value: unknown) => {
  const amount = Number(value ?? 0);
  if (!Number.isFinite(amount) || amount < 0 || !Number.isSafeInteger(Math.round(amount * 100))) throw new BadRequestException('CUSTOM_ORDER_INVALID_MONEY_SNAPSHOT');
  return Math.round(amount * 100);
};
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

@Injectable()
export class CustomOrderQueueService {
  private readonly logger = new Logger(CustomOrderQueueService.name);
  private brandCursor = '';
  private expiryCursor: { at: Date; id: string } | null = null;
  constructor(private readonly prisma: PrismaService, private readonly permissions: BrandPermissionService, private readonly finance: CustomOrderFinanceSyncService, private readonly ledger: LedgerService) {}

  async lockBrand(tx: Tx, brandId: string): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT "_id" AS id FROM "Brand" WHERE "_id" = ${brandId}::uuid FOR UPDATE`;
    if (!rows.length) throw new NotFoundException('Brand not found');
    const clock = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
    return clock[0].now;
  }

  async capacity(tx: Tx | PrismaService, brandId: string, now = new Date()) {
    const brand = await tx.brand.findUnique({ where: { id: brandId }, include: { owner: { select: { id: true, status: true } } } });
    if (!brand) throw new NotFoundException('Brand not found');
    const agreement = await tx.brandSubscription.findFirst({ where: { brandId, status: { in: ['ACTIVE', 'PAST_DUE', 'CANCELLED'] } }, orderBy: { createdAt: 'desc' }, include: { tier: true } });
    const tier = agreement?.tier ?? await tx.subscriptionTier.findUnique({ where: { key: brand.customOrderLegacyEligible ? 'LEGACY' : 'THREAD' } });
    if (!tier) throw new ConflictException('CUSTOM_ORDER_TIER_CONFIGURATION_MISSING');
    const campaign = await tx.capacityCampaign.findFirst({ where: { startsAt: { lte: now }, resetAt: null, OR: [{ resetMode: 'MANUAL' }, { endsAt: { gt: now } }] }, orderBy: { startsAt: 'desc' } });
    const override = brand.activeOrderCapOverride !== null && (!brand.activeOrderCapOverrideUntil || brand.activeOrderCapOverrideUntil > now) ? brand.activeOrderCapOverride : null;
    const active = override ?? (tier.maxActive === null ? null : Math.max(0, tier.maxActive + (campaign?.deltaActive ?? 0)));
    const safetyAllowed = brand.verificationStatus === 'APPROVED' && brand.owner.status === 'ACTIVE';
    const entitled = brand.customOrderLegacyEligible || Boolean(agreement?.status === 'ACTIVE' && agreement.currentPeriodEnd > now);
    return { brand, agreement, tierKey: tier.key, active, inDelivery: tier.maxInDelivery, queueJumpAllowed: ['ARU', 'IGWE'].includes(tier.key) && tier.queueJumpAllowed, intakeAllowed: entitled && safetyAllowed && !brand.customOrderIntakeBlockedAt, safetyAllowed };
  }

  async assertIntake(buyerId: string, brandId: string, tx: Tx | PrismaService = this.prisma) {
    const [buyer, cap] = await Promise.all([tx.user.findUnique({ where: { id: buyerId }, select: { type: true, status: true } }), this.capacity(tx, brandId)]);
    if (!buyer || buyer.type !== 'REGULAR' || buyer.status !== 'ACTIVE' || cap.brand.ownerId === buyerId) throw new ForbiddenException('Only an eligible shopper may order from this brand');
    if (!cap.intakeAllowed) throw new ForbiddenException('CUSTOM_ORDER_INTAKE_UNAVAILABLE');
    return cap;
  }

  async summary(brandId: string, buyerId?: string) {
    const [cap, counts, openOrderCount] = await Promise.all([this.capacity(this.prisma, brandId), this.prisma.customOrder.groupBy({ by: ['lane'], where: { brandId, lane: { not: null } }, _count: true }), buyerId ? this.prisma.customOrder.count({ where: { brandId, buyerId, lane: { in: ['PENDING', 'UP_NEXT', 'ACTIVE', 'IN_DELIVERY'] } } }) : Promise.resolve(0)]);
    const lanes = { PENDING: 0, UP_NEXT: 0, ACTIVE: 0, IN_DELIVERY: 0 };
    counts.forEach(row => { if (row.lane && row.lane in lanes) lanes[row.lane as keyof typeof lanes] = row._count; });
    return { brandId, counts: lanes, capacity: { tierKey: cap.tierKey, active: cap.active, inDelivery: cap.inDelivery, queueJumpAllowed: cap.queueJumpAllowed }, queueJumpEnabled: cap.brand.queueJumpEnabled, jumpAvailable: cap.queueJumpAllowed && cap.brand.queueJumpEnabled && cap.intakeAllowed && (lanes.PENDING + lanes.UP_NEXT > 0 || cap.active !== null && lanes.ACTIVE >= cap.active), intakeAllowed: cap.intakeAllowed, intakeBlocked: Boolean(cap.brand.customOrderIntakeBlockedAt), ...(buyerId && buyerId !== cap.brand.ownerId ? {} : { intakeBlockReason: cap.brand.customOrderIntakeBlockReason, activeOrderCapOverride: cap.brand.activeOrderCapOverride, activeOrderCapOverrideUntil: cap.brand.activeOrderCapOverrideUntil, massCancelAttentionAt: cap.brand.massCancelAttentionAt, assignedTierKey: cap.brand.assignedSubscriptionTierKey }), openOrderCount, buyerOpenOrderCount: openOrderCount, serverNow: new Date().toISOString() };
  }

  private async assertParticipant(userId: string, orderId: string, write = false) {
    const order = await this.prisma.customOrder.findUnique({ where: { id: orderId } });
    if (!order) throw new NotFoundException('Custom order not found');
    if (order.buyerId === userId) return order;
    await this.permissions.assertPermission(userId, order.brandId, write ? BRAND_PERMISSIONS.ORDERS_UPDATE : BRAND_PERMISSIONS.ORDERS_READ);
    return order;
  }

  async get(userId: string, orderId: string) { await this.assertParticipant(userId, orderId); return (await this.present([orderId]))[orderId]; }

  async batch(userId: string, orderIds: string[]) {
    const ids = [...new Set(orderIds)];
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { type: true } });
    const rows = await this.prisma.customOrder.findMany({ where: { id: { in: ids } }, select: { id: true, buyerId: true, brandId: true } });
    if (user?.type === 'REGULAR') {
      if (rows.some(row => row.buyerId !== userId)) throw new ForbiddenException('Not authorized for these orders');
    } else {
      for (const brandId of new Set(rows.map(row => row.brandId))) await this.permissions.assertPermission(userId, brandId, BRAND_PERMISSIONS.ORDERS_READ);
    }
    return { orders: await this.present(rows.map(row => row.id)), serverNow: new Date().toISOString() };
  }

  async present(ids: string[], tx: Tx | PrismaService = this.prisma) {
    if (!ids.length) return {};
    const rows = await tx.customOrder.findMany({ where: { id: { in: ids.slice(0, 100) } }, include: { queueRefund: true } });
    const brands = [...new Set(rows.map(row => row.brandId))];
    const ranks = brands.length ? await tx.$queryRaw<Array<{ id: string; position: bigint; waitingCount: bigint }>>(Prisma.sql`SELECT "id", ROW_NUMBER() OVER (PARTITION BY "brandId" ORDER BY CASE WHEN "lane" = 'UP_NEXT' THEN 0 ELSE 1 END, "queuePriority" DESC, "queuePosition" ASC NULLS LAST, "queuedAt", "id") AS position, COUNT(*) OVER (PARTITION BY "brandId") AS "waitingCount" FROM "CustomOrder" WHERE "brandId" IN (${Prisma.join(brands.map(id => Prisma.sql`${id}::uuid`))}) AND "lane" IN ('PENDING','UP_NEXT')`) : [];
    const byId = new Map(ranks.map(row => [row.id, row]));
    const now = new Date();
    return Object.fromEntries(rows.map(row => {
      const waiting = row.lane !== null && WAITING.includes(row.lane);
      const rank = byId.get(row.id);
      return [row.id, { lane: row.lane, orderRevision: row.orderRevision, queueExpiresAt: row.queueExpiresAt?.toISOString() ?? null, serverNow: now.toISOString(), retainOpensAt: row.queueExpiresAt ? new Date(+row.queueExpiresAt - RETAIN_OPEN_MS).toISOString() : null, retainClosesAt: row.queueExpiresAt ? new Date(+row.queueExpiresAt - RETAIN_CLOSE_MS).toISOString() : null, canRetain: Boolean(waiting && row.queueExpiresAt && canRetainPosition({ now, queueExpiresAt: row.queueExpiresAt, retainCount: row.retainCount })), canCancel: waiting && row.paymentStatus === 'PAID', canResubmit: Boolean(row.cancelledAt), adminPromotionHeld: row.adminPromotionHeld, position: rank ? Number(rank.position) : null, waitingCount: rank ? Number(rank.waitingCount) : 0, activatedAt: row.activatedAt?.toISOString() ?? null, captureSummary: { amount: Number(object(row.buyerPriceSummaryJson).grandTotal ?? 0), currency: row.currency, held: waiting, heldAmount: waiting ? Number(object(row.buyerPriceSummaryJson).grandTotal ?? 0) : 0, status: row.queueRefund ? (row.queueRefund.status === 'SETTLED' ? 'REFUNDED' : 'REFUND_PROCESSING') : waiting ? 'HELD' : 'RELEASED' }, refundSummary: row.queueRefund ? { id: row.queueRefund.id, status: row.queueRefund.status, amount: Number(row.queueRefund.amount), currency: row.queueRefund.currency, lastError: row.queueRefund.lastError } : null }];
    }));
  }

  private async invalidateReminders(tx: Tx, orderId: string) {
    await tx.customOrderNotificationOutbox.updateMany({ where: { customOrderId: orderId, status: { in: ['PENDING', 'FAILED'] }, OR: reminderStages.map(stage => ({ payloadJson: { path: ['stage'], equals: stage } })) }, data: { status: 'SKIPPED' } });
  }

  private async record(tx: Tx, order: { id: string; buyerId: string; brandId: string }, kind: string, message: string, actorType: CustomOrderActorType = 'SYSTEM', actorId?: string) {
    await tx.customOrderTimelineEvent.create({ data: { customOrderId: order.id, eventType: 'QUEUE_UPDATED', actorType, actorId, payloadJson: { kind, message } } });
    const brand = await tx.brand.findUnique({ where: { id: order.brandId }, select: { ownerId: true } });
    await tx.customOrderNotificationOutbox.createMany({ data: [...new Set([order.buyerId, brand?.ownerId].filter((id): id is string => Boolean(id)))].map(recipientId => ({ customOrderId: order.id, recipientId, actorId, notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED, payloadJson: { customOrderId: order.id, stage: kind, message, targetUrl: recipientId === order.buyerId ? `/profile?tab=orders&customOrderId=${order.id}` : `/studio/custom-orders/${order.id}` }, targetJson: { type: 'CUSTOM_ORDER', id: order.id }, dedupeMs: 0 })) });
  }

  private async schedule(tx: Tx, order: { id: string; buyerId: string; brandId: string; queueExpiresAt: Date | null }) {
    if (!order.queueExpiresAt) return;
    const brand = await tx.brand.findUnique({ where: { id: order.brandId }, select: { ownerId: true } });
    await tx.customOrderNotificationOutbox.createMany({ data: [48, 24, 5].flatMap(hours => [...new Set([order.buyerId, brand?.ownerId].filter((id): id is string => Boolean(id)))].map(recipientId => ({ customOrderId: order.id, recipientId, notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED, availableAt: new Date(+order.queueExpiresAt! - hours * 3600000), payloadJson: { customOrderId: order.id, stage: `QUEUE_EXPIRY_${hours}`, note: order.queueExpiresAt!.toISOString(), message: hours === 5 ? 'Your waiting custom order is scheduled to cancel in 5 hours. The retain window is closed. Cancellation deductions apply; delivery is refunded in full.' : `Your waiting custom order is scheduled to cancel in ${hours} hours. The shopper can retain the position once until 12 hours before expiry, adding 42 days to the current deadline.`, targetUrl: recipientId === order.buyerId ? `/profile?tab=orders&customOrderId=${order.id}` : `/studio/custom-orders/${order.id}` }, targetJson: { type: 'CUSTOM_ORDER', id: order.id }, dedupeMs: 0 }))) });
  }

  /** Called within every successful payment finalization transaction. */
  async admitPaid(tx: Tx, orderId: string) {
    let order = await tx.customOrder.findUniqueOrThrow({ where: { id: orderId } });
    const now = await this.lockBrand(tx, order.brandId);
    order = await tx.customOrder.findUniqueOrThrow({ where: { id: orderId } });
    if (order.lane !== null || order.paymentStatus !== 'PAID') return;
    const summary = object(order.buyerPriceSummaryJson);
    const jumpFee = Number(summary.queueJumpFee ?? 0);
    const max = await tx.customOrder.aggregate({ where: { brandId: order.brandId }, _max: { queuePosition: true } });
    order = await tx.customOrder.update({ where: { id: orderId }, data: { status: 'QUEUED', lane: 'PENDING', queuePosition: (max._max.queuePosition ?? 0) + 1, queuedAt: now, queueExpiresAt: new Date(+now + QUEUE_WAIT_MS), queuePolicyVersion: 1, queuePriority: jumpFee > 0 ? 1 : 0, jumpFeeAmount: jumpFee, acceptedAt: null, activatedAt: null, promisedProductionAt: null, promisedDispatchAt: null, promisedDeliveryAt: null, lastBrandProgressUpdateAt: null, currentProgressStage: 'ORDER_PLACED', orderRevision: { increment: 1 } } });
    await this.finance.applyPaidSettlement(tx, { customOrderId: order.id, brandId: order.brandId, grossAmount: Number(summary.grandTotal) - jumpFee, currency: order.currency, effectiveAt: now, releaseEligibleAt: now, queueHold: true });
    await this.record(tx, order, 'QUEUE_PLACED', 'Payment captured. Your custom order has entered the queue; its funds remain held until work becomes Active.');
    await this.schedule(tx, order);
    const cap = await this.capacity(tx, order.brandId, now);
    const buyer = await tx.user.findUnique({ where: { id: order.buyerId }, select: { type: true, status: true } });
    if (!cap.intakeAllowed || buyer?.type !== 'REGULAR' || buyer.status !== 'ACTIVE' || cap.brand.ownerId === order.buyerId || jumpFee > 0 && (!cap.queueJumpAllowed || !cap.brand.queueJumpEnabled)) {
      await this.cancelLocked(tx, order, now, 'Eligibility changed before payment finalization', 'SYSTEM');
      return;
    }
    await this.drain(tx, order.brandId, now);
  }

  async drain(tx: Tx, brandId: string, now: Date) {
    const cap = await this.capacity(tx, brandId, now);
    if (!cap.safetyAllowed) return;
    const ambiguous = await tx.customOrder.count({ where: { brandId, lane: null, status: { in: ['DISPUTED', 'DELIVERY_ISSUE_REPORTED'] } } });
    if (ambiguous) return;
    let active = await tx.customOrder.count({ where: { brandId, lane: 'ACTIVE' } });
    let streak = cap.brand.queuePriorityStreak;
    for (let turns = 0; turns < 50; turns++) {
      let up = await tx.customOrder.findFirst({ where: { brandId, lane: 'UP_NEXT' } });
      if (!up) {
        const [priority, ordinary] = await Promise.all([1, 0].map(queuePriority => tx.customOrder.findFirst({ where: { brandId, lane: 'PENDING', queuePriority, adminPromotionHeld: false, queueExpiresAt: { gt: now }, paymentStatus: 'PAID' }, orderBy: [{ queuePosition: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }] })));
        const candidate = selectQueueCandidate([priority, ordinary].filter((row): row is NonNullable<typeof row> => row !== null), streak);
        if (!candidate) break;
        up = await tx.customOrder.update({ where: { id: candidate.id }, data: { lane: 'UP_NEXT', orderRevision: { increment: 1 } } });
        await this.record(tx, up, 'QUEUE_UP_NEXT', 'Your custom order is Up Next. No additional garment payment is required.');
      }
      if (cap.active !== null && active >= cap.active || up.adminPromotionHeld || !up.queueExpiresAt || up.queueExpiresAt <= now) break;
      const production = new Date(+now + up.productionLeadDaysSnapshot * 86400000);
      const activated = await tx.customOrder.update({ where: { id: up.id }, data: { lane: 'ACTIVE', status: 'ACCEPTED', activatedAt: now, acceptedAt: now, queueExpiresAt: null, promisedProductionAt: production, promisedDispatchAt: production, promisedDeliveryAt: new Date(+production + up.deliveryMaxDaysSnapshot * 86400000), currentProgressStage: 'ORDER_RECEIVED', currentProgressStageEnteredAt: now, lastBrandProgressUpdateAt: now, orderRevision: { increment: 1 } } });
      await this.invalidateReminders(tx, up.id);
      await this.finance.applyPaidSettlement(tx, { customOrderId: up.id, brandId, grossAmount: Number(object(up.buyerPriceSummaryJson).grandTotal) - Number(up.jumpFeeAmount), currency: up.currency, effectiveAt: up.queuedAt ?? up.createdAt, releaseEligibleAt: now });
      if (Number(up.jumpFeeAmount) > 0) await this.releaseJump(tx, activated);
      await this.record(tx, activated, 'QUEUE_ACTIVE', 'Your custom order is now Active. Production dates start today; the brand acceptance portion is available under the settlement policy.');
      streak = up.queuePriority > 0 ? streak + 1 : 0;
      active++;
    }
    await tx.brand.update({ where: { id: brandId }, data: { queuePriorityStreak: streak } });
  }

  private async releaseJump(tx: Tx, order: { id: string; brandId: string; currency: string; jumpFeeAmount: Prisma.Decimal }) {
    const gross = Number(order.jumpFeeAmount), commission = Math.round(gross * 10) / 100, net = Math.round((gross - commission) * 100) / 100;
    const existing = await tx.customOrderLedgerAllocation.findFirst({ where: { customOrderId: order.id, allocationType: 'JUMP_FEE' } });
    if (!existing) await tx.customOrderLedgerAllocation.create({ data: { customOrderId: order.id, allocationType: 'JUMP_FEE', amount: gross, commissionRate: 10, commissionAmount: commission, netBrandAmount: net, currency: order.currency, status: 'PAYOUT_ELIGIBLE', eligibleAt: new Date() } });
    await this.ledger.postTransaction(tx, { idempotencyKey: `ledger:custom-order:${order.id}:jump_release`, type: LedgerTransactionType.ESCROW_RELEASE, description: 'Custom-order queue priority fee released at activation', referenceType: 'CustomOrder', referenceId: order.id, totalAmount: gross, currency: order.currency, lines: [
      { code: 'SYSTEM:CUSTOM_ORDER_ESCROW', name: 'Custom Order Escrow', type: LedgerAccountType.LIABILITY, subType: 'CUSTOM_ORDER_ESCROW', isSystemAccount: true, direction: LedgerEntryDirection.DEBIT, amount: gross },
      { code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE', name: 'Platform Commission Revenue', type: LedgerAccountType.REVENUE, subType: 'PLATFORM_COMMISSION', isSystemAccount: true, direction: LedgerEntryDirection.CREDIT, amount: commission },
      { code: `BRAND_WALLET:${order.brandId}`, name: `Brand Wallet ${order.brandId}`, type: LedgerAccountType.LIABILITY, subType: 'BRAND_AVAILABLE', entityType: 'BRAND', entityId: order.brandId, direction: LedgerEntryDirection.CREDIT, amount: net },
    ] });
  }

  async retain(userId: string, id: string, expectedRevision?: number) {
    const order = await this.prisma.customOrder.findFirst({ where: { id, buyerId: userId } });
    if (!order) throw new NotFoundException('Custom order not found');
    await this.prisma.$transaction(async tx => {
      const now = await this.lockBrand(tx, order.brandId);
      const current = await tx.customOrder.findUniqueOrThrow({ where: { id } });
      this.checkRevision(current.orderRevision, expectedRevision);
      if (!current.lane || !WAITING.includes(current.lane) || !current.queueExpiresAt || !canRetainPosition({ now, queueExpiresAt: current.queueExpiresAt, retainCount: current.retainCount })) throw new ConflictException('CUSTOM_ORDER_RETAIN_WINDOW_CLOSED');
      const updated = await tx.customOrder.update({ where: { id }, data: { queueExpiresAt: retainedExpiry(current.queueExpiresAt), retainCount: 1, retainedAt: now, orderRevision: { increment: 1 } } });
      await this.invalidateReminders(tx, id);
      await this.schedule(tx, updated);
      await this.record(tx, updated, 'QUEUE_RETAINED', 'Your queue position is retained. Your previous cancellation deadline has been extended by 42 days.', 'BUYER', userId);
    });
    return { queue: (await this.present([id]))[id] };
  }

  private checkRevision(actual: number, expected?: number) { if (expected !== undefined && actual !== expected) throw new ConflictException('CUSTOM_ORDER_CHANGED_REFRESH_REQUIRED'); }

  quote(order: { buyerPriceSummaryJson: unknown; currency: string; orderRevision: number }) {
    const summary = object(order.buyerPriceSummaryJson);
    const captureKobo = money(summary.grandTotal);
    const vatKobo = money(summary.vatAmount ?? summary.vat);
    const deliveryKobo = money(summary.delivery ?? summary.shippingFee);
    const jumpFeeKobo = money(summary.queueJumpFee);
    const garmentSubtotalKobo = money(summary.outfitTotal ?? summary.subtotal ?? (captureKobo - vatKobo - deliveryKobo - jumpFeeKobo) / 100);
    let refund: ReturnType<typeof preActiveRefund>;
    try { refund = preActiveRefund({ captureKobo, vatKobo, deliveryKobo, jumpFeeKobo, garmentSubtotalKobo }); } catch { throw new ConflictException('CUSTOM_ORDER_REFUND_SNAPSHOT_REQUIRES_REVIEW'); }
    return { currency: order.currency, captureAmount: captureKobo / 100, capturedAmount: captureKobo / 100, garmentSubtotal: garmentSubtotalKobo / 100, vatAmount: vatKobo / 100, vatWithheld: vatKobo / 100, deliveryAmount: deliveryKobo / 100, deliveryRefund: deliveryKobo / 100, jumpFeeAmount: jumpFeeKobo / 100, garmentCharge: refund.systemChargeKobo / 100, garmentFeeWithheld: refund.systemChargeKobo / 100, jumpCharge: refund.jumpChargeKobo / 100, jumpFeeWithheld: refund.jumpChargeKobo / 100, withheldAmount: refund.withheldKobo / 100, totalWithheld: refund.withheldKobo / 100, refundAmount: refund.refundKobo / 100, orderRevision: order.orderRevision };
  }

  async refundQuote(userId: string, id: string) {
    const order = await this.assertParticipant(userId, id);
    if (!order.lane || !WAITING.includes(order.lane)) throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
    return this.quote(order);
  }

  async cancel(userId: string | undefined, id: string, reason: string, expectedRevision?: number, actorType?: CustomOrderActorType) {
    const source = actorType === 'SYSTEM' || actorType === 'ADMIN' ? await this.prisma.customOrder.findUniqueOrThrow({ where: { id } }) : await this.assertParticipant(userId!, id, true);
    const actor = actorType ?? (source.buyerId === userId ? 'BUYER' : 'BRAND');
    await this.prisma.$transaction(async tx => {
      // Parent capture first, then brand: matches payment finalization lock order.
      if (source.paymentReference) await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "reference" = ${source.paymentReference} FOR UPDATE`;
      const now = await this.lockBrand(tx, source.brandId);
      const current = await tx.customOrder.findUniqueOrThrow({ where: { id } });
      if (current.cancelledAt) return;
      if (actor === 'SYSTEM' && (!current.queueExpiresAt || current.queueExpiresAt > now || !current.lane || !WAITING.includes(current.lane))) return;
      this.checkRevision(current.orderRevision, expectedRevision);
      await this.cancelLocked(tx, current, now, reason, actor, userId);
      await this.drain(tx, current.brandId, now);
    }, { timeout: 15000 });
    if (actor === 'BRAND') await this.flagMassCancellation(source.brandId);
    return { queue: (await this.present([id]))[id] };
  }

  async requestCancellationInTransaction(tx: Tx, id: string, reason: string, actor: CustomOrderActorType, actorId?: string) {
    const source = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    if (source.paymentReference) await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "reference" = ${source.paymentReference} FOR UPDATE`;
    const now = await this.lockBrand(tx, source.brandId);
    const current = await tx.customOrder.findUniqueOrThrow({ where: { id } });
    if (!current.cancelledAt) await this.cancelLocked(tx, current, now, reason, actor, actorId);
    await this.drain(tx, current.brandId, now);
    return tx.customOrderQueueRefund.findUniqueOrThrow({ where: { customOrderId: id } });
  }

  private async cancelLocked(tx: Tx, order: Prisma.CustomOrderGetPayload<object>, now: Date, reason: string, actor: CustomOrderActorType, actorId?: string) {
    if (!order.lane || !WAITING.includes(order.lane) || order.paymentStatus !== 'PAID') throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
    const quote = this.quote(order);
    const attempt = order.paymentReference ? await tx.paymentAttempt.findUnique({ where: { reference: order.paymentReference } }) : await tx.paymentAttempt.findFirst({ where: { customOrderId: order.id, status: 'PAID' }, orderBy: { createdAt: 'desc' } });
    if (!attempt || attempt.currency !== order.currency || !['PAID', 'PARTIALLY_REFUNDED'].includes(attempt.status)) throw new ConflictException('CUSTOM_ORDER_CAPTURE_REQUIRES_REVIEW');
    await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${attempt.id}::uuid FOR UPDATE`;
    const existing = await tx.customOrderQueueRefund.aggregate({ where: { paymentAttemptId: attempt.id }, _sum: { amount: true } });
    if (money(existing._sum.amount) + money(quote.refundAmount) > money(attempt.amount)) throw new ConflictException('CUSTOM_ORDER_REFUND_EXCEEDS_CAPTURE');
    await tx.customOrderQueueRefund.create({ data: { customOrderId: order.id, paymentAttemptId: attempt.id, amount: quote.refundAmount, currency: order.currency, breakdownJson: quote } });
    await tx.customOrder.update({ where: { id: order.id }, data: { lane: 'TERMINAL', status: 'REFUND_IN_PROGRESS', cancelledAt: now, cancellationReason: reason, cancellationActorType: actor, orderRevision: { increment: 1 }, adminPromotionHeld: false } });
    await tx.customOrderLedgerAllocation.updateMany({ where: { customOrderId: order.id, allocationType: 'PLACEMENT_CAPTURE' }, data: { status: 'REVERSED', reversedAt: now, reversalReason: reason } });
    await this.invalidateReminders(tx, order.id);
    await this.record(tx, order, 'QUEUE_CANCELLED', `Your waiting custom order was cancelled. Refund requested: ${order.currency} ${quote.refundAmount.toFixed(2)}. VAT ${quote.vatAmount.toFixed(2)}, garment charge ${quote.garmentCharge.toFixed(2)}, and priority charge ${quote.jumpCharge.toFixed(2)} are retained; delivery is refunded in full.`, actor, actorId);
  }

  async cancelMany(userId: string, brandId: string, ids: string[], reason: string) {
    await this.permissions.assertPermission(userId, brandId, BRAND_PERMISSIONS.ORDERS_UPDATE);
    const orders = await this.prisma.customOrder.findMany({ where: { id: { in: ids }, brandId }, select: { id: true } });
    if (orders.length !== new Set(ids).size) throw new NotFoundException('One or more orders do not belong to this brand');
    const results: Array<{ id: string; cancelled: boolean; message?: string }> = [];
    for (const row of orders) { try { await this.cancel(userId, row.id, reason); results.push({ id: row.id, cancelled: true }); } catch (error) { results.push({ id: row.id, cancelled: false, message: error instanceof Error ? error.message : 'Unable to cancel' }); } }
    return { results };
  }

  private async flagMassCancellation(brandId: string) {
    const count = await this.prisma.customOrder.count({ where: { brandId, cancellationActorType: 'BRAND', cancelledAt: { gte: new Date(Date.now() - 86400000) } } });
    if (count <= 5) return;
    const claimed = await this.prisma.brand.updateMany({ where: { id: brandId, OR: [{ massCancelAttentionAt: null }, { massCancelAttentionAt: { lt: new Date(Date.now() - 86400000) } }] }, data: { massCancelAttentionAt: new Date(), massCancelAttentionReason: `${count} waiting orders cancelled by this brand within 24 hours` } });
    if (!claimed.count) return;
    await this.prisma.operationalAlert.create({ data: { category: 'CUSTOM_ORDER_QUEUE', severity: 'WARNING', event: 'BRAND_MASS_CANCEL', message: `Brand ${brandId}: ${count} waiting custom orders cancelled within 24 hours` } });
    const order = await this.prisma.customOrder.findFirst({ where: { brandId, cancelledAt: { not: null } }, orderBy: { cancelledAt: 'desc' }, select: { id: true } });
    const admins = await getCachedActiveAdminIds(this.prisma);
    if (order && admins.length) await this.prisma.customOrderNotificationOutbox.createMany({ data: admins.map(recipientId => ({ customOrderId: order.id, recipientId, notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED, payloadJson: { customOrderId: order.id, stage: 'BRAND_MASS_CANCEL', message: `Brand ${brandId} cancelled ${count} waiting orders within 24 hours. Review is required; intake has not been suspended automatically.`, targetUrl: `/admin/custom-orders?brandId=${brandId}` }, targetJson: { type: 'CUSTOM_ORDER', id: order.id } })) });
  }

  async resubmit(userId: string, id: string) {
    const order = await this.prisma.customOrder.findFirst({ where: { id, buyerId: userId }, include: { queueRefund: true } });
    if (!order?.cancelledAt) throw new NotFoundException('Cancelled order not found');
    await this.assertIntake(userId, order.brandId);
    return { sourceType: order.sourceType, sourceId: order.sourceId, configurationId: order.configurationId, previousOrderId: id, refundPending: Boolean(order.queueRefund && order.queueRefund.status !== 'SETTLED'), requiresNewPayment: true };
  }

  async reorder(id: string, action: 'promote' | 'demote' | 'release-hold', actorId: string, reason: string) {
    const source = await this.prisma.customOrder.findUniqueOrThrow({ where: { id } });
    await this.prisma.$transaction(async tx => {
      const now = await this.lockBrand(tx, source.brandId);
      const row = await tx.customOrder.findUniqueOrThrow({ where: { id } });
      if (!row.lane || !WAITING.includes(row.lane) || !row.queueExpiresAt || row.queueExpiresAt <= now) throw new ConflictException('CUSTOM_ORDER_NO_LONGER_WAITING');
      if (action === 'release-hold') await tx.customOrder.update({ where: { id }, data: { adminPromotionHeld: false, orderRevision: { increment: 1 } } });
      else if (action === 'promote') {
        await tx.customOrder.updateMany({ where: { brandId: row.brandId, lane: 'UP_NEXT', id: { not: id } }, data: { lane: 'PENDING', orderRevision: { increment: 1 } } });
        await tx.customOrder.update({ where: { id }, data: { lane: 'UP_NEXT', adminPromotionHeld: false, orderRevision: { increment: 1 } } });
      } else {
        if (row.lane !== 'UP_NEXT') throw new ConflictException('Only Up Next can be demoted');
        const candidate = await tx.customOrder.findFirst({ where: { brandId: row.brandId, lane: 'PENDING', adminPromotionHeld: false, queueExpiresAt: { gt: now } }, orderBy: [{ queuePriority: 'desc' }, { queuePosition: 'asc' }] });
        await tx.customOrder.update({ where: { id }, data: { lane: 'PENDING', adminPromotionHeld: !candidate, orderRevision: { increment: 1 } } });
        if (candidate) await tx.customOrder.update({ where: { id: candidate.id }, data: { lane: 'UP_NEXT', orderRevision: { increment: 1 } } });
      }
      await this.record(tx, row, `ADMIN_QUEUE_${action.toUpperCase()}`, `An admin updated this order's queue placement (${action}). ${reason}`, 'ADMIN', actorId);
      await this.audit(tx, actorId, `queue.${action}`, id, { reason });
      await this.drain(tx, row.brandId, now);
    });
    return { queue: (await this.present([id]))[id] };
  }

  async audit(tx: Tx, actorId: string, operation: string, targetId: string, metadata: Record<string, unknown>) {
    await tx.adminAuditLog.create({ data: { id: randomUUID(), actorUserId: actorId, action: AdminAuditAction.ADMIN_SYSTEM_SETTINGS_UPDATE, targetType: operation, targetId, metadata: metadata as Prisma.InputJsonValue } });
  }

  async settings(userId: string, brandId: string, enabled: boolean) {
    await this.permissions.assertPermission(userId, brandId, BRAND_PERMISSIONS.SETTINGS_UPDATE);
    await this.prisma.$transaction(async tx => { const now = await this.lockBrand(tx, brandId); const cap = await this.capacity(tx, brandId, now); if (enabled && !cap.queueJumpAllowed) throw new ForbiddenException('Paid queue priority is available only on Aru and Igwe'); await tx.brand.update({ where: { id: brandId }, data: { queueJumpEnabled: enabled } }); });
    return this.summary(brandId);
  }

  async notices(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { type: true } });
    const now = new Date();
    const notices = user?.type === 'BRAND' ? await this.prisma.runwayBrandNotice.findMany({ where: { publishedAt: { not: null }, endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }, orderBy: { publishedAt: 'desc' }, take: 1 }) : [];
    return { notices, serverNow: now.toISOString() };
  }

  async sweep() {
    const due = await this.prisma.customOrder.findMany({ where: { lane: { in: WAITING }, queueExpiresAt: { lte: new Date() }, ...(this.expiryCursor ? { OR: [{ queueExpiresAt: { gt: this.expiryCursor.at } }, { queueExpiresAt: this.expiryCursor.at, id: { gt: this.expiryCursor.id } }] } : {}) }, orderBy: [{ queueExpiresAt: 'asc' }, { id: 'asc' }], take: 100, select: { id: true, queueExpiresAt: true } });
    for (const row of due) {
      try { await this.cancel(undefined, row.id, 'Waiting period expired after 42 days', undefined, 'SYSTEM'); }
      catch (error) { this.logger.error(`Queue expiry requires review for ${row.id}: ${error instanceof Error ? error.message : 'Unknown failure'}`); }
    }
    const last = due.at(-1);
    this.expiryCursor = due.length === 100 && last?.queueExpiresAt ? { at: last.queueExpiresAt, id: last.id } : null;
    const brands = await this.prisma.$queryRaw<Array<{ brandId: string }>>`SELECT DISTINCT "brandId" FROM "CustomOrder" WHERE "lane" IN ('PENDING','UP_NEXT') AND "brandId"::text > ${this.brandCursor} ORDER BY "brandId" LIMIT 100`;
    for (const row of brands) {
      try { await this.prisma.$transaction(async tx => { const now = await this.lockBrand(tx, row.brandId); await this.drain(tx, row.brandId, now); }); }
      catch (error) { this.logger.error(`Queue promotion requires review for brand ${row.brandId}: ${error instanceof Error ? error.message : 'Unknown failure'}`); }
    }
    this.brandCursor = brands.length === 100 ? brands[brands.length - 1].brandId : '';
  }
}
