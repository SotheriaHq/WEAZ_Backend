import { NotificationType, PushProvider } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationRegistry } from './notifications.registry';
import { PushNotificationsService } from './push-notifications.service';
import { DEFAULT_NOTIFICATION_SETTINGS } from './notifications.types';

const now = new Date('2026-05-14T12:00:00.000Z');

const makeToken = (overrides: Record<string, unknown> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  userId: 'user-1',
  token: 'ExponentPushToken[abcdef1234567890]',
  provider: PushProvider.EXPO,
  isActive: true,
  ...overrides,
});

const notification = {
  id: '22222222-2222-4222-8222-222222222222',
  type: NotificationType.THREAD,
  payload: {
    target: { type: 'POST', id: 'post-1', preview: 'Summer drop' },
    targetUrl: '/posts/post-1',
    message: 'A brand threaded your post',
  },
  actor: null,
};

class TestPushNotificationsService extends PushNotificationsService {
  constructor(
    prisma: PrismaService,
    registry: NotificationRegistry,
    private readonly client: {
      chunkPushNotifications: jest.Mock;
      sendPushNotificationsAsync: jest.Mock;
    },
    private readonly tokenValidator: (token: unknown) => boolean = () => true,
  ) {
    super(prisma, registry);
  }

  protected async getExpoClient() {
    return this.client;
  }

  protected async isExpoPushToken(token: unknown) {
    return this.tokenValidator(token);
  }
}

describe('PushNotificationsService', () => {
  let prisma: {
    pushDeviceToken: {
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let client: {
    chunkPushNotifications: jest.Mock;
    sendPushNotificationsAsync: jest.Mock;
  };
  let service: PushNotificationsService;

  beforeEach(() => {
    prisma = {
      pushDeviceToken: {
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
      },
    };
    client = {
      chunkPushNotifications: jest.fn((messages) => [messages]),
      sendPushNotificationsAsync: jest
        .fn()
        .mockResolvedValue([{ status: 'ok', id: 'ticket-1' }]),
    };
    service = new TestPushNotificationsService(
      prisma as unknown as PrismaService,
      NotificationRegistry.createDefault(),
      client,
    );
  });

  it('does not send when the user has no active Expo tokens', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([]);

    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result).toEqual({
      sent: 0,
      failed: 0,
      deactivated: 0,
      skippedReason: 'no-active-tokens',
    });
    expect(client.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('does not query tokens when push is globally disabled', async () => {
    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        push: { ...DEFAULT_NOTIFICATION_SETTINGS.push, enabled: false },
      },
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result.skippedReason).toBe('push-disabled');
    expect(prisma.pushDeviceToken.findMany).not.toHaveBeenCalled();
  });

  it('quiet hours block non-critical push notifications', async () => {
    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        push: {
          ...DEFAULT_NOTIFICATION_SETTINGS.push,
          quietHoursEnabled: true,
          quietHoursStart: '22:00',
          quietHoursEnd: '06:00',
        },
      },
      notificationTypeEnabled: true,
      date: new Date(Date.UTC(2026, 4, 14, 23, 0)),
    });

    expect(result.skippedReason).toBe('quiet-hours');
    expect(client.sendPushNotificationsAsync).not.toHaveBeenCalled();
  });

  it('uses generic body when preview is disabled', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([makeToken()]);

    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: {
        ...DEFAULT_NOTIFICATION_SETTINGS,
        push: {
          ...DEFAULT_NOTIFICATION_SETTINGS.push,
          showPreview: false,
        },
      },
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result.sent).toBe(1);
    expect(client.sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({
        to: 'ExponentPushToken[abcdef1234567890]',
        title: 'Threadly',
        body: 'You have a new notification.',
        sound: 'default',
        data: expect.objectContaining({
          notificationId: notification.id,
          type: NotificationType.THREAD,
          targetUrl: '/posts/post-1',
          target: { type: 'POST', id: 'post-1', preview: 'Summer drop' },
        }),
      }),
    ]);
  });

  it('preserves message routing fields in Expo push data without exposing message body', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([makeToken()]);

    const messageNotification = {
      id: '33333333-3333-4333-8333-333333333333',
      type: NotificationType.MESSAGE_RECEIVED,
      payload: {
        type: 'message',
        category: 'message',
        threadId: 'thread-123',
        conversationId: 'thread-123',
        messageId: 'message-123',
        orderId: null,
        customOrderId: 'custom-order-123',
        brandId: 'brand-123',
        customerId: 'customer-123',
        actorUserId: 'actor-123',
        targetUrl: '/messages?thread=thread-123&messageId=message-123',
        message: 'A brand sent a new message',
        bodyText: 'Private body should not be copied to push data',
      },
      actor: null,
    };

    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification: messageNotification,
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result.sent).toBe(1);
    expect(client.sendPushNotificationsAsync).toHaveBeenCalledWith([
      expect.objectContaining({
        data: expect.objectContaining({
          notificationId: messageNotification.id,
          notificationType: NotificationType.MESSAGE_RECEIVED,
          type: 'message',
          category: 'message',
          threadId: 'thread-123',
          conversationId: 'thread-123',
          messageId: 'message-123',
          orderId: null,
          customOrderId: 'custom-order-123',
          brandId: 'brand-123',
          customerId: 'customer-123',
          actorUserId: 'actor-123',
          targetUrl: '/messages?thread=thread-123&messageId=message-123',
        }),
      }),
    ]);
    expect(client.sendPushNotificationsAsync.mock.calls[0][0][0].data).not.toHaveProperty('message');
    expect(client.sendPushNotificationsAsync.mock.calls[0][0][0].data).not.toHaveProperty('bodyText');
  });

  it('deactivates invalid Expo tokens before sending', async () => {
    service = new TestPushNotificationsService(
      prisma as unknown as PrismaService,
      NotificationRegistry.createDefault(),
      client,
      () => false,
    );
    prisma.pushDeviceToken.findMany.mockResolvedValue([
      makeToken({ token: 'bad-token' }),
    ]);

    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result.deactivated).toBe(1);
    expect(client.sendPushNotificationsAsync).not.toHaveBeenCalled();
    expect(prisma.pushDeviceToken.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: {
        isActive: false,
        lastFailureAt: now,
        failureCount: { increment: 1 },
        disabledReason: 'INVALID_EXPO_TOKEN',
      },
    });
  });

  it('deactivates tokens when Expo returns DeviceNotRegistered', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([makeToken()]);
    client.sendPushNotificationsAsync.mockResolvedValue([
      {
        status: 'error',
        message: 'Device not registered',
        details: { error: 'DeviceNotRegistered' },
      },
    ]);

    const result = await service.deliverAfterNotificationCreated({
      recipientId: 'user-1',
      notification,
      settings: DEFAULT_NOTIFICATION_SETTINGS,
      notificationTypeEnabled: true,
      date: now,
    });

    expect(result.failed).toBe(1);
    expect(result.deactivated).toBe(1);
    expect(prisma.pushDeviceToken.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: {
        isActive: false,
        lastFailureAt: now,
        failureCount: { increment: 1 },
        disabledReason: 'DEVICE_NOT_REGISTERED',
      },
    });
  });

  it('records transient send failure without throwing', async () => {
    prisma.pushDeviceToken.findMany.mockResolvedValue([makeToken()]);
    client.sendPushNotificationsAsync.mockRejectedValue(
      new Error('Expo unavailable'),
    );

    await expect(
      service.deliverAfterNotificationCreated({
        recipientId: 'user-1',
        notification,
        settings: DEFAULT_NOTIFICATION_SETTINGS,
        notificationTypeEnabled: true,
        date: now,
      }),
    ).resolves.toMatchObject({ sent: 0, failed: 1, deactivated: 0 });

    expect(prisma.pushDeviceToken.update).toHaveBeenCalledWith({
      where: { id: '11111111-1111-4111-8111-111111111111' },
      data: {
        lastFailureAt: now,
        failureCount: { increment: 1 },
      },
    });
  });
});
