/**
 * Brand working-hours domain util (Business Hours feature).
 *
 * Pure, framework-free so it is trivially unit-testable. Provides:
 *  - types + validation for a per-weekday schedule and IANA timezone;
 *  - `businessHoursElapsedMs` — how much WORKING time elapsed between two
 *    instants given the schedule + timezone (the input to fulfilment SLAs).
 *
 * Timezone math uses native `Intl.DateTimeFormat` (no library). Africa/Lagos —
 * the default market — has no DST, so conversions are exact; the offset probe
 * also handles DST zones to within the transition hour, which is well inside
 * SLA tolerance.
 */

export const WEEKDAYS = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type Weekday = (typeof WEEKDAYS)[number];

export interface DaySchedule {
  /** "HH:mm" 24h. Ignored when `closed`. */
  open: string;
  /** "HH:mm" 24h, must be after `open`. Ignored when `closed`. */
  close: string;
  closed: boolean;
}

export type WorkingHoursSchedule = Record<Weekday, DaySchedule>;

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const JS_DAY_TO_WEEKDAY: Weekday[] = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
];

export function isValidTimeString(value: unknown): value is string {
  return typeof value === 'string' && TIME_RE.test(value.trim());
}

function timeToMinutes(value: string): number {
  const [h, m] = value.trim().split(':').map(Number);
  return h * 60 + m;
}

export function isValidIanaTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    // Throws RangeError for an unknown timezone.
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate + normalize a raw working-hours input into a full 7-day schedule.
 * Missing days default to closed. Throws a plain Error (message is safe to
 * surface) so the caller can map it to its own HTTP exception. Requires at
 * least one open day with `open < close`.
 */
export function validateWorkingHours(input: unknown): WorkingHoursSchedule {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('Working hours must be an object keyed by weekday.');
  }
  const raw = input as Record<string, unknown>;
  const schedule = {} as WorkingHoursSchedule;
  let openDays = 0;

  for (const day of WEEKDAYS) {
    const value = raw[day];
    if (value === undefined || value === null) {
      schedule[day] = { open: '09:00', close: '18:00', closed: true };
      continue;
    }
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Working hours for ${day} must be an object.`);
    }
    const entry = value as Record<string, unknown>;
    const closed = entry.closed === true;
    if (closed) {
      schedule[day] = { open: '09:00', close: '18:00', closed: true };
      continue;
    }
    if (!isValidTimeString(entry.open) || !isValidTimeString(entry.close)) {
      throw new Error(`Working hours for ${day} need valid open/close times (HH:mm).`);
    }
    const open = String(entry.open).trim();
    const close = String(entry.close).trim();
    if (timeToMinutes(close) <= timeToMinutes(open)) {
      throw new Error(`Working hours for ${day}: close time must be after open time.`);
    }
    schedule[day] = { open, close, closed: false };
    openDays += 1;
  }

  if (openDays === 0) {
    throw new Error('At least one working day must be open.');
  }
  return schedule;
}

/** Best-effort normalize an unknown JSON value (from the DB) to a schedule, or null. */
export function coerceWorkingHours(value: unknown): WorkingHoursSchedule | null {
  try {
    return validateWorkingHours(value);
  } catch {
    return null;
  }
}

function tzOffsetMs(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(date);
  const map: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') map[part.type] = Number(part.value);
  }
  // What UTC clock-time would show these same wall components:
  const asUtc = Date.UTC(
    map.year,
    (map.month ?? 1) - 1,
    map.day ?? 1,
    map.hour === 24 ? 0 : map.hour ?? 0,
    map.minute ?? 0,
    map.second ?? 0,
  );
  return asUtc - date.getTime();
}

/** UTC instant for a wall-clock time (y, m[1-12], d, h, min) in `tz`. */
function zonedWallTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  min: number,
  tz: string,
): number {
  const guess = Date.UTC(y, m - 1, d, h, min);
  const offset = tzOffsetMs(new Date(guess), tz);
  return guess - offset;
}

/** tz-local calendar date + weekday for an instant. */
function tzLocalDate(date: Date, tz: string): {
  year: number;
  month: number;
  day: number;
  weekday: Weekday;
} {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  });
  const map: Record<string, string> = {};
  for (const part of dtf.formatToParts(date)) map[part.type] = part.value;
  const jsDay = new Date(
    `${map.year}-${map.month}-${map.day}T00:00:00Z`,
  ).getUTCDay();
  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: JS_DAY_TO_WEEKDAY[jsDay],
  };
}

/**
 * Working-time elapsed (ms) between two instants given a schedule + timezone.
 * Only intervals inside open days/windows count. Returns 0 when end <= start.
 */
export function businessHoursElapsedMs(
  startAt: Date,
  endAt: Date,
  schedule: WorkingHoursSchedule,
  tz: string,
): number {
  const startMs = startAt.getTime();
  const endMs = endAt.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return 0;
  }

  let total = 0;
  let { year, month, day } = tzLocalDate(startAt, tz);

  // Cap the walk (safety) — 400 days covers any realistic SLA window.
  for (let i = 0; i < 400; i += 1) {
    const { weekday } = tzLocalDate(
      new Date(zonedWallTimeToUtc(year, month, day, 12, 0, tz)),
      tz,
    );
    const sched = schedule[weekday];
    if (sched && !sched.closed) {
      const [oh, om] = sched.open.split(':').map(Number);
      const [ch, cm] = sched.close.split(':').map(Number);
      const openUtc = zonedWallTimeToUtc(year, month, day, oh, om, tz);
      const closeUtc = zonedWallTimeToUtc(year, month, day, ch, cm, tz);
      const lo = Math.max(openUtc, startMs);
      const hi = Math.min(closeUtc, endMs);
      if (hi > lo) total += hi - lo;
    }

    // Advance to the next tz-local calendar day (noon avoids DST edges).
    const nextNoonUtc = zonedWallTimeToUtc(year, month, day, 12, 0, tz) + 24 * 60 * 60 * 1000;
    const next = tzLocalDate(new Date(nextNoonUtc), tz);
    // Stop once the new day starts after the end instant.
    if (zonedWallTimeToUtc(next.year, next.month, next.day, 0, 0, tz) > endMs) {
      break;
    }
    year = next.year;
    month = next.month;
    day = next.day;
  }

  return total;
}

export function businessHoursElapsedHours(
  startAt: Date,
  endAt: Date,
  schedule: WorkingHoursSchedule,
  tz: string,
): number {
  return businessHoursElapsedMs(startAt, endAt, schedule, tz) / (60 * 60 * 1000);
}

/**
 * Whether the brand is open at `at` per its schedule + timezone. Used to gate
 * SLA reminders: business-hours "elapsed" freezes overnight, so a tier could
 * otherwise re-fire on every closed-hour cron run — we only fire while open.
 */
export function isCurrentlyOpen(
  schedule: WorkingHoursSchedule,
  tz: string,
  at: Date = new Date(),
): boolean {
  const { year, month, day, weekday } = tzLocalDate(at, tz);
  const sched = schedule[weekday];
  if (!sched || sched.closed) return false;
  const [oh, om] = sched.open.split(':').map(Number);
  const [ch, cm] = sched.close.split(':').map(Number);
  const openUtc = zonedWallTimeToUtc(year, month, day, oh, om, tz);
  const closeUtc = zonedWallTimeToUtc(year, month, day, ch, cm, tz);
  const t = at.getTime();
  return t >= openUtc && t < closeUtc;
}
