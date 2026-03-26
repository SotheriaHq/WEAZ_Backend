export type TargetType =
  | 'POST'
  | 'COLLECTION'
  | 'COLLECTION_MEDIA'
  | 'PRODUCT'
  | 'USER'
  | 'SYSTEM';

export type NotificationTarget = {
  type: TargetType;
  id: string;
  preview?: string;
};

export interface CreateNotificationOptions {
  actorId?: string | null;
  target?: NotificationTarget | null;
  payload?: Record<string, any> | null;
  // Optional dedupe window in ms. If provided, will skip creating a new
  // notification if one with the same (recipientId, type, actorId, target)
  // exists within the given timeframe.
  dedupeMs?: number;
}

export interface NotificationSettings {
  security: {
    login: boolean;
  };
  social: {
    threads: boolean;
    follows: boolean;
    patches: boolean;
  };
  comments: {
    enabled: boolean;
    replies: boolean;
    fromUnpatchedUsers: boolean;
  };
  tags: {
    mentions: boolean;
    fromUnpatchedUsers: boolean;
  };
  collections: {
    lifecycle: boolean;
    access: boolean;
  };
  brand: {
    patchRequests: boolean;
    contributions: boolean;
  };
  orders: {
    placed: boolean;
    statusChanges: boolean;
  };
  reviews: {
    reminders: boolean;
    replies: boolean;
    moderation: boolean;
  };
  fit: {
    reminders: boolean;
    shares: boolean;
    approvals: boolean;
  };
  messaging: {
    newMessages: boolean;
    reminders: boolean;
    moderation: boolean;
    desktop: boolean;
    sound: boolean;
    readReceipts: boolean;
    deliveryReceipts: boolean;
  };
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  security: {
    login: true,
  },
  social: {
    threads: true,
    follows: true,
    patches: true,
  },
  comments: {
    enabled: true,
    replies: true,
    fromUnpatchedUsers: true,
  },
  tags: {
    mentions: true,
    fromUnpatchedUsers: true,
  },
  collections: {
    lifecycle: true,
    access: true,
  },
  brand: {
    patchRequests: true,
    contributions: true,
  },
  orders: {
    placed: true,
    statusChanges: true,
  },
  reviews: {
    reminders: true,
    replies: true,
    moderation: true,
  },
  fit: {
    reminders: true,
    shares: true,
    approvals: true,
  },
  messaging: {
    newMessages: true,
    reminders: true,
    moderation: true,
    desktop: true,
    sound: false,
    readReceipts: true,
    deliveryReceipts: true,
  },
};
