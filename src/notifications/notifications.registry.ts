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
      schema: Joi.object({
        targetUrl: Joi.string().optional(),
      }),
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
        targetUrl: Joi.string().optional(),
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
        targetUrl: Joi.string().optional(),
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
        targetUrl: Joi.string().optional(),
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

    // PRIVATE ACCESS REQUESTED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_REQUESTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        requesterId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : 'Someone';
        return `${actorName} requested access to a private collection`;
      },
    });

    // PRIVATE ACCESS APPROVED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_APPROVED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your request to view a private collection was approved',
    });

    // PRIVATE ACCESS REJECTED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_REJECTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        note: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your request to view a private collection was rejected',
    });

    // PRIVATE ACCESS REVOKED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_REVOKED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your access to a private collection was revoked',
    });

    // COLLECTION_UPLOAD
    registry.register({
      type: NotificationType.COLLECTION_UPLOAD,
      schema: Joi.object({
        collectionId: Joi.string().optional(),
        collectionName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const name = n.payload?.collectionName || 'Your collection';
        return `${name} was successfully uploaded`;
      },
    });

    // COLLECTION_DELETED (informational, no action link)
    registry.register({
      type: NotificationType.COLLECTION_DELETED,
      schema: Joi.object({
        collectionName: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        // Use custom message if provided, otherwise default
        if (n.payload?.message) return n.payload.message;
        const name = n.payload?.collectionName || 'Collection';
        return `${name} has been successfully deleted`;
      },
    });

    // BRAND_PATCH_REQUEST
    registry.register({
      type: NotificationType.BRAND_PATCH_REQUEST,
      schema: Joi.object({
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} sent you a patch request`;
      },
    });

    // BRAND_PATCH_ACCEPTED
    registry.register({
      type: NotificationType.BRAND_PATCH_ACCEPTED,
      schema: Joi.object({
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} accepted your patch request`;
      },
    });

    // BRAND_PATCH_REJECTED
    registry.register({
      type: NotificationType.BRAND_PATCH_REJECTED,
      schema: Joi.object({
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} rejected your patch request`;
      },
    });

    // CONTRIBUTION_REQUEST
    registry.register({
      type: NotificationType.CONTRIBUTION_REQUEST,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} requested to contribute to your collection`;
      },
    });

    // CONTRIBUTION_ACCEPTED
    registry.register({
      type: NotificationType.CONTRIBUTION_ACCEPTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} accepted your contribution request`;
      },
    });

    // CONTRIBUTION_REJECTED
    registry.register({
      type: NotificationType.CONTRIBUTION_REJECTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username || n.actor.brandFullName || 'A brand'
          : 'A brand';
        return `${actorName} rejected your contribution request`;
      },
    });

    return registry;
  }
}
