const DAY_MS = 24 * 60 * 60 * 1000;
const LAGOS_OFFSET_MS = 60 * 60 * 1000;

/** Monthly anniversary in Lagos, preserving the original anchor after February. */
export function nextBillingAnniversary(start: Date, anchorDay?: number): Date {
  const local = new Date(start.getTime() + LAGOS_OFFSET_MS);
  const year = local.getUTCFullYear();
  const month = local.getUTCMonth() + 1;
  const day = Math.min(
    anchorDay ?? local.getUTCDate(),
    new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  );
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      local.getUTCHours(),
      local.getUTCMinutes(),
      local.getUTCSeconds(),
      local.getUTCMilliseconds(),
    ) - LAGOS_OFFSET_MS,
  );
}

export function billingAnchorDay(date: Date): number {
  return new Date(date.getTime() + LAGOS_OFFSET_MS).getUTCDate();
}

/** Integer kobo; a positive upgrade difference never rounds into free service. */
export function proratedUpgradeKobo(
  oldMonthlyNgn: number,
  newMonthlyNgn: number,
  start: Date,
  end: Date,
  now: Date,
): number {
  const duration = end.getTime() - start.getTime();
  if (duration <= 0 || now >= end || newMonthlyNgn <= oldMonthlyNgn) return 0;
  const remaining = Math.min(
    duration,
    Math.max(0, end.getTime() - now.getTime()),
  );
  return Math.ceil(
    ((newMonthlyNgn - oldMonthlyNgn) * 100 * remaining) / duration,
  );
}

export function recoveryDeadline(periodEnd: Date): Date {
  return new Date(periodEnd.getTime() + 7 * DAY_MS);
}

/** Initial charge is due at renewal, with three authorized retries at day 1/3/7. */
export function renewalAttemptAt(
  periodEnd: Date,
  attemptCount: number,
): Date | null {
  const days = [0, 1, 3, 7];
  const day = days[attemptCount];
  return day === undefined
    ? null
    : new Date(periodEnd.getTime() + day * DAY_MS - (day === 7 ? 60_000 : 0));
}

export function subscriptionAttemptReference(
  reference: string,
  attempt: number,
): string {
  return attempt === 0 ? reference : `${reference}-a${attempt}`;
}
