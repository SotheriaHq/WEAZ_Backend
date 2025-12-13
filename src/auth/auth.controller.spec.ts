import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from './helper/password.service';
import { TokenService } from './helper/general.helper';
import { UserHelperService } from './helper/user-helper.service';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { ConfigService } from '@nestjs/config';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        AuthService,
        { provide: ThrottlerGuard, useValue: { canActivate: () => true } },
        { provide: 'THROTTLER:MODULE_OPTIONS', useValue: {} },
        { provide: ThrottlerStorage, useValue: {} },
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: {} },
        { provide: PasswordService, useValue: { hashPassword: jest.fn(), verifyPassword: jest.fn() } },
        { provide: TokenService, useValue: { generateTokens: jest.fn() } },
        { provide: UserHelperService, useValue: { generateUniqueUsername: jest.fn(), generateUsernameFromBrand: jest.fn(), generateIndustriNumber: jest.fn() } },
        { provide: EmailVerificationHelperService, useValue: { generateVerificationCode: jest.fn(), generateVerificationLink: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
