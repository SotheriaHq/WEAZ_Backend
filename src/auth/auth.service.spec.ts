import { Test, TestingModule } from '@nestjs/testing';
import { AuthService } from './auth.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';

describe('AuthService', () => {
  let service: AuthService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AuthService,
        { provide: PrismaService, useValue: {} },
        { provide: PasswordService, useValue: { hashPassword: jest.fn(), verifyPassword: jest.fn() } },
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
        { provide: UserHelperService, useValue: { generateUniqueUsername: jest.fn(), generateUsernameFromBrand: jest.fn(), generateIndustriNumber: jest.fn() } },
        { provide: EmailVerificationHelperService, useValue: { generateVerificationCode: jest.fn(), generateVerificationLink: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    service = module.get<AuthService>(AuthService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
