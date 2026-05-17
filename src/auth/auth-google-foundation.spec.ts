import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import {
  AuthProvider,
  EmailPriority,
  PasswordCredentialStatus,
  Role,
  UserStatus,
  UserType,
} from '@prisma/client';

import { AuthService } from './auth.service';

describe('AuthService Google auth foundation', () => {
  let service: AuthService;
  let mockPrisma: any;
  let mockPasswordService: any;
  let mockTokenService: any;
  let mockEmailService: any;
  let mockNotifications: any;
  let mockGoogleTokenVerifier: any;
  let mockTrustedDeviceService: any;

  const baseAuthUser = {
    id: 'user-1',
    username: 'ada',
    role: Role.User,
    type: UserType.REGULAR,
    email: 'ada@example.com',
    status: UserStatus.ACTIVE,
    passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
    brand: null,
    brandMemberships: [],
    adminPermissionGrants: [],
    isEmailVerified: true,
    isActive: 'Active',
    themePreference: 'system',
    mustResetPassword: false,
    authVersion: 0,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    userProfile: {
      firstName: 'Ada',
      lastName: 'Okafor',
      profileImage: null,
      profileImageFile: null,
      bannerImage: null,
      bannerImageFile: null,
      phoneNumber: null,
      address: null,
    },
  };

  const googleIdentity = {
    providerSubject: 'google-sub-123',
    email: 'ada@example.com',
    emailVerified: true,
    name: 'Ada Okafor',
    givenName: 'Ada',
    familyName: 'Okafor',
    picture: null,
    audience: 'web-client-id',
  };

  const createService = () => {
    mockPrisma = {
      user: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      authIdentity: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      emailLoginCode: {
        findFirst: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      passwordSetupToken: {
        findFirst: jest.fn(),
        updateMany: jest.fn(),
        create: jest.fn(),
      },
      refreshToken: {
        deleteMany: jest.fn(),
      },
      brandMember: {
        create: jest.fn(),
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
      generateTokens: jest.fn().mockResolvedValue({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
      }),
      revokeOtherRefreshTokens: jest.fn(),
    };
    mockEmailService = {
      send: jest.fn().mockResolvedValue({ dispatchStatus: 'SENT' }),
      getAppName: jest.fn(() => 'Threadly'),
    };
    mockNotifications = {
      create: jest.fn().mockResolvedValue({}),
      canSendScenarioEmail: jest.fn().mockResolvedValue(true),
    };
    mockGoogleTokenVerifier = {
      verifyIdToken: jest.fn().mockResolvedValue(googleIdentity),
    };
    mockTrustedDeviceService = {
      listDevices: jest.fn(),
      revokeDevice: jest.fn(),
      recordLoginDevice: jest.fn().mockResolvedValue({ isNewDevice: false }),
    };

    service = new AuthService(
      mockPrisma,
      mockPasswordService,
      mockTokenService,
      {
        generateUniqueUsername: jest.fn().mockResolvedValue('ada-okafor'),
        generateUsernameFromBrand: jest.fn().mockResolvedValue('ada-brand'),
        generateIndustriNumber: jest.fn().mockResolvedValue('IND-001'),
      } as any,
      {} as any,
      mockNotifications,
      mockEmailService,
      mockTrustedDeviceService,
      mockGoogleTokenVerifier,
    );
  };

  beforeEach(() => {
    jest.clearAllMocks();
    createService();
  });

  it('creates a Google-only user with AuthIdentity and no local password', async () => {
    mockPrisma.authIdentity.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      ...baseAuthUser,
      passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
    });

    await expect(
      service.googleAuth({ idToken: 'id-token' }, {} as any, {} as any),
    ).resolves.toEqual(
      expect.objectContaining({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        message: 'Welcome Back',
      }),
    );

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'ada@example.com',
          password: null,
          passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
          isEmailVerified: true,
          authIdentities: {
            create: expect.objectContaining({
              provider: AuthProvider.GOOGLE,
              providerSubject: 'google-sub-123',
              emailVerified: true,
            }),
          },
        }),
      }),
    );
    expect(mockTokenService.generateTokens).toHaveBeenCalled();
  });

  it('links Google to an existing active password user by verified matching email', async () => {
    mockPrisma.authIdentity.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue(baseAuthUser);

    await service.googleAuth({ idToken: 'id-token' }, {} as any, {} as any);

    expect(mockPrisma.authIdentity.create).toHaveBeenCalledWith({
      data: {
        userId: 'user-1',
        provider: AuthProvider.GOOGLE,
        providerSubject: 'google-sub-123',
        email: 'ada@example.com',
        emailVerified: true,
      },
    });
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
  });

  it('does not duplicate or bypass suspended matching accounts', async () => {
    mockPrisma.authIdentity.findUnique.mockResolvedValue(null);
    mockPrisma.user.findUnique.mockResolvedValue({
      ...baseAuthUser,
      status: UserStatus.SUSPENDED,
    });

    await expect(
      service.googleAuth({ idToken: 'id-token' }, {} as any, {} as any),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    expect(mockPrisma.authIdentity.create).not.toHaveBeenCalled();
    expect(mockPrisma.user.create).not.toHaveBeenCalled();
    expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
  });

  it('rejects invalid Google ID tokens before account lookup', async () => {
    mockGoogleTokenVerifier.verifyIdToken.mockRejectedValue(
      new BadRequestException('Invalid Google ID token'),
    );

    await expect(
      service.googleAuth({ idToken: 'bad-token' }, {} as any, {} as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.authIdentity.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('returns login-options for Google-only password setup without user ids', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.ACTIVE,
      password: null,
      passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
      authIdentities: [{ provider: AuthProvider.GOOGLE }],
    });

    await expect(service.getLoginOptions('ADA@example.com')).resolves.toEqual({
      requestId: expect.any(String),
      methods: {
        password: false,
        google: true,
        passwordSetupAvailable: true,
      },
      message: 'Continue with an available sign-in method.',
    });
  });

  it('stores email login codes hashed and returns a generic response', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      email: 'ada@example.com',
      status: UserStatus.ACTIVE,
      password: null,
      passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
      authIdentities: [{ provider: AuthProvider.GOOGLE }],
    });
    mockPasswordService.hashPassword.mockResolvedValue('hashed-code');

    await expect(
      service.requestEmailLoginCode('ada@example.com'),
    ).resolves.toEqual({
      message:
        'If this account can set up a password, a verification code has been sent.',
    });

    expect(mockPrisma.emailLoginCode.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          codeHash: 'hashed-code',
        }),
      }),
    );
    expect(mockPrisma.emailLoginCode.create.mock.calls[0][0].data.codeHash).not
      .toEqual(expect.stringMatching(/^\d{8}$/));
    expect(mockEmailService.send).toHaveBeenCalledWith(
      'ada@example.com',
      expect.any(String),
      expect.any(String),
      expect.any(String),
      expect.objectContaining({
        recipientUserId: 'user-1',
        scenarioKey: 'auth.email_login_code.password_setup',
        priority: EmailPriority.P0_SECURITY,
      }),
    );
  });

  it('confirms an email code, marks it used, and returns a setup token without logging in', async () => {
    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      status: UserStatus.ACTIVE,
      password: null,
      passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
      authIdentities: [{ provider: AuthProvider.GOOGLE }],
    });
    mockPrisma.emailLoginCode.findFirst.mockResolvedValue({
      id: 'code-1',
      codeHash: 'hashed-code',
      attempts: 0,
    });
    mockPasswordService.verifyPassword.mockResolvedValue(true);
    mockPrisma.emailLoginCode.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.confirmEmailLoginCode(
      'ada@example.com',
      '12345678',
    );

    expect(result.passwordSetupToken).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
    expect(mockPrisma.passwordSetupToken.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'user-1',
          tokenHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }),
    );
    expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
  });

  it('sets the first local password without issuing a login session', async () => {
    mockPrisma.passwordSetupToken.findFirst.mockResolvedValue({
      id: 'setup-1',
      userId: 'user-1',
      user: {
        ...baseAuthUser,
        password: null,
        passwordCredentialStatus: PasswordCredentialStatus.NOT_SET,
        authIdentities: [{ provider: AuthProvider.GOOGLE }],
      },
    });
    mockPasswordService.hashPassword.mockResolvedValue('new-password-hash');
    mockPrisma.passwordSetupToken.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.refreshToken.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.user.update.mockResolvedValue({});

    await expect(
      service.setupPassword('raw-setup-token', 'BetterPassword123!'),
    ).resolves.toEqual({
      message: 'Password set successfully. Sign in with your new password.',
    });

    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        password: 'new-password-hash',
        passwordCredentialStatus: PasswordCredentialStatus.ENABLED,
        mustResetPassword: false,
        authVersion: { increment: 1 },
      },
    });
    expect(mockPrisma.refreshToken.deleteMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
    });
    expect(mockTokenService.generateTokens).not.toHaveBeenCalled();
  });
});
