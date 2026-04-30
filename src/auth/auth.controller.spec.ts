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
});
