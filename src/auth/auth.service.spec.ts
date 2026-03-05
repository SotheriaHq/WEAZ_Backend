import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { Role } from '@prisma/client';

import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';

describe('AuthService', () => {
  let service: AuthService;

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
          useValue: { hashPassword: jest.fn(), verifyPassword: jest.fn() },
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
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('validateUser should query only non-inactive users', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    await service.validateUser('test@example.com', 'password');

    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          email: 'test@example.com',
          isActive: { not: 'Inactive' },
        },
      }),
    );
  });

  it('updateUser should reject password updates through generic endpoint', async () => {
    await expect(
      service.updateUser('user-id', { password: 'plain-text' } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('updateUser should reject role updates through generic endpoint', async () => {
    await expect(
      service.updateUser('user-id', { role: Role.SuperAdmin } as any),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

