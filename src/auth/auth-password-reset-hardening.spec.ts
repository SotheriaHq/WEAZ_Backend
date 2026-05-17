import { UnauthorizedException } from '@nestjs/common';
import { EmailPriority, Role, UserStatus } from '@prisma/client';

import { AuthService } from './auth.service';

describe('AuthService password reset hardening', () => {
  const ORIGINAL_ENV = process.env;
  const genericPasswordResetResponse = {
    message:
      'If an account with that email exists, a password reset link has been sent.',
  };

  let service: AuthService;
  let mockPrisma: any;
  let mockPasswordService: any;
  let mockTokenService: any;
  let mockEmailService: any;
  let mockNotifications: any;
  let loggerLogSpy: jest.SpyInstance;

  const activeResetUser = {
    id: 'user-1',
    status: UserStatus.ACTIVE,
    password: 'old-password-hash',
    email: 'user@example.com',
    username: 'owner',
    userProfile: {
      firstName: 'Ada',
      lastName: 'Okafor',
    },
    brand: null,
  };

  const createService = () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      passwordResetToken: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      refreshToken: {
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn((callback: (tx: any) => unknown) =>
        callback(mockPrisma),
      ),
    };

    mockPasswordService = {
      hashPassword: jest.fn(),
      verifyPassword: jest.fn(),
    };
    mockTokenService = {
      generateTokens: jest.fn(),
      revokeOtherRefreshTokens: jest.fn(),
    };
    mockEmailService = {
      send: jest.fn().mockResolvedValue({ dispatchStatus: 'SENT' }),
      getAppName: jest.fn(() => 'Threadly'),
    };
    mockNotifications = {
      create: jest.fn(),
      canSendScenarioEmail: jest.fn().mockResolvedValue(true),
    };

    service = new AuthService(
      mockPrisma,
      mockPasswordService,
      mockTokenService,
      {} as any,
      {} as any,
      mockNotifications,
      mockEmailService,
      {} as any,
      {} as any,
    );
    loggerLogSpy = jest
      .spyOn((service as any).logger, 'log')
      .mockImplementation(() => undefined);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...ORIGINAL_ENV,
      APP_ENV: undefined,
      DEPLOY_ENV: undefined,
      NODE_ENV: 'test',
      WEB_APP_URL: 'https://web.threadly.test/',
      FRONTEND_URL: undefined,
    };
    createService();
  });

  afterEach(() => {
    loggerLogSpy.mockRestore();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('returns a generic reset response and masks unknown or inactive emails in logs', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.requestPasswordReset('  Missing.User@example.com  '),
    ).resolves.toEqual(genericPasswordResetResponse);

    expect(mockPrisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: 'missing.user@example.com' },
      }),
    );
    expect(loggerLogSpy).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Password reset requested for unknown, inactive, or passwordless account email_fingerprint=[a-f0-9]{12}$/,
      ),
    );
    expect(loggerLogSpy.mock.calls[0][0]).not.toContain(
      'missing.user@example.com',
    );
  });

  it('creates a reset token and sends a web reset link using WEB_APP_URL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.ACTIVE,
      password: 'old-password-hash',
    });
    mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.passwordResetToken.create.mockResolvedValue({});

    await expect(
      service.requestPasswordReset('USER@example.com'),
    ).resolves.toEqual(genericPasswordResetResponse);

    expect(mockPrisma.passwordResetToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
          expiresAt: expect.any(Date),
        }),
      }),
    );
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'user@example.com',
      expect.any(String),
      expect.stringContaining(
        'https://web.threadly.test/reset-password?token=',
      ),
      expect.stringContaining(
        'https://web.threadly.test/reset-password?token=',
      ),
      expect.objectContaining({
        recipientUserId: 'user-1',
        scenarioKey: 'auth.password_reset',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: expect.stringMatching(
          /^auth:password-reset:user-1:[a-f0-9]{64}$/,
        ),
      }),
    );
  });

  it('rejects an expired or unknown reset token', async () => {
    mockPrisma.passwordResetToken.findFirst.mockResolvedValue(null);

    await expect(
      service.confirmPasswordReset('expired-token', 'BetterVault93!'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.refreshToken.deleteMany).not.toHaveBeenCalled();
  });

  it('prevents reset token reuse when the single-use claim fails', async () => {
    mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
      id: 'reset-token-1',
      userId: 'user-1',
      user: activeResetUser,
    });
    mockPasswordService.verifyPassword.mockResolvedValue(false);
    mockPasswordService.hashPassword.mockResolvedValue('new-password-hash');
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.confirmPasswordReset('used-token', 'BetterVault93!'),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.refreshToken.deleteMany).not.toHaveBeenCalled();
    expect(mockEmailService.send).not.toHaveBeenCalled();
  });

  it('confirms a regular password reset, revokes sessions, increments authVersion, and sends a security alert', async () => {
    mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
      id: 'reset-token-1',
      userId: 'user-1',
      user: activeResetUser,
    });
    mockPasswordService.verifyPassword.mockResolvedValue(false);
    mockPasswordService.hashPassword.mockResolvedValue('new-password-hash');
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 2 });
    mockPrisma.user.update.mockResolvedValue({});

    await expect(
      service.confirmPasswordReset('valid-token', 'BetterVault93!'),
    ).resolves.toEqual({ message: 'Password reset successful' });

    expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'reset-token-1',
          usedAt: null,
          expiresAt: expect.any(Object),
        }),
        data: { usedAt: expect.any(Date) },
      }),
    );
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        password: 'new-password-hash',
        passwordCredentialStatus: 'ENABLED',
        authVersion: { increment: 1 },
      },
    });
    expect(mockNotifications.canSendScenarioEmail).toHaveBeenCalledWith(
      'user-1',
      'auth.password.changed',
    );
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('security alert'),
      expect.stringContaining('Password Changed'),
      expect.stringContaining('password was changed'),
      expect.objectContaining({
        recipientUserId: 'user-1',
        scenarioKey: 'auth.password.changed',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey: 'auth:password-reset-confirmed:user-1:reset-token-1',
      }),
    );
  });

  it('confirms an admin password reset and sends the same password-changed security alert', async () => {
    mockPrisma.passwordResetToken.findFirst.mockResolvedValue({
      id: 'admin-reset-token-1',
      userId: 'admin-1',
      user: {
        ...activeResetUser,
        id: 'admin-1',
        role: Role.Admin,
        email: 'admin@example.com',
      },
    });
    mockPasswordService.verifyPassword.mockResolvedValue(false);
    mockPasswordService.hashPassword.mockResolvedValue('admin-password-hash');
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});

    await expect(
      service.resetAdminPassword('admin-token', 'BetterVault93!'),
    ).resolves.toEqual({ message: 'Password reset successful' });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'admin-1' },
      data: {
        password: 'admin-password-hash',
        passwordCredentialStatus: 'ENABLED',
        mustResetPassword: false,
        authVersion: { increment: 1 },
      },
    });
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'admin@example.com',
      expect.stringContaining('security alert'),
      expect.any(String),
      expect.stringContaining('password was changed'),
      expect.objectContaining({
        recipientUserId: 'admin-1',
        scenarioKey: 'auth.password.changed',
        priority: EmailPriority.P0_SECURITY,
        idempotencyKey:
          'auth:admin-password-reset-confirmed:admin-1:admin-reset-token-1',
      }),
    );
  });

  it('increments authVersion for authenticated password changes while preserving the current refresh session', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(activeResetUser);
    mockPasswordService.verifyPassword
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockPasswordService.hashPassword.mockResolvedValue('changed-password-hash');
    mockPrisma.user.update.mockResolvedValue({});

    await expect(
      service.changePasswordForAuthenticatedUser(
        'user-1',
        'CurrentPassword123!',
        'BetterVault93!',
        'refresh-session.current-secret',
      ),
    ).resolves.toEqual({ message: 'Password updated successfully' });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        password: 'changed-password-hash',
        passwordCredentialStatus: 'ENABLED',
        mustResetPassword: false,
        authVersion: { increment: 1 },
      },
    });
    expect(mockTokenService.revokeOtherRefreshTokens).toHaveBeenCalledWith(
      'user-1',
      'refresh-session.current-secret',
    );
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'user@example.com',
      expect.stringContaining('security alert'),
      expect.any(String),
      expect.stringContaining('password was changed'),
      expect.objectContaining({
        recipientUserId: 'user-1',
        scenarioKey: 'auth.password.changed',
        priority: EmailPriority.P0_SECURITY,
      }),
    );
  });
});
