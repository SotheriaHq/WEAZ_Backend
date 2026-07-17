import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { UserStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

/**
 * Progressive login lockout policy (OWASP-aligned):
 * - Failed password attempts 1-2: rejected with the generic credentials error.
 * - Attempts 3-6: a temporary lock is applied with escalating wait times
 *   (1m -> 5m -> 15m -> 30m). While locked, the password is not evaluated.
 * - Attempt 7 (max): the account is suspended. The user restores access by
 *   completing a password reset (proof of mailbox ownership) or submitting a
 *   reactivation request.
 * - The attempt counter restarts when failures are older than the rolling
 *   window, and clears on successful password login or password change/reset.
 *
 * Only the password credential is governed here. Google sign-in and email
 * login codes carry their own proofs and rate limits.
 */

export const LOGIN_LOCKOUT_SUSPENSION_REASON =
  'Automatic security suspension: too many failed login attempts';

const AUTO_LOCKOUT_REASON_MARKER = 'Automatic security suspension';

const DEFAULT_MAX_ATTEMPTS = 7;
const DEFAULT_ATTEMPT_WINDOW_HOURS = 24;

/** Lock applied AFTER the Nth consecutive failed attempt, in seconds. */
const LOCK_SCHEDULE_SECONDS: Record<number, number> = {
  3: 60,
  4: 5 * 60,
  5: 15 * 60,
  6: 30 * 60,
};

export interface LoginLockoutUserState {
  id: string;
  status: UserStatus;
  adminSuspendedReason?: string | null;
  failedLoginAttempts: number;
  lastFailedLoginAt: Date | null;
  loginLockedUntil: Date | null;
}

export interface FailedLoginAttemptResult {
  attempts: number;
  attemptsRemaining: number;
  lockSeconds: number | null;
  lockedUntil: Date | null;
  suspended: boolean;
}

@Injectable()
export class LoginLockoutService {
  private readonly logger = new Logger(LoginLockoutService.name);

  constructor(private readonly prisma: PrismaService) {}

  isEnabled(): boolean {
    return (
      String(process.env.LOGIN_LOCKOUT_ENABLED ?? 'true')
        .trim()
        .toLowerCase() !== 'false'
    );
  }

  getMaxAttempts(): number {
    const configured = Number(process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS ?? '');
    if (Number.isInteger(configured) && configured >= 3 && configured <= 20) {
      return configured;
    }
    return DEFAULT_MAX_ATTEMPTS;
  }

  private getAttemptWindowMs(): number {
    const configured = Number(
      process.env.LOGIN_LOCKOUT_ATTEMPT_WINDOW_HOURS ?? '',
    );
    const hours =
      Number.isFinite(configured) && configured > 0
        ? configured
        : DEFAULT_ATTEMPT_WINDOW_HOURS;
    return hours * 60 * 60 * 1000;
  }

  getLockSecondsForAttempts(attempts: number): number | null {
    if (attempts < 3) {
      return null;
    }
    return LOCK_SCHEDULE_SECONDS[attempts] ?? LOCK_SCHEDULE_SECONDS[6];
  }

  isAutoLockoutSuspension(reason: string | null | undefined): boolean {
    return String(reason ?? '').startsWith(AUTO_LOCKOUT_REASON_MARKER);
  }

  describeWait(totalSeconds: number): string {
    if (totalSeconds < 90) {
      return `${Math.max(1, Math.round(totalSeconds))} seconds`;
    }
    const minutes = Math.ceil(totalSeconds / 60);
    return `${minutes} minutes`;
  }

  /**
   * Pre-verification gate. Throws when the account is temporarily locked or
   * was suspended by the lockout policy — the password is never evaluated in
   * those states, which is the point of the lockout.
   */
  assertLoginAllowed(user: LoginLockoutUserState): void {
    if (!this.isEnabled()) {
      return;
    }

    if (
      user.status === UserStatus.SUSPENDED &&
      this.isAutoLockoutSuspension(user.adminSuspendedReason)
    ) {
      throw this.buildSuspendedException();
    }

    const lockedUntil = user.loginLockedUntil;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((lockedUntil.getTime() - Date.now()) / 1000),
      );
      throw new HttpException(
        {
          message: `Too many failed sign-in attempts. Try again in ${this.describeWait(retryAfterSeconds)}.`,
          errors: {
            code: 'LOGIN_TEMPORARILY_LOCKED',
            retryAfterSeconds,
            lockedUntil: lockedUntil.toISOString(),
          },
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Records a failed password attempt and applies the escalation policy.
   * Restarts the counter when the previous failure fell outside the rolling
   * window. Suspends the account (and revokes refresh tokens) at max attempts.
   */
  async registerFailedPasswordAttempt(
    user: LoginLockoutUserState,
  ): Promise<FailedLoginAttemptResult> {
    const now = new Date();
    const maxAttempts = this.getMaxAttempts();
    const windowExpired =
      !!user.lastFailedLoginAt &&
      now.getTime() - user.lastFailedLoginAt.getTime() >
        this.getAttemptWindowMs();

    const updated = await this.prisma.user.update({
      where: { id: user.id },
      data: windowExpired
        ? { failedLoginAttempts: 1, lastFailedLoginAt: now }
        : {
            failedLoginAttempts: { increment: 1 },
            lastFailedLoginAt: now,
          },
      select: { failedLoginAttempts: true },
    });

    const attempts = updated.failedLoginAttempts;
    const attemptsRemaining = Math.max(0, maxAttempts - attempts);

    if (attempts >= maxAttempts) {
      // Only auto-suspend accounts that are currently ACTIVE so an existing
      // admin suspension (and its reason) is never overwritten.
      await this.prisma.$transaction([
        this.prisma.user.updateMany({
          where: { id: user.id, status: UserStatus.ACTIVE },
          data: {
            status: UserStatus.SUSPENDED,
            adminSuspendedAt: now,
            adminSuspendedReason: LOGIN_LOCKOUT_SUSPENSION_REASON,
            loginLockedUntil: null,
          },
        }),
        this.prisma.refreshToken.deleteMany({ where: { userId: user.id } }),
      ]);

      this.logger.warn(
        `Account ${user.id} suspended after ${attempts} failed login attempts`,
      );

      return {
        attempts,
        attemptsRemaining: 0,
        lockSeconds: null,
        lockedUntil: null,
        suspended: true,
      };
    }

    const lockSeconds = this.getLockSecondsForAttempts(attempts);
    let lockedUntil: Date | null = null;
    if (lockSeconds) {
      lockedUntil = new Date(now.getTime() + lockSeconds * 1000);
      await this.prisma.user.update({
        where: { id: user.id },
        data: { loginLockedUntil: lockedUntil },
      });
    }

    return {
      attempts,
      attemptsRemaining,
      lockSeconds,
      lockedUntil,
      suspended: false,
    };
  }

  /** Clears lockout counters after a successful password login. */
  async registerSuccessfulLogin(user: {
    id: string;
    failedLoginAttempts: number;
    loginLockedUntil: Date | null;
  }): Promise<void> {
    if (!user.failedLoginAttempts && !user.loginLockedUntil) {
      return;
    }

    await this.prisma.user
      .update({
        where: { id: user.id },
        data: {
          failedLoginAttempts: 0,
          lastFailedLoginAt: null,
          loginLockedUntil: null,
        },
      })
      .catch((error) => {
        this.logger.error('Failed to reset login lockout counters', error);
      });
  }

  /**
   * Prisma update data that clears lockout state after a verified password
   * reset/change. When the account was suspended by this policy, the reset
   * (proof of mailbox ownership) also reactivates it — this keeps a hostile
   * third party from permanently locking someone out of their own account.
   */
  getPasswordResetClearData(wasAutoLockoutSuspended: boolean): Record<
    string,
    unknown
  > {
    return {
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      loginLockedUntil: null,
      ...(wasAutoLockoutSuspended
        ? {
            status: UserStatus.ACTIVE,
            adminSuspendedAt: null,
            adminSuspendedReason: null,
          }
        : {}),
    };
  }

  buildSuspendedException(): HttpException {
    return new HttpException(
      {
        message:
          'This account has been suspended after too many failed sign-in attempts. Reset your password to restore access, or submit a reactivation request.',
        errors: { code: 'ACCOUNT_SUSPENDED_LOGIN_LOCKOUT' },
      },
      HttpStatus.FORBIDDEN,
    );
  }

  buildJustLockedException(result: FailedLoginAttemptResult): HttpException {
    const retryAfterSeconds = result.lockSeconds ?? 60;
    return new HttpException(
      {
        message: `Incorrect password. Sign-in is paused for ${this.describeWait(retryAfterSeconds)} after ${result.attempts} failed attempts.`,
        errors: {
          code: 'LOGIN_TEMPORARILY_LOCKED',
          retryAfterSeconds,
          lockedUntil: result.lockedUntil?.toISOString() ?? null,
          attemptsRemaining: result.attemptsRemaining,
        },
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }

  buildInvalidCredentialsException(
    result: FailedLoginAttemptResult,
  ): UnauthorizedException {
    return new UnauthorizedException({
      message: 'Invalid email or password',
      errors: {
        code: 'INVALID_CREDENTIALS',
        attemptsRemaining: result.attemptsRemaining,
      },
    });
  }
}
