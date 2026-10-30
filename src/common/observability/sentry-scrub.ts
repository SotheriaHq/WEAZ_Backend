import type * as Sentry from '@sentry/nestjs';
import type { Breadcrumb, ErrorEvent, Event, Log } from '@sentry/nestjs';

// Not exported by @sentry/nestjs; taken from the hooks that receive them.
type InitOptions = NonNullable<Parameters<typeof Sentry.init>[0]>;
type SpanJSON = Parameters<NonNullable<InitOptions['beforeSendSpan']>>[0];
type TransactionEvent = Parameters<
  NonNullable<InitOptions['beforeSendTransaction']>
>[0];

/**
 * What leaves this server for Sentry.
 *
 * `sendDefaultPii: false` keeps out cookies, IP addresses and user details, but
 * not the text of an error, the URL a request was made to, or the URL of a call
 * this server made. Those are where secrets turn up: a reset link's `?token=`,
 * a signed S3/R2 media URL, a Paystack key or `AUTH_…` card code inside a
 * provider's error, an email address in a validation message. Every event,
 * span, breadcrumb and log passes through here first.
 */

const SAFE_HEADERS = new Set([
  'accept',
  'content-type',
  'user-agent',
  'x-request-id',
  'x-wiez-platform',
]);

/** Keys whose values are never reported, whatever they hold. */
const SENSITIVE_KEY =
  /pass(word|code)?|secret|token|authori[sz]ation|cookie|signature|api[-_]?key|private[-_]?key|cvv|card[-_]?number|account[-_]?number|refresh/i;
const EXACT_SENSITIVE_KEY = /^(code|otp|pin|auth|key|email)$/i;

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key) || EXACT_SENSITIVE_KEY.test(key);
}

/** Free text with credentials, tokens, keys, signed URLs and emails removed. */
export function redactSensitiveText(value: string): string {
  return (
    value
      // These segments are checkout recovery credentials, not resource IDs.
      .replace(
        /(\/custom-orders\/(?:checkout-sessions\/)?resume\/)[^\s/?#"'<>),;]+/gi,
        '$1<token>',
      )
      .replace(
        /([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi,
        '$1<credentials>@',
      )
      .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, '$1?<query>')
      .replace(/\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g, '<jwt>')
      .replace(/\b(sk|rk)_(live|test)_[A-Za-z0-9]+/g, '<provider-secret>')
      .replace(/\bAUTH_[A-Za-z0-9]{6,}\b/g, '<authorization-code>')
      .replace(
        /X-Amz-(Signature|Credential|Security-Token)=[^&\s"']+/gi,
        'X-Amz-$1=<redacted>',
      )
      .replace(/[^\s@"'<>(),;:]+@[^\s@"'<>(),;:]+\.[a-z]{2,}/gi, '<email>')
      .replace(/\b(bearer)\s+[\w.~+/-]+=*/gi, '$1 <redacted>')
      .replace(
        /\b(token|secret|password|authorization|api[_-]?key)\b(\s*[:=]\s*)[^\s,;&"']+/gi,
        '$1$2<redacted>',
      )
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>')
  );
}

/** A URL without its query string or fragment: those routinely carry tokens. */
export function stripQuery(url: string): string {
  return redactSensitiveText(url.replace(/[?#].*$/, ''));
}

function scrubValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (value === null || typeof value !== 'object') return value;
  if (depth >= 6) return '<truncated>';
  if (Array.isArray(value))
    return value.map((entry) => scrubValue(entry, depth + 1));
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = isSensitiveKey(key)
      ? '<redacted>'
      : scrubValue(entry, depth + 1);
  }
  return result;
}

function scrubUrlFields(data: Record<string, unknown> | undefined) {
  if (!data) return data;
  const result = scrubValue(data) as Record<string, unknown>;
  for (const key of [
    'url',
    'http.url',
    'url.full',
    'http.query',
    'url.query',
    'from',
    'to',
  ]) {
    const value = data[key];
    if (typeof value === 'string') {
      result[key] = key.endsWith('query') ? '<query>' : stripQuery(value);
    }
  }
  return result;
}

export function scrubBreadcrumb(breadcrumb: Breadcrumb): Breadcrumb {
  return {
    ...breadcrumb,
    ...(breadcrumb.message
      ? { message: redactSensitiveText(breadcrumb.message) }
      : {}),
    ...(breadcrumb.data ? { data: scrubUrlFields(breadcrumb.data) } : {}),
  };
}

export function scrubSpan(span: SpanJSON): SpanJSON {
  return {
    ...span,
    ...(span.description
      ? { description: redactSensitiveText(span.description) }
      : {}),
    ...(span.data
      ? { data: scrubUrlFields(span.data) as SpanJSON['data'] }
      : {}),
  };
}

export function scrubEvent<T extends Event>(event: T): T {
  if (event.request) {
    const request = event.request;
    if (request.url) request.url = stripQuery(request.url);
    delete request.query_string;
    delete request.cookies;
    delete request.data;
    if (request.headers) {
      request.headers = Object.fromEntries(
        Object.entries(request.headers).filter(([name]) =>
          SAFE_HEADERS.has(name.toLowerCase()),
        ),
      );
    }
  }
  if (typeof event.message === 'string')
    event.message = redactSensitiveText(event.message);
  if (event.logentry?.message)
    event.logentry.message = redactSensitiveText(event.logentry.message);
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = redactSensitiveText(exception.value);
  }
  if (event.transaction)
    event.transaction = redactSensitiveText(stripQuery(event.transaction));
  if (event.extra) event.extra = scrubValue(event.extra) as Event['extra'];
  if (event.contexts)
    event.contexts = scrubValue(event.contexts) as Event['contexts'];
  if (event.tags) event.tags = scrubValue(event.tags) as Event['tags'];
  if (event.user)
    event.user = event.user.id ? { id: event.user.id } : undefined;
  if (event.breadcrumbs)
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  if (event.spans) event.spans = event.spans.map(scrubSpan);
  return event;
}

export function scrubLog(log: Log): Log {
  return {
    ...log,
    message:
      typeof log.message === 'string'
        ? redactSensitiveText(log.message)
        : log.message,
    ...(log.attributes
      ? { attributes: scrubValue(log.attributes) as Log['attributes'] }
      : {}),
  };
}

/** The `Sentry.init` hooks, in one place so none can be forgotten. */
export const sentryScrubHooks = {
  beforeSend: (event: ErrorEvent) => scrubEvent(event),
  beforeSendTransaction: (event: TransactionEvent) => scrubEvent(event),
  beforeSendSpan: (span: SpanJSON) => scrubSpan(span),
  beforeBreadcrumb: (breadcrumb: Breadcrumb) => scrubBreadcrumb(breadcrumb),
  beforeSendLog: (log: Log) => scrubLog(log),
};
