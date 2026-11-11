import {
  DOWNGRADE_WINDOWS_DAYS,
  PLAN_ENDING_WINDOWS_DAYS,
  RECOVERY_WINDOWS_DAYS,
  daysUntil,
  downgradeReminder,
  lagosDate,
  planCopy,
  planEndedNotice,
  planEndingReminder,
  recoveryReminder,
  reminderWindow,
  renewalCancelledNotice,
  renewalFailedNotice,
} from './subscription-notices';

/*
 * A plan ending must never surprise a brand (owner, Nov 2026: "ensure the
 * user is notified as much as possible … at least be aware on all fronts").
 * Every notice names the plan, the date in Lagos time, what the free plan
 * means, and where to act.
 */
describe('subscription plan notices', () => {
  const now = new Date('2026-11-10T09:00:00Z');
  const inDays = (days: number) => new Date(now.getTime() + days * 86_400_000);

  it('names each tier and its active seats', () => {
    expect(planCopy('THREAD')).toEqual({
      name: 'Thread',
      active: 2,
      activeLabel: '2 active custom orders at a time',
      canUpgrade: true,
    });
    expect(planCopy('IGWE').active).toBe(6);
    expect(planCopy('IGWE').canUpgrade).toBe(false);
    expect(planCopy('RETIRED').name).toBe('paid');
  });

  it('writes dates in Lagos time', () => {
    // 23:30 UTC on 30 Nov is already 1 Dec in Lagos (UTC+1).
    expect(lagosDate(new Date('2026-11-30T23:30:00Z'))).toBe('1 Dec 2026');
  });

  it('puts each moment in the smallest window that holds it, once', () => {
    expect(
      reminderWindow(daysUntil(inDays(6), now), PLAN_ENDING_WINDOWS_DAYS),
    ).toBe(7);
    expect(
      reminderWindow(daysUntil(inDays(2.5), now), PLAN_ENDING_WINDOWS_DAYS),
    ).toBe(3);
    expect(
      reminderWindow(daysUntil(inDays(0.2), now), PLAN_ENDING_WINDOWS_DAYS),
    ).toBe(1);
    expect(
      reminderWindow(daysUntil(inDays(8), now), PLAN_ENDING_WINDOWS_DAYS),
    ).toBeNull();
    expect(reminderWindow(4, RECOVERY_WINDOWS_DAYS)).toBeNull();
    expect(reminderWindow(3, DOWNGRADE_WINDOWS_DAYS)).toBe(3);
    expect(daysUntil(inDays(0.01), now)).toBe(1);
  });

  it('every notice explains the free plan and where to act', () => {
    const notices = [
      renewalCancelledNotice('THREAD', inDays(5)),
      planEndingReminder('THREAD', inDays(3), now),
      renewalFailedNotice('ARU', inDays(7)),
      recoveryReminder('ARU', inDays(1), now),
      planEndedNotice('ASO_OKE'),
    ];
    for (const notice of notices) {
      expect(notice.message).toContain(
        'the free plan: 1 active custom order at a time',
      );
      expect(notice.message).toContain('Billing & subscriptions');
      expect(notice.message).not.toMatch(/intake is paused/i);
    }
  });

  it('says when, and what is kept', () => {
    const ending = planEndingReminder('THREAD', inDays(3), now);
    expect(ending.heading).toBe('Your Thread plan ends in 3 days');
    expect(ending.message).toContain('13 Nov 2026');
    // A cancelled renewal can't be undone while the plan runs, so the notice
    // never says "renew to keep" — it offers what works.
    expect(ending.message).toContain(
      'To get 2 active custom orders at a time back, subscribe again in Billing & subscriptions when it ends, or move to a bigger plan now',
    );
    expect(ending.message).not.toMatch(/to keep/);
    expect(planEndingReminder('IGWE', inDays(3), now).message).not.toContain(
      'bigger plan',
    );
    expect(renewalCancelledNotice('THREAD', inDays(5)).message).toContain(
      'once it ends, or move to a bigger plan before then.',
    );
    expect(planEndingReminder('THREAD', inDays(0.3), now).heading).toBe(
      'Your Thread plan ends within a day',
    );
    expect(planEndedNotice('ASO_OKE').heading).toBe(
      'Your brand is now on the free plan',
    );
    expect(planEndedNotice('ASO_OKE').message).toContain(
      '3 active custom orders at a time back',
    );
  });

  it('warns before a lower paid tier takes over', () => {
    const notice = downgradeReminder('ARU', 'THREAD', inDays(1), now);
    expect(notice.heading).toBe('Your plan changes to Thread within a day');
    expect(notice.message).toContain(
      'from Aru to Thread: 2 active custom orders at a time',
    );
  });
});
