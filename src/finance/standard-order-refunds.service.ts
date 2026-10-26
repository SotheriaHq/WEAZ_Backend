import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  NotificationType,
  PaymentStatus,
  Prisma,
  StandardOrderRefund,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { StandardOrderEscrowService } from './standard-order-escrow.service';
import { StandardOrderFinanceSyncService } from './standard-order-finance-sync.service';
import {
  ProviderRefund,
  RefundCapture,
  RefundGateway,
  RefundProviderClient,
  RefundProviderError,
  RefundTarget,
} from './refund-provider.client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';

type Tx = Prisma.TransactionClient;
export type StandardRefundTrigger =
  | 'RETURN'
  | 'SLA_TIMEOUT'
  | 'ADMIN_SLA_CANCEL'
  | 'PRODUCT_REMOVAL'
  | 'ADMIN';

const LEASE_MS = 10 * 60_000;
const POLL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const BATCH = 20;

type RefundWithCapture = StandardOrderRefund & {
  capture: RefundCapture;
  buyerId: string | null;
};

/**
 * The canonical standard-order refund. A request reserves the order's own
 * share of its capture inside the business transaction and never calls a
 * provider; a worker submits it outside every lock, records the provider's
 * refund id, and settles money, escrow and the order together only when the
 * provider confirms. An uncertain submission is looked up, never resent.
 */
@Injectable()
export class StandardOrderRefundsService {
  private readonly logger = new Logger(StandardOrderRefundsService.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly escrow: StandardOrderEscrowService,
    private readonly financeSync: StandardOrderFinanceSyncService,
    private readonly provider: RefundProviderClient,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /**
   * Reserve a full refund of one paid standard order. Idempotent per order:
   * a buyer, an admin, the SLA job and a product deletion asking at once all
   * converge on one refund. Lock order: capture → order → hold → brand → ledger.
   */
  async requestInTransaction(
    tx: Tx,
    params: {
      orderId: string;
      trigger: StandardRefundTrigger;
      reason: string;
      actorId?: string | null;
    },
  ): Promise<StandardOrderRefund> {
    const head = await tx.order.findUnique({
      where: { id: params.orderId },
      select: { paymentReference: true },
    });
    if (!head) throw new NotFoundException('Order not found');
    if (!head.paymentReference)
      throw new ConflictException('ORDER_CAPTURE_REQUIRES_REVIEW');
    const [capture] = await tx.$queryRaw<
      Array<{
        id: string;
        reference: string;
        provider: string;
        status: string;
        currency: string;
        settlementCurrency: string | null;
      }>
    >`SELECT id, reference, provider, status, currency, "settlementCurrency"
      FROM "PaymentAttempt" WHERE reference = ${head.paymentReference} FOR UPDATE`;
    await tx.$queryRaw`SELECT "_id" FROM "Order" WHERE "_id" = ${params.orderId}::uuid FOR UPDATE`;

    const existing = await tx.standardOrderRefund.findUnique({
      where: { orderId: params.orderId },
    });
    if (existing) return existing;

    const order = await tx.order.findUniqueOrThrow({
      where: { id: params.orderId },
      select: {
        id: true,
        paymentStatus: true,
        totalAmount: true,
        currency: true,
      },
    });
    if (order.paymentStatus !== PaymentStatus.PAID)
      throw new ConflictException('ORDER_NOT_REFUNDABLE');
    if (!capture || !['PAID', 'PARTIALLY_REFUNDED'].includes(capture.status))
      throw new ConflictException('ORDER_CAPTURE_REQUIRES_REVIEW');

    let hold = await this.escrow.lockHoldByOrderId(tx, order.id);
    if (!hold) {
      await this.financeSync.ensureHoldsForReferenceInTransaction(
        tx,
        capture.reference,
      );
      hold = await this.escrow.lockHoldByOrderId(tx, order.id);
    }
    if (!hold) throw new ConflictException('ORDER_SETTLEMENT_REQUIRES_REVIEW');
    const chargedCurrency = (capture.settlementCurrency || capture.currency).toUpperCase();
    if (hold.currency !== chargedCurrency)
      throw new ConflictException('ORDER_REFUND_CURRENCY_REQUIRES_REVIEW');

    const refundId = randomUUID();
    const reason = params.reason.trim().slice(0, 500) || params.trigger;
    await tx.standardOrderRefund.create({
      data: {
        id: refundId,
        requestKey: `standard-order:${order.id}:refund`,
        orderId: order.id,
        paymentAttemptId: capture.id,
        escrowHoldId: hold.id,
        provider: capture.provider.toUpperCase(),
        trigger: params.trigger,
        reason,
        amount: order.totalAmount,
        currency: order.currency,
        settlementAmount: hold.totalAmount,
        settlementCurrency: hold.currency,
        breakdownJson: {},
        actorId: params.actorId ?? null,
      },
    });
    const reserved = await this.escrow.reserveRefund(tx, {
      orderId: order.id,
      refundId,
      reason,
    });
    const updated = await tx.standardOrderRefund.update({
      where: { id: refundId },
      data: {
        breakdownJson: {
          captureReference: capture.reference,
          releasedGross: reserved?.split.releasedGross.toFixed(2) ?? '0.00',
          releasedCommission: reserved?.split.releasedCommission.toFixed(2) ?? '0.00',
          releasedNet: reserved?.split.releasedNet.toFixed(2) ?? '0.00',
          unreleasedGross: reserved?.split.unreleasedGross.toFixed(2) ?? '0.00',
        },
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentAttemptId: capture.id,
        type: 'STANDARD_ORDER_REFUND_REQUESTED',
        source: 'standard-order-refunds',
        payload: {
          refundId,
          orderId: order.id,
          trigger: params.trigger,
          amount: order.totalAmount.toFixed(2),
          currency: order.currency,
          actorId: params.actorId ?? null,
        },
      },
    });
    return updated;
  }

  /** Worker loop: submit due requests, poll provider-accepted refunds, notify. */
  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      await this.processPending();
      await this.notifySettled();
    } catch (error) {
      this.logger.error(
        `Standard refund processing failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  async processPending(limit = BATCH) {
    const now = Date.now();
    const stale = await this.prisma.standardOrderRefund.findMany({
      where: { status: 'SUBMITTING', lockedAt: { lt: new Date(now - LEASE_MS) } },
      select: { id: true, leaseToken: true },
      take: BATCH,
      orderBy: { lockedAt: 'asc' },
    });
    for (const row of stale) {
      await this.resolveUncertain(row.id, row.leaseToken, 'GATEWAY_SUBMISSION_OUTCOME_UNKNOWN');
    }
    const due = await this.prisma.standardOrderRefund.findMany({
      where: {
        nextAttemptAt: { lte: new Date(now) },
        OR: [
          { status: { in: ['REQUESTED', 'FAILED'] }, providerRefundId: null, attempts: { lt: MAX_ATTEMPTS } },
          {
            status: 'PROCESSING',
            OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(now - LEASE_MS) } }],
          },
        ],
      },
      select: { id: true, status: true },
      take: Math.max(1, Math.min(limit, BATCH)),
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    });
    let processed = 0;
    for (const row of due) {
      try {
        if (row.status === 'PROCESSING' ? await this.poll(row.id) : await this.submit(row.id))
          processed += 1;
      } catch {
        this.logger.error(`Standard refund ${row.id} not advanced; durable state retained`);
      }
    }
    return { processed, stale: stale.length };
  }

  /** Claim with a fresh lease token; only the token holder may record the outcome. */
  private async submit(id: string): Promise<boolean> {
    const leaseToken = randomUUID();
    const claimed = await this.prisma.standardOrderRefund.updateMany({
      where: {
        id,
        status: { in: ['REQUESTED', 'FAILED'] },
        providerRefundId: null,
        attempts: { lt: MAX_ATTEMPTS },
        nextAttemptAt: { lte: new Date() },
      },
      data: {
        status: 'SUBMITTING',
        leaseToken,
        lockedAt: new Date(),
        attempts: { increment: 1 },
        lastError: null,
      },
    });
    if (!claimed.count) return false;
    const row = await this.load(id);
    if (row.capture.providerMode.toLowerCase() === 'mock') {
      return this.simulate(row, leaseToken);
    }
    const target = this.target(row);
    try {
      await this.provider.verifyCapture(row.capture);
      const refund = await this.provider.submit(row.capture, target, this.note(row));
      if (!this.provider.matches(row.capture, target, refund))
        throw new RefundProviderError('REFUND_GATEWAY_RESPONSE_MISMATCH', false);
      const linked = await this.prisma.standardOrderRefund.updateMany({
        where: { id, status: 'SUBMITTING', leaseToken },
        data: {
          status: 'PROCESSING',
          providerRefundId: refund.id,
          leaseToken: null,
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      if (!linked.count) {
        // The lease expired while the provider answered: record what was created.
        await this.attention(id, 'REFUND_SUBMISSION_LEASE_LOST', ['SUBMITTING', 'NEEDS_ATTENTION'], refund.id);
        return false;
      }
      await this.apply({ ...row, providerRefundId: refund.id, status: 'PROCESSING' }, refund);
      return true;
    } catch (error) {
      const failure =
        error instanceof RefundProviderError
          ? error
          : new RefundProviderError('REFUND_GATEWAY_OUTCOME_UNKNOWN', false);
      if (failure.definitelyNotSubmitted && row.attempts < MAX_ATTEMPTS) {
        await this.prisma.standardOrderRefund.updateMany({
          where: { id, status: 'SUBMITTING', leaseToken },
          data: {
            status: 'FAILED',
            leaseToken: null,
            lockedAt: null,
            lastError: failure.code,
            nextAttemptAt: new Date(Date.now() + Math.min(24 * 3_600_000, 60_000 * 2 ** row.attempts)),
          },
        });
      } else if (failure.definitelyNotSubmitted) {
        await this.attention(id, failure.code, ['SUBMITTING'], null, leaseToken);
      } else {
        await this.resolveUncertain(id, leaseToken, failure.code);
      }
      return false;
    }
  }

  /**
   * The provider may have created a refund. Look for it by the note we sent;
   * link it when exactly one matching refund exists, otherwise ask a person.
   */
  private async resolveUncertain(id: string, leaseToken: string | null, code: string) {
    const row = await this.load(id);
    let found: ProviderRefund[] | null = null;
    try {
      found = await this.provider.findByNote(row.capture, this.note(row));
    } catch {
      found = null;
    }
    const target = this.target(row);
    const matching = (found ?? []).filter((refund) =>
      this.provider.matches(row.capture, target, refund),
    );
    if (matching.length === 1) {
      const linked = await this.prisma.standardOrderRefund.updateMany({
        where: { id, status: 'SUBMITTING', ...(leaseToken ? { leaseToken } : {}) },
        data: {
          status: 'PROCESSING',
          providerRefundId: matching[0].id,
          leaseToken: null,
          lockedAt: null,
          lastError: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      if (linked.count) {
        await this.apply({ ...row, providerRefundId: matching[0].id, status: 'PROCESSING' }, matching[0]);
        return;
      }
    }
    await this.attention(id, code, ['SUBMITTING'], null, leaseToken ?? undefined);
  }

  private async poll(id: string): Promise<boolean> {
    const claimed = await this.prisma.standardOrderRefund.updateMany({
      where: {
        id,
        status: 'PROCESSING',
        OR: [{ lockedAt: null }, { lockedAt: { lt: new Date(Date.now() - LEASE_MS) } }],
      },
      data: { lockedAt: new Date(), nextAttemptAt: new Date(Date.now() + POLL_MS) },
    });
    if (!claimed.count) return false;
    const row = await this.load(id);
    try {
      const refund = await this.provider.fetch(row.capture, row.providerRefundId!);
      if (!this.provider.matches(row.capture, this.target(row), refund) || refund.id !== row.providerRefundId) {
        await this.attention(id, 'REFUND_STATUS_RESPONSE_MISMATCH', ['PROCESSING']);
        return false;
      }
      await this.apply(row, refund);
      return true;
    } catch {
      // Repeating a status lookup is safe. Repeating a refund creation is not.
      await this.prisma.standardOrderRefund.updateMany({
        where: { id, status: 'PROCESSING' },
        data: {
          lockedAt: null,
          lastError: 'REFUND_STATUS_LOOKUP_UNAVAILABLE',
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      return false;
    }
  }

  /** Caller has verified the signature. Returns true when the event was ours. */
  async handleWebhook(gateway: RefundGateway, payload: unknown): Promise<boolean> {
    const identity = this.provider.webhookIdentity(gateway, payload);
    if (!identity) return false;
    const rows = identity.providerRefundId
      ? await this.prisma.standardOrderRefund.findMany({
          where: { provider: gateway, providerRefundId: identity.providerRefundId },
          select: { id: true },
        })
      : identity.transactionReference
        ? await this.prisma.standardOrderRefund.findMany({
            where: {
              provider: gateway,
              status: 'PROCESSING',
              paymentAttempt: { reference: identity.transactionReference },
            },
            select: { id: true },
            take: BATCH,
          })
        : [];
    // A webhook is a hint: each stored refund is re-read from the provider.
    for (const row of rows) await this.poll(row.id);
    return rows.length > 0;
  }

  /** Admin authorization belongs to the caller. A provider id never bypasses verification. */
  async reconcile(refundId: string, providerRefundId: string, actorId: string) {
    if (!/^[A-Za-z0-9_:-]{1,120}$/.test(providerRefundId))
      throw new ConflictException('REFUND_PROVIDER_ID_INVALID');
    const row = await this.load(refundId);
    if (row.status === 'SETTLED')
      return { id: row.id, status: row.status, providerRefundId: row.providerRefundId };
    if (!['NEEDS_ATTENTION', 'FAILED'].includes(row.status))
      throw new ConflictException('REFUND_NOT_AWAITING_RECONCILIATION');
    const refund = await this.provider
      .fetch(row.capture, providerRefundId)
      .catch(() => {
        throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE');
      });
    if (!this.provider.matches(row.capture, this.target(row), refund))
      throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_MISMATCH');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "StandardOrderRefund" WHERE id = ${refundId}::uuid FOR UPDATE`;
      const current = await tx.standardOrderRefund.findUniqueOrThrow({ where: { id: refundId } });
      if (
        !['NEEDS_ATTENTION', 'FAILED'].includes(current.status) ||
        (current.providerRefundId && current.providerRefundId !== providerRefundId)
      )
        throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
      await tx.standardOrderRefund.update({
        where: { id: refundId },
        data: {
          status: 'PROCESSING',
          providerRefundId,
          leaseToken: null,
          lockedAt: null,
          lastError: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: current.paymentAttemptId,
          type: 'STANDARD_ORDER_REFUND_RECONCILED',
          source: 'standard-order-refunds',
          payload: { refundId, orderId: current.orderId, providerRefundId, actorId },
        },
      });
    });
    await this.apply({ ...row, status: 'PROCESSING', providerRefundId }, refund);
    return this.prisma.standardOrderRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { id: true, status: true, providerRefundId: true },
    });
  }

  private async apply(row: RefundWithCapture, refund: ProviderRefund) {
    if (refund.state === 'PROCESSED') return this.complete(row.id, refund.rawStatus, false);
    if (refund.state === 'FAILED' || refund.state === 'NEEDS_ATTENTION')
      return this.attention(row.id, `REFUND_PROVIDER_${refund.rawStatus.toUpperCase().replace(/-/g, '_')}`, ['PROCESSING']);
    await this.prisma.standardOrderRefund.updateMany({
      where: { id: row.id, status: 'PROCESSING' },
      data: { lockedAt: null, nextAttemptAt: new Date(Date.now() + POLL_MS) },
    });
  }

  /**
   * The provider confirmed the refund. Money, escrow and order change together.
   * Lock order: order → hold → refund row → brand → ledger.
   */
  private async complete(id: string, providerStatus: string, simulated: boolean) {
    await this.prisma.$transaction(async (tx) => {
      const head = await tx.standardOrderRefund.findUniqueOrThrow({
        where: { id },
        select: { orderId: true },
      });
      await tx.$queryRaw`SELECT "_id" FROM "Order" WHERE "_id" = ${head.orderId}::uuid FOR UPDATE`;
      await this.escrow.lockHoldByOrderId(tx, head.orderId);
      await tx.$queryRaw`SELECT id FROM "StandardOrderRefund" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.standardOrderRefund.findUniqueOrThrow({
        where: { id },
        include: {
          paymentAttempt: { select: { exchangeRateSnapshotId: true } },
        },
      });
      if (current.status === 'SETTLED') return;
      if (!['PROCESSING', 'NEEDS_ATTENTION', ...(simulated ? ['SUBMITTING'] : [])].includes(current.status))
        return;
      await this.escrow.settleRefund(tx, {
        orderId: current.orderId,
        refundId: current.id,
        captureCurrency: current.currency,
        captureAmount: current.amount,
        exchangeRateSnapshotId: current.paymentAttempt.exchangeRateSnapshotId,
      });
      await tx.standardOrderRefund.update({
        where: { id },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
          leaseToken: null,
          lockedAt: null,
          lastError: null,
        },
      });
      // A full refund: the order leaves paid-customer counts exactly here, once.
      await tx.order.updateMany({
        where: { id: current.orderId, paymentStatus: { not: PaymentStatus.REFUNDED } },
        data: { paymentStatus: PaymentStatus.REFUNDED },
      });
      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: current.paymentAttemptId,
          type: 'STANDARD_ORDER_REFUND_SETTLED',
          source: 'standard-order-refunds',
          payload: {
            refundId: id,
            orderId: current.orderId,
            amount: current.settlementAmount.toFixed(2),
            currency: current.settlementCurrency,
            providerStatus,
            simulated,
          },
        },
      });
      await tx.operationalAlert.updateMany({
        where: { dedupeKey: `standard-refund:${id}:attention`, status: 'OPEN' },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      });
    });
  }

  private async attention(
    id: string,
    code: string,
    statuses: string[],
    providerRefundId: string | null = null,
    leaseToken?: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.standardOrderRefund.updateMany({
        where: { id, status: { in: statuses }, ...(leaseToken ? { leaseToken } : {}) },
        data: {
          status: 'NEEDS_ATTENTION',
          lastError: code,
          leaseToken: null,
          lockedAt: null,
          ...(providerRefundId ? { providerRefundId } : {}),
        },
      });
      if (!claimed.count) return false;
      const row = await tx.standardOrderRefund.findUniqueOrThrow({
        where: { id },
        select: { orderId: true, paymentAttemptId: true },
      });
      await tx.operationalAlert.upsert({
        where: { dedupeKey: `standard-refund:${id}:attention` },
        create: {
          category: 'STANDARD_ORDER_REFUND',
          severity: 'ERROR',
          event: 'STANDARD_REFUND_NEEDS_ATTENTION',
          entityType: 'StandardOrderRefund',
          entityId: id,
          dedupeKey: `standard-refund:${id}:attention`,
          message: 'A standard-order refund needs reconciliation before any further provider submission.',
          metadata: { orderId: row.orderId, code },
        },
        update: {
          occurrenceCount: { increment: 1 },
          lastSeenAt: new Date(),
          metadata: { orderId: row.orderId, code },
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: row.paymentAttemptId,
          type: 'STANDARD_ORDER_REFUND_NEEDS_ATTENTION',
          source: 'standard-order-refunds',
          payload: { refundId: id, orderId: row.orderId, code },
        },
      });
      return true;
    });
  }

  /** Local development and tests only, and only when explicitly enabled. */
  private async simulate(row: RefundWithCapture, leaseToken: string) {
    if (
      !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
      process.env.STANDARD_ORDER_REFUND_SIMULATION_ENABLED !== 'true'
    ) {
      await this.attention(row.id, 'REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED', ['SUBMITTING'], null, leaseToken);
      return false;
    }
    const linked = await this.prisma.standardOrderRefund.updateMany({
      where: { id: row.id, status: 'SUBMITTING', leaseToken },
      data: { providerRefundId: `simulated:${row.id}`, status: 'PROCESSING', leaseToken: null, lockedAt: null },
    });
    if (!linked.count) return false;
    await this.complete(row.id, 'SIMULATED_PROCESSED', true);
    return true;
  }

  /** Tell shoppers about committed settlements, after commit, once per refund. */
  async notifySettled() {
    if (!this.notifications) return 0;
    const rows = await this.prisma.standardOrderRefund.findMany({
      where: { status: 'SETTLED', buyerNotifiedAt: null },
      orderBy: { settledAt: 'asc' },
      take: BATCH,
      select: {
        id: true, orderId: true, settlementAmount: true, settlementCurrency: true,
        order: { select: { buyerId: true, status: true } },
      },
    });
    let sent = 0;
    for (const row of rows) {
      try {
        if (row.order.buyerId) {
          await this.notifications.create(row.order.buyerId, NotificationType.ORDER_STATUS_UPDATED, {
            notificationId: row.id,
            payload: {
              orderId: row.orderId,
              status: row.order.status,
              refundStatus: 'PROCESSED',
              targetUrl: `/orders/${row.orderId}`,
              message: `Your refund of ${row.settlementCurrency} ${row.settlementAmount.toFixed(2)} has been processed by the payment provider. Your bank may take up to 10 business days to show it.`,
            },
          });
        }
        await this.prisma.standardOrderRefund.updateMany({
          where: { id: row.id, buyerNotifiedAt: null },
          data: { buyerNotifiedAt: new Date() },
        });
        sent += 1;
      } catch {
        this.logger.warn(`Refund notice ${row.id} not yet delivered`);
      }
    }
    return sent;
  }

  /** Shopper-facing wording while a refund is not yet confirmed by the provider. */
  static pendingMessage(currency: string, amount: Prisma.Decimal) {
    return `Your refund of ${currency} ${amount.toFixed(2)} has been requested and is being processed with the payment provider. We will tell you when it completes.`;
  }

  private target(row: RefundWithCapture): RefundTarget {
    return { amount: row.settlementAmount, currency: row.settlementCurrency };
  }

  private note(row: { id: string }) {
    return `WIEZ standard refund ${row.id}`;
  }

  private async load(id: string): Promise<RefundWithCapture> {
    const row = await this.prisma.standardOrderRefund.findUnique({
      where: { id },
      include: {
        paymentAttempt: {
          select: {
            reference: true, provider: true, providerMode: true, providerTransactionId: true,
            amount: true, currency: true, settlementAmount: true, settlementCurrency: true,
          },
        },
        order: { select: { buyerId: true } },
      },
    });
    if (!row) throw new NotFoundException('Standard refund not found');
    const { paymentAttempt, order, ...refund } = row;
    return { ...refund, capture: paymentAttempt, buyerId: order.buyerId };
  }
}
