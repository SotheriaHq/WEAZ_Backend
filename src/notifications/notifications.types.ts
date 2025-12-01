export type TargetType =
  | 'POST'
  | 'COLLECTION'
  | 'COLLECTION_MEDIA'
  | 'USER'
  | 'SYSTEM';

export interface CreateNotificationOptions {
  actorId?: string | null;
  target?: { type: TargetType; id: string } | null;
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
  engagement: {
    likes: boolean;
    comments: boolean;
    follows: boolean;
  };
  brand: {
    patchRequests: boolean;
    contributions: boolean;
  };
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  security: {
    login: true,
  },
  engagement: {
    likes: true,
    comments: true,
    follows: true,
  },
  brand: {
    patchRequests: true,
    contributions: true,
  },
};
