import { BadRequestException } from '@nestjs/common';
import {
  MARKET_SIGNAL_MAX_INSTANT_LENGTH,
  MARKET_SIGNAL_MAX_VISIBLE_MS,
  MARKET_SIGNAL_POLICY_VERSION_PATTERN,
} from './dto/market-signal.dto';

/**
 * Proposed rollback flag for optional signal enrichment. Owner confirmation of
 * the name is still required. It controls only whether validated optional
 * telemetry and server enrichment are stored with the raw event. Validation,
 * authentication, throttles, replay/skew handling, owner and staff exclusion,
 * caps, impression gating and hard-signal refusal never depend on it.
 */
export const MARKET_SIGNAL_ENRICHMENT_FLAG = 'MARKET_SIGNAL_ENRICHMENT_V1';

/** Reserved metadata key written only by the server. */
export const MARKET_SIGNAL_SERVER_METADATA_KEY = '$server';
export const MARKET_SIGNAL_ENRICHMENT_VERSION = 1;

export const MARKET_SIGNAL_REPLAY_WINDOW_MS = 24 * 60 * 60 * 1000;
export const MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS = 10 * 60 * 1000;
/**
 * Event identifiers are deduplicated for the 24-hour replay window only. An
 * event delivered later than this could already have been accepted and then
 * purged by retention, so counting it again would double count. The skew
 * tolerance keeps the bound safely inside the replay window.
 */
export const MARKET_SIGNAL_MAX_DELIVERY_DELAY_MS =
  MARKET_SIGNAL_REPLAY_WINDOW_MS - MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS;

export type MarketSignalEnrichmentFlag = {
  enabled: boolean;
  invalid: boolean;
};

/** Only the exact strings `true` and `false` are accepted; anything else is off. */
export function readMarketSignalEnrichmentFlag(
  env: NodeJS.ProcessEnv = process.env,
): MarketSignalEnrichmentFlag {
  const raw = env[MARKET_SIGNAL_ENRICHMENT_FLAG]?.trim();
  if (!raw || raw === 'false') return { enabled: false, invalid: false };
  if (raw === 'true') return { enabled: true, invalid: false };
  return { enabled: false, invalid: true };
}

export type MarketSignalTiming = {
  /** Interaction instant on the server clock. */
  occurredAt: Date;
  /** Device clock disagreed beyond tolerance; the receipt instant was used. */
  clockSkewed: boolean;
  /** Measured client queue delay, when the batch carried `sentAt`. */
  deliveryDelayMs: number | null;
  /** Delivered too late to be safely deduplicated; never stored or counted. */
  stale: boolean;
};

export type MarketSignalTelemetry = {
  visibleMs: number | null;
  epoch: string | null;
  policyVersion: string | null;
  explore: boolean | null;
};

export function parseMarketSignalInstant(
  value: unknown,
  field: string,
): Date | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MARKET_SIGNAL_MAX_INSTANT_LENGTH ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:?\d{2})$/.test(
      value,
    )
  ) {
    throw new BadRequestException(`${field} must be an ISO-8601 instant`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new BadRequestException(`${field} must be an ISO-8601 instant`);
  }
  return parsed;
}

/**
 * Places a client instant on the server clock. With `sentAt`, only the device's
 * own queue delay matters, so a wrong device clock cannot move the event. With
 * no `sentAt`, a timestamp outside the skew tolerance cannot be trusted and the
 * receipt instant is used instead.
 */
export function resolveMarketSignalTiming(
  occurredAt: Date | null,
  sentAt: Date | null,
  receivedAt: Date,
): MarketSignalTiming | null {
  if (!occurredAt) return null;
  const received = receivedAt.getTime();
  if (sentAt) {
    const reportedDelay = sentAt.getTime() - occurredAt.getTime();
    const clockSkewed = reportedDelay < -MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS;
    const deliveryDelayMs = Math.max(0, reportedDelay);
    return {
      occurredAt: new Date(received - deliveryDelayMs),
      clockSkewed,
      deliveryDelayMs,
      stale: deliveryDelayMs >= MARKET_SIGNAL_MAX_DELIVERY_DELAY_MS,
    };
  }
  const age = received - occurredAt.getTime();
  if (Math.abs(age) > MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS) {
    return {
      occurredAt: new Date(received),
      clockSkewed: true,
      deliveryDelayMs: null,
      stale: false,
    };
  }
  return {
    occurredAt: new Date(Math.min(occurredAt.getTime(), received)),
    clockSkewed: false,
    deliveryDelayMs: null,
    stale: false,
  };
}

/** Defensive re-validation; the HTTP DTO enforces the same limits first. */
export function normalizeMarketSignalTelemetry(input: {
  visibleMs?: unknown;
  epoch?: unknown;
  policyVersion?: unknown;
  explore?: unknown;
}): MarketSignalTelemetry {
  let visibleMs: number | null = null;
  if (input.visibleMs !== undefined && input.visibleMs !== null) {
    if (
      typeof input.visibleMs !== 'number' ||
      !Number.isSafeInteger(input.visibleMs) ||
      input.visibleMs < 0 ||
      input.visibleMs > MARKET_SIGNAL_MAX_VISIBLE_MS
    ) {
      throw new BadRequestException(
        `visibleMs must be an integer from 0 to ${MARKET_SIGNAL_MAX_VISIBLE_MS}`,
      );
    }
    visibleMs = input.visibleMs;
  }

  let policyVersion: string | null = null;
  if (input.policyVersion !== undefined && input.policyVersion !== null) {
    if (
      typeof input.policyVersion !== 'string' ||
      !MARKET_SIGNAL_POLICY_VERSION_PATTERN.test(input.policyVersion)
    ) {
      throw new BadRequestException('policyVersion has an unsupported format');
    }
    policyVersion = input.policyVersion;
  }

  let explore: boolean | null = null;
  if (input.explore !== undefined && input.explore !== null) {
    if (typeof input.explore !== 'boolean') {
      throw new BadRequestException('explore must be a boolean');
    }
    explore = input.explore;
  }

  return {
    visibleMs,
    epoch:
      parseMarketSignalInstant(input.epoch, 'epoch')?.toISOString() ?? null,
    policyVersion,
    explore,
  };
}

export function buildMarketSignalEnrichment(input: {
  timing: MarketSignalTiming | null;
  telemetry: MarketSignalTelemetry;
  contribution: string;
}): Record<string, string | number | boolean> {
  const enrichment: Record<string, string | number | boolean> = {
    v: MARKET_SIGNAL_ENRICHMENT_VERSION,
    contribution: input.contribution,
  };
  if (input.timing) {
    enrichment.occurredAt = input.timing.occurredAt.toISOString();
    enrichment.clockSkewed = input.timing.clockSkewed;
    if (input.timing.deliveryDelayMs !== null)
      enrichment.deliveryDelayMs = input.timing.deliveryDelayMs;
  }
  const { visibleMs, epoch, policyVersion, explore } = input.telemetry;
  if (visibleMs !== null) enrichment.visibleMs = visibleMs;
  if (epoch !== null) enrichment.epoch = epoch;
  if (policyVersion !== null) enrichment.policyVersion = policyVersion;
  if (explore !== null) enrichment.explore = explore;
  return enrichment;
}
