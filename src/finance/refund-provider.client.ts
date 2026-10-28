import { Inject, Injectable, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export type RefundGateway = 'PAYSTACK' | 'FLUTTERWAVE';
type JsonObject = Record<string, unknown>;

export const REFUND_PROVIDER_BASE_URLS = 'REFUND_PROVIDER_BASE_URLS';
const DEFAULT_BASE_URLS: Record<RefundGateway, string> = {
  PAYSTACK: 'https://api.paystack.co',
  FLUTTERWAVE: 'https://api.flutterwave.com',
};
const TIMEOUT_MS = 15000;

const object = (value: unknown): JsonObject =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
const text = (value: unknown) =>
  typeof value === 'string' || typeof value === 'number' ? String(value) : '';

/**
 * `definitelyNotSubmitted` is true only when the provider cannot have created a
 * refund (no request sent, or a definitive rejection). Anything else is an
 * uncertain outcome and must never be resubmitted automatically.
 */
export class RefundProviderError extends Error {
  constructor(
    readonly code: string,
    readonly definitelyNotSubmitted: boolean,
  ) {
    super(code);
  }
}

/** The original capture a refund is drawn from. */
export type RefundCapture = {
  reference: string;
  provider: string;
  providerMode: string;
  providerTransactionId: string | null;
  amount: Prisma.Decimal;
  currency: string;
  settlementAmount: Prisma.Decimal | null;
  settlementCurrency: string | null;
};

/** What the provider is asked to return, in the currency the capture was charged in. */
export type RefundTarget = { amount: Prisma.Decimal; currency: string };

export type ProviderRefundState =
  | 'PENDING'
  | 'PROCESSED'
  | 'FAILED'
  | 'NEEDS_ATTENTION';

export type ProviderRefund = {
  id: string;
  state: ProviderRefundState;
  rawStatus: string;
  amount: Prisma.Decimal;
  currency: string;
  transactionReference: string;
  transactionId: string;
  note: string;
};

const FLUTTERWAVE_SETTLED = [
  'completed-bank-transfer',
  'completed-momo',
  'completed-mpgs',
  'completed-offline',
  'completed-preauth',
];

/**
 * The one provider protocol for refunds: original-capture verification,
 * submission, status lookup, identity checks and reconciliation lookups.
 * It holds no database state and is called only outside database locks.
 */
@Injectable()
export class RefundProviderClient {
  private readonly baseUrls: Record<RefundGateway, string>;

  constructor(
    @Optional()
    @Inject(REFUND_PROVIDER_BASE_URLS)
    baseUrls?: Partial<Record<RefundGateway, string>>,
  ) {
    this.baseUrls = { ...DEFAULT_BASE_URLS, ...(baseUrls ?? {}) };
  }

  gateway(provider: string): RefundGateway {
    const value = String(provider || '').toUpperCase();
    if (value !== 'PAYSTACK' && value !== 'FLUTTERWAVE')
      throw new RefundProviderError('REFUND_UNSUPPORTED_PROVIDER', true);
    return value;
  }

  /** Mode `mock` is never sent to a provider; callers handle simulation. */
  secret(gateway: RefundGateway, mode: string): string {
    const normalized = String(mode || '').toLowerCase();
    if (normalized !== 'live' && normalized !== 'test')
      throw new RefundProviderError('REFUND_UNKNOWN_PROVIDER_MODE', true);
    const secret =
      process.env[
        gateway === 'PAYSTACK'
          ? 'PAYSTACK_SECRET_KEY'
          : 'FLUTTERWAVE_SECRET_KEY'
      ];
    if (!secret)
      throw new RefundProviderError(
        'REFUND_PROVIDER_CREDENTIALS_UNAVAILABLE',
        true,
      );
    const isTestKey =
      gateway === 'PAYSTACK'
        ? secret.startsWith('sk_test_')
        : secret.includes('_TEST');
    if (normalized === 'test' && !isTestKey)
      throw new RefundProviderError(
        'REFUND_PROVIDER_MODE_CREDENTIAL_MISMATCH',
        true,
      );
    if (normalized === 'live' && isTestKey)
      throw new RefundProviderError(
        'REFUND_PROVIDER_MODE_CREDENTIAL_MISMATCH',
        true,
      );
    return secret;
  }

  /** The currency and amount the capture was actually charged in. */
  chargedAmount(capture: RefundCapture): RefundTarget {
    return {
      currency: (capture.settlementCurrency || capture.currency).toUpperCase(),
      amount: new Prisma.Decimal(capture.settlementAmount ?? capture.amount),
    };
  }

  /** Confirms the original capture really succeeded for the expected amount. */
  async verifyCapture(capture: RefundCapture): Promise<void> {
    const gateway = this.gateway(capture.provider);
    const secret = this.secret(gateway, capture.providerMode);
    const url =
      gateway === 'PAYSTACK'
        ? `${this.baseUrls.PAYSTACK}/transaction/verify/${encodeURIComponent(capture.reference)}`
        : `${this.baseUrls.FLUTTERWAVE}/v3/transactions/${encodeURIComponent(this.flutterwaveTransaction(capture))}/verify`;
    const { ok, payload } = await this.request(url, secret).catch(() => {
      throw new RefundProviderError(
        'REFUND_CAPTURE_VERIFICATION_UNAVAILABLE',
        true,
      );
    });
    if (!ok)
      throw new RefundProviderError(
        'REFUND_CAPTURE_VERIFICATION_UNAVAILABLE',
        true,
      );
    const data = object(payload.data);
    const charged = this.chargedAmount(capture);
    const amount = this.money(data.amount, gateway === 'PAYSTACK');
    if (
      (payload.status !== true && payload.status !== 'success') ||
      !['success', 'successful'].includes(text(data.status).toLowerCase()) ||
      text(data.reference ?? data.tx_ref) !== capture.reference ||
      (capture.providerTransactionId &&
        text(data.id) !== capture.providerTransactionId) ||
      text(data.currency).toUpperCase() !== charged.currency ||
      !amount ||
      !amount.equals(charged.amount)
    )
      throw new RefundProviderError(
        'REFUND_ORIGINAL_CAPTURE_VERIFICATION_MISMATCH',
        true,
      );
  }

  /**
   * Ask the provider to refund `target` from the capture. Resolves only with a
   * provider refund id; rejects with `definitelyNotSubmitted=false` whenever
   * the provider may have created a refund.
   */
  async submit(
    capture: RefundCapture,
    target: RefundTarget,
    note: string,
  ): Promise<ProviderRefund> {
    const gateway = this.gateway(capture.provider);
    const secret = this.secret(gateway, capture.providerMode);
    const url =
      gateway === 'PAYSTACK'
        ? `${this.baseUrls.PAYSTACK}/refund`
        : `${this.baseUrls.FLUTTERWAVE}/v3/transactions/${encodeURIComponent(this.flutterwaveTransaction(capture))}/refund`;
    const body =
      gateway === 'PAYSTACK'
        ? {
            transaction: capture.reference,
            amount: target.amount.times(100).toNumber(),
            currency: target.currency,
            merchant_note: note,
          }
        : { amount: target.amount.toNumber(), comments: note };
    let response: { ok: boolean; status: number; payload: JsonObject };
    try {
      response = await this.request(url, secret, body);
    } catch {
      throw new RefundProviderError('REFUND_GATEWAY_OUTCOME_UNKNOWN', false);
    }
    if (!response.ok)
      throw new RefundProviderError(
        `REFUND_GATEWAY_HTTP_${response.status}`,
        [400, 401, 403, 404, 422].includes(response.status),
      );
    if (
      response.payload.status !== true &&
      response.payload.status !== 'success'
    )
      throw new RefundProviderError('REFUND_GATEWAY_RESPONSE_UNCERTAIN', false);
    const refund = await this.normalize(
      gateway,
      capture,
      object(response.payload.data),
    );
    if (!refund.id)
      throw new RefundProviderError('REFUND_GATEWAY_RESPONSE_MISMATCH', false);
    return refund;
  }

  /** Current provider state of one refund. Safe to repeat. */
  async fetch(
    capture: RefundCapture,
    providerRefundId: string,
  ): Promise<ProviderRefund> {
    const gateway = this.gateway(capture.provider);
    const secret = this.secret(gateway, capture.providerMode);
    const url =
      gateway === 'PAYSTACK'
        ? `${this.baseUrls.PAYSTACK}/refund/${encodeURIComponent(providerRefundId)}`
        : `${this.baseUrls.FLUTTERWAVE}/v3/refunds/${encodeURIComponent(providerRefundId)}`;
    const { ok, payload } = await this.request(url, secret);
    if (!ok || (payload.status !== true && payload.status !== 'success'))
      throw new RefundProviderError('REFUND_STATUS_LOOKUP_UNAVAILABLE', false);
    const data = object(payload.data);
    if (text(data.id) !== providerRefundId)
      throw new RefundProviderError('REFUND_STATUS_IDENTITY_MISMATCH', false);
    return this.normalize(gateway, capture, data);
  }

  /**
   * Refunds the provider holds for this capture whose note carries `marker`.
   * Used after an uncertain submission to find the refund that was created,
   * instead of creating another. Paystack only; others return null (unknown).
   * Use the documented transaction-id filter and inspect every reported page,
   * within a five-page budget. A failed/incomplete search is unknown, never a
   * partial match. Missing transaction ids require manual reconciliation.
   */
  async findByNote(
    capture: RefundCapture,
    marker: string,
  ): Promise<ProviderRefund[] | null> {
    const gateway = this.gateway(capture.provider);
    if (gateway !== 'PAYSTACK') return null;
    const transaction = capture.providerTransactionId;
    if (!transaction || !/^\d+$/.test(transaction)) return null;
    const secret = this.secret(gateway, capture.providerMode);
    const matches: ProviderRefund[] = [];
    const ids = new Set<string>();
    for (let page = 1; page <= 5; page++) {
      const query = new URLSearchParams({
        transaction,
        perPage: '100',
        page: String(page),
      });
      const { ok, payload } = await this.request(
        `${this.baseUrls.PAYSTACK}/refund?${query}`,
        secret,
      );
      if (
        !ok ||
        payload.status !== true ||
        !Array.isArray(payload.data) ||
        payload.data.length > 100
      )
        return null;
      for (const item of payload.data) {
        const refund = await this.normalize(gateway, capture, object(item));
        if (refund.note.trim() !== marker) continue;
        if (!refund.id || ids.has(refund.id)) return null;
        ids.add(refund.id);
        matches.push(refund);
      }
      const meta = object(payload.meta);
      if (meta.page != null && Number(meta.page) !== page) return null;
      if (meta.pageCount != null) {
        const pageCount = Number(meta.pageCount);
        if (
          !Number.isSafeInteger(pageCount) ||
          pageCount < 0 ||
          pageCount > 5 ||
          (pageCount < page && payload.data.length !== 0)
        )
          return null;
        if (page >= pageCount) return matches;
      } else if (payload.data.length < 100) return matches;
    }
    return null;
  }

  /** Refund belongs to this capture and moves exactly `target`. */
  matches(
    capture: RefundCapture,
    target: RefundTarget,
    refund: ProviderRefund,
  ): boolean {
    const sameTransaction =
      (!refund.transactionReference ||
        refund.transactionReference === capture.reference) &&
      (!refund.transactionId ||
        !capture.providerTransactionId ||
        refund.transactionId === capture.providerTransactionId) &&
      Boolean(
        refund.transactionReference === capture.reference ||
          (capture.providerTransactionId &&
            refund.transactionId === capture.providerTransactionId),
      );
    return (
      sameTransaction &&
      refund.currency === target.currency &&
      refund.amount.equals(target.amount)
    );
  }

  /** Identity hints carried by a signed refund webhook. */
  webhookIdentity(gateway: RefundGateway, payload: unknown) {
    const envelope = object(payload);
    const event = text(envelope.event ?? envelope['event.type']).toLowerCase();
    const raw =
      gateway === 'FLUTTERWAVE' &&
      envelope.TransactionId != null &&
      envelope.AmountRefunded != null;
    if (!event.includes('refund') && !raw) return null;
    const data = raw ? envelope : object(envelope.data);
    return {
      providerRefundId: text(data.id ?? data.refund_id) || null,
      transactionReference:
        text(data.transaction_reference ?? data.tx_ref) || null,
      transactionId:
        text(data.tx_id ?? data.TransactionId ?? data.transaction_id) || null,
    };
  }

  private async normalize(
    gateway: RefundGateway,
    capture: RefundCapture,
    data: JsonObject,
  ): Promise<ProviderRefund> {
    let meta = object(data.meta);
    if (typeof data.meta === 'string') {
      try {
        meta = object(JSON.parse(data.meta));
      } catch {
        meta = {};
      }
    }
    const transaction = object(data.transaction);
    const rawStatus = text(data.status).toLowerCase().replace(/_/g, '-');
    const amount =
      this.money(
        gateway === 'FLUTTERWAVE'
          ? (data.amount_refunded ?? data.AmountRefunded ?? data.amount)
          : data.amount,
        gateway === 'PAYSTACK',
      ) ?? new Prisma.Decimal(-1);
    let currency = text(data.currency).toUpperCase();
    let transactionReference = text(
      data.transaction_reference ?? data.tx_ref ?? transaction.reference,
    );
    const transactionId = text(
      data.transaction_id ??
        data.tx_id ??
        data.TransactionId ??
        transaction.id ??
        (typeof data.transaction !== 'object' ? data.transaction : ''),
    );
    if (gateway === 'FLUTTERWAVE' && !currency) {
      // Flutterwave refund objects omit currency; read it from the verified transaction.
      if (!transactionId || transactionId !== capture.providerTransactionId)
        throw new RefundProviderError(
          'REFUND_PROVIDER_TRANSACTION_MISMATCH',
          false,
        );
      const secret = this.secret(gateway, capture.providerMode);
      const { ok, payload } = await this.request(
        `${this.baseUrls.FLUTTERWAVE}/v3/transactions/${encodeURIComponent(transactionId)}/verify`,
        secret,
      );
      const verified = object(payload.data);
      if (
        !ok ||
        payload.status !== 'success' ||
        text(verified.id) !== transactionId
      )
        throw new RefundProviderError(
          'REFUND_TRANSACTION_VERIFICATION_UNAVAILABLE',
          false,
        );
      currency = text(verified.currency).toUpperCase();
      transactionReference = text(verified.tx_ref);
    }
    let state: ProviderRefundState = 'PENDING';
    if (
      gateway === 'FLUTTERWAVE' &&
      text(meta.disburse_status).toLowerCase() === 'failed'
    )
      state = 'FAILED';
    else if (
      (gateway === 'PAYSTACK' && rawStatus === 'processed') ||
      (gateway === 'FLUTTERWAVE' && FLUTTERWAVE_SETTLED.includes(rawStatus))
    )
      state = 'PROCESSED';
    else if (rawStatus === 'failed' || rawStatus === 'cancelled')
      state = 'FAILED';
    else if (rawStatus === 'needs-attention') state = 'NEEDS_ATTENTION';
    return {
      id: text(data.id),
      state,
      rawStatus,
      amount,
      currency,
      transactionReference,
      transactionId,
      note: text(data.merchant_note ?? data.comments ?? data.comment),
    };
  }

  private flutterwaveTransaction(capture: RefundCapture): string {
    const id = capture.providerTransactionId;
    if (!id || !/^\d+$/.test(id))
      throw new RefundProviderError(
        'REFUND_PROVIDER_TRANSACTION_ID_MISSING',
        true,
      );
    return id;
  }

  private money(value: unknown, minorUnits: boolean): Prisma.Decimal | null {
    try {
      const amount = new Prisma.Decimal(String(value ?? 'NaN'));
      if (!amount.isFinite() || amount.isNegative()) return null;
      return minorUnits ? amount.dividedBy(100) : amount;
    } catch {
      return null;
    }
  }

  private async request(url: string, secret: string, body?: unknown) {
    const response = await fetch(url, {
      redirect: 'error',
      method: body ? 'POST' : 'GET',
      headers: {
        Authorization: `Bearer ${secret}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let payload: JsonObject = {};
    try {
      payload = object(await response.json());
    } catch {
      payload = {};
    }
    return { ok: response.ok, status: response.status, payload };
  }
}
