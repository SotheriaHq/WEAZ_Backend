import { UserStatus } from '@prisma/client';
import {
  LOGIN_LOCKOUT_SUSPENSION_REASON,
  LoginLockoutService,
} from './login-lockout.service';

describe('LoginLockoutService', () => {
  const ORIGINAL_ENV = process.env;
  let mockPrisma: any;
  let service: LoginLockoutService;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.LOGIN_LOCKOUT_ENABLED;
    delete process.env.LOGIN_LOCKOUT_MAX_ATTEMPTS;
    delete process.env.LOGIN_LOCKOUT_ATTEMPT_WINDOW_HOURS;

    mockPrisma = {
      user: {
        update: jest.fn(),
        updateMany: jest.fn(),
      },
      refreshToken: {
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((ops: unknown[]) => Promise.all(ops as any[])),
    };
    service = new LoginLockoutService(mockPrisma);
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  const baseUser = () => ({
    id: 'user-1',
    status: UserStatus.ACTIVE,
    adminSuspendedReason: null,
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    loginLockedUntil: null,
  });

  it('uses the progressive lock schedule 1m/5m/15m/30m from the third attempt', () => {
    expect(service.getLockSecondsForAttempts(1)).toBeNull();
    expect(service.getLockSecondsForAttempts(2)).toBeNull();
    expect(service.getLockSecondsForAttempts(3)).toBe(60);
    expect(service.getLockSecondsForAttempts(4)).toBe(300);
    expect(service.getLockSecondsForAttempts(5)).toBe(900);
    expect(service.getLockSecondsForAttempts(6)).toBe(1800);
  });

  it('defaults to suspension at 7 attempts', () => {
    expect(service.getMaxAttempts()).toBe(7);
  });

  it('does not throw for an unlocked active user', () => {
    expect(() => service.assertLoginAllowed(baseUser())).not.toThrow();
  });

  it('throws 429 with retry metadata while a temporary lock is active', () => {
    const user = {
      ...baseUser(),
      loginLockedUntil: new Date(Date.now() + 120_000),
    };

    try {
      service.assertLoginAllowed(user);
      fail('expected lock exception');
    } catch (error: any) {
      expect(error.getStatus()).toBe(429);
      expect(error.getResponse().errors.code).toBe('LOGIN_TEMPORARILY_LOCKED');
      expect(error.getResponse().errors.retryAfterSeconds).toBeGreaterThan(100);
    }
  });

  it('throws 403 for accounts suspended by the lockout policy', () => {
    const user = {
      ...baseUser(),
      status: UserStatus.SUSPENDED,
      adminSuspendedReason: LOGIN_LOCKOUT_SUSPENSION_REASON,
    };

    try {
      service.assertLoginAllowed(user);
      fail('expected suspension exception');
    } catch (error: any) {
      expect(error.getStatus()).toBe(403);
      expect(error.getResponse().errors.code).toBe(
        'ACCOUNT_SUSPENDED_LOGIN_LOCKOUT',
      );
    }
  });

  it('ignores admin suspensions (different reason) in the pre-verification gate', () => {
    const user = {
      ...baseUser(),
      status: UserStatus.SUSPENDED,
      adminSuspendedReason: 'Policy violation',
    };
    expect(() => service.assertLoginAllowed(user)).not.toThrow();
  });

  it('restarts the counter when the last failure is outside the rolling window', async () => {
    mockPrisma.user.update.mockResolvedValue({ failedLoginAttempts: 1 });

    const result = await service.registerFailedPasswordAttempt({
      ...baseUser(),
      failedLoginAttempts: 5,
      lastFailedLoginAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ failedLoginAttempts: 1 }),
      }),
    );
    expect(result.attempts).toBe(1);
    expect(result.lockSeconds).toBeNull();
    expect(result.suspended).toBe(false);
  });

  it('suspends and revokes refresh tokens at max attempts', async () => {
    mockPrisma.user.update.mockResolvedValue({ failedLoginAttempts: 7 });

    const result = await service.registerFailedPasswordAttempt({
      ...baseUser(),
      failedLoginAttempts: 6,
      lastFailedLoginAt: new Date(),
    });

    expect(result.suspended).toBe(true);
    expect(mockPrisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1', status: UserStatus.ACTIVE },
        data: expect.objectContaining({
          status: UserStatus.SUSPENDED,
          adminSuspendedReason: LOGIN_LOCKOUT_SUSPENSION_REASON,
        }),
      }),
    );
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
  });

  it('password reset clear data reactivates only lockout suspensions', () => {
    expect(service.getPasswordResetClearData(false)).toEqual({
      failedLoginAttempts: 0,
      lastFailedLoginAt: null,
      loginLockedUntil: null,
    });
    expect(service.getPasswordResetClearData(true)).toEqual(
      expect.objectContaining({
        status: UserStatus.ACTIVE,
        adminSuspendedAt: null,
        adminSuspendedReason: null,
      }),
    );
  });

  it('can be disabled via env', () => {
    process.env.LOGIN_LOCKOUT_ENABLED = 'false';
    expect(service.isEnabled()).toBe(false);
    expect(() =>
      service.assertLoginAllowed({
        ...baseUser(),
        loginLockedUntil: new Date(Date.now() + 120_000),
      }),
    ).not.toThrow();
  });
});
