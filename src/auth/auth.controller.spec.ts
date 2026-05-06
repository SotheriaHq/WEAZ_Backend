import { Test, TestingModule } from '@nestjs/testing';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { ThrottlerGuard, ThrottlerStorage } from '@nestjs/throttler';
import { Reflector } from '@nestjs/core';
import { TokenService } from './helper/general.helper';
import { ConfigService } from '@nestjs/config';
import { NotificationsService } from 'src/notifications/notifications.service';
import { StudioHandoffService } from './studio-handoff.service';

describe('AuthController', () => {
  let controller: AuthController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [AuthController],
      providers: [
        {
          provide: ThrottlerGuard,
          useValue: { canActivate: jest.fn().mockReturnValue(true) },
        },
        { provide: 'THROTTLER:MODULE_OPTIONS', useValue: {} },
        { provide: ThrottlerStorage, useValue: {} },
        { provide: Reflector, useValue: {} },
        {
          provide: AuthService,
          useValue: {
            login: jest.fn(),
            CreateUser: jest.fn(),
            getProfile: jest.fn(),
          },
        },
        { provide: TokenService, useValue: { rotateTokens: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn() } },
        { provide: NotificationsService, useValue: { create: jest.fn() } },
        {
          provide: StudioHandoffService,
          useValue: {
            create: jest.fn(),
            exchange: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<AuthController>(AuthController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('login response preserves themePreference from AuthService', async () => {
    const authService = (controller as any).authService as {
      login: jest.Mock;
    };
    authService.login.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'alex@example.com',
        themePreference: 'system',
      },
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });

    const req = {} as any;
    const res = {} as any;
    const result = await controller.login(
      { email: 'alex@example.com', password: 'Password123!' },
      req,
      res,
    );

    expect(result.user.themePreference).toBe('system');
    expect(result.user).not.toHaveProperty('resolvedTheme');
    expect(authService.login).toHaveBeenCalledWith(
      { email: 'alex@example.com', password: 'Password123!' },
      req,
      res,
    );
  });
});
