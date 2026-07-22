import {
  businessHoursElapsedHours,
  isCurrentlyOpen,
  isValidIanaTimeZone,
  validateWorkingHours,
  type WorkingHoursSchedule,
} from './working-hours.util';

const LAGOS = 'Africa/Lagos'; // UTC+1, no DST

// Mon–Sat 09:00–18:00, Sunday closed.
const schedule: WorkingHoursSchedule = validateWorkingHours({
  monday: { open: '09:00', close: '18:00' },
  tuesday: { open: '09:00', close: '18:00' },
  wednesday: { open: '09:00', close: '18:00' },
  thursday: { open: '09:00', close: '18:00' },
  friday: { open: '09:00', close: '18:00' },
  saturday: { open: '09:00', close: '18:00' },
  sunday: { closed: true },
});

describe('working-hours validation', () => {
  it('normalizes a valid schedule and marks missing days closed', () => {
    const s = validateWorkingHours({ monday: { open: '09:00', close: '17:00' } });
    expect(s.monday).toEqual({ open: '09:00', close: '17:00', closed: false });
    expect(s.sunday.closed).toBe(true);
  });

  it('rejects invalid times, inverted windows, and all-closed', () => {
    expect(() => validateWorkingHours({ monday: { open: '9', close: '18:00' } })).toThrow();
    expect(() => validateWorkingHours({ monday: { open: '18:00', close: '09:00' } })).toThrow();
    expect(() => validateWorkingHours({ monday: { closed: true } })).toThrow(/at least one/i);
  });

  it('validates IANA timezones', () => {
    expect(isValidIanaTimeZone(LAGOS)).toBe(true);
    expect(isValidIanaTimeZone('Not/AZone')).toBe(false);
    expect(isValidIanaTimeZone('')).toBe(false);
  });
});

describe('businessHoursElapsedHours (Africa/Lagos, Mon–Sat 09:00–18:00)', () => {
  const h = (startIso: string, endIso: string) =>
    businessHoursElapsedHours(new Date(startIso), new Date(endIso), schedule, LAGOS);

  it('counts working time within a single day', () => {
    // Mon 10:00 → 15:00 Lagos (09:00Z → 14:00Z)
    expect(h('2024-01-01T09:00:00Z', '2024-01-01T14:00:00Z')).toBeCloseTo(5, 5);
  });

  it('excludes overnight closed hours', () => {
    // Mon 17:00 → Tue 10:00 Lagos: 1h Mon + 1h Tue
    expect(h('2024-01-01T16:00:00Z', '2024-01-02T09:00:00Z')).toBeCloseTo(2, 5);
  });

  it('excludes a closed Sunday when spanning the weekend', () => {
    // Sat 17:00 → Mon 10:00 Lagos: 1h Sat + 0 Sun + 1h Mon
    expect(h('2024-01-06T16:00:00Z', '2024-01-08T09:00:00Z')).toBeCloseTo(2, 5);
  });

  it('is zero entirely outside working hours', () => {
    // Mon 07:00 → 08:30 Lagos (before 09:00 open)
    expect(h('2024-01-01T06:00:00Z', '2024-01-01T07:30:00Z')).toBe(0);
  });

  it('caps at the full working window when spanning open→close', () => {
    // Mon 08:00 → 20:00 Lagos: full 9h day
    expect(h('2024-01-01T07:00:00Z', '2024-01-01T19:00:00Z')).toBeCloseTo(9, 5);
  });

  it('returns 0 when end precedes start', () => {
    expect(h('2024-01-02T09:00:00Z', '2024-01-01T09:00:00Z')).toBe(0);
  });
});

describe('isCurrentlyOpen (Africa/Lagos, Mon–Sat 09:00–18:00)', () => {
  const at = (iso: string) => isCurrentlyOpen(schedule, LAGOS, new Date(iso));

  it('is open mid-window on a working day', () => {
    expect(at('2024-01-01T09:00:00Z')).toBe(true); // Mon 10:00 Lagos
  });
  it('is closed before open and at/after close', () => {
    expect(at('2024-01-01T06:00:00Z')).toBe(false); // Mon 07:00 Lagos
    expect(at('2024-01-01T17:00:00Z')).toBe(false); // Mon 18:00 Lagos (== close)
    expect(at('2024-01-01T20:00:00Z')).toBe(false); // Mon 21:00 Lagos
  });
  it('is closed all day on a closed weekday', () => {
    expect(at('2024-01-07T11:00:00Z')).toBe(false); // Sunday
  });
});
