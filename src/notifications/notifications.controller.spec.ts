import { PushPlatform, PushProvider } from '@prisma/client';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { PushDeviceTokensService } from './push-device-tokens.service';

describe('NotificationsController push token endpoints', () => {
  const notificationsService = {} as NotificationsService;
  const pushTokensService = {
    register: jest.fn(),
    listMine: jest.fn(),
    deactivateCurrent: jest.fn(),
    deactivateById: jest.fn(),
  };

  let controller: NotificationsController;

  beforeEach(() => {
    jest.clearAllMocks();
    controller = new NotificationsController(
      notificationsService,
      pushTokensService as unknown as PushDeviceTokensService,
    );
  });

  it('registers a push token for the authenticated user', async () => {
    pushTokensService.register.mockResolvedValue({ id: 'token-1' });
    const dto = {
      token: 'ExponentPushToken[abc]',
      provider: PushProvider.EXPO,
      platform: PushPlatform.ANDROID,
    };

    await expect(
      controller.registerPushToken({ user: { id: 'user-1' } }, dto),
    ).resolves.toEqual({ id: 'token-1' });
    expect(pushTokensService.register).toHaveBeenCalledWith('user-1', dto);
  });

  it('lists push token devices for the authenticated user', async () => {
    pushTokensService.listMine.mockResolvedValue({ items: [] });

    await expect(
      controller.listPushTokens({ user: { id: 'user-1' } }),
    ).resolves.toEqual({ items: [] });
    expect(pushTokensService.listMine).toHaveBeenCalledWith('user-1');
  });

  it('deactivates the current device token for the authenticated user', async () => {
    pushTokensService.deactivateCurrent.mockResolvedValue({ success: true });
    const dto = { token: 'ExponentPushToken[abc]' };

    await expect(
      controller.deactivateCurrentPushToken({ user: { id: 'user-1' } }, dto),
    ).resolves.toEqual({ success: true });
    expect(pushTokensService.deactivateCurrent).toHaveBeenCalledWith(
      'user-1',
      dto,
    );
  });

  it('deactivates a token id only in the authenticated user scope', async () => {
    pushTokensService.deactivateById.mockResolvedValue({ success: true });

    await expect(
      controller.deactivatePushTokenById(
        { user: { id: 'user-1' } },
        '11111111-1111-4111-8111-111111111111',
      ),
    ).resolves.toEqual({ success: true });
    expect(pushTokensService.deactivateById).toHaveBeenCalledWith(
      'user-1',
      '11111111-1111-4111-8111-111111111111',
    );
  });
});
