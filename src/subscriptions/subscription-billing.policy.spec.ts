import {
  billingAnchorDay,
  nextBillingAnniversary,
  proratedUpgradeKobo,
  recoveryDeadline,
  renewalAttemptAt,
} from './subscription-billing.policy';

describe('approved subscription billing policy', () => {
  it('keeps a January 31 Lagos anniversary through February and restores March 31', () => {
    const january = new Date('2027-01-30T23:30:00.000Z');
    const anchor = billingAnchorDay(january);
    expect(anchor).toBe(31);
    const february = nextBillingAnniversary(january, anchor);
    expect(february.toISOString()).toBe('2027-02-27T23:30:00.000Z');
    expect(nextBillingAnniversary(february, anchor).toISOString()).toBe(
      '2027-03-30T23:30:00.000Z',
    );
  });

  it('uses leap-day fallback without losing the original anchor', () => {
    expect(
      nextBillingAnniversary(
        new Date('2028-01-31T10:00:00Z'),
        31,
      ).toISOString(),
    ).toBe('2028-02-29T10:00:00.000Z');
  });

  it('charges only the remaining positive difference, rounded once in kobo', () => {
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    expect(proratedUpgradeKobo(10000, 30000, start, end, start)).toBe(
      2_000_000,
    );
    expect(
      proratedUpgradeKobo(
        10000,
        30000,
        start,
        end,
        new Date('2026-10-16T12:00:00Z'),
      ),
    ).toBe(1_000_000);
    expect(proratedUpgradeKobo(30000, 10000, start, end, start)).toBe(0);
    expect(proratedUpgradeKobo(10000, 30000, start, end, end)).toBe(0);
  });

  it('has a strict seven-day recovery cutoff and bounded retry schedule', () => {
    const end = new Date('2026-10-18T08:00:00Z');
    expect(recoveryDeadline(end).toISOString()).toBe(
      '2026-10-25T08:00:00.000Z',
    );
    expect(renewalAttemptAt(end, 0)).toEqual(end);
    expect(renewalAttemptAt(end, 1)?.toISOString()).toBe(
      '2026-10-19T08:00:00.000Z',
    );
    expect(renewalAttemptAt(end, 2)?.toISOString()).toBe(
      '2026-10-21T08:00:00.000Z',
    );
    expect(renewalAttemptAt(end, 3)?.getTime()).toBeLessThanOrEqual(
      recoveryDeadline(end).getTime(),
    );
    expect(renewalAttemptAt(end, 4)).toBeNull();
  });
});
