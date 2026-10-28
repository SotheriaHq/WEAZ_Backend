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
import { v5 as uuidv5 } from 'uuid';
import {
  claimStandardRefundSubmission,
  claimStandardRefundPoll,
  claimStandardRefundResolution,
  lockStandardRefundLease,
  ownsStandardRefundLease,
  loadStaleStandardRefunds,
  loadDueStandardRefunds,
  linkStandardRefundProvider,
  scheduleStandardRefundRetry,
} from './standard-refund-lease-query';
import { StandardOrderEscrowService } from './standard-order-escrow.service';
import { claimRefundReconciliation } from './refund-lease-query';
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
    const chargedCurrency = (
      capture.settlementCurrency || capture.currency
    ).toUpperCase();
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
          releasedCommission:
            reserved?.split.releasedCommission.toFixed(2) ?? '0.00',
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
    const stale = await loadStaleStandardRefunds(this.prisma, BATCH);
    for (const row of stale) {
      await this.resolveUncertain(
        row.id,
        row.leaseToken,
        'GATEWAY_SUBMISSION_OUTCOME_UNKNOWN',
      );
    }
    const take = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.trunc(limit), BATCH))
      : BATCH;
    const due = await loadDueStandardRefunds(this.prisma, take, MAX_ATTEMPTS);
    let processed = 0;
    for (const row of due) {
      try {
        if (
          row.status === 'PROCESSING'
            ? await this.poll(row.id)
            : await this.submit(row.id)
        )
          processed += 1;
      } catch {
        this.logger.error(
          `Standard refund ${row.id} not advanced; durable state retained`,
        );
      }
    }
    return { processed, stale: stale.length };
  }

  /** Claim with a fresh lease token; only the token holder may record the outcome. */
  private async submit(id: string): Promise<boolean> {
    const leaseToken = randomUUID();
    const claimed = await claimStandardRefundSubmission(
      this.prisma,
      id,
      leaseToken,
      MAX_ATTEMPTS,
    );
    if (!claimed) return false;
    const row = await this.load(id);
    if (row.capture.providerMode.toLowerCase() === 'mock') {
      return this.simulate(row, leaseToken);
    }
    const target = this.target(row);
    try {
      await this.provider.verifyCapture(row.capture);
      const refund = await this.provider.submit(
        row.capture,
        target,
        this.note(row),
      );
      if (!this.provider.matches(row.capture, target, refund))
        throw new RefundProviderError(
          'REFUND_GATEWAY_RESPONSE_MISMATCH',
          false,
        );
      const linked = await this.linkProviderResult(id, leaseToken, refund.id);
      if (!linked) {
        return false;
      }
      return this.apply(
        { ...row, providerRefundId: refund.id, status: 'PROCESSING' },
        refund,
        leaseToken,
      );
    } catch (error) {
      const failure =
        error instanceof RefundProviderError
          ? error
          : new RefundProviderError('REFUND_GATEWAY_OUTCOME_UNKNOWN', false);
      if (failure.definitelyNotSubmitted && row.attempts < MAX_ATTEMPTS) {
        await this.withOwnedLease(
          id,
          leaseToken,
          ['SUBMITTING'],
          async (tx) => {
            await scheduleStandardRefundRetry(
              tx,
              id,
              'FAILED',
              failure.code,
              Math.min(24 * 3_600_000, 60_000 * 2 ** row.attempts),
            );
            return true;
          },
        );
      } else if (failure.definitelyNotSubmitted) {
        await this.attention(
          id,
          failure.code,
          ['SUBMITTING'],
          null,
          leaseToken,
        );
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
  private async resolveUncertain(
    id: string,
    leaseToken: string | null,
    code: string,
  ) {
    const owner = randomUUID();
    if (
      !(await claimStandardRefundResolution(this.prisma, id, leaseToken, owner))
    )
      return;
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
    if (found?.length === 1 && matching.length === 1) {
      const linked = await this.linkProviderResult(id, owner, matching[0].id);
      if (linked) {
        await this.apply(
          { ...row, providerRefundId: matching[0].id, status: 'PROCESSING' },
          matching[0],
          owner,
        );
        return;
      }
    }
    await this.attention(id, code, ['SUBMITTING'], null, owner);
  }

  private async poll(id: string): Promise<boolean> {
    const owner = randomUUID();
    if (!(await claimStandardRefundPoll(this.prisma, id, owner, POLL_MS)))
      return false;
    const row = await this.load(id);
    try {
      const refund = await this.provider.fetch(
        row.capture,
        row.providerRefundId!,
      );
      if (
        !this.provider.matches(row.capture, this.target(row), refund) ||
        refund.id !== row.providerRefundId
      ) {
        await this.attention(
          id,
          'REFUND_STATUS_RESPONSE_MISMATCH',
          ['PROCESSING'],
          null,
          owner,
        );
        return false;
      }
      return this.apply(row, refund, owner);
    } catch {
      // Repeating a status lookup is safe. Repeating a refund creation is not.
      await this.withOwnedLease(id, owner, ['PROCESSING'], async (tx) => {
        await scheduleStandardRefundRetry(
          tx,
          id,
          'PROCESSING',
          'REFUND_STATUS_LOOKUP_UNAVAILABLE',
          POLL_MS,
        );
        return true;
      });
      return false;
    }
  }

  /** Caller has verified the signature. Returns true when the event was ours. */
  async handleWebhook(
    gateway: RefundGateway,
    payload: unknown,
  ): Promise<boolean> {
    const identity = this.provider.webhookIdentity(gateway, payload);
    if (!identity) return false;
    const rows = identity.providerRefundId
      ? await this.prisma.standardOrderRefund.findMany({
          where: {
            provider: gateway,
            providerRefundId: identity.providerRefundId,
          },
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
      return {
        id: row.id,
        status: row.status,
        providerRefundId: row.providerRefundId,
      };
    if (!['NEEDS_ATTENTION', 'FAILED'].includes(row.status))
      throw new ConflictException('REFUND_NOT_AWAITING_RECONCILIATION');
    const owner = randomUUID();
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockParents(tx, refundId);
        if (!(await claimRefundReconciliation(tx, refundId, owner)))
          throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
        await tx.paymentEvent.create({
          data: {
            paymentAttemptId: row.paymentAttemptId,
            type: 'STANDARD_ORDER_REFUND_RECONCILIATION_STARTED',
            source: 'standard-order-refunds',
            payload: { refundId, providerRefundId, actorId },
          },
        });
      },
      { timeout: 15000 },
    );
    let refund: ProviderRefund;
    try {
      refund = await this.provider
        .fetch(row.capture, providerRefundId)
        .catch(() => {
          throw new ConflictException(
            'REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE',
          );
        });
      if (!this.provider.matches(row.capture, this.target(row), refund))
        throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_MISMATCH');
      const applied = await this.withOwnedLease(
        refundId,
        owner,
        ['NEEDS_ATTENTION'],
        async (tx) => {
          const current = await this.load(refundId, tx);
          if (
            (current.providerRefundId &&
              current.providerRefundId !== providerRefundId) ||
            !this.provider.matches(
              current.capture,
              this.target(current),
              refund,
            )
          )
            throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
          if (
            !(await linkStandardRefundProvider(
              tx,
              refundId,
              providerRefundId,
              POLL_MS,
            ))
          )
            throw new ConflictException('REFUND_PROVIDER_ID_ALREADY_LINKED');
          await tx.paymentEvent.create({
            data: {
              paymentAttemptId: current.paymentAttemptId,
              type: 'STANDARD_ORDER_REFUND_RECONCILED',
              source: 'standard-order-refunds',
              payload: {
                refundId,
                orderId: current.orderId,
                providerRefundId,
                actorId,
              },
            },
          });
          return true;
        },
      );
      if (!applied)
        throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
    } catch (error) {
      const code =
        error instanceof ConflictException
          ? error.message
          : 'REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE';
      await this.attention(refundId, code, ['NEEDS_ATTENTION'], null, owner);
      throw error;
    }
    await this.apply(
      { ...row, status: 'PROCESSING', providerRefundId },
      refund,
      owner,
    );
    return this.prisma.standardOrderRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { id: true, status: true, providerRefundId: true },
    });
  }

  private async apply(
    row: RefundWithCapture,
    refund: ProviderRefund,
    owner: string,
  ) {
    if (refund.state === 'PROCESSED')
      return this.complete(row.id, refund.rawStatus, false, owner);
    if (refund.state === 'FAILED' || refund.state === 'NEEDS_ATTENTION')
      return this.attention(
        row.id,
        `REFUND_PROVIDER_${refund.rawStatus.toUpperCase().replace(/-/g, '_')}`,
        ['PROCESSING'],
        null,
        owner,
      );
    return this.withOwnedLease(row.id, owner, ['PROCESSING'], async (tx) => {
      await tx.$executeRaw(Prisma.sql`
        WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
        UPDATE "StandardOrderRefund" SET "lockedAt"=NULL,"leaseToken"=NULL,"lastError"=NULL,
          "nextAttemptAt"=clock.now+${POLL_MS}::bigint*INTERVAL '1 millisecond',"updatedAt"=clock.now
        FROM clock WHERE id=${row.id}::uuid
      `);
      return true;
    });
  }

  /**
   * The provider confirmed the refund. Money, escrow and order change together.
   * Lock order: capture → order → hold → refund row → brand → ledger.
   */
  private async complete(
    id: string,
    providerStatus: string,
    simulated: boolean,
    owner: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const head = await this.lockParents(tx, id);
      await this.escrow.lockHoldByOrderId(tx, head.orderId);
      await tx.$queryRaw`SELECT id FROM "StandardOrderRefund" WHERE id = ${id}::uuid FOR UPDATE`;
      const current = await tx.standardOrderRefund.findUniqueOrThrow({
        where: { id },
        include: {
          paymentAttempt: { select: { exchangeRateSnapshotId: true } },
        },
      });
      if (!(await ownsStandardRefundLease(tx, id, owner, ['PROCESSING'])))
        return false;
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
        where: {
          id: current.orderId,
          paymentStatus: { not: PaymentStatus.REFUNDED },
        },
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
      return true;
    });
  }

  private async attention(
    id: string,
    code: string,
    statuses: string[],
    providerRefundId: string | null,
    leaseToken: string,
  ) {
    return this.withOwnedLease(id, leaseToken, statuses, async (tx) => {
      await tx.standardOrderRefund.update({
        where: { id },
        data: {
          status: 'NEEDS_ATTENTION',
          lastError: code,
          leaseToken: null,
          lockedAt: null,
          ...(providerRefundId ? { providerRefundId } : {}),
        },
      });
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
          message:
            'A standard-order refund needs reconciliation before any further provider submission.',
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
      await this.attention(
        row.id,
        'REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED',
        ['SUBMITTING'],
        null,
        leaseToken,
      );
      return false;
    }
    const linked = await this.linkProviderResult(
      row.id,
      leaseToken,
      `simulated:${row.id}`,
    );
    if (!linked) return false;
    return this.complete(row.id, 'SIMULATED_PROCESSED', true, leaseToken);
  }

  /** Check ownership with a new database-clock statement after a real row-lock wait. */
  private async lockParents(tx: Tx, id: string) {
    const head = await tx.standardOrderRefund.findUniqueOrThrow({
      where: { id },
      select: { orderId: true, paymentAttemptId: true },
    });
    await tx.$queryRaw`SELECT id FROM "PaymentAttempt" WHERE id=${head.paymentAttemptId}::uuid FOR NO KEY UPDATE`;
    await tx.$queryRaw`SELECT "_id" FROM "Order" WHERE "_id"=${head.orderId}::uuid FOR NO KEY UPDATE`;
    return head;
  }

  private async linkProviderResult(
    id: string,
    owner: string,
    providerId: string,
  ) {
    let identityConflict = false;
    const linked = await this.withOwnedLease(
      id,
      owner,
      ['SUBMITTING'],
      async (tx) => {
        const count = await linkStandardRefundProvider(
          tx,
          id,
          providerId,
          POLL_MS,
        );
        identityConflict = count === 0;
        return count > 0;
      },
    );
    if (!linked) {
      if (identityConflict)
        await this.attention(
          id,
          'REFUND_PROVIDER_ID_ALREADY_LINKED',
          ['SUBMITTING'],
          null,
          owner,
        );
      await this.recordLateProviderResult(
        id,
        providerId,
        identityConflict
          ? 'REFUND_PROVIDER_ID_ALREADY_LINKED'
          : 'REFUND_SUBMISSION_LEASE_LOST',
      );
    }
    return linked;
  }

  private async withOwnedLease(
    id: string,
    owner: string,
    statuses: string[],
    work: (tx: Tx) => Promise<boolean>,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockParents(tx, id);
        if (!(await lockStandardRefundLease(tx, id, owner, statuses)))
          return false;
        return work(tx);
      },
      { timeout: 15000 },
    );
  }

  /** A late provider result is evidence, never permission to clear another claim. */
  private async recordLateProviderResult(
    id: string,
    providerRefundId: string,
    code = 'REFUND_SUBMISSION_LEASE_LOST',
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockParents(tx, id);
        await tx.$queryRaw(
          Prisma.sql`SELECT id FROM "StandardOrderRefund" WHERE id=${id}::uuid FOR UPDATE`,
        );
        const current = await tx.standardOrderRefund.findUniqueOrThrow({
          where: { id },
          select: {
            paymentAttemptId: true,
            orderId: true,
            status: true,
            providerRefundId: true,
          },
        });
        const metadata = {
          refundId: id,
          orderId: current.orderId,
          providerRefundId,
          code,
        };
        await tx.paymentEvent.upsert({
          where: {
            id: uuidv5(
              `standard-refund-late:${id}:${providerRefundId}`,
              uuidv5.URL,
            ),
          },
          create: {
            id: uuidv5(
              `standard-refund-late:${id}:${providerRefundId}`,
              uuidv5.URL,
            ),
            paymentAttemptId: current.paymentAttemptId,
            type: 'STANDARD_ORDER_REFUND_LATE_PROVIDER_RESULT',
            source: 'standard-order-refunds',
            payload: metadata,
          },
          update: {},
        });
        if (
          current.providerRefundId === providerRefundId &&
          ['PROCESSING', 'SETTLED'].includes(current.status)
        )
          return;
        await tx.operationalAlert.upsert({
          where: { dedupeKey: `standard-refund:${id}:attention` },
          create: {
            category: 'STANDARD_ORDER_REFUND',
            severity: 'ERROR',
            event: 'STANDARD_REFUND_LATE_PROVIDER_RESULT',
            entityType: 'StandardOrderRefund',
            entityId: id,
            dedupeKey: `standard-refund:${id}:attention`,
            message:
              'A late provider refund result was recorded without changing the current worker claim. Reconcile the recorded provider id if automatic recovery cannot link it.',
            metadata,
          },
          update: {
            occurrenceCount: { increment: 1 },
            lastSeenAt: new Date(),
            metadata,
          },
        });
      },
      { timeout: 15000 },
    );
  }

  /** Tell shoppers about committed settlements, after commit, once per refund. */
  async notifySettled() {
    if (!this.notifications) return 0;
    const rows = await this.prisma.standardOrderRefund.findMany({
      where: { status: 'SETTLED', buyerNotifiedAt: null },
      orderBy: { settledAt: 'asc' },
      take: BATCH,
      select: {
        id: true,
        orderId: true,
        settlementAmount: true,
        settlementCurrency: true,
        order: { select: { buyerId: true, status: true } },
      },
    });
    let sent = 0;
    for (const row of rows) {
      try {
        if (row.order.buyerId) {
          await this.notifications.create(
            row.order.buyerId,
            NotificationType.ORDER_STATUS_UPDATED,
            {
              notificationId: row.id,
              payload: {
                orderId: row.orderId,
                status: row.order.status,
                refundStatus: 'PROCESSED',
                targetUrl: `/orders/${row.orderId}`,
                message: `Your refund of ${row.settlementCurrency} ${row.settlementAmount.toFixed(2)} has been processed by the payment provider. Your bank may take up to 10 business days to show it.`,
              },
            },
          );
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

  private async load(
    id: string,
    db: Pick<Tx, 'standardOrderRefund'> = this.prisma,
  ): Promise<RefundWithCapture> {
    const row = await db.standardOrderRefund.findUnique({
      where: { id },
      include: {
        paymentAttempt: {
          select: {
            reference: true,
            provider: true,
            providerMode: true,
            providerTransactionId: true,
            amount: true,
            currency: true,
            settlementAmount: true,
            settlementCurrency: true,
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
