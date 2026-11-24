import {
  MARKET_CANONICAL_INSTANT_PATTERN,
  MARKET_RETENTION_ACTOR_SCAN,
  MARKET_RETENTION_CLASSES,
  marketRetentionActorSql,
  marketRetentionStepCount,
  marketRetentionSteps,
} from './market-intelligence.sql';

const cutoff = new Date('2026-11-23T12:00:00.000Z');
const eventClasses = ['feed', 'sections', 'suggestions', 'seen', 'receipts'];

describe('Market privacy retention SQL', () => {
  it('uses no PostgreSQL 16+ input validation function', () => {
    for (const kind of MARKET_RETENTION_CLASSES)
      for (const step of marketRetentionSteps(kind, cutoff)) {
        expect(step.delete.text).not.toContain('pg_input_is_valid');
        expect(step.remaining.text).not.toContain('pg_input_is_valid');
      }
  });

  it('compares only canonical cache instants as text, never casting them', () => {
    const [step] = marketRetentionSteps('runwayCache', cutoff);
    expect(step.delete.text).not.toMatch(/sourceWindowStart'\)?::timestamptz/);
    expect(step.delete.values).toEqual(
      expect.arrayContaining([
        MARKET_CANONICAL_INSTANT_PATTERN,
        cutoff.toISOString(),
      ]),
    );
    const canonical = new RegExp(MARKET_CANONICAL_INSTANT_PATTERN);
    for (const valid of [
      '2026-11-23T12:00:00.000Z',
      '2024-02-29T23:59:59.999Z',
      '2000-02-29T00:00:00.000Z',
    ])
      expect(canonical.test(valid)).toBe(true);
    for (const invalid of [
      '2026-02-30T00:00:00.000Z',
      '2023-02-29T00:00:00.000Z',
      '1900-02-29T00:00:00.000Z',
      '2026-04-31T00:00:00.000Z',
      '2026-11-23T24:00:00.000Z',
      '0000-01-01T00:00:00.000Z',
      '2026-11-23T12:00:00Z',
      '2026-11-23T12:00:00.000+01:00',
    ])
      expect(canonical.test(invalid)).toBe(false);
  });

  it.each(eventClasses)(
    'expires %s by one indexed age range plus a bounded actor scan',
    (kind) => {
      const steps = marketRetentionSteps(kind as never, cutoff);
      expect(steps).toHaveLength(1);
      for (const text of [steps[0].delete.text, steps[0].remaining.text]) {
        expect(text).toContain('"createdAt"<$1::timestamptz');
        expect(text).not.toMatch(/\bOR\b|NOT EXISTS|seenAt/);
      }
      expect(steps[0].delete.text).toContain('ORDER BY "createdAt","_id"');
      const actors = marketRetentionActorSql(kind as never, null)!;
      expect(actors.values).toEqual([MARKET_RETENTION_ACTOR_SCAN, 2_000]);
      expect(actors.text).toContain('"userId" IS NOT NULL');
      const resumed = marketRetentionActorSql(
        kind as never,
        '00000000-0000-0000-0000-000000000001',
      )!;
      expect(resumed.text).toContain('"userId">$1::uuid');
      expect(marketRetentionStepCount(kind as never)).toBe(2);
    },
  );

  it('splits identified aggregates into two indexed identity scans', () => {
    const steps = marketRetentionSteps('identifiedAggregates', cutoff);
    expect(steps.map((step) => step.remaining.text)).toEqual([
      expect.stringContaining('"userId" IS NOT NULL'),
      expect.stringContaining('"anonymousSessionId" IS NOT NULL'),
    ]);
    for (const step of steps) expect(step.delete.text).not.toMatch(/\bOR\b/);
    expect(marketRetentionActorSql('identifiedAggregates', null)).toBeNull();
  });

  it('rejects an unknown class name', () => {
    expect(() => marketRetentionSteps('users' as never, cutoff)).toThrow(
      RangeError,
    );
  });
});
