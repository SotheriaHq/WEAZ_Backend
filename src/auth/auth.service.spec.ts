import { Test, TestingModule } from '@nestjs/testing';
import { UnauthorizedException } from '@nestjs/common';
import { UserStatus } from '@prisma/client';

import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailService } from 'src/email/email.service';
import { TrustedDeviceService } from './helper/trusted-device.service';

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
});
