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
