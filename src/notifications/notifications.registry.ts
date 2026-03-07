import { NotificationType } from '@prisma/client';
import * as Joi from 'joi';

const NT_SIZE_FIT_UPDATE_REMINDER = 'SIZE_FIT_UPDATE_REMINDER' as NotificationType;
const NT_SIZE_FIT_SHARED = 'SIZE_FIT_SHARED' as NotificationType;
const NT_SIZE_FIT_SHARE_REQUEST = 'SIZE_FIT_SHARE_REQUEST' as NotificationType;
const NT_SIZE_FIT_SHARE_APPROVED = 'SIZE_FIT_SHARE_APPROVED' as NotificationType;
const NT_SIZE_FIT_SHARE_REJECTED = 'SIZE_FIT_SHARE_REJECTED' as NotificationType;
const NT_SIZE_FIT_RESHARED = 'SIZE_FIT_RESHARED' as NotificationType;
const NT_TAG_MENTION = 'TAG_MENTION' as NotificationType;
const NT_ITEM_FEATURED = 'ITEM_FEATURED' as NotificationType;
const NT_FEATURED_AUTO_REMOVED = 'FEATURED_AUTO_REMOVED' as NotificationType;

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
        action: Joi.string().valid('SIGNUP', 'EMAIL_VERIFIED').optional(),
        email: Joi.string().email().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.action === 'EMAIL_VERIFIED') {
          return 'Your email was verified successfully';
        }
        return 'Welcome! Your account was created';
      },
    });

    // FOLLOW (legacy -> Patch copy)
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
          ? `${actorName} patched your profile`
          : 'You have a new patch';
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
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
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

    // THREAD
    registry.register({
      type: NotificationType.THREAD,
      schema: Joi.object({
        target: Joi.object({
          type: Joi.string().optional(),
          id: Joi.string().optional(),
        }).optional(),
        postId: Joi.string().optional(),
        collectionId: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
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
          ? `${actorName} threaded your ${String(tt).toLowerCase()}`
          : 'New thread received';
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
        action: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : null;
        const action = n.payload?.action;
        // Profile patch (user-to-brand)
        if (action === 'PROFILE_PATCHED') {
          return actorName
            ? `${actorName} patched your profile`
            : 'Your profile received a patch';
        }
        if (action === 'PROFILE_UNPATCHED') {
          return actorName
            ? `${actorName} unpatched your profile`
            : 'A user unpatched your profile';
        }
        // Collection collab (brand-to-collection)
        if (action === 'COLLECTION_COLLAB') {
          return actorName
            ? `${actorName} collabed your collection`
            : 'Your collection received a collab';
        }
        // Fallback for legacy payloads
        const targetType = n.payload?.target?.type;
        const patchLabel = targetType === 'USER' ? 'profile' : 'collection';
        return actorName
          ? `${actorName} patched your ${patchLabel}`
          : `Your ${patchLabel} received a patch`;
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
        collectionTitle: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
        const name =
          n.payload?.collectionName ||
          n.payload?.collectionTitle ||
          'Your collection';
        return `${name} was successfully uploaded`;
      },
    });

    // PRODUCT_UPLOAD
    registry.register({
      type: NotificationType.PRODUCT_UPLOAD,
      schema: Joi.object({
        productId: Joi.string().optional(),
        productName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
        const name = n.payload?.productName || 'A new product';
        return `${name} is now available`;
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

    // SIZE_FIT_UPDATE_REMINDER
    registry.register({
      type: NT_SIZE_FIT_UPDATE_REMINDER,
      schema: Joi.object({
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        'Time to update your custom size/fits profile (recommended every 2 weeks)',
    });

    // SIZE_FIT_SHARED
    registry.register({
      type: NT_SIZE_FIT_SHARED,
      schema: Joi.object({
        ownerId: Joi.string().optional(),
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || 'A size fitting profile was shared with you',
    });

    // SIZE_FIT_SHARE_REQUEST
    registry.register({
      type: NT_SIZE_FIT_SHARE_REQUEST,
      schema: Joi.object({
        requestedViewerId: Joi.string().optional(),
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const actorName = n.actor
          ? n.actor.username ||
            `${n.actor.firstName ?? ''} ${n.actor.lastName ?? ''}`.trim()
          : 'A user';
        return `${actorName} requested permission to share your size fittings`;
      },
    });

    // SIZE_FIT_SHARE_APPROVED
    registry.register({
      type: NT_SIZE_FIT_SHARE_APPROVED,
      schema: Joi.object({
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'Your size fit share request was approved',
    });

    // SIZE_FIT_SHARE_REJECTED
    registry.register({
      type: NT_SIZE_FIT_SHARE_REJECTED,
      schema: Joi.object({
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'Your size fit share request was rejected',
    });

    // SIZE_FIT_RESHARED
    registry.register({
      type: NT_SIZE_FIT_RESHARED,
      schema: Joi.object({
        targetUserId: Joi.string().optional(),
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || 'Your size fitting profile was shared again',
    });

    // TAG_MENTION
    registry.register({
      type: NT_TAG_MENTION,
      schema: Joi.object({
        tag: Joi.string().optional(),
        tags: Joi.array().items(Joi.string()).optional(),
        entityType: Joi.string().optional(),
        entityId: Joi.string().optional(),
        entityTitle: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const tags = Array.isArray(n.payload?.tags)
          ? n.payload.tags.filter(Boolean)
          : [];
        const primaryTag = typeof n.payload?.tag === 'string' ? n.payload.tag : tags[0];
        const tagText = primaryTag ? `#${primaryTag}` : 'one of your tags';
        const title = n.payload?.entityTitle || 'A post';
        return `${title} matched ${tagText}`;
      },
    });

    // ITEM_FEATURED
    registry.register({
      type: NT_ITEM_FEATURED,
      schema: Joi.object({
        entityType: Joi.string().valid('PRODUCT', 'DESIGN').required(),
        entityId: Joi.string().required(),
        entityName: Joi.string().optional(),
        expiresAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const name = n.payload?.entityName || 'Your item';
        const type = n.payload?.entityType === 'DESIGN' ? 'design' : 'product';
        return `${name} has been featured! Your ${type} will be showcased for 7 days.`;
      },
    });

    // FEATURED_AUTO_REMOVED
    registry.register({
      type: NT_FEATURED_AUTO_REMOVED,
      schema: Joi.object({
        entityType: Joi.string().valid('PRODUCT', 'DESIGN').required(),
        entityId: Joi.string().required(),
        entityName: Joi.string().optional(),
        reason: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const name = n.payload?.entityName || 'Your item';
        const reason = n.payload?.reason;
        if (reason === 'EXPIRED') return `${name} is no longer featured — the 7-day period has ended.`;
        if (reason === 'BRAND_SUSPENDED') return `${name} was removed from featured due to account suspension.`;
        return `${name} has been removed from featured.`;
      },
    });

    return registry;
  }
}
