export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

export type AlertCategory =
  | 'AUTH'
  | 'PAYMENT'
  | 'WEBHOOK'
  | 'UPLOAD'
  | 'ADMIN'
  | 'RANKING'
  | 'QUEUE'
  | 'MIGRATION'
  | 'SECURITY'
  | 'SYSTEM';

export interface OperationalAlert {
  category: AlertCategory;
  severity: AlertSeverity;
  event: string;
  message: string;
  title?: string | null;
  correlationId?: string | null;
  userId?: string | null;
  actorId?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  dedupeKey?: string | null;
  metadata?: Record<string, unknown>;
}

export type SanitizedOperationalAlert = Omit<OperationalAlert, 'metadata'> & {
  emittedAt: string;
  metadata?: Record<string, unknown>;
};
