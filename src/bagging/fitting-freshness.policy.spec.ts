import { FittingFreshnessPolicy } from './fitting-freshness.policy';

describe('FittingFreshnessPolicy', () => {
  const policy = new FittingFreshnessPolicy();
  const now = new Date('2026-05-08T12:00:00.000Z');

  it('returns NOT_REQUIRED when no required keys exist', () => {
    expect(policy.evaluate({ requiredMeasurementKeys: [], now })).toMatchObject(
      {
        fittingState: 'NOT_REQUIRED',
        freshnessState: 'NOT_REQUIRED',
        missingMeasurementKeys: [],
        requiresStaleConfirmation: false,
      },
    );
  });

  it('returns MISSING when all required values are absent', () => {
    expect(
      policy.evaluate({ requiredMeasurementKeys: ['WAIST', 'CHEST'], now }),
    ).toMatchObject({
      fittingState: 'MISSING',
      freshnessState: 'MISSING',
      missingMeasurementKeys: ['WAIST', 'CHEST'],
    });
  });

  it('returns PARTIAL when some required values are absent', () => {
    expect(
      policy.evaluate({
        requiredMeasurementKeys: ['WAIST', 'CHEST'],
        profile: { measurements: { WAIST: 32 }, updatedAt: now },
        now,
      }),
    ).toMatchObject({
      fittingState: 'PARTIAL',
      freshnessState: 'PARTIAL',
      missingMeasurementKeys: ['CHEST'],
    });
  });

  it('returns FRESH when complete values are inside the 14-day window', () => {
    expect(
      policy.evaluate({
        requiredMeasurementKeys: ['WAIST'],
        profile: {
          measurements: { WAIST: { value: 32 } },
          lastUpdatedAt: new Date('2026-05-01T12:00:00.000Z'),
          updatedAt: new Date('2026-04-01T12:00:00.000Z'),
        },
        now,
      }),
    ).toMatchObject({
      fittingState: 'COMPLETE',
      freshnessState: 'FRESH',
      staleAfterDays: 14,
      staleAt: '2026-05-15T12:00:00.000Z',
      requiresStaleConfirmation: false,
    });
  });

  it('returns STALE when complete values are older than 14 days', () => {
    expect(
      policy.evaluate({
        requiredMeasurementKeys: ['WAIST'],
        profile: {
          measurements: { WAIST: 32 },
          lastUpdatedAt: new Date('2026-04-20T12:00:00.000Z'),
        },
        now,
      }),
    ).toMatchObject({
      fittingState: 'COMPLETE',
      freshnessState: 'STALE',
      staleAfterDays: 14,
      staleAt: '2026-05-04T12:00:00.000Z',
      staleMeasurementKeys: ['WAIST'],
      veryStaleMeasurementKeys: [],
      requiresStaleConfirmation: true,
    });
  });

  it('returns VERY_STALE when complete values are older than 30 days', () => {
    expect(
      policy.evaluate({
        requiredMeasurementKeys: ['WAIST'],
        profile: {
          measurements: { WAIST: 32 },
          lastUpdatedAt: new Date('2026-04-01T12:00:00.000Z'),
        },
        now,
      }),
    ).toMatchObject({
      fittingState: 'COMPLETE',
      freshnessState: 'VERY_STALE',
      staleMeasurementKeys: ['WAIST'],
      veryStaleMeasurementKeys: ['WAIST'],
      veryStaleAfterDays: 30,
      veryStaleAt: '2026-05-01T12:00:00.000Z',
      requiresStaleConfirmation: true,
    });
  });

  it('uses profile-level requireUpdateEveryDays over the default', () => {
    expect(
      policy.evaluate({
        requiredMeasurementKeys: ['WAIST'],
        profile: {
          measurements: { WAIST: 32 },
          lastUpdatedAt: new Date('2026-05-01T12:00:00.000Z'),
          requireUpdateEveryDays: 5,
        },
        now,
      }),
    ).toMatchObject({
      freshnessState: 'STALE',
      staleAfterDays: 5,
      staleAt: '2026-05-06T12:00:00.000Z',
      requiresStaleConfirmation: true,
    });
  });
});
