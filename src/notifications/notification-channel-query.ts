import {
  NotificationChannelOutbox,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'crypto';

export type ClaimedNotificationChannels = NotificationChannelOutbox & {
  recipientId: string;
  actorId: string | null;
  notificationType: NotificationType;
  payload: Prisma.JsonValue | null;
};

export function claimNotificationChannels(
  tx: Prisma.TransactionClient,
  take: number,
  id?: string | string[],
): Promise<ClaimedNotificationChannels[]> {
  if (!Number.isInteger(take) || take < 1 || take > 10)
    throw new Error('Invalid notification channel claim batch');
  if (Array.isArray(id) && id.length > 25)
    throw new Error('Notification channel scope exceeds 25 identities');
  const owner = randomUUID(),
    scope = Array.isArray(id)
      ? id.length
        ? Prisma.sql`AND o."id" IN (${Prisma.join(id.map((value) => Prisma.sql`${value}::uuid`))})`
        : Prisma.sql`AND false`
      : id
        ? Prisma.sql`AND o."id"=${id}::uuid`
        : Prisma.empty;
  return tx.$queryRaw<ClaimedNotificationChannels[]>`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT o."id" FROM "NotificationChannelOutbox" o,clock
      WHERE o."attempts"<8 ${scope} AND (
        (o."status" IN ('PENDING','FAILED') AND o."availableAt"<=clock.now)
        OR (o."status"='PROCESSING' AND o."lockExpiresAt"<=clock.now)
      ) ORDER BY o."availableAt",o."createdAt",o."id" LIMIT ${take} FOR UPDATE OF o SKIP LOCKED
    ) UPDATE "NotificationChannelOutbox" o SET "status"='PROCESSING',"attempts"=o."attempts"+1,
      "lockedAt"=clock.now,"lockOwner"=${owner}::uuid,"lockExpiresAt"=clock.now+INTERVAL '60 seconds',
      "lastError"=NULL,"updatedAt"=clock.now
    FROM due JOIN "Notification" n ON n."_id"=due."id",clock
    WHERE o."id"=due."id" RETURNING o.*,n."recipientId",n."actorId",n."type" AS "notificationType",n."payload"
  `;
}

export function reapExhaustedNotificationChannels(
  tx: Prisma.TransactionClient,
) {
  return tx.$executeRaw`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT o."id" FROM "NotificationChannelOutbox" o,clock
      WHERE o."status"='PROCESSING' AND o."attempts">=8 AND o."lockExpiresAt"<=clock.now
      ORDER BY o."lockExpiresAt",o."id" LIMIT 100 FOR UPDATE OF o SKIP LOCKED
    ) UPDATE "NotificationChannelOutbox" o SET "status"='FAILED',
      "lastError"='DLQ_EXHAUSTED:notification channel lease expired',
      "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"updatedAt"=clock.now
    FROM due,clock WHERE o."id"=due."id"
  `;
}

/** Bounded indexed retention; active and retryable instructions are preserved. */
export function cleanupNotificationChannels(
  tx: Prisma.TransactionClient,
  take = 1000,
) {
  if (!Number.isInteger(take) || take < 1 || take > 10000)
    throw new Error('Invalid notification channel cleanup batch');
  return tx.$executeRaw`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), completed AS (
      SELECT o."id" FROM "NotificationChannelOutbox" o,clock
      WHERE o."status"='COMPLETED' AND o."updatedAt"<clock.now-INTERVAL '30 days'
      ORDER BY o."updatedAt",o."id" LIMIT ${take} FOR UPDATE OF o SKIP LOCKED
    ), exhausted AS (
      SELECT o."id" FROM "NotificationChannelOutbox" o,clock
      WHERE o."status"='FAILED' AND o."attempts">=8 AND o."lastError" LIKE 'DLQ_EXHAUSTED:%'
        AND o."updatedAt"<clock.now-INTERVAL '90 days'
      ORDER BY o."updatedAt",o."id" LIMIT ${take} FOR UPDATE OF o SKIP LOCKED
    ), due AS (SELECT "id" FROM completed UNION ALL SELECT "id" FROM exhausted)
    DELETE FROM "NotificationChannelOutbox" o USING due WHERE o."id"=due."id"
  `;
}
