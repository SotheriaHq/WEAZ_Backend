import { NotificationType } from '@prisma/client';
import * as Joi from 'joi';

export interface NotificationConfig {
  type: NotificationType;
  schema: Joi.ObjectSchema;
  formatter: (notification: any) => string;
}

export class NotificationRegistry {
  private configs: Map<NotificationType, NotificationConfig> = new Map();

  register(config: NotificationConfig) {
    this.configs.set(config.type, config);
  }

  getConfig(type: NotificationType): NotificationConfig | undefined {
    return this.configs.get(type);
  }

  getAllTypes(): NotificationType[] {
    return Array.from(this.configs.keys());
  }

  // Pre-register existing types
  static createDefault(): NotificationRegistry {
    const registry = new NotificationRegistry();

    // LOGIN
    registry.register({
      type: NotificationType.LOGIN,
      schema: Joi.object({
        ip: Joi.string().optional(),
        userAgent: Joi.string().optional(),
        location: Joi.object({
          city: Joi.string().optional(),
          region: Joi.string().optional(),
          country: Joi.string().optional(),
        }).optional(),
      }),
      formatter: (n: any) => {
        const ip = n.payload?.ip ?? 'unknown IP';
        const ua = n.payload?.userAgent
          ? String(n.payload.userAgent).split('(')[0].trim()
          : 'your device';
        const loc = n.payload?.location;
        const where =
          loc?.city || loc?.region || loc?.country
            ? [loc?.city, loc?.region, loc?.country].filter(Boolean).join(', ')
            : null;
        return where
          ? `New sign-in in ${where} on ${ua}`
          : `New sign-in from ${ip} on ${ua}`;
      },
    });

    // LOGOUT
    registry.register({
      type: NotificationType.LOGOUT,
      schema: Joi.object({}),
      formatter: () => 'You logged out',
    });

    // LOGOUT_ALL
    registry.register({
      type: NotificationType.LOGOUT_ALL,
      schema: Joi.object({}),
      formatter: () => 'You logged out from all devices',
    });

    // SIGNUP
    registry.register({
      type: NotificationType.SIGNUP,
      schema: Joi.object({
        action: Joi.string().valid('EMAIL_VERIFIED').optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.action === 'EMAIL_VERIFIED') {
          return 'Your email was verified successfully';
        }
        return 'Welcome! Your account was created';
      },
    });

    // FOLLOW
    registry.register({
      type: NotificationType.FOLLOW,
      schema: Joi.object({}),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : null;
        return actorName
          ? `${actorName} started following you`
          : 'You have a new follower';
      },
    });

    // COMMENT
    registry.register({
      type: NotificationType.COMMENT,
      schema: Joi.object({
        target: Joi.object({
          type: Joi.string().optional(),
          id: Joi.string().optional(),
        }).optional(),
        targetType: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : null;
        const tt =
          n.payload?.target?.type || n.payload?.targetType || 'content';
        return actorName
          ? `${actorName} commented on your ${String(tt).toLowerCase()}`
          : 'New comment received';
      },
    });

    // LIKE
    registry.register({
      type: NotificationType.LIKE,
      schema: Joi.object({
        target: Joi.object({
          type: Joi.string().optional(),
          id: Joi.string().optional(),
        }).optional(),
        postId: Joi.string().optional(),
        collectionId: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : null;
        const tt = n.payload?.target?.type
          ? n.payload.target.type
          : n.payload?.postId
            ? 'POST'
            : n.payload?.collectionId
              ? 'COLLECTION'
              : 'content';
        return actorName
          ? `${actorName} liked your ${String(tt).toLowerCase()}`
          : 'New like received';
      },
    });

    // PATCH
    registry.register({
      type: NotificationType.PATCH,
      schema: Joi.object({
        target: Joi.object({
          type: Joi.string().optional(),
          id: Joi.string().optional(),
        }).optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : null;
        return actorName
          ? `${actorName} patched your collection`
          : 'Your collection received a patch';
      },
    });

    return registry;
  }
}
