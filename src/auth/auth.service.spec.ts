import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
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

  const mockPrisma = {
    user: {
      findFirst: jest.fn(),
      update: jest.fn(),
    },
  } as unknown as PrismaService;

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
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
        {
          provide: UserHelperService,
          useValue: {
            generateUniqueUsername: jest.fn(),
            generateUsernameFromBrand: jest.fn(),
            generateIndustriNumber: jest.fn(),
          },
        },
        {
          provide: EmailVerificationHelperService,
          useValue: {
            generateVerificationCode: jest.fn(),
            generateVerificationLink: jest.fn(),
          },
        },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: EmailService,
          useValue: { send: jest.fn(), getAppName: jest.fn(() => 'Threadly') },
        },
        {
          provide: TrustedDeviceService,
          useValue: { listDevices: jest.fn(), revokeDevice: jest.fn() },
        },
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
});
