import {
  FREE_PLAN_CAPACITY,
  SUBSCRIPTION_TIERS,
} from '../custom-orders/queue/subscription-queue.policy';

/**
 * What a brand is told when its plan is about to end, has ended, or changes
 * (owner, Nov 2026: "ensure the user is notified as much as possible, giving
 * the user the option to subscribe or make plans … at least be aware on all
 * fronts").
 *
 * Every notice says the same three things: what is happening and when (in
 * Lagos time, the billing timezone), what the free plan means for custom
 * orders, and what the owner can do about it. The wording lives here, pure,
 * so it is tested once and every channel (inbox, push, email) says it alike.
 */

export type BillingNotice = { heading: string; message: string };

const DAY_MS = 86_400_000;

/** Warn this many days before a renewal-cancelled plan ends. */
export const PLAN_ENDING_WINDOWS_DAYS = [7, 3, 1] as const;
/** Warn this many days before a failed renewal's recovery window closes. */
export const RECOVERY_WINDOWS_DAYS = [3, 1] as const;
/** Warn this many days before a scheduled lower tier takes over. */
export const DOWNGRADE_WINDOWS_DAYS = [3, 1] as const;

export function planCopy(tierKey: string | null | undefined): {
  name: string;
  active: number | null;
  activeLabel: string;
  /** A bigger plan exists to move up to. */
  canUpgrade: boolean;
} {
  const index = SUBSCRIPTION_TIERS.findIndex((entry) => entry.key === tierKey);
  const tier = index === -1 ? undefined : SUBSCRIPTION_TIERS[index];
  if (!tier) {
    return {
      name: 'paid',
      active: null,
      activeLabel: 'more active orders',
      canUpgrade: false,
    };
  }
  return {
    name: tier.name,
    active: tier.maxActive,
    canUpgrade: index < SUBSCRIPTION_TIERS.length - 1,
    activeLabel:
      tier.maxActive === null
        ? 'unlimited active orders'
        : `${tier.maxActive} active custom orders at a time`,
  };
}

/** A date as the billing pages show it: Lagos time, day month year. */
export function lagosDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

/** Whole days left, rounded up: anything under a day is one. */
export function daysUntil(end: Date, now: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / DAY_MS));
}

/**
 * The warning a moment falls into, or null when it is outside every window.
 * Windows are checked smallest first, so a plan ending in 2 days is in the
 * 3-day window, and each window sends once (its key carries the window).
 */
export function reminderWindow(
  daysLeft: number,
  windows: readonly number[],
): number | null {
  const sorted = [...windows].sort((a, b) => a - b);
  return sorted.find((window) => daysLeft <= window) ?? null;
}

const FREE_PLAN_LINE = `the free plan: ${FREE_PLAN_CAPACITY.maxActive} active custom order at a time. Orders already active continue, and orders waiting keep their place and move up one at a time`;

function whenLeft(daysLeft: number): string {
  return daysLeft <= 1 ? 'within a day' : `in ${daysLeft} days`;
}

/*
 * A cancelled renewal cannot be undone: choosing the same plan again while it
 * is still running changes nothing (the quote is UNCHANGED). So the notices
 * offer what does work — subscribe again once it ends, or move up now.
 */

/** Renewal cancelled: the plan will end, and what happens then. */
export function renewalCancelledNotice(
  tierKey: string | null | undefined,
  periodEnd: Date,
): BillingNotice {
  const plan = planCopy(tierKey);
  return {
    heading: 'Subscription renewal cancelled',
    message: `Future renewals are cancelled. Your ${plan.name} plan stays in place until ${lagosDate(periodEnd)} (Lagos time); after that your brand moves to ${FREE_PLAN_LINE}. You can subscribe again in Billing & subscriptions once it ends${plan.canUpgrade ? ', or move to a bigger plan before then' : ''}.`,
  };
}

/** Before a renewal-cancelled plan ends. */
export function planEndingReminder(
  tierKey: string | null | undefined,
  periodEnd: Date,
  now: Date,
): BillingNotice {
  const plan = planCopy(tierKey);
  const daysLeft = daysUntil(periodEnd, now);
  return {
    heading: `Your ${plan.name} plan ends ${whenLeft(daysLeft)}`,
    message: `Your ${plan.name} plan ends on ${lagosDate(periodEnd)} (Lagos time) because renewal is cancelled. After that your brand moves to ${FREE_PLAN_LINE}. To get ${plan.activeLabel} back, subscribe again in Billing & subscriptions when it ends${plan.canUpgrade ? ', or move to a bigger plan now' : ''}.`,
  };
}

/** The renewal failed: free plan now, and how to recover the paid one. */
export function renewalFailedNotice(
  tierKey: string | null | undefined,
  recoveryUntil: Date,
): BillingNotice {
  const plan = planCopy(tierKey);
  return {
    heading: 'Your plan renewal didn’t go through',
    message: `Your ${plan.name} renewal didn’t go through, so until it is recovered your brand is on ${FREE_PLAN_LINE}. Recover the renewal by ${lagosDate(recoveryUntil)} (Lagos time) at your current price to get ${plan.activeLabel} back — check your card in Billing & subscriptions.`,
  };
}

/** Before a failed renewal's recovery window closes. */
export function recoveryReminder(
  tierKey: string | null | undefined,
  recoveryUntil: Date,
  now: Date,
): BillingNotice {
  const plan = planCopy(tierKey);
  const daysLeft = daysUntil(recoveryUntil, now);
  return {
    heading: `Recover your ${plan.name} plan ${whenLeft(daysLeft)}`,
    message: `Your ${plan.name} renewal still hasn’t gone through. Recover it by ${lagosDate(recoveryUntil)} (Lagos time) at your current price; after that a new subscription uses current pricing, and until then your brand stays on ${FREE_PLAN_LINE}. Update your card in Billing & subscriptions.`,
  };
}

/** The paid period is over: the brand is on the free plan now. */
export function planEndedNotice(
  tierKey: string | null | undefined,
): BillingNotice {
  const plan = planCopy(tierKey);
  return {
    heading: 'Your brand is now on the free plan',
    message: `Your ${plan.name} plan has ended, so your brand is now on ${FREE_PLAN_LINE}. Subscribe again in Billing & subscriptions to get ${plan.activeLabel} back.`,
  };
}

/** Before a scheduled lower tier takes over at renewal. */
export function downgradeReminder(
  fromTierKey: string | null | undefined,
  toTierKey: string | null | undefined,
  changesAt: Date,
  now: Date,
): BillingNotice {
  const from = planCopy(fromTierKey);
  const to = planCopy(toTierKey);
  const daysLeft = daysUntil(changesAt, now);
  return {
    heading: `Your plan changes to ${to.name} ${whenLeft(daysLeft)}`,
    message: `On ${lagosDate(changesAt)} (Lagos time) your plan changes from ${from.name} to ${to.name}: ${to.activeLabel}. Orders already active continue, and extra waiting orders move up as seats free. Review your plan in Billing & subscriptions.`,
  };
}
