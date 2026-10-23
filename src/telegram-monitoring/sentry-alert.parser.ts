import { createHmac, timingSafeEqual } from 'crypto';
import { cleanText, safeUrl } from './telegram-message.format';

/**
 * What survives from a Sentry webhook. Everything else in the payload —
 * exception frames, request headers/cookies, user objects, breadcrumbs,
 * tags, contexts — is dropped here and never queued, logged or sent.
 */
export type NormalizedSentryAlert = {
  resource: 'event_alert' | 'metric_alert' | 'issue';
  action: string;
  level: string;
  title: string;
  culprit: string | null;
  environment: string | null;
  project: string | null;
  issueId: string | null;
  ruleName: string | null;
  webUrl: string | null;
  description: string | null;
  occurredAt: string | null;
  release: string | null;
  /** Triage details for event alerts (owner request 2026-10-22). */
  details: SentryEventDetails | null;
};

/**
 * Enough to locate and reproduce the failure without the stack trace:
 * WHAT failed (type/message/frame), WHERE (method + endpoint + transaction),
 * HOW it answered (status), and WHICH request (event/request ids).
 * Headers, cookies, request bodies, query strings and breadcrumbs are never
 * copied; message text is scrubbed of emails and long tokens.
 */
export type SentryEventDetails = {
  eventId: string | null;
  errorType: string | null;
  errorMessage: string | null;
  handled: string | null;
  mechanism: string | null;
  method: string | null;
  endpoint: string | null;
  statusCode: string | null;
  requestId: string | null;
  transaction: string | null;
  inAppFrame: string | null;
  runtime: string | null;
  os: string | null;
  browser: string | null;
  device: string | null;
  userId: string | null;
  serverName: string | null;
  logger: string | null;
};

const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;

/**
 * Sentry integration-platform webhooks carry `Sentry-Hook-Signature`: the hex
 * HMAC-SHA256 of the request body keyed with the integration's CLIENT SECRET
 * (docs.sentry.io → Integration Platform → Webhooks → Verifying the
 * signature). Sentry's own examples hash `JSON.stringify(body)`, so the parsed
 * re-serialisation is accepted as well as the raw bytes; both are keyed with
 * the secret, so neither weakens the check. Comparison is constant-time.
 */
export function verifySentrySignature(params: {
  secret: string;
  signature: string | undefined;
  rawBody: string | undefined;
  parsedBody: unknown;
}): boolean {
  const { secret, signature } = params;
  if (!secret || !signature || !SIGNATURE_PATTERN.test(signature)) return false;
  const provided = Buffer.from(signature.toLowerCase(), 'hex');
  const candidates: string[] = [];
  if (typeof params.rawBody === 'string' && params.rawBody.length > 0) {
    candidates.push(params.rawBody);
  }
  if (params.parsedBody && typeof params.parsedBody === 'object') {
    candidates.push(JSON.stringify(params.parsedBody));
  }
  return candidates.some((body) => {
    const expected = createHmac('sha256', secret).update(body, 'utf8').digest();
    return (
      expected.length === provided.length && timingSafeEqual(expected, provided)
    );
  });
}

const str = (value: unknown, max = 200): string | null => {
  if (value === null || value === undefined) return null;
  const text = cleanText(value, max);
  return text || null;
};

function tagValue(tags: unknown, name: string): string | null {
  if (!Array.isArray(tags)) return null;
  for (const entry of tags) {
    if (Array.isArray(entry) && entry[0] === name) return str(entry[1], 64);
    if (entry && typeof entry === 'object' && (entry as any).key === name) {
      return str((entry as any).value, 64);
    }
  }
  return null;
}

/** Remove emails, credentialed URLs and long opaque tokens from free text. */
export function scrubSentryText(value: unknown, max = 300): string | null {
  const text = str(value, 2_000);
  if (!text) return null;
  return cleanText(
    text
      .replace(/[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@/gi, '<credentials>@')
      .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/gi, '<email>')
      .replace(
        /\b(bearer|token|secret|password|authorization)\b\s*[:=]\s*\S+/gi,
        '$1=<redacted>',
      )
      .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '<redacted>'),
    max,
  );
}

/** Path only: query strings and fragments routinely carry tokens. */
export function endpointPath(raw: unknown): string | null {
  const text = str(raw, 500);
  if (!text) return null;
  try {
    const url = new URL(text, 'https://placeholder.invalid');
    const host = url.hostname === 'placeholder.invalid' ? '' : url.host;
    return cleanText(`${host}${url.pathname}`, 200);
  } catch {
    return cleanText(text.split(/[?#]/)[0], 200);
  }
}

function contextLabel(context: any): string | null {
  if (!context || typeof context !== 'object') return null;
  return str([context.name, context.version].filter(Boolean).join(' '), 60);
}

function firstInAppFrame(exception: any): string | null {
  const frames = exception?.stacktrace?.frames;
  if (!Array.isArray(frames)) return null;
  // Sentry orders frames oldest → newest; the crash site is the LAST in-app one.
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (frame?.in_app) {
      const file = str(frame.filename ?? frame.module ?? frame.abs_path, 120);
      const fn = str(frame.function, 80);
      const line = frame.lineno ? `:${Number(frame.lineno)}` : '';
      if (file) return `${file}${line}${fn ? ` in ${fn}` : ''}`;
    }
  }
  return null;
}

export function extractEventDetails(event: any): SentryEventDetails {
  const exceptionValues = Array.isArray(event?.exception?.values)
    ? event.exception.values
    : [];
  // The last exception value is the outermost/primary error in Sentry payloads.
  const primary = exceptionValues[exceptionValues.length - 1] ?? null;
  const request = event?.request ?? {};
  const contexts = event?.contexts ?? {};
  const tags = event?.tags;
  const handledFlag = primary?.mechanism?.handled;
  return {
    eventId: str(event?.event_id ?? event?.id, 40),
    errorType: str(primary?.type ?? event?.metadata?.type, 120),
    errorMessage: scrubSentryText(
      primary?.value ?? event?.metadata?.value ?? event?.message,
    ),
    handled:
      handledFlag === true
        ? 'yes'
        : handledFlag === false
          ? 'no (unhandled)'
          : null,
    mechanism: str(primary?.mechanism?.type, 40),
    method:
      str(request.method ?? tagValue(tags, 'http.method'), 10)?.toUpperCase() ??
      null,
    endpoint:
      endpointPath(request.url) ??
      endpointPath(tagValue(tags, 'http.path')) ??
      endpointPath(tagValue(tags, 'url')),
    statusCode:
      tagValue(tags, 'http.status_code') ??
      str(contexts?.response?.status_code, 6) ??
      str(contexts?.trace?.data?.['http.response.status_code'], 6),
    requestId:
      tagValue(tags, 'requestId') ??
      tagValue(tags, 'request_id') ??
      tagValue(tags, 'correlationId'),
    transaction: str(event?.transaction ?? tagValue(tags, 'transaction'), 160),
    inAppFrame: firstInAppFrame(primary),
    runtime: contextLabel(contexts.runtime),
    os: contextLabel(contexts.os) ?? contextLabel(contexts.client_os),
    browser: contextLabel(contexts.browser),
    device: str(
      [contexts.device?.brand, contexts.device?.model]
        .filter(Boolean)
        .join(' '),
      60,
    ),
    userId: str(event?.user?.id, 64),
    serverName: str(event?.server_name ?? tagValue(tags, 'server_name'), 60),
    logger: str(event?.logger, 60),
  };
}

export function parseSentryWebhook(
  resource: string,
  body: any,
): NormalizedSentryAlert | null {
  const action = str(body?.action, 40) ?? 'unknown';
  const data = body?.data ?? {};

  if (resource === 'event_alert') {
    const event = data.event ?? {};
    const issueId = str(event.issue_id ?? event.group_id, 32);
    return {
      resource,
      action,
      level: (str(event.level, 16) ?? 'error').toLowerCase(),
      title: str(event.title ?? event.message, 200) ?? 'Untitled Sentry event',
      culprit: str(event.culprit, 160),
      environment:
        (
          str(event.environment, 64) ?? tagValue(event.tags, 'environment')
        )?.toLowerCase() ?? null,
      project: str(
        event.project_slug ?? event.project_name ?? event.project,
        64,
      ),
      issueId,
      ruleName: str(data.triggered_rule ?? data.issue_alert?.title, 120),
      webUrl: safeUrl(event.web_url) ?? null,
      description: null,
      occurredAt: str(event.datetime ?? event.timestamp, 40),
      release: str(event.release ?? tagValue(event.tags, 'release'), 80),
      details: extractEventDetails(event),
    };
  }

  if (resource === 'metric_alert') {
    const metric = data.metric_alert ?? {};
    const rule = metric.alert_rule ?? {};
    const projects = Array.isArray(rule.projects)
      ? rule.projects.join(', ')
      : null;
    return {
      resource,
      action,
      // action is critical | warning | resolved for metric alerts.
      level:
        action === 'critical'
          ? 'fatal'
          : action === 'warning'
            ? 'warning'
            : 'info',
      title:
        str(data.description_title ?? metric.title ?? rule.name, 200) ??
        'Metric alert',
      culprit: null,
      environment: str(rule.environment, 64)?.toLowerCase() ?? null,
      project: str(projects, 120),
      issueId: str(metric.id ?? metric.identifier, 32),
      ruleName: str(rule.name, 120),
      webUrl: safeUrl(data.web_url) ?? null,
      description: str(data.description_text, 300),
      occurredAt: str(metric.date_detected ?? metric.date_started, 40),
      release: null,
      details: null,
    };
  }

  if (resource === 'issue') {
    const issue = data.issue ?? {};
    return {
      resource,
      action,
      level: (str(issue.level, 16) ?? 'error').toLowerCase(),
      title: str(issue.title, 200) ?? 'Sentry issue',
      culprit: str(issue.culprit, 160),
      // Issue webhooks carry no environment; the processor treats null as
      // "cannot prove this belongs here" and does not forward it.
      environment: null,
      project: str(issue.project?.slug ?? issue.project?.name, 64),
      issueId: str(issue.id, 32),
      ruleName: null,
      webUrl: safeUrl(issue.web_url ?? issue.permalink) ?? null,
      description: null,
      occurredAt: str(issue.lastSeen ?? issue.firstSeen, 40),
      release: null,
      details: null,
    };
  }

  return null;
}

export function sentrySeverity(
  level: string,
): 'critical' | 'error' | 'warning' | 'info' {
  switch ((level || '').toLowerCase()) {
    case 'fatal':
      return 'critical';
    case 'error':
      return 'error';
    case 'warning':
      return 'warning';
    default:
      return 'info';
  }
}
