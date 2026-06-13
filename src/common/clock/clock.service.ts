import { Injectable, Logger } from '@nestjs/common';
import { ClockMode, ClockEffectiveState } from './clock.types';

/**
 * Restart-only fake clock for business/test time.
 *
 * Reads CLOCK_MODE, CLOCK_OFFSET_DAYS, CLOCK_OFFSET_HOURS, CLOCK_FIXED_TIME at
 * process startup. Changes require a full backend restart to take effect.
 *
 * Production safety: APP_ENV=production forces real mode and rejects fake config
 * at startup. SIT (APP_ENV=sit) may use offset/fixed after restart.
 *
 * ONLY use ClockService.now() for business expiry logic (collection draft TTL,
 * warning thresholds, soft-delete recovery window). Never replace real time for
 * auth tokens, presigned URLs, payments, queue locks, or audit timestamps.
 */
@Injectable()
export class ClockService {
  private readonly logger = new Logger(ClockService.name);
  private readonly mode: ClockMode;
  private readonly offsetMs: number;
  private readonly offsetDays: number;
  private readonly offsetHours: number;
  private readonly fixedTime: Date | null;

  constructor() {
    const appEnv = String(process.env.APP_ENV ?? '').trim().toLowerCase();
    const isHardProduction = appEnv === 'production';

    const rawMode = String(process.env.CLOCK_MODE ?? 'real')
      .trim()
      .toLowerCase();

    if (isHardProduction && rawMode !== 'real') {
      throw new Error(
        `[ClockService] CLOCK_MODE=${rawMode} is not allowed when APP_ENV=production. Set CLOCK_MODE=real.`,
      );
    }

    if (rawMode !== 'real' && rawMode !== 'offset' && rawMode !== 'fixed') {
      throw new Error(
        `[ClockService] Unknown CLOCK_MODE="${rawMode}". Must be real, offset, or fixed.`,
      );
    }

    this.mode = rawMode as ClockMode;

    if (this.mode === 'offset') {
      const days = parseFloat(process.env.CLOCK_OFFSET_DAYS ?? '0');
      const hours = parseFloat(process.env.CLOCK_OFFSET_HOURS ?? '0');
      if (isNaN(days) || isNaN(hours)) {
        throw new Error(
          '[ClockService] CLOCK_OFFSET_DAYS and CLOCK_OFFSET_HOURS must be valid numbers.',
        );
      }
      this.offsetDays = days;
      this.offsetHours = hours;
      this.offsetMs = (days * 24 * 60 * 60 + hours * 3600) * 1000;
      this.fixedTime = null;
      this.logger.warn(
        `[ClockService] OFFSET mode active: +${days}d ${hours}h. Restart required to change.`,
      );
    } else if (this.mode === 'fixed') {
      const fixedStr = process.env.CLOCK_FIXED_TIME ?? '';
      if (!fixedStr) {
        throw new Error(
          '[ClockService] CLOCK_FIXED_TIME must be set when CLOCK_MODE=fixed.',
        );
      }
      const parsed = new Date(fixedStr);
      if (isNaN(parsed.getTime())) {
        throw new Error(
          `[ClockService] CLOCK_FIXED_TIME="${fixedStr}" is not a valid ISO date.`,
        );
      }
      this.fixedTime = parsed;
      this.offsetMs = 0;
      this.offsetDays = 0;
      this.offsetHours = 0;
      this.logger.warn(
        `[ClockService] FIXED mode active: ${this.fixedTime.toISOString()}. Restart required to change.`,
      );
    } else {
      this.mode = 'real';
      this.offsetMs = 0;
      this.offsetDays = 0;
      this.offsetHours = 0;
      this.fixedTime = null;
    }
  }

  /** Effective business/test time. Use for draft expiry comparisons. */
  now(): Date {
    if (this.mode === 'fixed' && this.fixedTime) {
      return new Date(this.fixedTime.getTime());
    }
    if (this.mode === 'offset') {
      return new Date(Date.now() + this.offsetMs);
    }
    return new Date();
  }

  /** Always returns real server wall-clock time. */
  realNow(): Date {
    return new Date();
  }

  getMode(): ClockMode {
    return this.mode;
  }

  getEffectiveState(): ClockEffectiveState {
    const state: ClockEffectiveState = {
      mode: this.mode,
      realNow: this.realNow().toISOString(),
      effectiveNow: this.now().toISOString(),
    };
    if (this.mode === 'offset') {
      state.offsetDays = this.offsetDays;
      state.offsetHours = this.offsetHours;
    }
    if (this.mode === 'fixed' && this.fixedTime) {
      state.fixedTime = this.fixedTime.toISOString();
    }
    return state;
  }
}
