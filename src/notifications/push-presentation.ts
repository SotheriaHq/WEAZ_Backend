import { NotificationType } from '@prisma/client';

/**
 * Canonical Android notification channel ids. MUST stay in lock-step with the
 * mobile client's `src/notifications/pushChannels.ts PUSH_CHANNEL_IDS`, or
 * Android will silently drop messages onto the default channel.
 */
export const PUSH_CHANNEL_IDS = {
  default: 'default',
  messages: 'messages',
  orders: 'orders',
  social: 'social',
  commerce: 'commerce',
  system: 'system',
} as const;

export type PushChannelId = (typeof PUSH_CHANNEL_IDS)[keyof typeof PUSH_CHANNEL_IDS];

export type PushPresentation = {
  channelId: PushChannelId;
  title: string;
  /**
   * The body when the user has turned message previews off. It says what KIND
   * of thing happened — never the content — so a lock screen stays private and
   * the push is still worth reading. There is no single generic line any more:
   * "Something new for you on WIEZ" told nobody anything (SIT, Nov 2026).
   */
  hiddenBody: string;
  /** True only for the last-resort branch; a spec keeps every type off it. */
  isFallback?: boolean;
};

const SECURITY_TYPES = new Set<string>([
  'LOGIN',
  'LOGOUT',
  'LOGOUT_ALL',
  'SIGNUP',
]);

const CONTENT_REVIEW_PRESENTATION: Record<
  string,
  { title: string; hiddenBody: string }
> = {
  CONTENT_SUBMITTED_FOR_REVIEW: {
    title: 'Sent for review 📝',
    hiddenBody: 'Wiez 👋 Your upload is in review. We’ll tell you when it’s live.',
  },
  CONTENT_RESUBMITTED: {
    title: 'Back in review 📝',
    hiddenBody: 'Wiez 👋 Your update is back in review.',
  },
  CONTENT_CHANGES_REQUESTED: {
    title: 'Changes requested ✏️',
    hiddenBody: 'Wiez 👋 A few changes were requested on one of your uploads.',
  },
  CONTENT_REVIEW_APPROVED: {
    title: 'Approved 🎉',
    hiddenBody: 'Wiez 👋 One of your uploads was approved.',
  },
  CONTENT_PUBLISHED: {
    title: 'Live now 🎉',
    hiddenBody: 'Wiez 👋 One of your uploads is live.',
  },
  CONTENT_REVIEW_REJECTED: {
    title: 'Not approved this time',
    hiddenBody: 'Wiez 👋 One of your uploads needs another look.',
  },
  CONTENT_REVIEW_FAILED: {
    title: 'Needs a retry',
    hiddenBody: 'Wiez 👋 We couldn’t finish checking one of your uploads.',
  },
  CONTENT_PUBLISH_FAILED: {
    title: 'Needs a retry',
    hiddenBody: 'Wiez 👋 We couldn’t finish publishing one of your uploads.',
  },
};

/**
 * Resolve the OS channel, the bold title and the preview-off body for a
 * notification type. With previews on, the descriptive body comes from the
 * registry formatter (or its `pushFormatter`).
 */
export function getPushPresentation(type: NotificationType): PushPresentation {
  const value = String(type).toUpperCase();

  const contentReview = CONTENT_REVIEW_PRESENTATION[value];
  if (contentReview) {
    return { channelId: PUSH_CHANNEL_IDS.system, ...contentReview };
  }

  if (value.includes('MESSAGE')) {
    return {
      channelId: PUSH_CHANNEL_IDS.messages,
      title: 'New message 💬',
      hiddenBody: 'Wiez 👋 You have a new message.',
    };
  }

  if (value.startsWith('ORDER_') || value.startsWith('CUSTOM_ORDER_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.orders,
      title: 'Order update 📦',
      hiddenBody: 'Wiez 👋 There’s an update on one of your orders.',
    };
  }

  if (value.startsWith('VERIFICATION_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Verification update ✅',
      hiddenBody: 'Wiez 👋 There’s news on your brand verification.',
    };
  }
  if (value.startsWith('SIZE_FIT_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Fit update 📐',
      hiddenBody: 'Wiez 👋 There’s an update on your fit profile.',
    };
  }
  if (SECURITY_TYPES.has(value)) {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Security alert 🔐',
      hiddenBody: 'Wiez 👋 There was sign-in activity on your account.',
    };
  }
  if (value === 'ADMIN_ACTION') {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Account update',
      hiddenBody: 'Wiez 👋 There’s an update on your account.',
    };
  }
  if (value.startsWith('ADMIN_EMAIL_CHANGE_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Email change ✉️',
      hiddenBody: 'Wiez 👋 There’s an update on your email change request.',
    };
  }
  if (value.startsWith('BRAND_BALANCE_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.system,
      title: 'Balance update 💳',
      hiddenBody: 'Wiez 👋 Your brand balance changed.',
    };
  }

  if (value === 'WISHLIST_PRODUCT_AVAILABLE') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'Back in stock 🎉',
      hiddenBody: 'Wiez 👋 Something on your wishlist is back.',
    };
  }
  if (value === 'WISHLIST_PRODUCT_UNAVAILABLE') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'Wishlist update',
      hiddenBody: 'Wiez 👋 Something on your wishlist changed.',
    };
  }
  if (value === 'BAG_ITEM_ADDED') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'In your bag 🛍️',
      hiddenBody: 'Wiez 👋 Your bag was updated.',
    };
  }
  if (value === 'BAG_CHECKOUT_REMINDER') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'Your bag misses you 🛍️',
      hiddenBody: 'Wiez 👋 Your bag is still waiting for you.',
    };
  }
  if (value === 'PRODUCT_UPLOAD') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'New drop 🔥',
      hiddenBody: 'Wiez 👋 A brand you follow just dropped a new piece.',
    };
  }
  if (value === 'ITEM_FEATURED' || value === 'FEATURED_AUTO_REMOVED') {
    return {
      channelId: PUSH_CHANNEL_IDS.commerce,
      title: 'Featured ⭐',
      hiddenBody: 'Wiez 👋 There’s news about a featured spot.',
    };
  }

  if (value === 'THREAD') {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'New thread 🧵',
      hiddenBody: 'Wiez 👋 Someone threaded your work.',
    };
  }
  if (value === 'COMMENT' || value.includes('REPLY')) {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'New comment 💬',
      hiddenBody: 'Wiez 👋 You have a new comment.',
    };
  }
  if (value === 'FOLLOW') {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'New follower 🎉',
      hiddenBody: 'Wiez 👋 You have a new follower.',
    };
  }
  if (value === 'TAG_MENTION') {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'You got a mention 👋',
      hiddenBody: 'Wiez 👋 Someone mentioned you.',
    };
  }
  if (value === 'PATCH' || value.startsWith('BRAND_PATCH_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'Patch update 🧵',
      hiddenBody: 'Wiez 👋 There’s a new patch update.',
    };
  }
  if (value.startsWith('REVIEW_')) {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'Review update ⭐',
      hiddenBody: 'Wiez 👋 There’s an update on a review.',
    };
  }
  if (
    value.startsWith('COLLECTION') ||
    value.startsWith('PRIVATE_ACCESS_') ||
    value.startsWith('CONTRIBUTION')
  ) {
    return {
      channelId: PUSH_CHANNEL_IDS.social,
      title: 'Collection update 🧵',
      hiddenBody: 'Wiez 👋 There’s an update on a collection.',
    };
  }

  // Last resort for a type added without copy. push-presentation.spec fails
  // when any existing type lands here, so this is never what users see.
  return {
    channelId: PUSH_CHANNEL_IDS.default,
    title: 'WIEZ',
    hiddenBody: 'Wiez 👋 You have an update waiting in WIEZ.',
    isFallback: true,
  };
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : null;
}

/**
 * Stable per-entity grouping key so repeated notifications about the same
 * thread / order / entity collapse instead of stacking on the device.
 */
export function getPushCollapseId(
  type: NotificationType,
  payload: Record<string, any> | null,
  target: { id?: string | null } | null,
): string | undefined {
  const value = String(type).toUpperCase();

  if (value.includes('MESSAGE')) {
    const threadId =
      readString(payload?.threadId) ?? readString(payload?.conversationId);
    if (threadId) return `message:${threadId}`;
  }

  if (value.startsWith('ORDER_') || value.startsWith('CUSTOM_ORDER_')) {
    const orderId =
      readString(payload?.orderId) ?? readString(payload?.customOrderId);
    if (orderId) return `order:${orderId}`;
  }

  const targetId = readString(target?.id ?? null);
  if (targetId) return `target:${value}:${targetId}`;

  return undefined;
}
