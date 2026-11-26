import { BadRequestException } from '@nestjs/common';
import {
  buildMarketSignalEnrichment,
  MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS,
  MARKET_SIGNAL_ENRICHMENT_FLAG,
  MARKET_SIGNAL_MAX_DELIVERY_DELAY_MS,
  normalizeMarketSignalTelemetry,
  parseMarketSignalInstant,
  readMarketSignalEnrichmentFlag,
  resolveMarketSignalTiming,
} from './market-signal-telemetry';

const received = new Date('2026-11-25T12:00:00.000Z');
const minus = (ms: number) => new Date(received.getTime() - ms);

describe('market signal telemetry', () => {
  it('enables enrichment only for the exact string true', () => {
    const read = (value?: string) =>
      readMarketSignalEnrichmentFlag(
        value === undefined ? {} : { [MARKET_SIGNAL_ENRICHMENT_FLAG]: value },
      );
    expect(MARKET_SIGNAL_ENRICHMENT_FLAG).toBe('MARKET_SIGNAL_ENRICHMENT_V1');
    expect(read()).toEqual({ enabled: false, invalid: false });
    expect(read('false')).toEqual({ enabled: false, invalid: false });
    expect(read('true')).toEqual({ enabled: true, invalid: false });
    for (const value of ['TRUE', '1', 'yes', 'on'])
      expect(read(value)).toEqual({ enabled: false, invalid: true });
  });

  it('rejects malformed instants and accepts complete ISO-8601 instants', () => {
    expect(parseMarketSignalInstant(undefined, 'sentAt')).toBeNull();
    expect(
      parseMarketSignalInstant('2026-11-25T11:59:00.123Z', 'sentAt'),
    ).toEqual(new Date('2026-11-25T11:59:00.123Z'));
    for (const value of [
      '2026-11-25',
      '2026-11-25T11:59:00',
      'yesterday',
      1764072000000,
      '2026-13-45T99:00:00Z',
    ])
      expect(() => parseMarketSignalInstant(value, 'sentAt')).toThrow(
        BadRequestException,
      );
  });

  it('uses the device queue delay when sentAt is present, so a wrong device clock cannot move an event', () => {
    // Device clock two days behind; event queued for 5 minutes.
    const deviceOffset = 2 * 86_400_000;
    const timing = resolveMarketSignalTiming(
      minus(deviceOffset + 5 * 60_000),
      minus(deviceOffset),
      received,
    );
    expect(timing).toEqual({
      occurredAt: minus(5 * 60_000),
      clockSkewed: false,
      deliveryDelayMs: 5 * 60_000,
      stale: false,
    });
  });

  it('marks deliveries too late to deduplicate as stale', () => {
    const timing = resolveMarketSignalTiming(
      minus(MARKET_SIGNAL_MAX_DELIVERY_DELAY_MS),
      received,
      received,
    );
    expect(timing?.stale).toBe(true);
    expect(
      resolveMarketSignalTiming(
        minus(MARKET_SIGNAL_MAX_DELIVERY_DELAY_MS - 1),
        received,
        received,
      )?.stale,
    ).toBe(false);
  });

  it('flags an occurredAt after sentAt as skew and never dates an event in the future', () => {
    const timing = resolveMarketSignalTiming(
      new Date(received.getTime() + MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS + 1),
      received,
      received,
    );
    expect(timing).toMatchObject({
      occurredAt: received,
      clockSkewed: true,
      deliveryDelayMs: 0,
      stale: false,
    });
  });

  it('without sentAt, trusts only timestamps inside the skew tolerance', () => {
    expect(
      resolveMarketSignalTiming(minus(60_000), null, received),
    ).toMatchObject({ occurredAt: minus(60_000), clockSkewed: false });
    expect(
      resolveMarketSignalTiming(
        new Date(received.getTime() + 60_000),
        null,
        received,
      ),
    ).toMatchObject({ occurredAt: received, clockSkewed: false });
    expect(
      resolveMarketSignalTiming(
        minus(MARKET_SIGNAL_CLOCK_SKEW_TOLERANCE_MS + 1),
        null,
        received,
      ),
    ).toMatchObject({ occurredAt: received, clockSkewed: true, stale: false });
    expect(resolveMarketSignalTiming(null, received, received)).toBeNull();
  });

  it('re-validates optional telemetry defensively', () => {
    expect(normalizeMarketSignalTelemetry({})).toEqual({
      visibleMs: null,
      epoch: null,
      policyVersion: null,
      explore: null,
    });
    expect(
      normalizeMarketSignalTelemetry({
        visibleMs: 1200,
        epoch: '2026-11-25T12:00:00+01:00',
        policyVersion: 'trend@2',
        explore: false,
      }),
    ).toEqual({
      visibleMs: 1200,
      epoch: '2026-11-25T11:00:00.000Z',
      policyVersion: 'trend@2',
      explore: false,
    });
    for (const input of [
      { visibleMs: -1 },
      { visibleMs: 1.5 },
      { visibleMs: 3_600_001 },
      { policyVersion: 'has space' },
      { policyVersion: 'x'.repeat(41) },
      { explore: 'true' },
      { epoch: 'now' },
    ])
      expect(() => normalizeMarketSignalTelemetry(input)).toThrow(
        BadRequestException,
      );
  });

  it('builds a versioned server record with the contribution decision', () => {
    expect(
      buildMarketSignalEnrichment({
        timing: {
          occurredAt: received,
          clockSkewed: false,
          deliveryDelayMs: 1000,
          stale: false,
        },
        telemetry: {
          visibleMs: 900,
          epoch: null,
          policyVersion: 'trend@2',
          explore: null,
        },
        contribution: 'ungated',
      }),
    ).toEqual({
      v: 1,
      contribution: 'ungated',
      occurredAt: received.toISOString(),
      clockSkewed: false,
      deliveryDelayMs: 1000,
      visibleMs: 900,
      policyVersion: 'trend@2',
    });
  });
});
