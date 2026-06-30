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
};

const SECURITY_TYPES = new Set<string>([
  'LOGIN',
  'LOGOUT',
  'LOGOUT_ALL',
  'SIGNUP',
]);

/**
 * Resolve the OS channel + bold title for a notification type. The title is the
 * heading line; the descriptive body still comes from the registry formatter.
 */
export function getPushPresentation(type: NotificationType): PushPresentation {
  const value = String(type).toUpperCase();

  if (value.includes('MESSAGE')) {
    return { channelId: PUSH_CHANNEL_IDS.messages, title: 'New message' };
  }

  if (value.startsWith('ORDER_') || value.startsWith('CUSTOM_ORDER_')) {
    return { channelId: PUSH_CHANNEL_IDS.orders, title: 'Order update' };
  }

  if (value.startsWith('VERIFICATION_')) {
    return { channelId: PUSH_CHANNEL_IDS.system, title: 'Verification update' };
  }
  if (value.startsWith('SIZE_FIT_')) {
    return { channelId: PUSH_CHANNEL_IDS.system, title: 'Fit update' };
  }
  if (SECURITY_TYPES.has(value)) {
    return { channelId: PUSH_CHANNEL_IDS.system, title: 'Security alert' };
  }
  if (value === 'ADMIN_ACTION') {
    return { channelId: PUSH_CHANNEL_IDS.system, title: 'Account update' };
  }

  if (value === 'WISHLIST_PRODUCT_AVAILABLE') {
    return { channelId: PUSH_CHANNEL_IDS.commerce, title: 'Back in stock' };
  }
  if (value === 'WISHLIST_PRODUCT_UNAVAILABLE') {
    return { channelId: PUSH_CHANNEL_IDS.commerce, title: 'Wishlist update' };
  }
  if (value === 'PRODUCT_UPLOAD') {
    return { channelId: PUSH_CHANNEL_IDS.commerce, title: 'New drop' };
  }
  if (value === 'ITEM_FEATURED' || value === 'FEATURED_AUTO_REMOVED') {
    return { channelId: PUSH_CHANNEL_IDS.commerce, title: 'Featured' };
  }

  if (value === 'COMMENT' || value.includes('REPLY')) {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'New comment' };
  }
  if (value === 'FOLLOW') {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'New follower' };
  }
  if (value === 'TAG_MENTION') {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'New mention' };
  }
  if (value === 'PATCH' || value.startsWith('BRAND_PATCH_')) {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'Patch update' };
  }
  if (value.startsWith('REVIEW_')) {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'Review update' };
  }
  if (
    value.startsWith('COLLECTION') ||
    value.startsWith('PRIVATE_ACCESS_') ||
    value.startsWith('CONTRIBUTION')
  ) {
    return { channelId: PUSH_CHANNEL_IDS.social, title: 'Collection update' };
  }

  return { channelId: PUSH_CHANNEL_IDS.default, title: 'WIEZ' };
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
