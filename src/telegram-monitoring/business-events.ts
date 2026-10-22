import { HttpException } from '@nestjs/common';
import type { SanitizedOperationalAlert } from 'src/monitoring/monitoring.types';
import { resolveAppUrl } from 'src/email/email.branding';
import type { MonitoringEventInput } from './telegram-events.service';
import type { MessageField } from './telegram-message.format';
import { formatDuration } from './telegram-message.format';
import { scrubSentryText } from './sentry-alert.parser';

/**
 * Builders that turn domain facts into monitoring events. Business services
 * call `telegramEvents?.record(builder(...))` AFTER their write commits, so
 * the call site stays one line and the formatting rules live here.
 */

type RequestLike = { headers?: Record<string, unknown> } | null | undefined;

export function clientPlatform(req: RequestLike): string {
  const header = String(req?.headers?.['x-client-platform'] ?? '').toLowerCase();
  if (header.includes('mobile')) return 'Mobile app';
  if (header) return header.slice(0, 30);
  return 'Web';
}

// ------------------------------------------------------------------ signup

export function signupSucceeded(input: {
  user: { id: string; username?: string | null; email?: string | null; type?: string | null };
  method: 'Email & password' | 'Google';
  req: RequestLike;
  brandName?: string | null;
  device?: string | null;
  location?: string | null;
  verificationEmail?: string | null;
  createdAt?: Date;
}): MonitoringEventInput {
  const isBrand = input.user.type === 'BRAND';
  return {
    key: isBrand ? 'brand.registered' : 'user.registered',
    idempotencyKey: input.user.id,
    occurredAt: input.createdAt,
    summary: isBrand
      ? `A new brand account signed up via ${input.method}.`
      : `A new shopper signed up via ${input.method}.`,
    fields: [
      ['Brand name', isBrand ? input.brandName : null],
      ['Sign-up method', input.method],
      ['Platform', clientPlatform(input.req)],
      ['Device', input.device],
      ['Approx. location', input.location],
      ['Verification email', input.verificationEmail],
    ],
    identity: {
      userId: input.user.id,
      username: input.user.username,
      email: input.user.email,
      accountType: input.user.type,
    },
    timeline: [['Account created', input.createdAt ?? new Date()]],
  };
}

const SIGNUP_SYSTEM_FAILURE_MESSAGES = [
  'database connection error',
  'failed to generate username',
  'failed to generate industri number',
  'password processing failed',
  'failed to create user account',
  'account created but failed to generate login session',
  'failed to create user:',
];

/** Expected user mistakes vs system faults, for a signup that threw. */
export function classifySignupError(error: unknown): { system: boolean; status: number; code: string; message: string } {
  // Unique-constraint race between the duplicate pre-check and the insert:
  // the service answers 409 EMAIL_ALREADY_EXISTS, an expected outcome.
  if ((error as { code?: unknown })?.code === 'P2002') {
    return { system: false, status: 409, code: 'EMAIL_ALREADY_EXISTS', message: 'Email already exists (insert race)' };
  }
  const status = error instanceof HttpException ? error.getStatus() : 500;
  const response = error instanceof HttpException ? (error.getResponse() as any) : null;
  const rawMessage =
    (typeof response === 'object' && response?.message) ||
    (error instanceof Error ? error.message : String(error ?? 'unknown'));
  const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage);
  const lowered = message.toLowerCase();
  const system =
    status >= 500 ||
    !(error instanceof HttpException) ||
    SIGNUP_SYSTEM_FAILURE_MESSAGES.some((needle) => lowered.startsWith(needle));
  const code =
    (typeof response === 'object' && typeof response?.code === 'string' && response.code) ||
    (error instanceof Error ? error.constructor.name : 'Error');
  return { system, status, code, message };
}

export function signupFailed(input: {
  error: unknown;
  email?: string | null;
  accountType?: string | null;
  method: 'Email & password' | 'Google';
  req: RequestLike;
}): MonitoringEventInput {
  const outcome = classifySignupError(input.error);
  const at = new Date();
  return {
    key: outcome.system ? 'auth.signup_system_failure' : 'auth.signup_rejected',
    idempotencyKey: `${input.email ?? 'unknown'}:${at.getTime()}`,
    occurredAt: at,
    summary: outcome.system
      ? 'A sign-up attempt failed because of a server-side error. The person could not create an account.'
      : 'Sign-up attempts are being rejected by validation.',
    fields: [
      ['Endpoint', input.method === 'Google' ? 'POST /auth/google' : 'POST /auth/signup'],
      ['Response status', outcome.status],
      ['Error code', outcome.code],
      ['Error message', scrubSentryText(outcome.message, 200)],
      ['Sign-up method', input.method],
      ['Account type', input.accountType],
      ['Platform', clientPlatform(input.req)],
    ],
    // Only immediate (system) failures are rendered per attempt; the email is
    // what lets the owner contact the person who could not sign up.
    identity: outcome.system && input.email ? { email: input.email, accountType: input.accountType } : null,
    timeline: [['Attempted', at]],
    counterSuffix: outcome.code,
  };
}

// ---------------------------------------------------------------- payments

type AttemptLike = {
  id: string;
  reference: string;
  status: string;
  amount: unknown;
  currency?: string | null;
  provider?: string | null;
  channel?: string | null;
  providerChannel?: string | null;
  subjectType?: string | null;
  buyerId?: string | null;
  failureCode?: string | null;
  failureMessage?: string | null;
  createdAt?: Date | null;
  confirmedAt?: Date | null;
  finalizedAt?: Date | null;
  orderIds?: string[] | null;
  customOrderId?: string | null;
  checkoutSessionId?: string | null;
  correlationId?: string | null;
};

export function formatMoney(amount: unknown, currency?: string | null): string {
  const value = Number(amount);
  if (!Number.isFinite(value)) return 'n/a';
  return `${currency ?? ''} ${value.toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
}

export function paymentOutcome(attempt: AttemptLike, source: string): MonitoringEventInput {
  const paid = attempt.status === 'PAID';
  const endedAt = (paid ? attempt.confirmedAt : attempt.finalizedAt) ?? new Date();
  const took = attempt.createdAt ? formatDuration(endedAt.getTime() - attempt.createdAt.getTime()) : null;
  const fields: MessageField[] = [
    ['Amount', formatMoney(attempt.amount, attempt.currency)],
    ['Status', attempt.status],
    ['Purpose', attempt.subjectType],
    ['Provider', [attempt.provider, attempt.providerChannel ?? attempt.channel].filter(Boolean).join(' / ')],
    ['Reference', attempt.reference],
    ['Confirmed by', source],
    ['Failure code', paid ? null : attempt.failureCode],
    ['Failure reason', paid ? null : attempt.failureMessage],
    ['Checkout session', attempt.checkoutSessionId],
    ['Custom order', attempt.customOrderId],
    ['Correlation ID', attempt.correlationId],
    ['Time to outcome', took],
  ];
  return {
    key: paid ? 'payment.succeeded' : 'payment.failed',
    idempotencyKey: `${attempt.reference}:${attempt.status}`,
    occurredAt: endedAt,
    title: paid ? 'Payment succeeded' : `Payment ${attempt.status.toLowerCase()}`,
    summary: paid
      ? `${formatMoney(attempt.amount, attempt.currency)} captured.`
      : `A ${formatMoney(attempt.amount, attempt.currency)} payment did not complete.`,
    fields,
    identity: attempt.buyerId ? { userId: attempt.buyerId } : null,
    timeline: [
      ['Checkout started', attempt.createdAt],
      [paid ? 'Payment confirmed' : 'Payment ended', endedAt],
    ],
    counterSuffix: attempt.status,
  };
}

export function checkoutCompleted(input: {
  reference: string;
  buyerId: string | null;
  orderIds: string[];
  customOrderIds: string[];
  summary: { currency: string; items: Array<{ name: string; quantity: number; price: number }>; grandTotal: number; shippingCity: string; shippingState: string };
  brandNames: string[];
}): MonitoringEventInput {
  const itemCount = input.summary.items.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0);
  const items = input.summary.items
    .slice(0, 5)
    .map((item) => `${item.quantity}× ${item.name}`)
    .join(', ');
  return {
    key: 'checkout.completed',
    idempotencyKey: input.reference,
    summary: `${input.orderIds.length} order(s) and ${input.customOrderIds.length} custom order(s) placed — ${formatMoney(input.summary.grandTotal, input.summary.currency)}.`,
    fields: [
      ['Total', formatMoney(input.summary.grandTotal, input.summary.currency)],
      ['Items', `${itemCount} (${items}${input.summary.items.length > 5 ? ', …' : ''})`],
      ['Brands', input.brandNames.slice(0, 5).join(', ') || null],
      ['Ship to', [input.summary.shippingCity, input.summary.shippingState].filter(Boolean).join(', ') || null],
      ['Order IDs', input.orderIds.slice(0, 5).join(', ') || null],
      ['Custom order IDs', input.customOrderIds.slice(0, 5).join(', ') || null],
      ['Payment reference', input.reference],
    ],
    identity: input.buyerId ? { userId: input.buyerId } : null,
    timeline: [['Order placed', new Date()]],
  };
}

// ---------------------------------------------------------- verification

export function verificationDecision(input: {
  stage: 'Document review' | 'Physical visit';
  brandId: string;
  brandName: string;
  ownerId: string;
  outcome: string;
  nextStatus: string;
  reasons?: string | null;
  reviewerId: string;
  decidedAt: Date;
  submittedAt?: Date | null;
}): MonitoringEventInput {
  return {
    key: 'brand.verification_decided',
    idempotencyKey: `${input.brandId}:${input.stage}:${input.decidedAt.toISOString()}`,
    occurredAt: input.decidedAt,
    title: `Brand verification: ${input.stage} ${input.outcome.toLowerCase()}`,
    summary: `${input.brandName} — ${input.stage.toLowerCase()} ${input.outcome.toLowerCase()}; brand is now ${input.nextStatus}.`,
    fields: [
      ['Brand', input.brandName],
      ['Brand ID', input.brandId],
      ['Stage', input.stage],
      ['Decision', input.outcome],
      ['New status', input.nextStatus],
      ['Reasons', input.reasons],
      ['Reviewer ID', input.reviewerId],
    ],
    identity: { userId: input.ownerId },
    timeline: [
      [input.stage === 'Physical visit' ? 'Visit completed' : 'Documents submitted', input.submittedAt],
      ['Decided', input.decidedAt],
    ],
    counterSuffix: `${input.stage}:${input.outcome}`,
  };
}

// --------------------------------------------------- operational alerts

const IMMEDIATE_CATEGORIES = new Set(['PAYMENT', 'WEBHOOK', 'UPLOAD', 'QUEUE', 'SECURITY', 'MIGRATION']);

/**
 * Policy for alerts already recorded through MonitoringService:
 *   - 5xx responses          → threshold burst alert (each one is in Sentry)
 *   - 401/403 responses      → report counter only
 *   - critical, admin-routed, or error-level money/upload/queue/security
 *                             → immediate
 *   - everything else        → report counter only
 */
export function operationalAlertEvent(
  alert: SanitizedOperationalAlert,
  adminRouted: boolean,
): MonitoringEventInput | { countOnly: string } {
  const meta = (alert.metadata ?? {}) as Record<string, unknown>;
  if (alert.event === 'http_unhandled_failure') {
    return {
      key: 'http.server_error',
      idempotencyKey: alert.emittedAt,
      summary: `Most recent: ${meta.method ?? '?'} ${meta.path ?? '?'} → ${meta.status ?? '5xx'} (${meta.errorName ?? 'Error'}). Check Sentry for the individual issues.`,
      fields: [],
      counterSuffix: `${meta.method ?? ''} ${meta.path ?? ''}`.trim().slice(0, 80),
    };
  }
  if (alert.event === 'http_auth_or_permission_failure') {
    return { countOnly: 'http.auth_failure' };
  }
  const immediate =
    alert.severity === 'critical' ||
    adminRouted ||
    (alert.severity === 'error' && IMMEDIATE_CATEGORIES.has(alert.category));
  if (!immediate) {
    return { countOnly: `operational.alert:${alert.event}` };
  }

  const scalarMeta: MessageField[] = Object.entries(meta)
    .filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
    .slice(0, 10)
    .map(([key, value]) => [key, scrubSentryText(value, 160)]);
  // 30-minute buckets: a recurring alert re-notifies at most twice an hour.
  const bucket = Math.floor(new Date(alert.emittedAt).getTime() / (30 * 60_000));
  return {
    key: 'operational.alert',
    idempotencyKey: `${alert.dedupeKey ?? `${alert.category}:${alert.event}:${alert.entityId ?? ''}`}:${bucket}`,
    severity: alert.severity === 'critical' ? 'critical' : alert.severity === 'warning' ? 'warning' : 'error',
    title: `${alert.category}: ${alert.title ?? alert.event}`,
    summary: scrubSentryText(alert.message, 300),
    fields: [
      ['Event', alert.event],
      ['Severity', alert.severity],
      ['Entity', alert.entityType || alert.entityId ? `${alert.entityType ?? 'entity'}:${alert.entityId ?? '?'}` : null],
      ['Correlation ID', alert.correlationId],
      ['Actor ID', alert.actorId],
      ...scalarMeta,
    ],
    identity: alert.userId ? { userId: alert.userId } : null,
    timeline: [['Recorded', alert.emittedAt]],
    links: [['Admin console', resolveAppUrl('/admin/monitoring')]],
    counterSuffix: alert.event,
  };
}
