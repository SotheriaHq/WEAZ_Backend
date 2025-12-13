import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationType } from '@prisma/client';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { NotificationRegistry } from './notifications.registry';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let mockPrisma: any;
  let cacheManager: any;
  let registry: NotificationRegistry;

  beforeEach(async () => {
    mockPrisma = {
      notification: {
        findMany: jest.fn(),
        count: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        findFirst: jest.fn(),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({ notificationSettings: null }),
      },
    };

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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: mockPrisma },
        { provide: EventsGateway, useValue: mockEvents },
        { provide: CACHE_MANAGER, useValue: mockCacheManager },
        { provide: NotificationRegistry, useValue: mockRegistry },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
    cacheManager = module.get(CACHE_MANAGER);
    registry = module.get(NotificationRegistry);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('list', () => {
    it('should return paginated notifications', async () => {
      const mockNotifications = [
        {
          id: '1',
          type: NotificationType.LIKE,
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
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 1 });

      const result = await service.markRead('user-id', 'notif-id');

      expect(result.success).toBe(true);
      expect(cacheManager.del).toHaveBeenCalledWith('unread_count:user-id');
    });

    it('should throw NotFoundException if notification not found', async () => {
      mockPrisma.notification.updateMany.mockResolvedValue({ count: 0 });
      mockPrisma.notification.findUnique.mockResolvedValue(null);

      await expect(service.markRead('user-id', 'notif-id')).rejects.toThrow(
        'Notification not found',
      );
    });
  });

  describe('create', () => {
    it('should skip self-notifications', async () => {
      const result = await service.create('user-id', NotificationType.LIKE, {
        actorId: 'user-id',
      });

      expect(result).toBeNull();
    });

    it('should validate and sanitize payload', async () => {
      const mockCreated = {
        id: '1',
        type: NotificationType.LIKE,
        payload: { target: { id: 'target-id' } },
        isRead: false,
        createdAt: new Date(),
        actor: null,
      };
      mockPrisma.notification.create.mockResolvedValue(mockCreated);

      await service.create('recipient-id', NotificationType.LIKE, {
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
        type: NotificationType.LIKE,
        payload: { target: { id: 'target-id' } },
      });

      const result = await service.create(
        'recipient-id',
        NotificationType.LIKE,
        {
          dedupeMs: 60000,
          target: { type: 'POST' as any, id: 'target-id' },
        },
      );

      expect(result.id).toBe('existing');
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
  });
});
