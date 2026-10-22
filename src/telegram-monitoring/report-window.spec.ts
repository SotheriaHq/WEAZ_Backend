import { formatZoned, hourBucketsBetween, resolveReportWindow } from './report-window';

describe('resolveReportWindow (Africa/Lagos, UTC+1)', () => {
  it('morning report at 07:00 Lagos covers yesterday 22:00 → today 07:00', () => {
    const window = resolveReportWindow('morning', new Date('2026-10-22T06:00:00Z'));
    expect(window.start.toISOString()).toBe('2026-10-21T21:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-22T06:00:00.000Z');
  });

  it('evening report at 22:00 Lagos covers today 07:00 → 22:00', () => {
    const window = resolveReportWindow('evening', new Date('2026-10-22T21:00:00Z'));
    expect(window.start.toISOString()).toBe('2026-10-22T06:00:00.000Z');
    expect(window.end.toISOString()).toBe('2026-10-22T21:00:00.000Z');
  });

  it('a late run (worker restarted across 07:00) reports the same window', () => {
    const onTime = resolveReportWindow('morning', new Date('2026-10-22T06:00:00Z'));
    const late = resolveReportWindow('morning', new Date('2026-10-22T09:47:12Z'));
    expect(late.start).toEqual(onTime.start);
    expect(late.end).toEqual(onTime.end);
  });

  it('a run just before 07:00 Lagos resolves to the previous completed window', () => {
    const window = resolveReportWindow('morning', new Date('2026-10-22T05:59:59Z'));
    expect(window.end.toISOString()).toBe('2026-10-21T06:00:00.000Z');
  });

  it('consecutive windows are contiguous: no gap, no overlap', () => {
    const morning = resolveReportWindow('morning', new Date('2026-10-22T06:00:00Z'));
    const evening = resolveReportWindow('evening', new Date('2026-10-22T21:00:00Z'));
    const nextMorning = resolveReportWindow('morning', new Date('2026-10-23T06:00:00Z'));
    expect(evening.start).toEqual(morning.end);
    expect(nextMorning.start).toEqual(evening.end);
    const total = nextMorning.end.getTime() - morning.start.getTime();
    expect(total).toBe(33 * 60 * 60 * 1000);
  });

  it('crosses month and year boundaries', () => {
    const window = resolveReportWindow('morning', new Date('2027-01-01T06:30:00Z'));
    expect(window.start.toISOString()).toBe('2026-12-31T21:00:00.000Z');
    expect(window.end.toISOString()).toBe('2027-01-01T06:00:00.000Z');
  });

  it('hour buckets exactly tile the window (9 h morning, 15 h evening)', () => {
    const morning = resolveReportWindow('morning', new Date('2026-10-22T06:00:00Z'));
    const evening = resolveReportWindow('evening', new Date('2026-10-22T21:00:00Z'));
    expect(hourBucketsBetween(morning.start, morning.end)).toHaveLength(9);
    expect(hourBucketsBetween(evening.start, evening.end)).toHaveLength(15);
    expect(hourBucketsBetween(morning.start, morning.end)[0]).toBe('2026102121');
  });

  it('formats in Lagos local time', () => {
    expect(formatZoned(new Date('2026-10-22T06:00:00Z'))).toMatch(/22 Oct 2026, 07:00/);
  });
});
