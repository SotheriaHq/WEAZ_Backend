import { NotificationType } from '@prisma/client';
import * as Joi from 'joi';

const NT_SIZE_FIT_UPDATE_REMINDER =
  'SIZE_FIT_UPDATE_REMINDER' as NotificationType;
const NT_SIZE_FIT_SHARED = 'SIZE_FIT_SHARED' as NotificationType;
const NT_SIZE_FIT_SHARE_REQUEST = 'SIZE_FIT_SHARE_REQUEST' as NotificationType;
const NT_SIZE_FIT_SHARE_APPROVED =
  'SIZE_FIT_SHARE_APPROVED' as NotificationType;
const NT_SIZE_FIT_SHARE_REJECTED =
  'SIZE_FIT_SHARE_REJECTED' as NotificationType;
const NT_SIZE_FIT_RESHARED = 'SIZE_FIT_RESHARED' as NotificationType;
const NT_WISHLIST_PRODUCT_UNAVAILABLE =
  'WISHLIST_PRODUCT_UNAVAILABLE' as NotificationType;
const NT_WISHLIST_PRODUCT_AVAILABLE =
  'WISHLIST_PRODUCT_AVAILABLE' as NotificationType;
const NT_TAG_MENTION = 'TAG_MENTION' as NotificationType;
const NT_ITEM_FEATURED = 'ITEM_FEATURED' as NotificationType;
const NT_FEATURED_AUTO_REMOVED = 'FEATURED_AUTO_REMOVED' as NotificationType;
const NT_VERIFICATION_SUBMITTED = 'VERIFICATION_SUBMITTED' as NotificationType;
const NT_VERIFICATION_IN_REVIEW = 'VERIFICATION_IN_REVIEW' as NotificationType;
const NT_VERIFICATION_INFO_REQUESTED =
  'VERIFICATION_INFO_REQUESTED' as NotificationType;
const NT_VERIFICATION_INFO_RESUBMITTED =
  'VERIFICATION_INFO_RESUBMITTED' as NotificationType;
const NT_VERIFICATION_APPROVED = 'VERIFICATION_APPROVED' as NotificationType;
const NT_VERIFICATION_REJECTED = 'VERIFICATION_REJECTED' as NotificationType;
const NT_VERIFICATION_CANCELLED = 'VERIFICATION_CANCELLED' as NotificationType;
const NT_VERIFICATION_CANCELLED_ADMIN =
  'VERIFICATION_CANCELLED_ADMIN' as NotificationType;
const NT_VERIFICATION_COOLDOWN_EXPIRED =
  'VERIFICATION_COOLDOWN_EXPIRED' as NotificationType;
const NT_VERIFICATION_NUDGE = 'VERIFICATION_NUDGE' as NotificationType;
const NT_VERIFICATION_SLA_WARNING =
  'VERIFICATION_SLA_WARNING' as NotificationType;
const NT_VERIFICATION_SLA_BREACH =
  'VERIFICATION_SLA_BREACH' as NotificationType;
const NT_VERIFICATION_REVIEW_DELAYED =
  'VERIFICATION_REVIEW_DELAYED' as NotificationType;
const NT_REVIEW_REMINDER = 'REVIEW_REMINDER' as NotificationType;
const NT_REVIEW_REPLY_RECEIVED = 'REVIEW_REPLY_RECEIVED' as NotificationType;
const NT_REVIEW_HIDDEN_BY_ADMIN = 'REVIEW_HIDDEN_BY_ADMIN' as NotificationType;
const NT_CUSTOM_ORDER_PAYMENT_RECEIVED =
  'CUSTOM_ORDER_PAYMENT_RECEIVED' as NotificationType;
const NT_CUSTOM_ORDER_REVIEW_REQUIRED =
  'CUSTOM_ORDER_REVIEW_REQUIRED' as NotificationType;
const NT_CUSTOM_ORDER_BRAND_ACCEPTED =
  'CUSTOM_ORDER_BRAND_ACCEPTED' as NotificationType;
const NT_CUSTOM_ORDER_BRAND_REJECTED =
  'CUSTOM_ORDER_BRAND_REJECTED' as NotificationType;
const NT_CUSTOM_ORDER_PROGRESS_UPDATED =
  'CUSTOM_ORDER_PROGRESS_UPDATED' as NotificationType;
const NT_CUSTOM_ORDER_EXTENSION_REQUESTED =
  'CUSTOM_ORDER_EXTENSION_REQUESTED' as NotificationType;
const NT_CUSTOM_ORDER_EXTENSION_RESOLVED =
  'CUSTOM_ORDER_EXTENSION_RESOLVED' as NotificationType;
const NT_CUSTOM_ORDER_BUYER_COUNTERED =
  'CUSTOM_ORDER_BUYER_COUNTERED' as NotificationType;
const NT_CUSTOM_ORDER_BUYER_REJECTED_EXTENSION =
  'CUSTOM_ORDER_BUYER_REJECTED_EXTENSION' as NotificationType;
const NT_CUSTOM_ORDER_DELIVERED = 'CUSTOM_ORDER_DELIVERED' as NotificationType;
const NT_CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER =
  'CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER' as NotificationType;
const NT_CUSTOM_ORDER_ISSUE_REPORTED =
  'CUSTOM_ORDER_ISSUE_REPORTED' as NotificationType;
const NT_CUSTOM_ORDER_DISPUTE_CREATED =
  'CUSTOM_ORDER_DISPUTE_CREATED' as NotificationType;
const NT_CUSTOM_ORDER_STALE_STAGE_WARNING =
  'CUSTOM_ORDER_STALE_STAGE_WARNING' as NotificationType;
const NT_CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED =
  'CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED' as NotificationType;
const NT_CUSTOM_ORDER_ACCEPTANCE_SLA_RISK =
  'CUSTOM_ORDER_ACCEPTANCE_SLA_RISK' as NotificationType;
const NT_MESSAGE_RECEIVED = 'MESSAGE_RECEIVED' as NotificationType;
const NT_MESSAGE_UNREAD_REMINDER =
  'MESSAGE_UNREAD_REMINDER' as NotificationType;
const NT_MESSAGE_THREAD_REOPENED =
  'MESSAGE_THREAD_REOPENED' as NotificationType;
const NT_MESSAGE_MODERATED = 'MESSAGE_MODERATED' as NotificationType;
const NT_BAG_ITEM_ADDED = 'BAG_ITEM_ADDED' as NotificationType;
const NT_BAG_CHECKOUT_REMINDER =
  'BAG_CHECKOUT_REMINDER' as NotificationType;

const optionalMessageRoutingString = Joi.string().allow(null).optional();

const messageRoutingPayloadShape = {
  type: optionalMessageRoutingString,
  category: optionalMessageRoutingString,
  conversationId: optionalMessageRoutingString,
  orderId: optionalMessageRoutingString,
  customOrderId: optionalMessageRoutingString,
  brandId: optionalMessageRoutingString,
  customerId: optionalMessageRoutingString,
  actorUserId: optionalMessageRoutingString,
  targetUrl: optionalMessageRoutingString,
  message: optionalMessageRoutingString,
};

const formatOrderCode = (orderId: unknown) => {
  if (typeof orderId !== 'string' || orderId.trim().length === 0) {
    return 'order';
  }

  return `#${orderId.slice(0, 8).toUpperCase()}`;
};

const humanizeOrderStatus = (status: unknown) => {
  const normalized =
    typeof status === 'string' ? status.trim().toUpperCase() : '';
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

/**
 * Human-readable reason for an admin-review nudge. Returns null for unknown /
 * free-text reasons so the copy falls back to a clean generic line.
 */
const describeAdminReviewReason = (reason: unknown): string | null => {
  switch (String(reason || '').toUpperCase()) {
    case 'STALE_OPERATIONAL_STATUS':
      return "it's been sitting without an update";
    case 'BRAND_ACCEPTANCE_TIMEOUT':
      return "the brand hasn't accepted it in time";
    case 'STALE_STAGE':
      return "it's been stuck at the same stage for a while";
    case 'PAYOUT_RELEASE_ELIGIBLE':
      return "it's ready for a manual payout release";
    default:
      return null;
  }
};

const formatActorDisplayName = (
  actor:
    | {
        username?: string | null;
        userProfile?: {
          firstName?: string | null;
          lastName?: string | null;
        } | null;
      }
    | null
    | undefined,
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
  actor:
    | {
        username?: string | null;
        brand?: { name?: string | null } | null;
      }
    | null
    | undefined,
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
        method: Joi.string().optional(),
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

        const customerName =
          actorName || n.payload?.customerName || 'A customer';
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
        const orderTitle =
          typeof n.payload?.orderTitle === 'string'
            ? n.payload.orderTitle.trim()
            : '';
        const brandName = n.payload?.brandName;
        const reason =
          typeof n.payload?.reason === 'string' ? n.payload.reason.trim() : '';
        const refundStatus =
          typeof n.payload?.refundStatus === 'string'
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

    // ORDER_FULFILLMENT_REMINDER — escalating brand nudge to move an unshipped
    // paid order forward. In-app + push only (kept out of the email default set).
    registry.register({
      type: NotificationType.ORDER_FULFILLMENT_REMINDER,
      schema: Joi.object({
        orderId: Joi.string().required(),
        tier: Joi.string().valid('GENTLE', 'FIRM', 'FINAL').optional(),
        status: Joi.string().optional(),
        hoursElapsed: Joi.number().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const orderCode = formatOrderCode(n.payload?.orderId);
        switch (n.payload?.tier) {
          case 'FIRM':
            return `⏳ Your customer is still waiting on ${orderCode}. A quick status update keeps them excited — tap to move it forward.`;
          case 'FINAL':
            return `⏰ Last call on ${orderCode}! It's due to ship now. Dispatch it to delight your customer and stay ahead of escalation.`;
          default:
            return `🎉 You've got an order to make someone's day! ${orderCode} is ready for you to start — tap to kick it off.`;
        }
      },
    });

    // ORDER_FULFILLMENT_OVERDUE — SLA breach: escalation to admin/brand, or an
    // auto-cancel+refund notice to the buyer. In-app + push only.
    registry.register({
      type: NotificationType.ORDER_FULFILLMENT_OVERDUE,
      schema: Joi.object({
        orderId: Joi.string().required(),
        reason: Joi.string().optional(),
        hoursElapsed: Joi.number().optional(),
        autoCancelled: Joi.boolean().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const orderCode = formatOrderCode(n.payload?.orderId);
        if (n.payload?.autoCancelled) {
          return `Order ${orderCode} passed its fulfilment window and was cancelled and refunded. Tap for the details.`;
        }
        return `👀 Order ${orderCode} is overdue and needs a look — no dispatch within the fulfilment window yet. Tap to review.`;
      },
    });

    // BAG_ITEM_ADDED
    registry.register({
      type: NT_BAG_ITEM_ADDED,
      schema: Joi.object({
        action: Joi.string().valid('BAG_ITEM_ADDED').optional(),
        productId: Joi.string().optional(),
        productIds: Joi.array().items(Joi.string()).optional(),
        productName: Joi.string().optional(),
        productNames: Joi.array().items(Joi.string()).optional(),
        brandName: Joi.string().optional(),
        collectionId: Joi.string().optional(),
        collectionName: Joi.string().optional(),
        checkoutSessionId: Joi.string().optional(),
        checkoutIntentId: Joi.string().optional(),
        configurationId: Joi.string().optional(),
        sourceType: Joi.string().optional(),
        sourceId: Joi.string().optional(),
        itemCount: Joi.number().integer().min(1).optional(),
        quantity: Joi.number().integer().min(1).optional(),
        selectedSize: Joi.string().allow(null).optional(),
        selectedColor: Joi.string().allow(null).optional(),
        currency: Joi.string().optional(),
        price: Joi.number().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;

        const itemCount = Number(n.payload?.itemCount ?? 1);
        const productName =
          typeof n.payload?.productName === 'string' &&
          n.payload.productName.trim()
            ? n.payload.productName.trim()
            : 'Your item';
        const brandName =
          typeof n.payload?.brandName === 'string' &&
          n.payload.brandName.trim()
            ? ` from ${n.payload.brandName.trim()}`
            : '';
        const variant = [n.payload?.selectedSize, n.payload?.selectedColor]
          .filter((value) => typeof value === 'string' && value.trim())
          .join(', ');
        const variantText = variant ? ` (${variant})` : '';

        if (itemCount > 1) {
          const collectionName =
            typeof n.payload?.collectionName === 'string' &&
            n.payload.collectionName.trim()
              ? ` from ${n.payload.collectionName.trim()}`
              : '';
          return `${itemCount} items${collectionName} are in your bag. Check out soon before sizes sell out or prices change.`;
        }

        return `${productName}${brandName}${variantText} is in your bag. Check out soon before it sells out or the price changes.`;
      },
    });

    // BAG_CHECKOUT_REMINDER
    registry.register({
      type: NT_BAG_CHECKOUT_REMINDER,
      schema: Joi.object({
        action: Joi.string().valid('BAG_CHECKOUT_REMINDER').optional(),
        itemCount: Joi.number().integer().min(1).required(),
        topItemTitle: Joi.string().optional(),
        otherItemCount: Joi.number().integer().min(0).optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;

        const itemCount = Number(n.payload?.itemCount ?? 1);
        const topItemTitle =
          typeof n.payload?.topItemTitle === 'string' &&
          n.payload.topItemTitle.trim()
            ? n.payload.topItemTitle.trim()
            : '';

        if (topItemTitle && itemCount > 1) {
          return `${topItemTitle} and ${itemCount - 1} more item${itemCount - 1 === 1 ? '' : 's'} are still in your bag. Check out soon before sizes sell out or prices change.`;
        }

        if (topItemTitle) {
          return `${topItemTitle} is still in your bag. Check out soon before it sells out or the price changes.`;
        }

        return `You still have ${itemCount} item${itemCount === 1 ? '' : 's'} in your bag. Check out soon before they sell out or prices change.`;
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
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const actorName = formatActorDisplayName(n.actor, null);
        const action = n.payload?.action;
        // Requester (buyer) confirmation of their own patch (user-to-brand)
        if (action === 'USER_PATCH_CONFIRMED') {
          const brandName =
            (typeof n.payload?.brandName === 'string' && n.payload.brandName) ||
            actorName ||
            'this brand';
          return `You have successfully patched on ${brandName}. Keep shopping and patching.`;
        }
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

    registry.register({
      type: NT_WISHLIST_PRODUCT_UNAVAILABLE,
      schema: Joi.object({
        productId: Joi.string().required(),
        productName: Joi.string().required(),
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message =
          typeof n.payload?.message === 'string'
            ? n.payload.message.trim()
            : '';
        if (message) return message;
        const productName =
          n.payload?.productName || 'A product in your wishlist';
        const brandName = n.payload?.brandName;
        return brandName
          ? `${productName} from ${brandName} is no longer available from your wishlist`
          : `${productName} is no longer available from your wishlist`;
      },
    });

    registry.register({
      type: NT_WISHLIST_PRODUCT_AVAILABLE,
      schema: Joi.object({
        productId: Joi.string().required(),
        productName: Joi.string().required(),
        brandName: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        const message =
          typeof n.payload?.message === 'string'
            ? n.payload.message.trim()
            : '';
        if (message) return message;
        const productName =
          n.payload?.productName || 'A product in your wishlist';
        const brandName = n.payload?.brandName;
        return brandName
          ? `${productName} from ${brandName} is available again from your wishlist`
          : `${productName} is available again from your wishlist`;
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
      formatter: (n: any) =>
        n.payload?.message || 'Your size fit share request was approved',
    });

    // SIZE_FIT_SHARE_REJECTED
    registry.register({
      type: NT_SIZE_FIT_SHARE_REJECTED,
      schema: Joi.object({
        message: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message || 'Your size fit share request was rejected',
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
        const primaryTag =
          typeof n.payload?.tag === 'string' ? n.payload.tag : tags[0];
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
        if (reason === 'EXPIRED')
          return `${name} is no longer featured — the 7-day period has ended.`;
        if (reason === 'BRAND_SUSPENDED')
          return `${name} was removed from featured due to account suspension.`;
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
      formatter: () =>
        'More information is needed to continue your verification review',
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
        const message =
          typeof n.payload?.message === 'string'
            ? n.payload.message.trim()
            : '';
        if (message) return message;
        return 'Complete verification to add a stronger trust signal to your store';
      },
    });

    registry.register({
      type: NT_VERIFICATION_SLA_WARNING,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        dueAt: Joi.string().optional(),
        slaDeadlineAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        'Your verification review is approaching its service deadline',
    });

    registry.register({
      type: NT_VERIFICATION_SLA_BREACH,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        breachedAt: Joi.string().optional(),
        slaDeadlineAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        'Your verification review has passed its service deadline',
    });

    registry.register({
      type: NT_VERIFICATION_REVIEW_DELAYED,
      schema: Joi.object({
        brandId: Joi.string().required(),
        brandName: Joi.string().optional(),
        reviewStartedAt: Joi.string().optional(),
        delayedAt: Joi.string().optional(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        'Your verification review is taking longer than expected',
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
        n.payload?.message ||
        `Payment received for ${formatCustomOrderCode(n.payload?.customOrderId)}`,
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
        `${formatCustomOrderCode(n.payload?.customOrderId)} moved to ${String(
          n.payload?.stage || 'a new stage',
        )
          .toLowerCase()
          .replace(/_/g, ' ')}`,
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
        n.payload?.message ||
        `${formatCustomOrderCode(n.payload?.customOrderId)} was marked as delivered`,
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
        `Almost there — confirm delivery or report an issue for ${formatCustomOrderCode(n.payload?.customOrderId)}.`,
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
        n.payload?.message ||
        `Heads up — an issue was reported on ${formatCustomOrderCode(n.payload?.customOrderId)}. Take a look when you can.`,
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
        n.payload?.message ||
        `A dispute was opened on ${formatCustomOrderCode(n.payload?.customOrderId)} — let's get it sorted.`,
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
        n.payload?.message ||
        `${formatCustomOrderCode(n.payload?.customOrderId)} hasn't moved in a while — a gentle nudge might help.`,
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) => {
        if (n.payload?.message) return n.payload.message;
        const code = formatCustomOrderCode(n.payload?.customOrderId);
        const detail = describeAdminReviewReason(n.payload?.reason);
        return detail
          ? `${code} needs a quick review — ${detail}. Tap to take a look and act.`
          : `${code} needs a quick review. Tap to open it and take action.`;
      },
    });

    registry.register({
      type: NT_CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
      schema: Joi.object({
        customOrderId: Joi.string().required(),
        targetUrl: Joi.string().optional(),
        message: Joi.string().optional(),
      }),
      formatter: (n: any) =>
        n.payload?.message ||
        `${formatCustomOrderCode(n.payload?.customOrderId)} is approaching an acceptance SLA breach`,
    });

    registry.register({
      type: NT_MESSAGE_RECEIVED,
      schema: Joi.object({
        ...messageRoutingPayloadShape,
        threadId: Joi.string().required(),
        messageId: Joi.string().required(),
      }),
      formatter: (n: any) =>
        n.payload?.message || 'You received a new message on an order thread',
    });

    registry.register({
      type: NT_MESSAGE_UNREAD_REMINDER,
      schema: Joi.object({
        ...messageRoutingPayloadShape,
        threadId: Joi.string().required(),
        messageId: optionalMessageRoutingString,
      }),
      formatter: (n: any) =>
        n.payload?.message || 'You have unread order messages waiting',
    });

    registry.register({
      type: NT_MESSAGE_THREAD_REOPENED,
      schema: Joi.object({
        ...messageRoutingPayloadShape,
        threadId: Joi.string().required(),
        messageId: optionalMessageRoutingString,
      }),
      formatter: (n: any) =>
        n.payload?.message || 'A thread has been reopened by support',
    });

    registry.register({
      type: NT_MESSAGE_MODERATED,
      schema: Joi.object({
        ...messageRoutingPayloadShape,
        threadId: Joi.string().required(),
        messageId: Joi.string().required(),
      }),
      formatter: (n: any) =>
        n.payload?.message || 'A message in your order thread was moderated',
    });

    [
      NotificationType.CONTENT_SUBMITTED_FOR_REVIEW,
      NotificationType.CONTENT_REVIEW_APPROVED,
      NotificationType.CONTENT_REVIEW_REJECTED,
      NotificationType.CONTENT_CHANGES_REQUESTED,
      NotificationType.CONTENT_RESUBMITTED,
      NotificationType.CONTENT_PUBLISHED,
      NotificationType.CONTENT_REVIEW_FAILED,
      NotificationType.CONTENT_PUBLISH_FAILED,
    ].forEach((type) => {
      registry.register({
        type,
        schema: Joi.object({
          submissionId: Joi.string().optional(),
          entityType: Joi.string().optional(),
          productId: Joi.string().optional(),
          collectionId: Joi.string().optional(),
          designId: Joi.string().optional(),
          reasonCode: Joi.string().optional().allow(null),
          message: Joi.string().optional(),
          title: Joi.string().optional().allow(null, ''),
          contentTitle: Joi.string().optional().allow(null, ''),
          targetUrl: Joi.string().optional(),
        }).unknown(true),
        formatter: (n: any) => {
          const detailed =
            typeof n.payload?.message === 'string' && n.payload.message.trim()
              ? n.payload.message.trim()
              : '';
          if (detailed) return detailed;
          const title =
            (typeof n.payload?.title === 'string' && n.payload.title.trim()) ||
            (typeof n.payload?.contentTitle === 'string' &&
              n.payload.contentTitle.trim()) ||
            '';
          if (title) {
            return `Content review update for "${title}"`;
          }
          return 'Content review status updated';
        },
      });
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
        operationalAlertId: Joi.string().optional(),
        alertSeverity: Joi.string().optional(),
        alertCategory: Joi.string().optional(),
        alertEvent: Joi.string().optional(),
        alertStatus: Joi.string().optional(),
        correlationId: Joi.string().optional(),
        entityType: Joi.string().optional(),
        entityId: Joi.string().optional(),
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

    const NT_EMAIL_CHANGE_REQUESTED =
      'ADMIN_EMAIL_CHANGE_REQUESTED' as NotificationType;
    registry.register({
      type: NT_EMAIL_CHANGE_REQUESTED,
      schema: Joi.object({
        requestId: Joi.string().required(),
        newEmail: Joi.string().required(),
      }),
      formatter: (n: any) =>
        `An admin has requested an email address change to ${n.payload?.newEmail ?? 'a new address'}`,
    });

    const NT_EMAIL_CHANGE_APPROVED =
      'ADMIN_EMAIL_CHANGE_APPROVED' as NotificationType;
    registry.register({
      type: NT_EMAIL_CHANGE_APPROVED,
      schema: Joi.object({
        newEmail: Joi.string().required(),
      }),
      formatter: (n: any) =>
        `Your email change request has been approved. Your new email is ${n.payload?.newEmail ?? 'updated'}.`,
    });

    const NT_EMAIL_CHANGE_REJECTED =
      'ADMIN_EMAIL_CHANGE_REJECTED' as NotificationType;
    registry.register({
      type: NT_EMAIL_CHANGE_REJECTED,
      schema: Joi.object({
        newEmail: Joi.string().required(),
        reason: Joi.string().optional().allow(''),
      }),
      formatter: (n: any) => {
        const base = `Your email change request to ${n.payload?.newEmail ?? 'the new address'} was not approved.`;
        return n.payload?.reason ? `${base} Reason: ${n.payload.reason}` : base;
      },
    });

    return registry;
  }
}
