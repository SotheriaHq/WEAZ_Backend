import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { LedgerService } from 'src/finance/ledger.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { reserveFullOrderRefund } from './queue-refund-reservation';
import {
  loadQueueRefundContexts,
  QueueRefundContext,
} from './queue-refund-query';

type Tx = Prisma.TransactionClient;
type Refund = QueueRefundContext;
type Gateway = 'PAYSTACK' | 'FLUTTERWAVE';
type JsonObject = Record<string, unknown>;
type RefundNoticeContext = {
  customOrderId: string;
  paymentAttemptId: string;
  customOrder: { buyerId: string };
};
const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' ? (value as JsonObject) : {};
const string = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';
const LEASE_MS = 10 * 60000;
const POLL_MS = 5 * 60000;

class GatewayFailure extends Error {
  constructor(
    readonly code: string,
    readonly definitelyNotSubmitted: boolean,
  ) {
    super(code);
  }
}

/** A cancellation request, gateway acceptance and gateway completion are distinct durable states. */
@Injectable()
export class CustomOrderQueueRefundsService {
  private readonly logger = new Logger(CustomOrderQueueRefundsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
  ) {}

  async processPending(
    limit = 20,
  ): Promise<{ processed: number; attention: number }> {
    const now = new Date();
    const stale = await this.prisma.customOrderQueueRefund.findMany({
      where: {
        status: 'SUBMITTING',
        lockedAt: { lt: new Date(+now - LEASE_MS) },
      },
      select: { id: true },
      take: 20,
      orderBy: { lockedAt: 'asc' },
    });
    let attention = 0;
    for (const row of stale)
      if (
        await this.attention(row.id, 'GATEWAY_SUBMISSION_OUTCOME_UNKNOWN', [
          'SUBMITTING',
        ])
      )
        attention++;
    const rows = await this.prisma.customOrderQueueRefund.findMany({
      where: {
        nextAttemptAt: { lte: now },
        OR: [
          {
            status: { in: ['REQUESTED', 'FAILED'] },
            providerRefundId: null,
            attempts: { lt: 5 },
          },
          {
            status: 'PROCESSING',
            providerRefundId: { not: null },
            OR: [
              { lockedAt: null },
              { lockedAt: { lt: new Date(+now - LEASE_MS) } },
            ],
          },
        ],
      },
      select: { id: true },
      take: Math.max(
        1,
        Math.min(Number.isFinite(limit) ? Math.floor(limit) : 20, 20),
      ),
      orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
    });
    let processed = 0;
    for (let offset = 0; offset < rows.length; offset += 4) {
      await Promise.all(
        rows.slice(offset, offset + 4).map(async ({ id }) => {
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

  private money(value: unknown): Prisma.Decimal {
    const amount = new Prisma.Decimal(String(value ?? 'NaN'));
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

  private async claim(id: string): Promise<Refund | null> {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.customOrderQueueRefund.updateMany({
        where: {
          id,
          status: { in: ['REQUESTED', 'FAILED'] },
          providerRefundId: null,
          attempts: { lt: 5 },
          nextAttemptAt: { lte: new Date() },
        },
        data: {
          status: 'SUBMITTING',
          lockedAt: new Date(),
          attempts: { increment: 1 },
          lastError: null,
        },
      });
      if (!claimed.count) return null;
      const row = await this.currentRefund(tx, id);
      await this.reserve(tx, row);
      return row;
    });
  }

  private async processOne(id: string): Promise<boolean> {
    const [existing] = await loadQueueRefundContexts(this.prisma, { id });
    if (!existing) return false;
    if (existing.status === 'PROCESSING') return this.poll(existing);
    let row: Refund | null;
    try {
      row = await this.claim(id);
    } catch (error) {
      if (error instanceof GatewayFailure)
        await this.attention(id, error.code, ['REQUESTED', 'FAILED']);
      else throw error;
      return false;
    }
    if (!row) return false;
    if (this.money(row.amount).isZero()) {
      await this.complete(row, 'ZERO_REFUND', true);
      return true;
    }
    try {
      const mode = row.paymentAttempt.providerMode.toLowerCase();
      if (mode === 'mock') {
        if (
          !['development', 'test'].includes(process.env.NODE_ENV ?? '') ||
          process.env.CUSTOM_ORDER_QUEUE_REFUND_SIMULATION_ENABLED !== 'true'
        ) {
          throw new GatewayFailure(
            'REFUND_SIMULATION_NOT_EXPLICITLY_ENABLED',
            true,
          );
        }
        const id = `simulated:${row.id}`;
        await this.prisma.customOrderQueueRefund.update({
          where: { id: row.id },
          data: { providerRefundId: id, status: 'PROCESSING', lockedAt: null },
        });
        await this.complete(
          { ...row, providerRefundId: id },
          'SIMULATED_PROCESSED',
          true,
        );
        return true;
      }
      if (mode !== 'live' && mode !== 'test')
        throw new GatewayFailure('REFUND_UNKNOWN_PROVIDER_MODE', true);
      const gateway = this.gateway(row);
      const secret = this.secret(gateway, mode);
      const settlement = this.providerSettlement(row);
      await this.verifyCapture(row, gateway, secret);
      const url =
        gateway === 'PAYSTACK'
          ? 'https://api.paystack.co/refund'
          : `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(this.flutterwaveTransaction(row))}/refund`;
      const body =
        gateway === 'PAYSTACK'
          ? {
              transaction: row.paymentAttempt.reference,
              amount: settlement.amount.times(100).toNumber(),
              currency: settlement.currency,
              merchant_note: `Queue refund ${row.id}`,
            }
          : {
              amount: settlement.amount.toNumber(),
              comments: `Queue refund ${row.id}`,
            };
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${secret}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok)
        throw new GatewayFailure(
          `REFUND_GATEWAY_HTTP_${response.status}`,
          [400, 401, 403, 404, 422].includes(response.status),
        );
      const payload = object(await response.json());
      const data = object(payload.data);
      if (payload.status !== true && payload.status !== 'success')
        throw new GatewayFailure('REFUND_GATEWAY_RESPONSE_UNCERTAIN', false);
      const providerId = string(data.id);
      if (!providerId)
        throw new GatewayFailure('REFUND_GATEWAY_RESPONSE_MISMATCH', false);
      const saved = await this.prisma.customOrderQueueRefund.updateMany({
        where: { id: row.id, status: 'SUBMITTING' },
        data: {
          providerRefundId: providerId,
          status: 'PROCESSING',
          lockedAt: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
          lastError: null,
        },
      });
      if (saved.count) {
        const current = { ...row, providerRefundId: providerId };
        const normalized = await this.normalizeProviderData(
          current,
          gateway,
          data,
        );
        if (!this.matches(current, gateway, normalized))
          throw new GatewayFailure('REFUND_GATEWAY_RESPONSE_MISMATCH', false);
        await this.applyProviderStatus(current, gateway, normalized);
      }
      return true;
    } catch (error) {
      const failure =
        error instanceof GatewayFailure
          ? error
          : new GatewayFailure('REFUND_GATEWAY_OUTCOME_UNKNOWN', false);
      if (failure.definitelyNotSubmitted && row.attempts < 5) {
        await this.prisma.customOrderQueueRefund.updateMany({
          where: { id, status: 'SUBMITTING' },
          data: {
            status: 'FAILED',
            lockedAt: null,
            lastError: failure.code,
            nextAttemptAt: new Date(
              Date.now() + Math.min(24 * 3600000, 60000 * 2 ** row.attempts),
            ),
          },
        });
      } else
        await this.attention(id, failure.code, ['SUBMITTING', 'PROCESSING']);
      return false;
    }
  }

  private gateway(row: Refund): Gateway {
    const value = row.paymentAttempt.provider.toUpperCase();
    if (value !== 'PAYSTACK' && value !== 'FLUTTERWAVE')
      throw new GatewayFailure('REFUND_UNSUPPORTED_PROVIDER', true);
    return value;
  }

  private secret(gateway: Gateway, mode: string): string {
    const secret =
      process.env[
        gateway === 'PAYSTACK'
          ? 'PAYSTACK_SECRET_KEY'
          : 'FLUTTERWAVE_SECRET_KEY'
      ];
    if (!secret)
      throw new GatewayFailure('REFUND_PROVIDER_CREDENTIALS_UNAVAILABLE', true);
    if (
      (gateway === 'PAYSTACK' &&
        mode === 'test' &&
        !secret.startsWith('sk_test_')) ||
      (gateway === 'FLUTTERWAVE' &&
        mode === 'test' &&
        !secret.includes('_TEST'))
    )
      throw new GatewayFailure(
        'REFUND_PROVIDER_MODE_CREDENTIAL_MISMATCH',
        true,
      );
    return secret;
  }

  private providerSettlement(row: Refund): {
    amount: Prisma.Decimal;
    currency: string;
  } {
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
      return { amount, currency: saved.currency };
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

  private async verifyCapture(row: Refund, gateway: Gateway, secret: string) {
    const url =
      gateway === 'PAYSTACK'
        ? `https://api.paystack.co/transaction/verify/${encodeURIComponent(row.paymentAttempt.reference)}`
        : `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(this.flutterwaveTransaction(row))}/verify`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new GatewayFailure('REFUND_CAPTURE_VERIFICATION_UNAVAILABLE', true);
    const payload = object(await response.json()),
      data = object(payload.data);
    const expectedCurrency =
      row.paymentAttempt.settlementCurrency || row.paymentAttempt.currency;
    const expectedAmount =
      row.paymentAttempt.settlementAmount ?? row.paymentAttempt.amount;
    const amount = this.money(data.amount).dividedBy(
      gateway === 'PAYSTACK' ? 100 : 1,
    );
    if (
      (payload.status !== true && payload.status !== 'success') ||
      !['success', 'successful'].includes(string(data.status).toLowerCase()) ||
      string(data.reference ?? data.tx_ref) !== row.paymentAttempt.reference ||
      (row.paymentAttempt.providerTransactionId &&
        string(data.id) !== row.paymentAttempt.providerTransactionId) ||
      string(data.currency).toUpperCase() !== expectedCurrency.toUpperCase() ||
      !amount.equals(expectedAmount)
    ) {
      throw new GatewayFailure(
        'REFUND_ORIGINAL_CAPTURE_VERIFICATION_MISMATCH',
        true,
      );
    }
  }

  private flutterwaveTransaction(row: Refund): string {
    const id = row.paymentAttempt.providerTransactionId;
    if (!id || !/^\d+$/.test(id))
      throw new GatewayFailure('REFUND_PROVIDER_TRANSACTION_ID_MISSING', true);
    return id;
  }

  private matches(
    row: Refund,
    gateway: Gateway,
    data: JsonObject,
    checkId = true,
  ): boolean {
    try {
      const transaction = object(data.transaction);
      const reference = string(
        data.transaction_reference ?? data.tx_ref ?? transaction.reference,
      );
      const transactionId = string(
        data.transaction_id ??
          transaction.id ??
          (typeof data.transaction !== 'object' ? data.transaction : ''),
      );
      const sameTransaction =
        reference === row.paymentAttempt.reference ||
        Boolean(
          row.paymentAttempt.providerTransactionId &&
            transactionId === row.paymentAttempt.providerTransactionId,
        );
      const amount = this.money(data.amount);
      const normalized =
        gateway === 'PAYSTACK' ? amount.dividedBy(100) : amount;
      const settlement = this.providerSettlement(row);
      return (
        sameTransaction &&
        (!checkId || string(data.id) === row.providerRefundId) &&
        string(data.currency).toUpperCase() ===
          settlement.currency.toUpperCase() &&
        normalized.equals(settlement.amount)
      );
    } catch {
      return false;
    }
  }

  private async normalizeProviderData(
    row: Refund,
    gateway: Gateway,
    data: JsonObject,
  ): Promise<JsonObject> {
    if (gateway !== 'FLUTTERWAVE') return data;
    const normalized = {
      ...data,
      amount: data.amount_refunded ?? data.AmountRefunded ?? data.amount,
      transaction_id: data.tx_id ?? data.TransactionId ?? data.transaction_id,
    };
    if (data.currency) return normalized;
    const id = string(normalized.transaction_id);
    if (!id || id !== row.paymentAttempt.providerTransactionId)
      throw new GatewayFailure('REFUND_PROVIDER_TRANSACTION_MISMATCH', false);
    const secret = this.secret(
      gateway,
      row.paymentAttempt.providerMode.toLowerCase(),
    );
    const response = await fetch(
      `https://api.flutterwave.com/v3/transactions/${encodeURIComponent(id)}/verify`,
      {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15000),
      },
    );
    if (!response.ok)
      throw new GatewayFailure(
        'REFUND_TRANSACTION_VERIFICATION_UNAVAILABLE',
        false,
      );
    const payload = object(await response.json());
    const verified = object(payload.data);
    if (
      payload.status !== 'success' ||
      string(verified.id) !== id ||
      string(verified.tx_ref) !== row.paymentAttempt.reference ||
      string(verified.currency) !== this.providerSettlement(row).currency
    )
      throw new GatewayFailure(
        'REFUND_TRANSACTION_VERIFICATION_MISMATCH',
        false,
      );
    return {
      ...normalized,
      currency: verified.currency,
      tx_ref: verified.tx_ref,
    };
  }

  private async poll(row: Refund): Promise<boolean> {
    const claimed = await this.prisma.customOrderQueueRefund.updateMany({
      where: {
        id: row.id,
        status: 'PROCESSING',
        OR: [
          { lockedAt: null },
          { lockedAt: { lt: new Date(Date.now() - LEASE_MS) } },
        ],
      },
      data: {
        lockedAt: new Date(),
        nextAttemptAt: new Date(Date.now() + POLL_MS),
      },
    });
    if (!claimed.count) return false;
    try {
      const gateway = this.gateway(row);
      const secret = this.secret(
        gateway,
        row.paymentAttempt.providerMode.toLowerCase(),
      );
      const url =
        gateway === 'PAYSTACK'
          ? `https://api.paystack.co/refund/${encodeURIComponent(row.providerRefundId!)}`
          : `https://api.flutterwave.com/v3/refunds/${encodeURIComponent(row.providerRefundId!)}`;
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${secret}` },
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error('REFUND_STATUS_LOOKUP_UNAVAILABLE');
      const payload = object(await response.json());
      const data = await this.normalizeProviderData(
        row,
        gateway,
        object(payload.data),
      );
      if (
        (payload.status !== true && payload.status !== 'success') ||
        !this.matches(row, gateway, data)
      ) {
        await this.attention(row.id, 'REFUND_STATUS_RESPONSE_MISMATCH', [
          'PROCESSING',
        ]);
        return false;
      }
      await this.applyProviderStatus(row, gateway, data);
      return true;
    } catch {
      // Repeating a status lookup is safe. Repeating an uncertain refund creation is not.
      await this.prisma.customOrderQueueRefund.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: {
          lockedAt: null,
          lastError: 'REFUND_STATUS_LOOKUP_UNAVAILABLE',
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      return false;
    }
  }

  /** Caller must validate the original provider signature before entering this method. */
  async handleWebhook(gateway: Gateway, payload: unknown): Promise<boolean> {
    const envelope = object(payload);
    const event = string(
      envelope.event ?? envelope['event.type'],
    ).toLowerCase();
    const rawFlutterwaveRefund =
      gateway === 'FLUTTERWAVE' &&
      envelope.TransactionId != null &&
      envelope.AmountRefunded != null;
    if (!event.includes('refund') && !rawFlutterwaveRefund) return false;
    const rawData = rawFlutterwaveRefund ? envelope : object(envelope.data);
    const data = rawData;
    const providerId = string(data.id ?? data.refund_id);
    if (providerId) {
      const [row] = await loadQueueRefundContexts(this.prisma, {
        providerRefundId: providerId,
        gateway,
      });
      if (!row) return false;
      try {
        const normalized = await this.normalizeProviderData(row, gateway, {
          ...data,
          id: providerId,
        });
        if (!this.matches(row, gateway, normalized)) {
          await this.attention(row.id, 'REFUND_WEBHOOK_IDENTITY_MISMATCH', [
            'PROCESSING',
          ]);
          return true;
        }
        await this.applyProviderStatus(row, gateway, normalized);
      } catch {
        await this.attention(row.id, 'REFUND_WEBHOOK_VERIFICATION_REQUIRED', [
          'PROCESSING',
        ]);
      }
      return true;
    }
    // Paystack may omit the refund ID in webhooks. Read each stored ID from the provider,
    // so equal-price sibling refunds cannot be confused with one another.
    const reference = string(data.transaction_reference ?? data.tx_ref);
    if (!reference) return false;
    const rows = await loadQueueRefundContexts(this.prisma, {
      paymentReference: reference,
      gateway,
    });
    for (const row of rows) await this.poll(row);
    return rows.length > 0;
  }

  private async applyProviderStatus(
    row: Refund,
    gateway: Gateway,
    data: JsonObject,
  ) {
    const state = string(data.status).toLowerCase().replace(/_/g, '-');
    let meta = object(data.meta);
    if (typeof data.meta === 'string') {
      try {
        meta = object(JSON.parse(data.meta));
      } catch {
        meta = {};
      }
    }
    if (
      gateway === 'FLUTTERWAVE' &&
      string(meta.disburse_status).toLowerCase() === 'failed'
    ) {
      await this.attention(row.id, 'REFUND_PROVIDER_DISBURSEMENT_FAILED', [
        'PROCESSING',
      ]);
      return;
    }
    const flutterwaveSettled = [
      'completed-bank-transfer',
      'completed-momo',
      'completed-mpgs',
      'completed-offline',
      'completed-preauth',
    ];
    if (
      (gateway === 'PAYSTACK' && state === 'processed') ||
      (gateway === 'FLUTTERWAVE' && flutterwaveSettled.includes(state))
    )
      await this.complete(row, state);
    else if (['failed', 'needs-attention', 'cancelled'].includes(state))
      await this.attention(
        row.id,
        `REFUND_PROVIDER_${state.toUpperCase().replace(/-/g, '_')}`,
        ['PROCESSING'],
      );
    else
      await this.prisma.customOrderQueueRefund.updateMany({
        where: { id: row.id, status: 'PROCESSING' },
        data: { lockedAt: null, nextAttemptAt: new Date(Date.now() + POLL_MS) },
      });
  }

  private async complete(
    row: Refund,
    providerStatus: string,
    simulated = false,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "CustomOrderQueueRefund" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
      const current = await this.currentRefund(tx, row.id);
      if (current.status === 'SETTLED') return;
      if (
        ![
          'PROCESSING',
          'NEEDS_ATTENTION',
          ...(simulated ? ['SUBMITTING'] : []),
        ].includes(current.status)
      )
        return;
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
      await tx.customOrderQueueRefund.update({
        where: { id: current.id },
        data: {
          status: 'SETTLED',
          settledAt: new Date(),
          lockedAt: null,
          lastError: null,
        },
      });
      await tx.customOrder.update({
        where: { id: current.customOrderId },
        data: {
          ...(object(current.breakdownJson).refundKind === 'POST_ACTIVE_PARTIAL'
            ? {}
            : { status: 'CLOSED', paymentStatus: 'REFUNDED' }),
          orderRevision: { increment: 1 },
        },
      });
      // A parent unified capture stays paid: other lines and retained deductions remain.
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
    });
  }

  /** Admin authorization belongs to the caller. Attaching an ID never bypasses provider verification. */
  async reconcile(refundId: string, providerRefundId: string, actorId: string) {
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(providerRefundId))
      throw new ConflictException('REFUND_PROVIDER_ID_INVALID');
    const [row] = await loadQueueRefundContexts(this.prisma, { id: refundId });
    if (!row) throw new NotFoundException('Queue refund not found');
    if (row.status === 'SETTLED')
      return {
        id: row.id,
        status: row.status,
        providerRefundId: row.providerRefundId,
      };
    if (!['NEEDS_ATTENTION', 'FAILED'].includes(row.status))
      throw new ConflictException('REFUND_NOT_AWAITING_RECONCILIATION');
    const gateway = this.gateway(row);
    const secret = this.secret(
      gateway,
      row.paymentAttempt.providerMode.toLowerCase(),
    );
    const url =
      gateway === 'PAYSTACK'
        ? `https://api.paystack.co/refund/${encodeURIComponent(providerRefundId)}`
        : `https://api.flutterwave.com/v3/refunds/${encodeURIComponent(providerRefundId)}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_UNAVAILABLE');
    const payload = object(await response.json());
    const candidate = { ...row, providerRefundId };
    const data = await this.normalizeProviderData(
      candidate,
      gateway,
      object(payload.data),
    );
    if (
      (payload.status !== true && payload.status !== 'success') ||
      !this.matches(candidate, gateway, data)
    )
      throw new ConflictException('REFUND_PROVIDER_RECONCILIATION_MISMATCH');
    await this.prisma.$transaction(async (tx) => {
      // Serialize linking across equal-priced siblings of the same parent capture.
      await tx.$queryRaw`SELECT "id" FROM "PaymentAttempt" WHERE "id" = ${row.paymentAttemptId}::uuid FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "CustomOrderQueueRefund" WHERE "id" = ${refundId}::uuid FOR UPDATE`;
      const current = await this.currentRefund(tx, refundId);
      if (
        !['NEEDS_ATTENTION', 'FAILED'].includes(current.status) ||
        (current.providerRefundId &&
          current.providerRefundId !== providerRefundId)
      )
        throw new ConflictException('REFUND_RECONCILIATION_STATE_CHANGED');
      const duplicate = await tx.customOrderQueueRefund.findFirst({
        where: {
          providerRefundId,
          id: { not: refundId },
          paymentAttempt: { provider: gateway },
        },
        select: { id: true },
      });
      if (duplicate)
        throw new ConflictException('REFUND_PROVIDER_ID_ALREADY_LINKED');
      await this.reserve(tx, current);
      await tx.customOrderQueueRefund.update({
        where: { id: refundId },
        data: {
          providerRefundId,
          status: 'PROCESSING',
          lockedAt: null,
          lastError: null,
          nextAttemptAt: new Date(Date.now() + POLL_MS),
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: row.paymentAttemptId,
          type: 'CUSTOM_ORDER_QUEUE_REFUND_RECONCILED',
          source: 'custom-order-queue-refunds',
          payload: {
            refundId,
            customOrderId: row.customOrderId,
            providerRefundId,
            actorId,
          },
        },
      });
    });
    await this.applyProviderStatus(candidate, gateway, data);
    const current = await this.prisma.customOrderQueueRefund.findUniqueOrThrow({
      where: { id: refundId },
      select: { id: true, status: true, providerRefundId: true },
    });
    return {
      id: current.id,
      status: current.status,
      providerRefundId: current.providerRefundId,
    };
  }

  private async attention(id: string, code: string, statuses: string[]) {
    return this.prisma.$transaction(async (tx) => {
      const claimed = await tx.customOrderQueueRefund.updateMany({
        where: { id, status: { in: statuses } },
        data: { status: 'NEEDS_ATTENTION', lastError: code, lockedAt: null },
      });
      if (!claimed.count) return false;
      const contexts = await tx.$queryRaw<
        Array<{
          customOrderId: string;
          paymentAttemptId: string;
          buyerId: string;
        }>
      >(Prisma.sql`
        SELECT r."customOrderId", r."paymentAttemptId", o."buyerId"
        FROM "CustomOrderQueueRefund" r
        JOIN "CustomOrder" o ON o.id = r."customOrderId"
        WHERE r.id = ${id}::uuid
      `);
      const context = contexts[0];
      if (!context) throw new NotFoundException('Refund context not found');
      const row: RefundNoticeContext = {
        ...context,
        customOrder: { buyerId: context.buyerId },
      };
      await tx.operationalAlert.upsert({
        where: { dedupeKey: `queue-refund:${id}:attention` },
        create: {
          category: 'CUSTOM_ORDER_QUEUE',
          severity: 'ERROR',
          event: 'QUEUE_REFUND_NEEDS_ATTENTION',
          entityType: 'CustomOrderQueueRefund',
          entityId: id,
          dedupeKey: `queue-refund:${id}:attention`,
          message:
            'A waiting-order refund requires reconciliation before any further provider submission.',
          metadata: { customOrderId: row.customOrderId, code },
        },
        update: {
          occurrenceCount: { increment: 1 },
          lastSeenAt: new Date(),
          message:
            'A waiting-order refund requires reconciliation before any further provider submission.',
        },
      });
      await tx.paymentEvent.create({
        data: {
          paymentAttemptId: row.paymentAttemptId,
          type: 'CUSTOM_ORDER_QUEUE_REFUND_NEEDS_ATTENTION',
          source: 'custom-order-queue-refunds',
          payload: { refundId: id, customOrderId: row.customOrderId, code },
        },
      });
      await this.notify(
        tx,
        row,
        'QUEUE_REFUND_NEEDS_ATTENTION',
        'Your custom-order refund needs WIEZ attention. Your request remains recorded. You can contact WIEZ through your order conversation.',
      );
      return true;
    });
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
}
