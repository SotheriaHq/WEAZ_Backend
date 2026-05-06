import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { Role, UserStatus, UserType } from '@prisma/client';

import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailService } from 'src/email/email.service';
import { TrustedDeviceService } from './helper/trusted-device.service';
import { toAuthUserResponse } from './helper/prisma-select.helper';

describe('AuthService', () => {
  let service: AuthService;

  const mockPasswordService = {
    hashPassword: jest.fn(),
    verifyPassword: jest.fn(),
  };

  const mockTokenService = {
    generateTokens: jest.fn(),
    revokeOtherRefreshTokens: jest.fn(),
  };

  const mockUserHelperService = {
    generateUniqueUsername: jest.fn(),
    generateUsernameFromBrand: jest.fn(),
    generateIndustriNumber: jest.fn(),
  };

  const mockEmailVerificationHelper = {
    generateVerificationCode: jest.fn(),
    generateVerificationLink: jest.fn(),
  };

  const mockNotifications = {
    create: jest.fn(),
  };

  const mockEmailService = {
    send: jest.fn(),
    getAppName: jest.fn(() => 'Threadly'),
  };

  const mockTrustedDeviceService = {
    listDevices: jest.fn(),
    revokeDevice: jest.fn(),
  };

  const mockPrisma: any = {
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    userProfile: {
      upsert: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(mockPrisma)),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: mockPrisma },
        {
          provide: PasswordService,
          useValue: mockPasswordService,
        },
        { provide: TokenService, useValue: mockTokenService },
        { provide: UserHelperService, useValue: mockUserHelperService },
        {
          provide: EmailVerificationHelperService,
          useValue: mockEmailVerificationHelper,
        },
        { provide: NotificationsService, useValue: mockNotifications },
        { provide: EmailService, useValue: mockEmailService },
        { provide: TrustedDeviceService, useValue: mockTrustedDeviceService },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('validateUser should normalize email before query', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(false);

    await service.validateUser('  TEST@example.com  ', 'password');

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: {
            equals: 'test@example.com',
            mode: 'insensitive',
          },
        },
      }),
    );
  });

  it('validateUser should return null when password is invalid', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      status: UserStatus.ACTIVE,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(false);

    await expect(service.validateUser('user@example.com', 'wrong-password')).resolves.toBeNull();
  });

  it('validateUser should throw when account is not active', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      status: UserStatus.SUSPENDED,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(true);

    await expect(service.validateUser('user@example.com', 'correct-password')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('validateUser should return user data when credentials are valid', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({
      id: 'user-1',
      email: 'user@example.com',
      password: 'hashed-password',
      firstName: 'Alex',
      lastName: 'Doe',
      status: UserStatus.ACTIVE,
    });
    (mockPasswordService.verifyPassword as jest.Mock).mockResolvedValue(true);

    const result = await service.validateUser('user@example.com', 'correct-password');

    expect(result).not.toBeNull();
    expect(result).toEqual(
      expect.objectContaining({
        id: 'user-1',
        email: 'user@example.com',
      }),
    );
    expect(result).not.toHaveProperty('password');
  });

  it('auth responses include themePreference without resolvedTheme', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
      brandDescription: null,
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: [],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'dark',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.themePreference).toBe('dark');
    expect(result).not.toHaveProperty('resolvedTheme');
  });

  it('auth responses normalize legacy themePreference values to system', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
      brandDescription: null,
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: [],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'auto',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
    } as any);

    expect(result.themePreference).toBe('system');
    expect(result).not.toHaveProperty('resolvedTheme');
  });

  it('auth responses prefer UserProfile fields and fall back to User fields', () => {
    const result = toAuthUserResponse({
      id: 'user-1',
      username: 'alex',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Legacy',
      lastName: 'Name',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: 'legacy-phone',
      address: 'legacy-address',
      brandFullName: null,
      brandDescription: null,
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: [],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: 'legacy-avatar.jpg',
      profileImageId: null,
      bannerImage: 'legacy-banner.jpg',
      bannerImageId: null,
      isEmailVerified: true,
      isActive: 'active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Profile',
        lastName: 'Owner',
        phoneNumber: null,
        address: 'profile-address',
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: 'profile-banner.jpg',
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    } as any);

    expect(result.firstName).toBe('Profile');
    expect(result.lastName).toBe('Owner');
    expect(result.phoneNumber).toBe('legacy-phone');
    expect(result.address).toBe('profile-address');
    expect(result.profileImage).toBe('legacy-avatar.jpg');
    expect(result.bannerImage).toBe('profile-banner.jpg');
  });

  it('signup creates a UserProfile for regular users', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockUserHelperService.generateUniqueUsername.mockResolvedValue('alex-doe');
    mockPasswordService.hashPassword.mockResolvedValue('hashed-password');
    mockEmailVerificationHelper.generateVerificationCode.mockReturnValue('123456');
    mockEmailVerificationHelper.generateVerificationLink.mockReturnValue('https://threadly.test/verify');
    mockEmailService.send.mockResolvedValue({ dispatchStatus: 'SENT' });
    mockNotifications.create.mockResolvedValue({});
    mockTokenService.generateTokens.mockResolvedValue({ accessToken: 'access-token' });
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-1',
      username: 'alex-doe',
      role: Role.User,
      type: UserType.REGULAR,
      firstName: 'Alex',
      lastName: 'Doe',
      email: 'alex@example.com',
      status: UserStatus.ACTIVE,
      brand: null,
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: null,
      brandDescription: null,
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: [],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: false,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Alex',
        lastName: 'Doe',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: null,
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    });

    await service.CreateUser(
      {
        firstName: 'Alex',
        lastName: 'Doe',
        email: 'alex@example.com',
        password: 'StrongerPassword123!',
        type: UserType.REGULAR,
      },
      { headers: {}, socket: {} } as any,
      {} as any,
    );

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userProfile: {
            create: expect.objectContaining({
              firstName: 'Alex',
              lastName: 'Doe',
            }),
          },
        }),
      }),
    );
  });

  it('signup creates a UserProfile for brand users', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockUserHelperService.generateUsernameFromBrand.mockResolvedValue('ada-style');
    mockUserHelperService.generateIndustriNumber.mockResolvedValue('IND-123');
    mockPasswordService.hashPassword.mockResolvedValue('hashed-password');
    mockEmailVerificationHelper.generateVerificationCode.mockReturnValue('123456');
    mockEmailVerificationHelper.generateVerificationLink.mockReturnValue('https://threadly.test/verify');
    mockEmailService.send.mockResolvedValue({ dispatchStatus: 'SENT' });
    mockNotifications.create.mockResolvedValue({});
    mockTokenService.generateTokens.mockResolvedValue({ accessToken: 'access-token' });
    mockPrisma.user.create.mockResolvedValue({
      id: 'user-1',
      username: 'ada-style',
      role: Role.User,
      type: UserType.BRAND,
      firstName: 'Ada',
      lastName: 'Okafor',
      email: 'ada@example.com',
      status: UserStatus.ACTIVE,
      brand: { id: 'brand-1', name: 'Ada Style', isStoreOpen: false, verificationStatus: 'NOT_SUBMITTED' },
      adminPermissionGrants: [],
      phoneNumber: null,
      address: null,
      brandFullName: 'Ada Style',
      brandDescription: null,
      brandCountry: null,
      brandState: null,
      brandCity: null,
      brandTags: [],
      brandBusinessType: null,
      socialInstagram: null,
      socialFacebook: null,
      socialTwitter: null,
      socialWebsite: null,
      cacNumber: null,
      tin: null,
      ceoNin: null,
      ceoFirstName: null,
      ceoLastName: null,
      companyLocation: null,
      profileImage: null,
      profileImageId: null,
      bannerImage: null,
      bannerImageId: null,
      isEmailVerified: false,
      isActive: 'Active',
      themePreference: 'system',
      mustResetPassword: false,
      authVersion: 0,
      createdAt: new Date('2026-05-05T00:00:00.000Z'),
      updatedAt: new Date('2026-05-05T00:00:00.000Z'),
      userProfile: {
        firstName: 'Ada',
        lastName: 'Okafor',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        profileImageFile: null,
        bannerImage: null,
        bannerImageId: null,
        bannerImageFile: null,
        profileVisibility: 'UNLOCKED',
      },
    });

    await service.CreateUser(
      {
        firstName: 'Ada',
        lastName: 'Okafor',
        email: 'ada@example.com',
        password: 'StrongerPassword123!',
        type: UserType.BRAND,
        brandFullName: 'Ada Style',
      },
      { headers: {}, socket: {} } as any,
      {} as any,
    );

    expect(mockPrisma.user.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brand: expect.any(Object),
          userProfile: {
            create: expect.objectContaining({
              firstName: 'Ada',
              lastName: 'Okafor',
            }),
          },
        }),
      }),
    );
  });

  it('profile update writes only whitelisted profile fields', async () => {
    mockPrisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'user-1',
        firstName: 'Old',
        lastName: 'Name',
        phoneNumber: null,
        address: null,
        profileImage: null,
        profileImageId: null,
        bannerImage: null,
        bannerImageId: null,
        profileVisibility: 'UNLOCKED',
      })
      .mockResolvedValueOnce({
        id: 'user-1',
        username: 'alex',
        role: Role.User,
        type: UserType.REGULAR,
        firstName: 'Alex',
        lastName: 'Doe',
        email: 'alex@example.com',
        status: UserStatus.ACTIVE,
        brand: null,
        adminPermissionGrants: [],
        phoneNumber: null,
        address: 'Lagos',
        brandFullName: null,
        brandDescription: null,
        brandCountry: null,
        brandState: null,
        brandCity: null,
        brandTags: [],
        brandBusinessType: null,
        socialInstagram: null,
        socialFacebook: null,
        socialTwitter: null,
        socialWebsite: null,
        cacNumber: null,
        tin: null,
        ceoNin: null,
        ceoFirstName: null,
        ceoLastName: null,
        companyLocation: null,
        profileImage: null,
        profileImageId: null,
        bannerImage: null,
        bannerImageId: null,
        isEmailVerified: true,
        isActive: 'Active',
        themePreference: 'system',
        mustResetPassword: false,
        authVersion: 0,
        createdAt: new Date('2026-05-05T00:00:00.000Z'),
        updatedAt: new Date('2026-05-05T00:00:00.000Z'),
        userProfile: {
          firstName: 'Alex',
          lastName: 'Doe',
          phoneNumber: null,
          address: 'Lagos',
          profileImage: null,
          profileImageId: null,
          profileImageFile: null,
          bannerImage: null,
          bannerImageId: null,
          bannerImageFile: null,
          profileVisibility: 'UNLOCKED',
        },
      });
    mockPrisma.user.update.mockResolvedValue({});
    mockPrisma.userProfile.upsert.mockResolvedValue({});

    await service.updateProfile('user-1', {
      firstName: ' Alex ',
      lastName: ' Doe ',
      address: ' Lagos ',
      username: 'ignored',
    });

    expect(mockPrisma.userProfile.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: {
          firstName: 'Alex',
          lastName: 'Doe',
          address: 'Lagos',
        },
      }),
    );
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: {
        firstName: 'Alex',
        lastName: 'Doe',
        address: 'Lagos',
      },
    });
  });

  it('profile update rejects sensitive fields', async () => {
    await expect(
      service.updateProfile('user-1', {
        firstName: 'Alex',
        email: 'takeover@example.com',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(mockPrisma.userProfile.upsert).not.toHaveBeenCalled();
  });
});
