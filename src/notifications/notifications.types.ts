export type TargetType =
  | 'DESIGN'
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
    logout: boolean;
  };
  push: {
    enabled: boolean;
    sound: boolean;
    vibration: boolean;
    showPreview: boolean;
    quietHoursEnabled: boolean;
    quietHoursStart: string | null;
    quietHoursEnd: string | null;
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
    verificationPrompts: boolean;
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

export type NotificationSettingsPatch = {
  [K in keyof NotificationSettings]?: Partial<NotificationSettings[K]>;
};

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  security: {
    login: false,
    logout: false,
  },
  push: {
    enabled: true,
    sound: true,
    vibration: true,
    showPreview: true,
    quietHoursEnabled: false,
    quietHoursStart: null,
    quietHoursEnd: null,
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
    verificationPrompts: true,
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
