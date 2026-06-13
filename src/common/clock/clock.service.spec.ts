import { ClockService } from './clock.service';

function makeService(env: Record<string, string | undefined> = {}): ClockService {
  const saved: Record<string, string | undefined> = {};
  const keys = ['APP_ENV', 'CLOCK_MODE', 'CLOCK_OFFSET_DAYS', 'CLOCK_OFFSET_HOURS', 'CLOCK_FIXED_TIME'];
  for (const k of keys) {
    saved[k] = process.env[k];
    if (k in env) {
      process.env[k] = env[k];
    } else {
      delete process.env[k];
    }
  }
  try {
    return new ClockService();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

describe('ClockService', () => {
  describe('real mode', () => {
    it('now() returns real-ish current time', () => {
      const svc = makeService({ CLOCK_MODE: 'real' });
      const before = Date.now();
      const result = svc.now().getTime();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after + 5);
    });

    it('realNow() always uses real server time', () => {
      const svc = makeService({ CLOCK_MODE: 'real' });
      const before = Date.now();
      const result = svc.realNow().getTime();
      const after = Date.now();
      expect(result).toBeGreaterThanOrEqual(before);
      expect(result).toBeLessThanOrEqual(after + 5);
    });

    it('getMode() returns real', () => {
      const svc = makeService({ CLOCK_MODE: 'real' });
      expect(svc.getMode()).toBe('real');
    });

    it('defaults to real mode when CLOCK_MODE is unset', () => {
      const svc = makeService({});
      expect(svc.getMode()).toBe('real');
    });
  });

  describe('offset mode', () => {
    it('applies day offset to now()', () => {
      const svc = makeService({ CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '5', CLOCK_OFFSET_HOURS: '0' });
      const expected = Date.now() + 5 * 24 * 60 * 60 * 1000;
      expect(svc.now().getTime()).toBeCloseTo(expected, -2);
    });

    it('applies hour offset to now()', () => {
      const svc = makeService({ CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '0', CLOCK_OFFSET_HOURS: '3' });
      const expected = Date.now() + 3 * 60 * 60 * 1000;
      expect(svc.now().getTime()).toBeCloseTo(expected, -2);
    });

    it('combines days and hours', () => {
      const svc = makeService({ CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '2', CLOCK_OFFSET_HOURS: '6' });
      const expectedOffset = (2 * 24 * 60 * 60 + 6 * 3600) * 1000;
      expect(svc.now().getTime()).toBeCloseTo(Date.now() + expectedOffset, -2);
    });

    it('realNow() always returns real server time in offset mode', () => {
      const svc = makeService({ CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '30', CLOCK_OFFSET_HOURS: '0' });
      const before = Date.now();
      const real = svc.realNow().getTime();
      const after = Date.now();
      expect(real).toBeGreaterThanOrEqual(before);
      expect(real).toBeLessThanOrEqual(after + 5);
    });

    it('getEffectiveState() reports offset details', () => {
      const svc = makeService({ CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '5', CLOCK_OFFSET_HOURS: '2' });
      const state = svc.getEffectiveState();
      expect(state.mode).toBe('offset');
      expect(state.offsetDays).toBe(5);
      expect(state.offsetHours).toBe(2);
      expect(new Date(state.effectiveNow).getTime()).toBeGreaterThan(new Date(state.realNow).getTime());
    });
  });

  describe('fixed mode', () => {
    const FIXED = '2026-06-20T09:00:00.000Z';

    it('now() returns the fixed ISO time', () => {
      const svc = makeService({ CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: FIXED });
      expect(svc.now().toISOString()).toBe(FIXED);
    });

    it('now() is repeatable across multiple calls', () => {
      const svc = makeService({ CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: FIXED });
      expect(svc.now().toISOString()).toBe(svc.now().toISOString());
    });

    it('realNow() returns real server time even in fixed mode', () => {
      const svc = makeService({ CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: FIXED });
      const before = Date.now();
      const real = svc.realNow().getTime();
      const after = Date.now();
      expect(real).toBeGreaterThanOrEqual(before);
      expect(real).toBeLessThanOrEqual(after + 5);
    });

    it('getEffectiveState() reports fixed time', () => {
      const svc = makeService({ CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: FIXED });
      const state = svc.getEffectiveState();
      expect(state.mode).toBe('fixed');
      expect(state.fixedTime).toBe(FIXED);
    });

    it('fails startup when CLOCK_FIXED_TIME is missing', () => {
      expect(() => makeService({ CLOCK_MODE: 'fixed' })).toThrow('CLOCK_FIXED_TIME');
    });

    it('fails startup when CLOCK_FIXED_TIME is an invalid date', () => {
      expect(() =>
        makeService({ CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: 'not-a-date' }),
      ).toThrow('not a valid ISO date');
    });
  });

  describe('production safety', () => {
    it('rejects offset mode when APP_ENV=production', () => {
      expect(() =>
        makeService({ APP_ENV: 'production', CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '5' }),
      ).toThrow('not allowed when APP_ENV=production');
    });

    it('rejects fixed mode when APP_ENV=production', () => {
      expect(() =>
        makeService({ APP_ENV: 'production', CLOCK_MODE: 'fixed', CLOCK_FIXED_TIME: '2026-06-20T09:00:00.000Z' }),
      ).toThrow('not allowed when APP_ENV=production');
    });

    it('allows real mode when APP_ENV=production', () => {
      expect(() =>
        makeService({ APP_ENV: 'production', CLOCK_MODE: 'real' }),
      ).not.toThrow();
    });

    it('allows offset mode when APP_ENV=sit (non-production)', () => {
      expect(() =>
        makeService({ APP_ENV: 'sit', CLOCK_MODE: 'offset', CLOCK_OFFSET_DAYS: '5' }),
      ).not.toThrow();
    });

    it('rejects unknown CLOCK_MODE values', () => {
      expect(() =>
        makeService({ CLOCK_MODE: 'bogus' }),
      ).toThrow('Unknown CLOCK_MODE');
    });
  });
});
