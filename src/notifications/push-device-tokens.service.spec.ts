import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PushPlatform, PushProvider } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PushDeviceTokensService } from './push-device-tokens.service';
import { RegisterPushTokenDto } from './push-token.dto';

const now = new Date('2026-05-14T10:00:00.000Z');

const makeTokenRecord = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  token: 'ExponentPushToken[abcdef1234567890]',
  provider: PushProvider.EXPO,
  platform: PushPlatform.ANDROID,
  deviceId: 'device-1',
  deviceName: 'Pixel 8',
  appVersion: '1.0.0',
  expoProjectId: 'project-1',
  isActive: true,
  lastSeenAt: now,
  lastSuccessAt: null,
  lastFailureAt: null,
  failureCount: 0,
  disabledReason: null,
  createdAt: now,
  updatedAt: now,
  ...overrides,
});

describe('PushDeviceTokensService', () => {
  let service: PushDeviceTokensService;
  let prisma: {
    pushDeviceToken: {
      upsert: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
    };
  };

  beforeEach(() => {
    jest.useRealTimers();
    prisma = {
      pushDeviceToken: {
        upsert: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = new PushDeviceTokensService(prisma as unknown as PrismaService);
  });

  it('register creates a new token through unique-token upsert', async () => {
    prisma.pushDeviceToken.upsert.mockResolvedValue(makeTokenRecord());

    const result = await service.register('user-1', {
      token: ' ExponentPushToken[abcdef1234567890] ',
      provider: PushProvider.EXPO,
      platform: PushPlatform.ANDROID,
      deviceId: 'device-1',
      deviceName: 'Pixel 8',
      appVersion: '1.0.0',
      expoProjectId: 'project-1',
    });

    expect(prisma.pushDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'ExponentPushToken[abcdef1234567890]' },
        create: expect.objectContaining({
          userId: 'user-1',
          token: 'ExponentPushToken[abcdef1234567890]',
          provider: PushProvider.EXPO,
          platform: PushPlatform.ANDROID,
          isActive: true,
          disabledReason: null,
        }),
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({
        id: '11111111-1111-4111-8111-111111111111',
        maskedToken: 'Exponent...67890]',
        provider: PushProvider.EXPO,
        platform: PushPlatform.ANDROID,
      }),
    );
    expect(result).not.toHaveProperty('token');
  });

  it('register same token for same user updates existing row instead of duplicating', async () => {
    prisma.pushDeviceToken.upsert.mockResolvedValue(makeTokenRecord());

    await service.register('user-1', {
      token: 'ExponentPushToken[abcdef1234567890]',
      deviceName: 'New Pixel',
    });

    expect(prisma.pushDeviceToken.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.pushDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'ExponentPushToken[abcdef1234567890]' },
        update: expect.objectContaining({
          userId: 'user-1',
          provider: PushProvider.EXPO,
          platform: PushPlatform.UNKNOWN,
          deviceName: 'New Pixel',
          isActive: true,
          disabledReason: null,
        }),
      }),
    );
  });

  it('register same token for different user transfers ownership safely', async () => {
    prisma.pushDeviceToken.upsert.mockResolvedValue(
      makeTokenRecord({ userId: 'user-2' }),
    );

    await service.register('user-2', {
      token: 'ExponentPushToken[abcdef1234567890]',
      platform: PushPlatform.IOS,
    });

    expect(prisma.pushDeviceToken.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { token: 'ExponentPushToken[abcdef1234567890]' },
        update: expect.objectContaining({
          userId: 'user-2',
          platform: PushPlatform.IOS,
          isActive: true,
          disabledReason: null,
        }),
      }),
    );
  });

  it('deactivate current token marks only the authenticated user token inactive', async () => {
    prisma.pushDeviceToken.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      service.deactivateCurrent('user-1', {
        token: ' ExponentPushToken[abcdef1234567890] ',
      }),
    ).resolves.toEqual({ success: true });

    expect(prisma.pushDeviceToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        token: 'ExponentPushToken[abcdef1234567890]',
      },
      data: {
        isActive: false,
        disabledReason: 'USER_LOGOUT',
      },
    });
  });

  it('deactivate current token is idempotent and does not leak other ownership', async () => {
    prisma.pushDeviceToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.deactivateCurrent('user-1', 'ExponentPushToken[missing]'),
    ).resolves.toEqual({ success: true });
  });

  it('listMine masks raw tokens', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([
      makeTokenRecord({
        token: 'ExponentPushToken[abcdef1234567890]',
      }),
    ]);

    const result = await service.listMine('user-1');

    expect(prisma.pushDeviceToken.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: [{ isActive: 'desc' }, { lastSeenAt: 'desc' }],
      select: expect.objectContaining({
        token: true,
        deviceName: true,
        appVersion: true,
      }),
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      maskedToken: 'Exponent...67890]',
      deviceName: 'Pixel 8',
      appVersion: '1.0.0',
    });
    expect(result.items[0]).not.toHaveProperty('token');
  });

  it('deactivateById cannot deactivate another user token', async () => {
    prisma.pushDeviceToken.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.deactivateById('user-1', '22222222-2222-4222-8222-222222222222'),
    ).resolves.toEqual({ success: true });

    expect(prisma.pushDeviceToken.updateMany).toHaveBeenCalledWith({
      where: {
        id: '22222222-2222-4222-8222-222222222222',
        userId: 'user-1',
      },
      data: {
        isActive: false,
        disabledReason: 'USER_DISABLED',
      },
    });
  });

  it('RegisterPushTokenDto validation rejects invalid payloads and applies defaults', async () => {
    const invalidDto = plainToInstance(RegisterPushTokenDto, {
      token: '   ',
      provider: 'BAD_PROVIDER',
      platform: 'BAD_PLATFORM',
    });

    await expect(validate(invalidDto)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ property: 'token' }),
        expect.objectContaining({ property: 'provider' }),
        expect.objectContaining({ property: 'platform' }),
      ]),
    );

    const defaultedDto = plainToInstance(RegisterPushTokenDto, {
      token: ' ExponentPushToken[abcdef1234567890] ',
      deviceName: ' Pixel 8 ',
    });

    expect(defaultedDto.provider).toBe(PushProvider.EXPO);
    expect(defaultedDto.platform).toBe(PushPlatform.UNKNOWN);
    expect(defaultedDto.token).toBe('ExponentPushToken[abcdef1234567890]');
    expect(defaultedDto.deviceName).toBe('Pixel 8');
  });
});
