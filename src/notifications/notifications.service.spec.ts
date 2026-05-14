import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationType } from '@prisma/client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NotificationRegistry } from './notifications.registry';
import { EmailService } from 'src/email/email.service';
import { ConfigService } from '@nestjs/config';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: any;
  let cacheManager: any;

  beforeEach(async () => {
    mockPrisma = {
      notification: {
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ notificationSettings: null }),
        update: jest.fn(),
      },
      userEmailPreference: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      userEmailScenarioPreference: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      emailSuppression: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      patchConnection: {
        findFirst: jest.fn(),
      },
    };
    mockPrisma.notification.findMany.mockResolvedValue([]);

    const mockEvents = {
      server: {
        to: jest.fn().mockReturnThis(),
        emit: jest.fn(),
      },
    };

    const mockRegistry: Partial<NotificationRegistry> = {
      getConfig: jest.fn((type: NotificationType) => {
        if (type === NotificationType.LOGIN) {
          return {
            schema: {
              validate: () => ({ error: new Error('invalid'), value: {} }),
            } as any,
            formatter: () => 'fmt',
          } as any;
        }
        return undefined;
      }),
    };

    const mockCacheManager = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    };

    const mockEmailService: Partial<EmailService> = {
      getAppName: jest.fn().mockReturnValue('Threadly'),
      send: jest.fn().mockResolvedValue(undefined),
    };

    const mockConfigService: Partial<ConfigService> = {
      get: jest.fn(),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEvents },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: NotificationRegistry, useValue: mockRegistry },
        { provide: EmailService, useValue: mockEmailService },
        { provide: ConfigService, useValue: mockConfigService },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    cacheManager = module.get(CACHE_MANAGER);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('list', () => {
    it('should return paginated notifications', async () => {
      const mockNotifications = [
        {
          id: '1',
          type: NotificationType.THREAD,
          payload: {},
          isRead: false,
          createdAt: new Date(),
        },
      ];
      mockPrisma.notification.findMany.mockResolvedValue(mockNotifications);

      const result = await service.list('user-id', { limit: 10 });

      expect(result.items).toHaveLength(1);
      expect(result.hasNextPage).toBe(false);
    });
  });

  describe('unreadCount', () => {
    it('should return cached count if available', async () => {
      cacheManager.get.mockResolvedValue(5);

      const result = await service.unreadCount('user-id');

      expect(result.count).toBe(5);
      expect(mockPrisma.notification.count).not.toHaveBeenCalled();
    });

    it('should query DB and cache if not cached', async () => {
      cacheManager.get.mockResolvedValue(undefined);
      mockPrisma.notification.count.mockResolvedValue(3);

      const result = await service.unreadCount('user-id');

      expect(result.count).toBe(3);
      expect(cacheManager.set).toHaveBeenCalledWith(
        'unread_count:user-id',
        3,
        300000,
      );
    });
  });

  describe('markRead', () => {
    it('should mark notification as read and invalidate cache', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'notif-id',
        isRead: false,
      });
      mockPrisma.notification.update.mockResolvedValue({
        id: 'notif-id',
        isRead: true,
      });

      const result = await service.markRead('user-id', 'notif-id');

      expect(result.success).toBe(true);
      expect(result.alreadyRead).toBe(false);
      expect(mockPrisma.notification.update).toHaveBeenCalledWith({
        where: { id: 'notif-id' },
        data: { isRead: true },
      });
      expect(cacheManager.del).toHaveBeenCalledWith('unread_count:user-id');
    });

    it('should throw NotFoundException if notification not found', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue(null);
      mockPrisma.notification.findUnique.mockResolvedValue(null);

      await expect(service.markRead('user-id', 'notif-id')).rejects.toThrow(
        'Notification not found',
      );
    });
  });

  describe('create', () => {
    it('should skip self-notifications', async () => {
      const result = await service.create('user-id', NotificationType.THREAD, {
        actorId: 'user-id',
      });

      expect(result).toBeNull();
    });

    it('should validate and sanitize payload', async () => {
      const mockCreated = {
        id: '1',
        type: NotificationType.THREAD,
        payload: { target: { id: 'target-id' } },
        isRead: false,
        createdAt: new Date(),
        actor: null,
      };
      mockPrisma.notification.create.mockResolvedValue(mockCreated);

      await service.create('recipient-id', NotificationType.THREAD, {
        payload: { target: { id: 'target-id' } },
      });

      expect(mockPrisma.notification.create).toHaveBeenCalled();
      expect(cacheManager.del).toHaveBeenCalledWith(
        'unread_count:recipient-id',
      );
    });

    it('should dedupe notifications within window', async () => {
      mockPrisma.notification.findFirst.mockResolvedValue({
        id: 'existing',
        type: NotificationType.THREAD,
        payload: { target: { id: 'target-id' } },
      });

      const result = await service.create(
        'recipient-id',
        NotificationType.THREAD,
        {
          dedupeMs: 60000,
          target: { type: 'POST' as any, id: 'target-id' },
        },
      );

      expect(result.id).toBe('existing');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should dedupe semantically without explicit dedupeMs', async () => {
      mockPrisma.notification.findMany.mockResolvedValue([
        {
          id: 'semantic-existing',
          type: NotificationType.THREAD,
          payload: {
            target: { type: 'POST', id: 'post-1' },
            message: 'New thread reply',
          },
          createdAt: new Date(),
        },
      ]);

      const result = await service.create(
        'recipient-id',
        NotificationType.THREAD,
        {
          payload: {
            target: { type: 'POST', id: 'post-1' },
            message: 'New thread reply',
          },
        },
      );

      expect(result?.id).toBe('semantic-existing');
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should throw error for invalid payload', async () => {
      // Joi validation should throw before DB call
      await expect(
        service.create('recipient-id', NotificationType.LOGIN, {
          payload: { invalidField: 'value' },
        }),
      ).rejects.toThrow('Invalid payload for notification type LOGIN');
    });

    it('should skip TAG_MENTION from unpatched actor when disabled in settings', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: {
          tags: { mentions: true, fromUnpatchedUsers: false },
        },
      });
      mockPrisma.patchConnection.findFirst.mockResolvedValue(null);

      const result = await service.create(
        'recipient-id',
        'TAG_MENTION' as NotificationType,
        { actorId: 'actor-id', payload: { tag: 'fresh' } },
      );

      expect(result).toBeNull();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should skip COMMENT reply notifications when replies toggle is off', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: {
          comments: { enabled: true, replies: false, fromUnpatchedUsers: true },
        },
      });

      const result = await service.create(
        'recipient-id',
        NotificationType.COMMENT,
        {
          actorId: 'actor-id',
          payload: { parentId: 'parent-comment-id' },
        },
      );

      expect(result).toBeNull();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should skip ORDER_STATUS_UPDATED notifications when order updates are disabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: {
          orders: { statusChanges: false },
        },
      });

      const result = await service.create(
        'recipient-id',
        NotificationType.ORDER_STATUS_UPDATED,
        {
          actorId: 'brand-owner-id',
          payload: { orderId: 'order-123', status: 'PROCESSING' },
        },
      );

      expect(result).toBeNull();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it('should skip ORDER_PLACED notifications when order placement confirmations are disabled', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: {
          orders: { placed: false },
        },
      });

      const result = await service.create(
        'recipient-id',
        NotificationType.ORDER_PLACED,
        {
          payload: { orderId: 'order-123' },
        },
      );

      expect(result).toBeNull();
      expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    });

    it.each([
      NotificationType.WISHLIST_PRODUCT_UNAVAILABLE,
      NotificationType.WISHLIST_PRODUCT_AVAILABLE,
    ])(
      'should skip %s notifications when product lifecycle notifications are disabled',
      async (type) => {
        mockPrisma.user.findUnique.mockResolvedValue({
          notificationSettings: {
            collections: { lifecycle: false },
          },
        });

        const result = await service.create('recipient-id', type, {
          actorId: 'brand-owner-id',
          payload: {
            productId: 'product-123',
            productName: 'Linen Wrap Dress',
            brandName: 'Threadly Studio',
          },
        });

        expect(result).toBeNull();
        expect(mockPrisma.notification.create).not.toHaveBeenCalled();
      },
    );

    it('should migrate legacy orders.updates settings into the split order preferences', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: {
          orders: { updates: false },
        },
      });

      const result = await service.getSettings('user-id');

      expect(result.orders.placed).toBe(false);
      expect(result.orders.statusChanges).toBe(false);
    });
  });

  describe('updateSettings', () => {
    it('should ignore unknown settings keys and only persist allowed booleans', async () => {
      mockPrisma.user.findUnique.mockResolvedValue({
        notificationSettings: null,
      });
      mockPrisma.user.update.mockResolvedValue({ id: 'user-id' });

      await service.updateSettings('user-id', {
        orders: { placed: false },
        social: { follows: false } as any,
        bogus: { nope: true },
      } as any);

      expect(mockPrisma.user.update).toHaveBeenCalledWith({
        where: { id: 'user-id' },
        data: {
          notificationSettings: expect.objectContaining({
            orders: expect.objectContaining({ placed: false }),
            social: expect.objectContaining({ follows: false }),
          }),
        },
      });

      const persisted =
        mockPrisma.user.update.mock.calls[0][0].data.notificationSettings;
      expect(persisted.bogus).toBeUndefined();
    });
  });
});
