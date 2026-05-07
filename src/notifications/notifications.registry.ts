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
const NT_VERIFICATION_SUBMITTED = 'VERIFICATION_SUBMITTED' as NotificationType;
const NT_VERIFICATION_IN_REVIEW = 'VERIFICATION_IN_REVIEW' as NotificationType;
const NT_VERIFICATION_INFO_REQUESTED = 'VERIFICATION_INFO_REQUESTED' as NotificationType;
const NT_VERIFICATION_INFO_RESUBMITTED = 'VERIFICATION_INFO_RESUBMITTED' as NotificationType;
const NT_VERIFICATION_APPROVED = 'VERIFICATION_APPROVED' as NotificationType;
const NT_VERIFICATION_REJECTED = 'VERIFICATION_REJECTED' as NotificationType;
const NT_VERIFICATION_CANCELLED = 'VERIFICATION_CANCELLED' as NotificationType;
const NT_VERIFICATION_CANCELLED_ADMIN = 'VERIFICATION_CANCELLED_ADMIN' as NotificationType;
const NT_VERIFICATION_COOLDOWN_EXPIRED = 'VERIFICATION_COOLDOWN_EXPIRED' as NotificationType;
const NT_VERIFICATION_NUDGE = 'VERIFICATION_NUDGE' as NotificationType;
const NT_REVIEW_REMINDER = 'REVIEW_REMINDER' as NotificationType;
const NT_REVIEW_REPLY_RECEIVED = 'REVIEW_REPLY_RECEIVED' as NotificationType;
const NT_REVIEW_HIDDEN_BY_ADMIN = 'REVIEW_HIDDEN_BY_ADMIN' as NotificationType;
const NT_CUSTOM_ORDER_PAYMENT_RECEIVED = 'CUSTOM_ORDER_PAYMENT_RECEIVED' as NotificationType;
const NT_CUSTOM_ORDER_REVIEW_REQUIRED = 'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType;
const NT_CUSTOM_ORDER_BRAND_ACCEPTED = 'CUSTOM_ORDER_BRAND_ACCEPTED' as NotificationType;
const NT_CUSTOM_ORDER_BRAND_REJECTED = 'CUSTOM_ORDER_BRAND_REJECTED' as NotificationType;
const NT_CUSTOM_ORDER_PROGRESS_UPDATED = 'CUSTOM_ORDER_PROGRESS_UPDATED' as NotificationType;
const NT_CUSTOM_ORDER_EXTENSION_REQUESTED = 'CUSTOM_ORDER_EXTENSION_REQUESTED' as NotificationType;
const NT_CUSTOM_ORDER_EXTENSION_RESOLVED = 'CUSTOM_ORDER_EXTENSION_RESOLVED' as NotificationType;
const NT_CUSTOM_ORDER_BUYER_COUNTERED = 'CUSTOM_ORDER_BUYER_COUNTERED' as NotificationType;
const NT_CUSTOM_ORDER_BUYER_REJECTED_EXTENSION = 'CUSTOM_ORDER_BUYER_REJECTED_EXTENSION' as NotificationType;
const NT_CUSTOM_ORDER_DELIVERED = 'CUSTOM_ORDER_DELIVERED' as NotificationType;
const NT_CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER = 'CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER' as NotificationType;
const NT_CUSTOM_ORDER_ISSUE_REPORTED = 'CUSTOM_ORDER_ISSUE_REPORTED' as NotificationType;
const NT_CUSTOM_ORDER_DISPUTE_CREATED = 'CUSTOM_ORDER_DISPUTE_CREATED' as NotificationType;
const NT_CUSTOM_ORDER_STALE_STAGE_WARNING = 'CUSTOM_ORDER_STALE_STAGE_WARNING' as NotificationType;
const NT_CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED = 'CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED' as NotificationType;
const NT_CUSTOM_ORDER_ACCEPTANCE_SLA_RISK = 'CUSTOM_ORDER_ACCEPTANCE_SLA_RISK' as NotificationType;
const NT_MESSAGE_RECEIVED = 'MESSAGE_RECEIVED' as NotificationType;
const NT_MESSAGE_UNREAD_REMINDER = 'MESSAGE_UNREAD_REMINDER' as NotificationType;
const NT_MESSAGE_THREAD_REOPENED = 'MESSAGE_THREAD_REOPENED' as NotificationType;
const NT_MESSAGE_MODERATED = 'MESSAGE_MODERATED' as NotificationType;

const formatOrderCode = (orderId: unknown) => {
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    return 'order';
  }

  return `#${orderId.slice(0, 8).toUpperCase()}`;
};

const humanizeOrderStatus = (status: unknown) => {
  const normalized = typeof status === 'string' ? status.trim().toUpperCase() : '';
  switch (normalized) {
    case 'PENDING':
      return 'pending';
    case 'PROCESSING':
      return 'processing';
    case 'SHIPPED':
      return 'shipped';
    case 'DELIVERED':
      return 'delivered';
    case 'CANCELLED':
      return 'cancelled';
    case 'RETURNED':
      return 'returned';
    default:
      return normalized ? normalized.toLowerCase() : 'updated';
  }
};

const formatCustomOrderCode = (customOrderId: unknown) => {
  if (typeof customOrderId !== 'string' || customOrderId.trim().length === 0) {
    return 'custom order';
  }

  return `#CO-${customOrderId.slice(0, 8).toUpperCase()}`;
};

const formatActorDisplayName = (
  actor: {
    username?: string | null;
    userProfile?: { firstName?: string | null; lastName?: string | null } | null;
  } | null | undefined,
  fallback: string | null,
) => {
  if (!actor) return fallback;
  return (
    actor.username ||
    [actor.userProfile?.firstName, actor.userProfile?.lastName]
      .map((value) => String(value ?? '').trim())
      .filter(Boolean)
      .join(' ') ||
    fallback
  );
};

const formatActorBrandName = (
  actor: {
    username?: string | null;
    brand?: { name?: string | null } | null;
  } | null | undefined,
  fallback: string,
) => {
  if (!actor) return fallback;
  return actor.username || actor.brand?.name || fallback;
};

const toContentLabel = (targetType: unknown): string => {
  const normalizedType = String(targetType ?? 'content').toUpperCase();
  if (normalizedType === 'COLLECTION_MEDIA') return 'design';
  if (normalizedType === 'COLLECTION') return 'design';
  if (normalizedType === 'POST') return 'post';
  if (normalizedType === 'PRODUCT') return 'product';
  if (normalizedType === 'USER') return 'profile';
  return String(targetType ?? 'content').toLowerCase();
};

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
        displayName: Joi.string().optional(),
        username: Joi.string().optional(),
        createdAtIso: Joi.string().isoDate().optional(),
        device: Joi.string().optional(),
        location: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.action === 'EMAIL_VERIFIED') {
          return 'Your email is verified. Your account is now secured and ready.';
        }
        return 'Welcome! Your account was created';
      },
    });

    // ORDER_PLACED
    registry.register({
      type: NotificationType.ORDER_PLACED,
      schema: Joi.object({
        orderId: Joi.string().required(),
        brandId: Joi.string().optional(),
        brandName: Joi.string().optional(),
        customerName: Joi.string().optional(),
        totalAmount: Joi.number().optional(),
        isBuyerCopy: Joi.boolean().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;

        const orderCode = formatOrderCode(n.payload?.orderId);
        const brandName = n.payload?.brandName;
        const actorName = formatActorDisplayName(n.actor, null);

        if (n.payload?.isBuyerCopy) {
          return brandName
            ? `Your order ${orderCode} with ${brandName} was placed successfully`
            : `Your order ${orderCode} was placed successfully`;
        }

        const customerName = actorName || n.payload?.customerName || 'A customer';
        return `${customerName} placed ${orderCode}`;
      },
    });

    // ORDER_STATUS_UPDATED
    registry.register({
      type: NotificationType.ORDER_STATUS_UPDATED,
      schema: Joi.object({
        orderId: Joi.string().required(),
        orderTitle: Joi.string().optional(),
        status: Joi.string().required(),
        previousStatus: Joi.string().optional(),
        brandName: Joi.string().optional(),
        reason: Joi.string().optional(),
        refundStatus: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;

        const orderCode = formatOrderCode(n.payload?.orderId);
        const statusLabel = humanizeOrderStatus(n.payload?.status);
        const orderTitle = typeof n.payload?.orderTitle === 'string'
          ? n.payload.orderTitle.trim()
          : '';
        const brandName = n.payload?.brandName;
        const reason = typeof n.payload?.reason === 'string' ? n.payload.reason.trim() : '';
        const refundStatus = typeof n.payload?.refundStatus === 'string'
          ? n.payload.refundStatus.trim().toLowerCase()
          : '';

        let message = '';
        const orderReference = orderTitle || orderCode;

        if (n.payload?.status === 'SHIPPED') {
          message = brandName
            ? `Your order ${orderReference} from ${brandName} has been shipped`
            : `Your order ${orderReference} has been shipped`;
        } else if (n.payload?.status === 'DELIVERED') {
          message = brandName
            ? `Your order ${orderReference} from ${brandName} has been delivered`
            : `Your order ${orderReference} has been delivered`;
        } else {
          message = brandName
            ? `Your order ${orderReference} from ${brandName} is now ${statusLabel}`
            : `Your order ${orderReference} is now ${statusLabel}`;
        }

        if (reason) {
          message += `. Reason: ${reason}`;
        }

        if (refundStatus) {
          message += `. Refund status: ${refundStatus}`;
        }

        return message;
      },
    });

    // FOLLOW (legacy -> Patch copy)
    registry.register({
      type: NotificationType.FOLLOW,
      schema: Joi.object({
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = formatActorDisplayName(n.actor, null);
        return actorName
          ? `${actorName} patched on your profile`
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
        contentTitle: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }
        const actorName = formatActorDisplayName(n.actor, null);
        const contentTitle =
          typeof n.payload?.contentTitle === 'string' &&
          n.payload.contentTitle.trim().length > 0
            ? n.payload.contentTitle.trim()
            : null;
        const tt =
          n.payload?.target?.type || n.payload?.targetType || 'content';
        const contentLabel = toContentLabel(tt);
        return actorName
          ? contentTitle
            ? `${actorName} commented on ${contentLabel} "${contentTitle}"`
            : `${actorName} commented on ${contentLabel}`
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
        contentTitle: Joi.string().optional(),
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
        const actorName = formatActorDisplayName(n.actor, null);
        const contentTitle =
          typeof n.payload?.contentTitle === 'string' &&
          n.payload.contentTitle.trim().length > 0
            ? n.payload.contentTitle.trim()
            : null;
        const tt = n.payload?.target?.type
          ? n.payload.target.type
          : n.payload?.postId
            ? 'POST'
            : n.payload?.collectionId
              ? 'COLLECTION'
              : 'content';
        const contentLabel = toContentLabel(tt);

        return actorName
          ? contentTitle
            ? `${actorName} threaded ${contentLabel} "${contentTitle}"`
            : `${actorName} threaded ${contentLabel}`
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
        const actorName = formatActorDisplayName(n.actor, null);
        const action = n.payload?.action;
        // Profile patch (user-to-brand)
        if (action === 'PROFILE_PATCHED') {
          return actorName
            ? `${actorName} patched on your profile`
            : 'Your profile received a patch';
        }
        if (action === 'PROFILE_UNPATCHED') {
          return actorName
            ? `${actorName} unpatched from your profile`
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
          ? `${actorName} patched on your ${patchLabel}`
          : `Your ${patchLabel} received a patch`;
      },
    });

    // PRIVATE ACCESS REQUESTED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_REQUESTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        requesterId: Joi.string().required(),
        brandName: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = formatActorDisplayName(n.actor, 'Someone');
        return `${actorName} requested access to view your private collections`;
      },
    });

    // PRIVATE ACCESS APPROVED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_APPROVED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        brandName: Joi.string().allow(null).optional(),
        username: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = formatActorDisplayName(n.actor, null);
        const brandName = n.payload?.brandName || actorName || 'the brand';
        const username = n.payload?.username || 'there';
        return `Congratulations ${username}, ${brandName} approved your request`;
      },
    });

    // PRIVATE ACCESS REJECTED
    registry.register({
      type: NotificationType.PRIVATE_ACCESS_REJECTED,
      schema: Joi.object({
        collectionId: Joi.string().required(),
        brandName: Joi.string().allow(null).optional(),
        username: Joi.string().allow(null).optional(),
        note: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = formatActorDisplayName(n.actor, null);
        const brandName = n.payload?.brandName || actorName || 'the brand';
        const username = n.payload?.username || 'there';
        return `Sorry ${username}, ${brandName} rejected your request`;
      },
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        const actorName = formatActorBrandName(n.actor, 'A brand');
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
        'Time to update your custom size/fits profile.(recommended every 2 weeks)',
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
        const actorName = formatActorDisplayName(n.actor, 'A user');
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
        return `${name} has been featured! Your ${type} will be featured for 7 days.`;
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

    // VERIFICATION_SUBMITTED
    registry.register({
      type: NT_VERIFICATION_SUBMITTED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        attemptNumber: Joi.number().optional(),
        submittedAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your verification request was submitted',
    });

    // VERIFICATION_IN_REVIEW
    registry.register({
      type: NT_VERIFICATION_IN_REVIEW,
      schema: Joi.object({
        brandId: Joi.string().required(),
        reviewStartedAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your verification request is now under review',
    });

    // VERIFICATION_INFO_REQUESTED
    registry.register({
      type: NT_VERIFICATION_INFO_REQUESTED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        items: Joi.array().items(Joi.object()).optional(),
        message: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'More information is needed to continue your verification review',
    });

    // VERIFICATION_INFO_RESUBMITTED
    registry.register({
      type: NT_VERIFICATION_INFO_RESUBMITTED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.brandName
          ? `${n.payload.brandName} submitted the requested verification updates`
          : 'Requested verification updates were submitted',
    });

    // VERIFICATION_APPROVED
    registry.register({
      type: NT_VERIFICATION_APPROVED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        approvedAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your brand verification was approved',
    });

    // VERIFICATION_REJECTED
    registry.register({
      type: NT_VERIFICATION_REJECTED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        rejectedAt: Joi.string().optional(),
        reasons: Joi.array().items(Joi.object()).optional(),
        cooldownExpiresAt: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your brand verification was rejected',
    });

    // VERIFICATION_CANCELLED
    registry.register({
      type: NT_VERIFICATION_CANCELLED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        cancelledAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'Your verification request was cancelled',
    });

    // VERIFICATION_CANCELLED_ADMIN
    registry.register({
      type: NT_VERIFICATION_CANCELLED_ADMIN,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        cancelledAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.brandName
          ? `${n.payload.brandName} cancelled its verification request`
          : 'A brand cancelled its verification request',
    });

    registry.register({
      type: NT_VERIFICATION_COOLDOWN_EXPIRED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: () => 'You can submit verification again',
    });

    registry.register({
      type: NT_VERIFICATION_NUDGE,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = typeof n.payload?.message === 'string' ? n.payload.message.trim() : '';
        if (message) return message;
        return 'Complete verification to add a stronger trust signal to your store';
      },
    });

    registry.register({
      type: NT_REVIEW_REMINDER,
      schema: Joi.object({
        orderId: Joi.string().optional(),
        orderItemId: Joi.string().optional(),
        productId: Joi.string().optional(),
        productName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const productName = n.payload?.productName || 'your recent purchase';
        return `Share a review for ${productName}`;
      },
    });

    registry.register({
      type: NT_REVIEW_REPLY_RECEIVED,
      schema: Joi.object({
        reviewId: Joi.string().optional(),
        productId: Joi.string().optional(),
        productName: Joi.string().optional(),
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const brandName = n.payload?.brandName || 'A brand';
        const productName = n.payload?.productName || 'your review';
        return `${brandName} replied to your review on ${productName}`;
      },
    });

    registry.register({
      type: NT_REVIEW_HIDDEN_BY_ADMIN,
      schema: Joi.object({
        reviewId: Joi.string().optional(),
        productId: Joi.string().optional(),
        productName: Joi.string().optional(),
        reason: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const productName = n.payload?.productName || 'a product';
        return `Your review for ${productName} was hidden by an admin`;
      },
    });

    registry.register({
      type: NT_CUSTOM_ORDER_PAYMENT_RECEIVED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        sourceTitle: Joi.string().optional(),
        sourceBrandName: Joi.string().optional(),
        orderAmount: Joi.number().optional(),
        currency: Joi.string().optional(),
        buyerUsername: Joi.string().optional(),
        buyerFirstName: Joi.string().optional(),
        buyerLastName: Joi.string().optional(),
        buyerDisplayName: Joi.string().optional(),
        buyerEmail: Joi.string().email().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `Payment received for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_REVIEW_REQUIRED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        buyerName: Joi.string().optional(),
        buyerUsername: Joi.string().optional(),
        buyerFirstName: Joi.string().optional(),
        buyerLastName: Joi.string().optional(),
        buyerDisplayName: Joi.string().optional(),
        buyerEmail: Joi.string().email().optional(),
        sourceTitle: Joi.string().optional(),
        sourceBrandName: Joi.string().optional(),
        orderAmount: Joi.number().optional(),
        currency: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `${n.payload?.buyerName || 'A buyer'} paid for ${formatCustomOrderCode(n.payload?.customOrderId)} and it is awaiting your review`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_BRAND_ACCEPTED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `${n.payload?.brandName || 'The brand'} accepted ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_BRAND_REJECTED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        reason: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `${formatCustomOrderCode(n.payload?.customOrderId)} was rejected by the brand`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_PROGRESS_UPDATED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        stage: Joi.string().optional(),
        note: Joi.string().allow(null).optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `${formatCustomOrderCode(n.payload?.customOrderId)} moved to ${String(n.payload?.stage || 'a new stage').toLowerCase().replace(/_/g, ' ')}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_EXTENSION_REQUESTED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        requestedExtraDays: Joi.number().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `An extension was requested for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_EXTENSION_RESOLVED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        response: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `The extension request for ${formatCustomOrderCode(n.payload?.customOrderId)} was ${String(n.payload?.response || 'resolved').toLowerCase()}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_BUYER_COUNTERED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        counterDays: Joi.number().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `The buyer countered the extension request for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_BUYER_REJECTED_EXTENSION,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `The buyer rejected the extension request for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_DELIVERED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `${formatCustomOrderCode(n.payload?.customOrderId)} was marked as delivered`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `Please confirm delivery or report an issue for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ISSUE_REPORTED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        issueType: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `An issue was reported for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_DISPUTE_CREATED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        reasonType: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `A dispute was opened for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_STALE_STAGE_WARNING,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        stage: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `${formatCustomOrderCode(n.payload?.customOrderId)} has not been updated on time`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `${formatCustomOrderCode(n.payload?.customOrderId)} requires admin review`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || `${formatCustomOrderCode(n.payload?.customOrderId)} is approaching an acceptance SLA breach`,
    });

    registry.register({
      type: NT_MESSAGE_RECEIVED,
      schema: Joi.object({
        threadId: Joi.string().required(),
        messageId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'You received a new message on an order thread',
    });

    registry.register({
      type: NT_MESSAGE_UNREAD_REMINDER,
      schema: Joi.object({
        threadId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'You have unread order messages waiting',
    });

    registry.register({
      type: NT_MESSAGE_THREAD_REOPENED,
      schema: Joi.object({
        threadId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'A thread has been reopened by support',
    });

    registry.register({
      type: NT_MESSAGE_MODERATED,
      schema: Joi.object({
        threadId: Joi.string().required(),
        messageId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => n.payload?.message || 'A message in your order thread was moderated',
    });

    registry.register({
      type: NotificationType.ADMIN_ACTION,
      schema: Joi.object({
        action: Joi.string().optional(),
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        actorUserId: Joi.string().optional(),
        brandId: Joi.string().optional(),
        categoryId: Joi.string().optional(),
        subCategoryId: Joi.string().optional(),
        pointId: Joi.string().optional(),
        submittedByUserId: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message = n.payload?.message;
        if (typeof message === 'string' && message.trim().length > 0) {
          return message;
        }

        const action =
          typeof n.payload?.action === 'string'
            ? n.payload.action.trim().toUpperCase()
            : '';
        if (!action) {
          return 'Admin action recorded';
        }

        return `Admin action: ${action.replace(/_/g, ' ').toLowerCase()}`;
      },
    });

    return registry;
  }
}
