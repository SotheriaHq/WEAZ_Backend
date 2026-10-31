import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { v5 as uuidv5 } from 'uuid';
import { LedgerService } from 'src/finance/ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  RefundProviderClient,
  RefundProviderError,
  type ProviderRefund,
  type RefundGateway,
} from 'src/finance/refund-provider.client';
import {
  claimRefundSubmission,
  claimRefundPoll,
  claimRefundResolution,
  claimRefundReconciliation,
  loadDueRefunds,
  loadStaleRefunds,
  ownsRefundLease,
  linkRefundProvider,
  scheduleRefundRetry,
} from 'src/finance/refund-lease-query';
import { reserveFullOrderRefund } from './queue-refund-reservation';
import {
  loadQueueRefundContexts,
  type QueueRefundContext,
} from './queue-refund-query';

type Tx = Prisma.TransactionClient;
type Refund = QueueRefundContext;
type Gateway = RefundGateway;
type JsonObject = Record<string, unknown>;
type RefundNoticeContext = {
  customOrderId: string;
  paymentAttemptId: string;
  customOrder: { buyerId: string };
};
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const string = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const POLL_MS = 5 * 60_000;
const TABLE = 'CustomOrderQueueRefund' as const;
class GatewayFailure extends RefundProviderError {}

/** Every external response is applied only by its current database lease owner. */
@Injectable()
export class CustomOrderQueueRefundsService {
  private readonly logger = new Logger(CustomOrderQueueRefundsService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    @Optional()
    private readonly provider: RefundProviderClient = new RefundProviderClient(),
  ) {}

  async processPending(
    limit = 20,
  ): Promise<{ processed: number; attention: number }> {
    const take = Math.max(
      1,
      Math.min(Number.isFinite(limit) ? Math.floor(limit) : 20, 20),
    );
    let processed = 0,
      attention = 0;
    const stale = await loadStaleRefunds(this.prisma, 20, TABLE);
    for (let offset = 0; offset < stale.length; offset += 4) {
      await Promise.all(
        stale.slice(offset, offset + 4).map(async (item) => {
          try {
            const [row] = await loadQueueRefundContexts(this.prisma, {
              id: item.id,
            });
            if (
              row &&
              (await this.resolveUncertain(
                row,
                item.leaseToken,
                'GATEWAY_SUBMISSION_OUTCOME_UNKNOWN',
              ))
            )
              attention++;
          } catch {
            this.logger.error(
              `Queue refund recovery failed for ${item.id}; durable state retained`,
            );
          }
        }),
      );
    }
    const due = await loadDueRefunds(this.prisma, take, 5, TABLE);
    for (let offset = 0; offset < due.length; offset += 4) {
      await Promise.all(
        due.slice(offset, offset + 4).map(async ({ id }) => {
          try {
            if (await this.processOne(id)) processed++;
          } catch {
            this.logger.error(
              `Queue refund processing failed for ${id}; durable state retained`,
            );
          }
        }),
      );
    }
    return { processed, attention };
  }

  private async lockParents(
    tx: Tx,
    row: Refund,
    skipBusy = false,
  ): Promise<boolean> {
    const skip = skipBusy ? Prisma.sql`SKIP LOCKED` : Prisma.empty;
    const capture = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "PaymentAttempt" WHERE id=${row.paymentAttemptId}::uuid FOR NO KEY UPDATE ${skip}`,
    );
    if (!capture.length) return false;
    const order = await tx.$queryRaw<Array<{ id: string }>>(
      Prisma.sql`SELECT id FROM "CustomOrder" WHERE id=${row.customOrderId}::uuid FOR NO KEY UPDATE ${skip}`,
    );
    return order.length > 0;
  }

  private async withOwnedLease<T>(
    row: Refund,
    owner: string,
    statuses: readonly string[],
    apply: (tx: Tx, current: Refund) => Promise<T>,
  ): Promise<T | null> {
    return this.prisma.$transaction(
      async (tx) => {
        if (!(await this.lockParents(tx, row))) return null;
        await tx.$queryRaw`SELECT id FROM "CustomOrderQueueRefund" WHERE id=${row.id}::uuid FOR UPDATE`;
        if (!(await ownsRefundLease(tx, row.id, owner, statuses, TABLE)))
          return null;
        const current = await this.currentRefund(tx, row.id);
        if (
          current.paymentAttemptId !== row.paymentAttemptId ||
          current.customOrderId !== row.customOrderId
        )
          throw new ConflictException('REFUND_CONTEXT_CHANGED');
        return apply(tx, current);
      },
      { timeout: 15_000 },
    );
  }

  private async claim(row: Refund, owner: string): Promise<Refund | null> {
    return this.prisma.$transaction(
      async (tx) => {
        if (
          !(await this.lockParents(tx, row, true)) ||
          !(await claimRefundSubmission(tx, row.id, owner, 5, TABLE))
        )
          return null;
        const current = await this.currentRefund(tx, row.id);
        if (
          current.paymentAttemptId !== row.paymentAttemptId ||
          current.customOrderId !== row.customOrderId
        )
          throw new ConflictException('REFUND_CONTEXT_CHANGED');
        await this.reserve(tx, current);
        return current;
      },
      { timeout: 15_000 },
    );
  }

  private async processOne(id: string): Promise<boolean> {
    const [head] = await loadQueueRefundContexts(this.prisma, { id });
    if (!head) return false;
    if (head.status === 'PROCESSING') return this.poll(head);
    const owner = randomUUID();
    let row: Refund | null;
    try {
      row = await this.claim(head, owner);
    } catch (error) {
      if (error instanceof RefundProviderError)
        await this.attentionUnclaimed(head, error.code);
      else throw error;
      return false;
    }
    if (!row) return false;
    if (this.money(row.amount).isZero()) {
      await this.complete(row, 'ZERO_REFUND', owner, true);
      return true;
    }
    const mode = row.paymentAttempt.providerMode.toLowerCase();
    if (mode === 'mock') {
      if (
        !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
        process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED !== 'true'
      ) {
        await this.failOrResolve(
          row,
          owner,
          new GatewayFailure('REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED', true),
        );
        return false;
      }
      const providerId = `simulated:${row.id}`;
      if (
        !(await this.withOwnedLease(
          row,
          owner,
          ['SUBMITTING'],
          async (tx) =>
            (await linkRefundProvider(
              tx,
              row!.id,
              providerId,
              POLL_MS,
              TABLE,
            )) > 0,
        ))
      )
        return false;
      await this.complete(
        { ...row, providerRefundId: providerId },
        'SIMULATED_PROCESSED',
        owner,
        true,
      );
      return true;
    }
    let result: ProviderRefund;
    try {
      const target = this.providerTarget(row);
      await this.provider.verifyCapture(row.paymentAttempt);
      result = await this.provider.submit(
        row.paymentAttempt,
        target,
        `Queue refund ${row.id}`,
      );
    } catch (error) {
      await this.failOrResolve(
        row,
        owner,
        error instanceof RefundProviderError
          ? error
          : new GatewayFailure('REFUND_GATEWAY_OUTCOME_UNKNOWN', false),
      );
      return false;
    }
    if (!(await this.linkResult(row, owner, result))) return false;
    await this.applyProviderStatus(
      { ...row, providerRefundId: result.id, status: 'PROCESSING' },
      result,
      owner,
    );
    return true;
  }

  private async failOrResolve(
    row: Refund,
    owner: string,
    failure: RefundProviderError,
  ) {
    if (failure.definitelyNotSubmitted && row.attempts < 5) {
      await this.withOwnedLease(row, owner, ['SUBMITTING'], async (tx) => {
        await scheduleRefundRetry(
          tx,
          row.id,
          'FAILED',
          failure.code,
          Math.min(24 * 3_600_000, 60_000 * 2 ** row.attempts),
          TABLE,
        );
      });
    } else if (failure.definitelyNotSubmitted)
      await this.attention(row, owner, failure.code, ['SUBMITTING']);
    else await this.resolveUncertain(row, owner, failure.code);
  }

  private async linkResult(
    row: Refund,
    owner: string,
    result: ProviderRefund,
  ): Promise<boolean> {
    let refusalCode = 'REFUND_SUBMISSION_LEASE_LOST';
    const linked = await this.withOwnedLease(
      row,
      owner,
      ['SUBMITTING'],
      async (tx, current) => {
        if (
          !this.provider.matches(
            current.paymentAttempt,
            this.providerTarget(current),
            result,
          )
        ) {
          refusalCode = 'REFUND_GATEWAY_RESPONSE_MISMATCH';
          await this.writeAttention(
            tx,
            current,
            'REFUND_GATEWAY_RESPONSE_MISMATCH',
          );
          return false;
        }
        if (
          !(await linkRefundProvider(tx, current.id, result.id, POLL_MS, TABLE))
        ) {
          refusalCode = 'REFUND_PROVIDER_ID_ALREADY_LINKED';
          await this.writeAttention(
            tx,
            current,
            'REFUND_PROVIDER_ID_ALREADY_LINKED',
          );
          return false;
        }
        return true;
      },
    );
    if (!linked) await this.recordLateProviderResult(row, result, refusalCode);
    return linked === true;
  }

  private async resolveUncertain(
    row: Refund,
    previous: string | null,
    code: string,
  ): Promise<boolean> {
    const owner = randomUUID();
    if (
      !(await claimRefundResolution(
        this.prisma,
        row.id,
        previous,
        owner,
        TABLE,
      ))
    )
      return false;
    let found: ProviderRefund[] | null = null;
    try {
      found = await this.provider.findByNote(
        row.paymentAttempt,
        `Queue refund ${row.id}`,
        row.createdAt,
      );
    } catch {
      /* Unknown remains a manual reconciliation state. */
    }
    let matches = false;
    try {
      matches =
        found?.length === 1 &&
        this.provider.matches(
          row.paymentAttempt,
          this.providerTarget(row),
          found[0],
        );
    } catch {
      return (
        (await this.attention(
          row,
          owner,
          'REFUND_SNAPSHOT_RECONCILIATION_REQUIRED',
          ['SUBMITTING'],
        )) === true
      );
    }
    if (matches && found && (await this.linkResult(row, owner, found[0]))) {
      await this.applyProviderStatus(
        { ...row, status: 'PROCESSING', providerRefundId: found[0].id },
        found[0],
        owner,
      );
      return false;
    }
    return (await this.attention(row, owner, code, ['SUBMITTING'])) === true;
  }

  private async poll(row: Refund): Promise<boolean> {
    const owner = randomUUID();
    if (!(await claimRefundPoll(this.prisma, row.id, owner, POLL_MS, TABLE)))
      return false;
    const current = await this.currentRefund(this.prisma, row.id);
    let result: ProviderRefund;
    try {
      result = await this.provider.fetch(
        current.paymentAttempt,
        current.providerRefundId!,
      );
    } catch {
      await this.withOwnedLease(current, owner, ['PROCESSING'], async (tx) => {
        await scheduleRefundRetry(
          tx,
          row.id,
          'PROCESSING',
          'REFUND_STATUS_LOOKUP_UNAVAILABLE',
          POLL_MS,
          TABLE,
        );
      });
      return false;
    }
    return await this.applyProviderStatus(current, result, owner);
  }

  /** Signature-verified webhooks are hints; re-read the stored provider refund. */
  async handleWebhook(gateway: Gateway, payload: unknown): Promise<boolean> {
    const identity = this.provider.webhookIdentity(gateway, payload);
    if (!identity) return false;
    const rows = identity.providerRefundId
      ? await loadQueueRefundContexts(this.prisma, {
          gateway,
          providerRefundId: identity.providerRefundId,
        })
      : identity.transactionReference
        ? await loadQueueRefundContexts(this.prisma, {
            gateway,
            paymentReference: identity.transactionReference,
          })
        : [];
    for (let offset = 0; offset < rows.length; offset += 4)
      await Promise.all(
        rows.slice(offset, offset + 4).map((row) => this.poll(row)),
      );
    return rows.length > 0;
  }

  private async applyProviderStatus(
    row: Refund,
    result: ProviderRefund,
    owner: string,
  ): Promise<boolean> {
    let matches = false;
    try {
      matches = this.provider.matches(
        row.paymentAttempt,
        this.providerTarget(row),
        result,
      );
    } catch {
      await this.attention(
        row,
        owner,
        'REFUND_SNAPSHOT_RECONCILIATION_REQUIRED',
        ['PROCESSING'],
      );
      return false;
    }
    if (!matches || result.id !== row.providerRefundId) {
      await this.attention(row, owner, 'REFUND_STATUS_RESPONSE_MISMATCH', [
        'PROCESSING',
      ]);
      return false;
    }
    if (result.state === 'PROCESSED') {
      return (
        (await this.complete(row, result.rawStatus, owner, false, result)) ===
        true
      );
    }
    if (result.state === 'FAILED' || result.state === 'NEEDS_ATTENTION') {
      await this.attention(row, owner, `REFUND_PROVIDER_${result.state}`, [
        'PROCESSING',
      ]);
      return false;
    }
    return (
      (await this.withOwnedLease(row, owner, ['PROCESSING'], async (tx) => {
        await scheduleRefundRetry(
          tx,
          row.id,
          'PROCESSING',
          null,
          POLL_MS,
          TABLE,
        );
        return true;
      })) === true
    );
  }

  async reconcile(refundId: string, providerRefundId: string, actorId: string) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(providerRefundId))
      throw new ConflictException('REFUND_PROVIDER_ID_INVALID');
    const row = await this.currentRefund(this.prisma, refundId);
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
        await this.lockParents(tx, row);
        if (!(await claimRefundReconciliation(tx, refundId, owner, TABLE)))
          throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
        await tx.paymentEvent.create({
          data: {
            paymentAttemptId: row.paymentAttemptId,
            type: 'CUSTOM_ORDER_QUEUE_REFUND_RECONCILIATION_STARTED',
            source: 'custom-order-queue-refunds',
            payload: { refundId, providerRefundId, actorId },
          },
        });
      },
      { timeout: 15_000 },
    );
    let result: ProviderRefund;
    try {
      result = await this.provider
        .fetch(row.paymentAttempt, providerRefundId)
        .catch(() => {
          throw new ConflictException(
            'REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE',
          );
        });
      if (
        !this.provider.matches(
          row.paymentAttempt,
          this.providerTarget(row),
          result,
        )
      )
        throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_MISMATCH');
      const applied = await this.withOwnedLease(
        row,
        owner,
        ['NEEDS_ATTENTION'],
        async (tx, current) => {
          if (
            current.providerRefundId &&
            current.providerRefundId !== providerRefundId
          )
            throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
          if (
            !this.provider.matches(
              current.paymentAttempt,
              this.providerTarget(current),
              result,
            )
          )
            throw new ConflictException(
              'REFUND_PROVIDER_RECONCILIATION_MISMATCH',
            );
          await this.reserve(tx, current);
          if (
            !(await linkRefundProvider(
              tx,
              refundId,
              providerRefundId,
              POLL_MS,
              TABLE,
            ))
          )
            throw new ConflictException('REFUND_PROVIDER_ID_ALREADY_LINKED');
          await tx.paymentEvent.create({
            data: {
              paymentAttemptId: current.paymentAttemptId,
              type: 'CUSTOM_ORDER_QUEUE_REFUND_RECONCILED',
              source: 'custom-order-queue-refunds',
              payload: {
                refundId,
                customOrderId: current.customOrderId,
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
      await this.attention(row, owner, code, ['NEEDS_ATTENTION']);
      throw error;
    }
    await this.applyProviderStatus(
      { ...row, providerRefundId, status: 'PROCESSING' },
      result,
      owner,
    );
    return this.prisma.customOrderQueueRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { id: true, status: true, providerRefundId: true },
    });
  }

  private async attention(
    row: Refund,
    owner: string,
    code: string,
    statuses: string[],
  ) {
    return this.withOwnedLease(row, owner, statuses, (tx, current) =>
      this.writeAttention(tx, current, code),
    );
  }

  private async attentionUnclaimed(row: Refund, code: string) {
    return this.prisma.$transaction(
      async (tx) => {
        await this.lockParents(tx, row);
        await tx.$queryRaw`SELECT id FROM "CustomOrderQueueRefund" WHERE id=${row.id}::uuid FOR UPDATE`;
        const current = await this.currentRefund(tx, row.id);
        if (
          !['REQUESTED', 'FAILED'].includes(current.status) ||
          current.leaseToken
        )
          return false;
        return this.writeAttention(tx, current, code);
      },
      { timeout: 15_000 },
    );
  }

  private async writeAttention(tx: Tx, row: Refund, code: string) {
    await tx.$executeRaw`UPDATE "CustomOrderQueueRefund" SET status='NEEDS_ATTENTION',"lastError"=${code},"lockedAt"=NULL,"leaseToken"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE id=${row.id}::uuid`;
    await tx.operationalAlert.upsert({
      where: { dedupeKey: `queue-refund:${row.id}:attention` },
      create: {
        category: 'CUSTOM_ORDER_QUEUE',
        severity: 'ERROR',
        event: 'QUEUE_REFUND_NEEDS_ATTENTION',
        entityType: TABLE,
        entityId: row.id,
        dedupeKey: `queue-refund:${row.id}:attention`,
        message:
          'A custom-order refund requires reconciliation before further submission.',
        metadata: { customOrderId: row.customOrderId, code },
      },
      update: {
        occurrenceCount: { increment: 1 },
        status: 'OPEN',
        resolvedAt: null,
        lastSeenAt: new Date(),
        metadata: { customOrderId: row.customOrderId, code },
      },
    });
    await tx.paymentEvent.create({
      data: {
        paymentAttemptId: row.paymentAttemptId,
        type: 'CUSTOM_ORDER_QUEUE_REFUND_NEEDS_ATTENTION',
        source: 'custom-order-queue-refunds',
        payload: { refundId: row.id, customOrderId: row.customOrderId, code },
      },
    });
    await this.notify(
      tx,
      row,
      'QUEUE_REFUND_NEEDS_ATTENTION',
      'Your custom-order refund needs WIEZ attention. Your request remains recorded. You can contact WIEZ through your order conversation.',
    );
    return true;
  }

  private async recordLateProviderResult(
    row: Refund,
    result: ProviderRefund,
    code = 'REFUND_SUBMISSION_LEASE_LOST',
  ) {
    await this.prisma.$transaction(
      async (tx) => {
        await this.lockParents(tx, row);
        await tx.$queryRaw`SELECT id FROM "CustomOrderQueueRefund" WHERE id=${row.id}::uuid FOR UPDATE`;
        const current = await this.currentRefund(tx, row.id);
        if (
          ['PROCESSING', 'SETTLED'].includes(current.status) &&
          current.providerRefundId === result.id
        )
          return;
        const payload = {
          refundId: row.id,
          customOrderId: row.customOrderId,
          providerRefundId: result.id,
          code,
        };
        await tx.paymentEvent.upsert({
          where: {
            id: uuidv5(
              `custom-order-refund:${row.id}:${result.id}`,
              uuidv5.URL,
            ),
          },
          create: {
            id: uuidv5(
              `custom-order-refund:${row.id}:${result.id}`,
              uuidv5.URL,
            ),
            paymentAttemptId: row.paymentAttemptId,
            type: 'CUSTOM_ORDER_QUEUE_REFUND_LATE_PROVIDER_RESULT',
            source: 'custom-order-queue-refunds',
            payload,
          },
          update: {},
        });
        await tx.operationalAlert.upsert({
          where: { dedupeKey: `queue-refund:${row.id}:attention` },
          create: {
            category: 'CUSTOM_ORDER_QUEUE',
            severity: 'ERROR',
            event: 'QUEUE_REFUND_LATE_PROVIDER_RESULT',
            entityType: TABLE,
            entityId: row.id,
            dedupeKey: `queue-refund:${row.id}:attention`,
            message:
              'A late provider result needs linking without repeating the refund.',
            metadata: payload,
          },
          update: {
            metadata: payload,
            status: 'OPEN',
            resolvedAt: null,
            lastSeenAt: new Date(),
          },
        });
      },
      { timeout: 15_000 },
    );
  }

  private money(value: unknown): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(String(value ?? 'NaN'));
    } catch {
      throw new GatewayFailure('REFUND_INVALID_MONEY_SNAPSHOT', false);
    }
    if (!amount.isFinite() || amount.isNegative() || amount.decimalPlaces() > 2)
      throw new GatewayFailure('REFUND_INVALID_MONEY_SNAPSHOT', false);
    return amount;
  }

  private async currentRefund(tx: Tx, id: string): Promise<Refund> {
    const [row] = await loadQueueRefundContexts(tx, { id });
    if (!row) throw new NotFoundException('Queue refund not found');
    return row;
  }

  private async reserve(tx: Tx, row: Refund) {
    const quote = object(row.breakdownJson);
    const captured = this.money(quote.captureAmount);
    const vat = this.money(quote.vatAmount ?? 0);
    const charge = this.money(quote.garmentCharge).plus(
      this.money(quote.jumpCharge ?? 0),
    );
    const refund = this.money(row.amount);
    if (
      !captured.equals(refund.plus(vat).plus(charge)) ||
      !refund.equals(this.money(quote.refundAmount)) ||
      row.currency !== row.paymentAttempt.currency ||
      row.currency !== quote.currency ||
      refund.greaterThan(row.paymentAttempt.amount) ||
      (quote.refundKind !== 'POST_ACTIVE_PARTIAL' &&
        (row.customOrder.lane !== 'TERMINAL' || !row.customOrder.cancelledAt))
    )
      throw new GatewayFailure(
        'REFUND_SNAPSHOT_RECONCILIATION_REQUIRED',
        false,
      );
    if (
      ['POST_ACTIVE_FULL', 'POST_ACTIVE_PARTIAL'].includes(
        String(quote.refundKind),
      )
    ) {
      await reserveFullOrderRefund(tx, this.ledger, {
        id: row.id,
        customOrderId: row.customOrderId,
        brandId: row.customOrder.brandId,
        currency: row.currency,
        reservationKey:
          typeof quote.reservationKey === 'string'
            ? quote.reservationKey
            : undefined,
        captureAmount: captured.toNumber(),
        releasedNet: this.money(quote.releasedNet).toNumber(),
        releasedCommission: this.money(quote.releasedCommission).toNumber(),
        unreleasedGross: this.money(quote.unreleasedGross).toNumber(),
      });
      return;
    }
    await this.ledger.postTransaction(tx, {
      idempotencyKey: `ledger:custom-order:${row.customOrderId}:queue_refund_reserved`,
      type: 'REVERSAL',
      referenceType: 'CustomOrderQueueRefund',
      referenceId: row.id,
      currency: row.currency,
      totalAmount: captured.toNumber(),
      description:
        'Reserve cancelled waiting-order refund and approved deductions',
      lines: [
        {
          code: 'SYSTEM:CUSTOM_ORDER_ESCROW',
          name: 'Custom Order Escrow',
          type: 'LIABILITY',
          subType: 'CUSTOM_ORDER_ESCROW',
          isSystemAccount: true,
          direction: 'DEBIT',
          amount: captured.toNumber(),
        },
        {
          code: 'SYSTEM:REFUND_PAYABLE',
          name: 'Refund Payable',
          type: 'LIABILITY',
          subType: 'REFUND_PAYABLE',
          isSystemAccount: true,
          direction: 'CREDIT',
          amount: refund.toNumber(),
        },
        {
          code: 'SYSTEM:VAT_PAYABLE',
          name: 'VAT Payable',
          type: 'LIABILITY',
          subType: 'VAT_PAYABLE',
          isSystemAccount: true,
          direction: 'CREDIT',
          amount: vat.toNumber(),
        },
        {
          code: 'SYSTEM:PLATFORM_COMMISSION_REVENUE',
          name: 'Platform Commission Revenue',
          type: 'REVENUE',
          subType: 'PLATFORM_COMMISSION',
          isSystemAccount: true,
          direction: 'CREDIT',
          amount: charge.toNumber(),
        },
      ],
    });
  }

  private providerTarget(row: Refund): {
    amount: Prisma.Decimal;
    currency: string;
  } {
    const target = { amount: this.money(row.amount), currency: row.currency };
    if (
      row.currency !== row.paymentAttempt.currency ||
      target.amount.greaterThan(row.paymentAttempt.amount)
    ) {
      throw new GatewayFailure(
        'REFUND_SNAPSHOT_RECONCILIATION_REQUIRED',
        false,
      );
    }
    const saved = object(object(row.breakdownJson).settlement);
    if (saved.status === 'RECORDED' && typeof saved.currency === 'string') {
      const amount = this.money(saved.amount);
      if (
        saved.currency !== row.paymentAttempt.settlementCurrency ||
        amount.greaterThan(
          row.paymentAttempt.settlementAmount ?? row.paymentAttempt.amount,
        )
      )
        throw new GatewayFailure('REFUND_SETTLEMENT_SNAPSHOT_MISMATCH', false);
      return target;
    }
    // Older same-currency requests need no conversion; foreign-currency requests require their original snapshot.
    if (
      !Object.keys(saved).length &&
      (!row.paymentAttempt.settlementCurrency ||
        row.paymentAttempt.settlementCurrency === row.currency)
    )
      return { amount: this.money(row.amount), currency: row.currency };
    throw new GatewayFailure(
      string(saved.reason) || 'REFUND_ORIGINAL_FX_SNAPSHOT_MISSING',
      false,
    );
  }

  private async notify(
    tx: Tx,
    row: RefundNoticeContext,
    stage: string,
    message: string,
  ) {
    await tx.customOrderTimelineEvent.create({
      data: {
        customOrderId: row.customOrderId,
        actorType: 'SYSTEM',
        eventType: 'QUEUE_UPDATED',
        payloadJson: { kind: stage, message },
      },
    });
    await tx.customOrderNotificationOutbox.create({
      data: {
        customOrderId: row.customOrderId,
        recipientId: row.customOrder.buyerId,
        notificationType: NotificationType.CUSTOM_ORDER_PROGRESS_UPDATED,
        payloadJson: {
          customOrderId: row.customOrderId,
          stage,
          message,
          targetUrl: `/profile?tab=orders&customOrderId=${row.customOrderId}`,
        },
        targetJson: { type: 'CUSTOM_ORDER', id: row.customOrderId },
        dedupeMs: 0,
      },
    });
  }

  private async complete(
    row: Refund,
    providerStatus: string,
    owner: string,
    simulated = false,
    verified?: ProviderRefund,
  ) {
    return this.withOwnedLease(
      row,
      owner,
      ['PROCESSING', ...(simulated ? ['SUBMITTING'] : [])],
      async (tx, current) => {
        if (
          verified &&
          (!this.provider.matches(
            current.paymentAttempt,
            this.providerTarget(current),
            verified,
          ) ||
            current.providerRefundId !== verified.id)
        )
          throw new GatewayFailure('REFUND_CURRENT_SNAPSHOT_MISMATCH', false);
        await this.reserve(tx, current);
        const amount = this.money(current.amount).toNumber();
        const settlement = object(object(current.breakdownJson).settlement);
        await this.ledger.postTransaction(tx, {
          idempotencyKey: `ledger:custom-order:${current.customOrderId}:queue_refund_settled:${current.id}`,
          type: 'REFUND_ISSUED',
          referenceType: 'CustomOrderQueueRefund',
          referenceId: current.id,
          totalAmount: amount,
          currency: current.currency,
          ...(settlement.status === 'RECORDED'
            ? {
                baseCurrency: String(settlement.currency),
                baseCurrencyAmount: this.money(settlement.amount).toNumber(),
                fxRateSnapshotId:
                  typeof settlement.exchangeRateSnapshotId === 'string'
                    ? settlement.exchangeRateSnapshotId
                    : null,
              }
            : {}),
          description: 'Gateway confirmed waiting-order refund processed',
          lines: [
            {
              code: 'SYSTEM:REFUND_PAYABLE',
              name: 'Refund Payable',
              type: 'LIABILITY',
              subType: 'REFUND_PAYABLE',
              isSystemAccount: true,
              direction: 'DEBIT',
              amount,
            },
            {
              code: 'SYSTEM:GATEWAY_RECEIVABLES',
              name: 'Gateway Receivables',
              type: 'ASSET',
              subType: 'GATEWAY_RECEIVABLES',
              isSystemAccount: true,
              direction: 'CREDIT',
              amount,
            },
          ],
        });
        await tx.$executeRaw`UPDATE "CustomOrderQueueRefund" SET status='SETTLED',"settledAt"=clock_timestamp() AT TIME ZONE 'UTC',"lockedAt"=NULL,"leaseToken"=NULL,"lastError"=NULL,"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC' WHERE id=${current.id}::uuid`;
        await tx.customOrder.update({
          where: { id: current.customOrderId },
          data: {
            ...(object(current.breakdownJson).refundKind ===
            'POST_ACTIVE_PARTIAL'
              ? {}
              : { status: 'CLOSED', paymentStatus: 'REFUNDED' }),
            orderRevision: { increment: 1 },
          },
        });
        // A unified capture stays paid while its other lines/deductions remain.
        await tx.paymentEvent.create({
          data: {
            paymentAttemptId: current.paymentAttemptId,
            type: 'CUSTOM_ORDER_QUEUE_REFUND_SETTLED',
            source: 'custom-order-queue-refunds',
            payload: {
              refundId: current.id,
              customOrderId: current.customOrderId,
              amount,
              currency: current.currency,
              providerStatus,
              simulated,
            },
          },
        });
        await this.notify(
          tx,
          current,
          'QUEUE_REFUND_PROCESSED',
          `Your custom-order refund of ${current.currency} ${amount.toFixed(2)} has been processed by the payment provider. Your bank may still need time to credit it.`,
        );
        await tx.operationalAlert.updateMany({
          where: {
            dedupeKey: `queue-refund:${current.id}:attention`,
            status: 'OPEN',
          },
          data: { status: 'RESOLVED', resolvedAt: new Date() },
        });
        return true;
      },
    );
  }
}
