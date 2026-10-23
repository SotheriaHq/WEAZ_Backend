export type ReportKind = 'morning' | 'evening';

/**
 * Report boundaries in the report time zone (Africa/Lagos by default).
 *
 *   morning: [yesterday 22:00, today 07:00)  — sent at 07:00
 *   evening: [today 07:00,     today 22:00)  — sent at 22:00
 *
 * Windows are half-open and share their boundaries, so back-to-back reports
 * cover every instant exactly once.
 */
export const REPORT_SCHEDULE: Record<
  ReportKind,
  { endHour: number; startHour: number; startDayOffset: number }
> = {
  morning: { endHour: 7, startHour: 22, startDayOffset: -1 },
  evening: { endHour: 22, startHour: 7, startDayOffset: 0 },
};

export type ReportWindow = {
  kind: ReportKind;
  start: Date;
  end: Date;
  timeZone: string;
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

/** Offset (ms) of `timeZone` from UTC at `instant`. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** The UTC instant at which the wall clock in `timeZone` reads y-m-d h:00. */
export function zonedWallTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, 0, 0);
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  // Re-check once at the candidate instant so DST transitions resolve
  // correctly in zones that have them (Lagos does not; others might).
  const second = guess - zoneOffsetMs(new Date(first), timeZone);
  return new Date(second);
}

/**
 * The most recent window of `kind` that has fully ENDED at or before `now`.
 *
 * Derived from the clock rather than the job's trigger time, so a report that
 * runs late (worker restarted across 07:00) still reports the window it was
 * scheduled for, and the duplicate key (kind + end) stays the same.
 */
export function resolveReportWindow(
  kind: ReportKind,
  now: Date,
  timeZone = 'Africa/Lagos',
): ReportWindow {
  const schedule = REPORT_SCHEDULE[kind];
  const local = zonedParts(now, timeZone);
  let end = zonedWallTimeToUtc(
    local.year,
    local.month,
    local.day,
    schedule.endHour,
    timeZone,
  );
  if (end.getTime() > now.getTime()) {
    const previous = new Date(
      Date.UTC(local.year, local.month - 1, local.day - 1),
    );
    end = zonedWallTimeToUtc(
      previous.getUTCFullYear(),
      previous.getUTCMonth() + 1,
      previous.getUTCDate(),
      schedule.endHour,
      timeZone,
    );
  }
  const endLocal = zonedParts(end, timeZone);
  const startDay = new Date(
    Date.UTC(
      endLocal.year,
      endLocal.month - 1,
      endLocal.day + schedule.startDayOffset,
    ),
  );
  const start = zonedWallTimeToUtc(
    startDay.getUTCFullYear(),
    startDay.getUTCMonth() + 1,
    startDay.getUTCDate(),
    schedule.startHour,
    timeZone,
  );
  return { kind, start, end, timeZone };
}

/** UTC hour buckets (YYYYMMDDHH) overlapping [start, end). */
export function hourBucketsBetween(start: Date, end: Date): string[] {
  const buckets: string[] = [];
  const cursor = new Date(start.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor.getTime() < end.getTime()) {
    buckets.push(hourBucket(cursor));
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return buckets;
}

export function hourBucket(instant: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${instant.getUTCFullYear()}${pad(instant.getUTCMonth() + 1)}${pad(instant.getUTCDate())}${pad(instant.getUTCHours())}`;
}

export function formatZoned(
  instant: Date | null | undefined,
  timeZone = 'Africa/Lagos',
): string {
  if (!instant || Number.isNaN(instant.getTime())) return 'n/a';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'short',
  }).format(instant);
}
