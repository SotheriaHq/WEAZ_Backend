import {
  Injectable,
  ForbiddenException,
  NotFoundException,
  Inject,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { EventsGateway } from 'src/realtime/events.gateway';
import { NotificationType, PatchStatus } from '@prisma/client';
import {
  CreateNotificationOptions,
  NotificationSettings,
  DEFAULT_NOTIFICATION_SETTINGS,
  NotificationTarget,
} from './notifications.types';
import { v4 as uuidv4 } from 'uuid';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { NotificationRegistry } from './notifications.registry';

@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventsGateway,
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private readonly registry: NotificationRegistry,
  ) {}

  private validateAndSanitizePayload(
    type: NotificationType,
    payload: any,
  ): any {
    const config = this.registry.getConfig(type);
    if (!config) return payload; // No validation for unknown types

    const { error, value } = config.schema.validate(payload, {
      stripUnknown: true,
    });
    if (error) {
      console.warn(
        `Invalid payload for notification type ${type}:`,
        error.details,
      );
      throw new Error(`Invalid payload for notification type ${type}`);
    }
    return value;
  }

  private sanitizeTargetUrl(url: unknown): string | undefined {
    if (!url || typeof url !== 'string') return undefined;
    // Disallow protocols and hosts
    try {
      const hasScheme = /^(https?:)?\/\//i.test(url);
      if (hasScheme) return undefined;
    } catch {}
    // Normalize to ensure leading slash
    const cleaned = url.startsWith('/') ? url : `/${url}`;
    // Allow only known internal prefixes
    const allowed = [
      '/',
      '/collections/',
      '/profile/',
      '/brands/',
      '/posts/',
      '/products/',
      '/orders',
      '/patches',
      '/settings',
      '/settings/collections',
      '/studio/',
    ];
    if (allowed.some((p) => cleaned === p || cleaned.startsWith(p))) {
      return cleaned;
    }
    return undefined;
  }

  private formatMessage(n: any) {
    try {
      const config = this.registry.getConfig(n.type);
      if (config) {
        return config.formatter(n);
      }
      return 'You have a new notification';
    } catch (error) {
      console.error('Error formatting notification message:', error);
      return 'You have a new notification';
    }
  }

  async list(
    recipientId: string,
    q: { cursor?: string; limit?: number; type?: string },
  ) {
    const take = Math.min(Math.max(q.limit ?? 20, 1), 50);
    const cursorDate = q.cursor ? new Date(q.cursor) : undefined;
    const where: any = {
      recipientId,
      ...(q.type ? { type: q.type as NotificationType } : {}),
    };
    if (cursorDate) {
      where.createdAt = { lt: cursorDate };
    }
    const items = await this.prisma.notification.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      include: {
        actor: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
    });
    const hasNextPage = items.length > take;
    const sliced = hasNextPage ? items.slice(0, -1) : items;

    // Transform to include structured target data for Multi-Target Pattern
    const data = sliced.map((n) => {
      const payload = n.payload as Record<string, any> | null;

      // Extract structured target from payload
      const target = this.extractTarget(n.type, payload);
      const subTargetId = payload?.subTargetId || payload?.commentId || null;
      const targetUrl = this.sanitizeTargetUrl(payload?.targetUrl);

      return {
        id: n.id,
        type: n.type,
        version: 2 as const, // All responses now use v2 structured format
        createdAt: n.createdAt,
        isRead: n.isRead,
        actor: n.actor,
        message: this.formatMessage(n),
        target,
        subTargetId,
        targetUrl,
        payload, // Include raw payload for backward compatibility
      };
    });

    return {
      items: data,
      hasNextPage,
      endCursor: data.length
        ? data[data.length - 1].createdAt.toISOString()
        : null,
    };
  }

  /**
   * Extract structured target from notification payload
   */
  private extractTarget(
    type: NotificationType,
    payload: Record<string, any> | null,
  ): NotificationTarget | null {
    if (!payload) return null;

    // Direct target object
    if (payload.target?.type && payload.target?.id) {
      return {
        type: payload.target.type,
        id: payload.target.id,
        preview: payload.target.preview,
      };
    }

    // Infer from payload fields
    if (payload.collectionId) {
      return {
        type: 'COLLECTION',
        id: payload.collectionId,
        preview: payload.collectionName || payload.collectionTitle,
      };
    }

    if (payload.postId) {
      return { type: 'POST', id: payload.postId };
    }

    if (payload.productId) {
      return {
        type: 'PRODUCT',
        id: payload.productId,
        preview: payload.productName,
      };
    }

    // Infer from targetUrl
    const url = payload.targetUrl as string | undefined;
    if (url) {
      const collectionMatch = url.match(/\/collections\/([a-f0-9-]+)/);
      if (collectionMatch) {
        return { type: 'COLLECTION', id: collectionMatch[1] };
      }
      const productMatch = url.match(/\/products\/([a-f0-9-]+)/);
      if (productMatch) {
        return { type: 'PRODUCT', id: productMatch[1] };
      }
      const brandsMatch = url.match(/\/brands\/([a-f0-9-]+)/);
      if (brandsMatch) {
        return { type: 'USER', id: brandsMatch[1] };
      }
      const profileMatch = url.match(/\/profile\/([a-f0-9-]+)/);
      if (profileMatch) {
        return { type: 'USER', id: profileMatch[1] };
      }
    }

    return null;
  }

  async unreadCount(recipientId: string) {
    const cacheKey = `unread_count:${recipientId}`;
    let count = await this.cacheManager.get<number>(cacheKey);

    if (count === undefined) {
      count = await this.prisma.notification.count({
        where: { recipientId, isRead: false },
      });
      await this.cacheManager.set(cacheKey, count, 300000); // Cache for 5 minutes
    }

    return { count };
  }

  async markRead(recipientId: string, id: string) {
    // Check if notification exists and current read state (idempotency)
    const notification = await this.prisma.notification.findFirst({
      where: { id, recipientId },
      select: { id: true, isRead: true },
    });

    if (!notification) {
      // Check if it exists at all but belongs to someone else
      const exists = await this.prisma.notification.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Notification not found');
      throw new ForbiddenException('Cannot modify this notification');
    }

    // Idempotent: if already read, return success without updating
    if (notification.isRead) {
      return { success: true, alreadyRead: true };
    }

    // Mark as read
    await this.prisma.notification.update({
      where: { id },
      data: { isRead: true },
    });

    // Invalidate cache
    await this.cacheManager.del(`unread_count:${recipientId}`);
    return { success: true, alreadyRead: false };
  }

  async markAllRead(recipientId: string) {
    const res = await this.prisma.notification.updateMany({
      where: { recipientId, isRead: false },
      data: { isRead: true },
    });
    // Invalidate cache
    await this.cacheManager.del(`unread_count:${recipientId}`);
    return { success: true, count: res.count };
  }

  async remove(recipientId: string, id: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, recipientId },
      select: { id: true, isRead: true },
    });

    if (!notification) {
      const exists = await this.prisma.notification.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) throw new NotFoundException('Notification not found');
      throw new ForbiddenException('Cannot modify this notification');
    }

    await this.prisma.notification.delete({ where: { id } });
    await this.cacheManager.del(`unread_count:${recipientId}`);

    try {
      this.events.server?.to(`USER:${recipientId}`).emit('notification.deleted', {
        id,
        unreadDelta: notification.isRead ? 0 : -1,
        ts: Date.now(),
      });
    } catch {
      // Ignore realtime emit errors for deletion path.
    }

    return { success: true, id };
  }

  async getSettings(userId: string): Promise<NotificationSettings> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { notificationSettings: true },
    });

    if (!user?.notificationSettings) {
      return DEFAULT_NOTIFICATION_SETTINGS;
    }

    const raw = (user.notificationSettings as any) ?? {};
    const legacyEngagement = raw.engagement ?? {};

    // Merge with defaults, including legacy key migration (engagement -> social/tags)
    return {
      ...DEFAULT_NOTIFICATION_SETTINGS,
      ...raw,
      security: {
        ...DEFAULT_NOTIFICATION_SETTINGS.security,
        ...(raw.security ?? {}),
      },
      social: {
        ...DEFAULT_NOTIFICATION_SETTINGS.social,
        ...(raw.social ?? {}),
        threads:
          raw.social?.threads ??
          legacyEngagement.threads ??
          DEFAULT_NOTIFICATION_SETTINGS.social.threads,
        patches:
          raw.social?.patches ??
          legacyEngagement.patches ??
          DEFAULT_NOTIFICATION_SETTINGS.social.patches,
      },
      comments: {
        ...DEFAULT_NOTIFICATION_SETTINGS.comments,
        ...(raw.comments ?? {}),
        enabled:
          raw.comments?.enabled ??
          raw.social?.comments ??
          legacyEngagement.comments ??
          DEFAULT_NOTIFICATION_SETTINGS.comments.enabled,
      },
      tags: {
        ...DEFAULT_NOTIFICATION_SETTINGS.tags,
        ...(raw.tags ?? {}),
        mentions:
          raw.tags?.mentions ??
          legacyEngagement.tags ??
          DEFAULT_NOTIFICATION_SETTINGS.tags.mentions,
      },
      collections: {
        ...DEFAULT_NOTIFICATION_SETTINGS.collections,
        ...(raw.collections ?? {}),
      },
      brand: {
        ...DEFAULT_NOTIFICATION_SETTINGS.brand,
        ...(raw.brand ?? {}),
      },
      orders: {
        ...DEFAULT_NOTIFICATION_SETTINGS.orders,
        ...(raw.orders ?? {}),
      },
      fit: {
        ...DEFAULT_NOTIFICATION_SETTINGS.fit,
        ...(raw.fit ?? {}),
      },
    };
  }

  async updateSettings(
    userId: string,
    settings: Partial<NotificationSettings>,
  ) {
    const current = await this.getSettings(userId);
    const updated = {
      ...current,
      ...settings,
      security: { ...current.security, ...settings.security },
      social: { ...current.social, ...settings.social },
      comments: { ...current.comments, ...settings.comments },
      tags: { ...current.tags, ...settings.tags },
      collections: { ...current.collections, ...settings.collections },
      brand: { ...current.brand, ...settings.brand },
      orders: { ...current.orders, ...settings.orders },
      fit: { ...current.fit, ...settings.fit },
    };

    await this.prisma.user.update({
      where: { id: userId },
      data: { notificationSettings: updated as any },
    });

    return updated;
  }

  private isNotificationEnabled(
    type: NotificationType,
    settings: NotificationSettings,
  ): boolean {
    switch (type) {
      case NotificationType.LOGIN:
      case NotificationType.LOGOUT:
      case NotificationType.LOGOUT_ALL:
        return settings.security.login;
      case NotificationType.THREAD:
        return settings.social.threads;
      case NotificationType.COMMENT:
        return settings.comments.enabled;
      case NotificationType.FOLLOW:
        return settings.social.follows;
      case NotificationType.PATCH:
        return settings.social.patches;
      case 'TAG_MENTION' as NotificationType:
        return settings.tags.mentions;
      case NotificationType.COLLECTION_UPLOAD:
      case NotificationType.PRODUCT_UPLOAD:
      case NotificationType.COLLECTION_DELETED:
        return settings.collections.lifecycle;
      case NotificationType.PRIVATE_ACCESS_REQUESTED:
      case NotificationType.PRIVATE_ACCESS_APPROVED:
      case NotificationType.PRIVATE_ACCESS_REJECTED:
      case NotificationType.PRIVATE_ACCESS_REVOKED:
        return settings.collections.access;
      case NotificationType.BRAND_PATCH_REQUEST:
        return settings.brand.patchRequests;
      case NotificationType.CONTRIBUTION_REQUEST:
      case NotificationType.CONTRIBUTION_ACCEPTED:
      case NotificationType.CONTRIBUTION_REJECTED:
        return settings.brand.contributions;
      case NotificationType.ORDER_PLACED:
      case NotificationType.ORDER_STATUS_UPDATED:
        return settings.orders.updates;
      case 'SIZE_FIT_UPDATE_REMINDER' as NotificationType:
        return settings.fit.reminders;
      case 'SIZE_FIT_SHARED' as NotificationType:
      case 'SIZE_FIT_SHARE_REQUEST' as NotificationType:
      case 'SIZE_FIT_RESHARED' as NotificationType:
        return settings.fit.shares;
      case 'SIZE_FIT_SHARE_APPROVED' as NotificationType:
      case 'SIZE_FIT_SHARE_REJECTED' as NotificationType:
        return settings.fit.approvals;
      default:
        return true; // Default to true for critical/other types
    }
  }

  private async areUsersPatched(
    userAId: string,
    userBId: string,
  ): Promise<boolean> {
    const connection = await this.prisma.patchConnection.findFirst({
      where: {
        status: PatchStatus.ACCEPTED,
        OR: [
          { requesterId: userAId, targetId: userBId },
          { requesterId: userBId, targetId: userAId },
        ],
      },
      select: { id: true },
    });
    return !!connection;
  }

  private async canReceiveTagMentionFromActor(
    recipientId: string,
    actorId: string | null,
    settings: NotificationSettings,
  ): Promise<boolean> {
    if (!settings.tags.mentions) return false;
    if (settings.tags.fromUnpatchedUsers) return true;
    if (!actorId) return true;
    return this.areUsersPatched(actorId, recipientId);
  }

  private async canReceiveCommentFromActor(
    recipientId: string,
    actorId: string | null,
    payload: Record<string, any> | null | undefined,
    settings: NotificationSettings,
  ): Promise<boolean> {
    if (!settings.comments.enabled) return false;

    const isReplyComment = !!payload?.parentId;
    if (isReplyComment && !settings.comments.replies) return false;

    if (!settings.comments.fromUnpatchedUsers && actorId) {
      return this.areUsersPatched(actorId, recipientId);
    }

    return true;
  }

  async create(
    recipientId: string,
    type: NotificationType,
    opts?: CreateNotificationOptions,
  ) {
    console.log(
      `Creating notification: type=${type}, recipient=${recipientId}, actor=${opts?.actorId}`,
    );

    const actorId = opts?.actorId ?? null;
    if (actorId && actorId === recipientId) {
      console.log('Skipping self-notification');
      return null;
    }

    // Check user settings
    const settings = await this.getSettings(recipientId);
    if (type === ('TAG_MENTION' as NotificationType)) {
      const canReceive = await this.canReceiveTagMentionFromActor(
        recipientId,
        actorId,
        settings,
      );
      if (!canReceive) {
        console.log(
          `Tag mention blocked by settings. recipient=${recipientId}, actor=${actorId}`,
        );
        return null;
      }
    } else if (type === NotificationType.COMMENT) {
      const canReceive = await this.canReceiveCommentFromActor(
        recipientId,
        actorId,
        opts?.payload,
        settings,
      );
      if (!canReceive) {
        console.log(
          `Comment notification blocked by settings. recipient=${recipientId}, actor=${actorId}`,
        );
        return null;
      }
    } else if (!this.isNotificationEnabled(type, settings)) {
      console.log(
        `Notification type ${type} disabled by user settings. Skipping.`,
      );
      return null;
    }

    try {
      // Validate payload by type
      const sanitizedPayload = this.validateAndSanitizePayload(
        type,
        opts?.payload ?? {},
      );
      // Enforce internal-only targetUrl if present
      if (sanitizedPayload && typeof sanitizedPayload === 'object') {
        const tu = this.sanitizeTargetUrl((sanitizedPayload as any).targetUrl);
        if (tu) (sanitizedPayload as any).targetUrl = tu;
        else delete (sanitizedPayload as any).targetUrl;
      }
      console.log('Payload validated and sanitized');

      // Optional dedupe within window based on same recipient/type/actor and target id in payload
      if (opts?.dedupeMs && opts.dedupeMs > 0) {
        const since = new Date(Date.now() - opts.dedupeMs);
        const whereClause: any = {
          recipientId,
          type,
          actorId: actorId ?? undefined,
          createdAt: { gte: since },
        };
        if (opts.target) {
          whereClause.payload = {
            path: ['target', 'id'],
            equals: opts.target.id,
          };
        }
        const existing = await this.prisma.notification.findFirst({
          where: whereClause,
        });
        if (existing) {
          console.log('Duplicate notification found, skipping creation');
          return existing;
        }
      }

      const created = await this.prisma.notification.create({
        data: {
          id: uuidv4(),
          type,
          payload: {
            ...sanitizedPayload,
            ...(opts?.target ? { target: opts.target } : {}),
          },
          isRead: false,
          recipient: { connect: { id: recipientId } },
          ...(actorId ? { actor: { connect: { id: actorId } } } : {}),
        },
        include: {
          actor: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
      });

      console.log(`Notification created successfully: id=${created.id}`);

      // Invalidate cache for unread count
      await this.cacheManager.del(`unread_count:${recipientId}`);

      try {
        // Sanitize payload for emission: remove sensitive fields
        const emittedPayload =
          created.payload &&
          typeof created.payload === 'object' &&
          !Array.isArray(created.payload)
            ? { ...created.payload }
            : {};
        if ((emittedPayload as any).ip) delete (emittedPayload as any).ip; // Remove IP addresses
        if ((emittedPayload as any).userAgent)
          delete (emittedPayload as any).userAgent; // Remove user agents

        const target = opts?.target ?? this.extractTarget(type, emittedPayload);
        const targetUrl = this.sanitizeTargetUrl((emittedPayload as any).targetUrl);

        this.events.server
          ?.to(`USER:${recipientId}`)
          .emit('notification.created', {
            id: created.id,
            type: created.type,
            payload: emittedPayload,
            actor: created.actor,
            createdAt: created.createdAt,
            isRead: created.isRead,
            message: this.formatMessage(created),
            version: 2,
            target,
            targetUrl,
            ts: Date.now(),
          });
        console.log('Notification event emitted successfully');
      } catch (error) {
        console.error('Failed to emit notification event:', error);
        // Log for monitoring, but don't fail the notification creation
      }

      return created;
    } catch (error) {
      console.error('Failed to create notification:', error);
      throw error; // Re-throw to let caller handle
    }
  }
}
