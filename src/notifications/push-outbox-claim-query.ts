import { Prisma, PushDeviceToken, PushOutbox } from '@prisma/client';
import { randomUUID } from 'crypto';

export type PendingPushToken = Pick<
  PushDeviceToken,
  'id' | 'token' | 'userId' | 'provider' | 'isActive' | 'registrationVersion'
>;

export async function claimPushOutbox(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<PushOutbox | null> {
  const token = randomUUID();
  const rows = await tx.$queryRaw<PushOutbox[]>`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT p."id" FROM "PushOutbox" p, clock
      WHERE p."id"=${id}::uuid AND p."attempts"<6
        AND (
          (p."status" IN ('PENDING','FAILED') AND p."availableAt"<=clock.now)
          OR (p."status"='PROCESSING' AND p."lockExpiresAt"<=clock.now)
        )
      FOR UPDATE OF p SKIP LOCKED
    )
    UPDATE "PushOutbox" p SET "status"='PROCESSING',"attempts"=p."attempts"+1,
      "lockedAt"=clock.now,"lockOwner"=${token},
      "lockExpiresAt"=clock.now+INTERVAL '60 seconds',
      "lastError"=NULL,"updatedAt"=clock.now
    FROM due, clock WHERE p."id"=due."id" RETURNING p.*
  `;
  return rows[0] ?? null;
}

export async function reapExhaustedPushOutbox(tx: Prisma.TransactionClient) {
  return tx.$executeRaw`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT p."id" FROM "PushOutbox" p, clock
      WHERE p."status"='PROCESSING' AND p."attempts">=6
        AND p."lockExpiresAt"<=clock.now
      ORDER BY p."lockExpiresAt",p."id" LIMIT 100 FOR UPDATE OF p SKIP LOCKED
    )
    UPDATE "PushOutbox" p SET "status"='FAILED',
      "lastError"='DLQ_EXHAUSTED:worker lease expired',
      "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"updatedAt"=clock.now
    FROM due, clock WHERE p."id"=due."id"
  `;
}

/** Accepted tickets survive retries; only active devices without an accepted ticket need another send. */
export function loadPendingPushTokens(
  tx: Prisma.TransactionClient,
  outbox: Pick<PushOutbox, 'id' | 'recipientId'>,
): Promise<PendingPushToken[]> {
  return tx.$queryRaw<PendingPushToken[]>`
    SELECT t."id",t."token",t."userId",t."provider",t."isActive",t."registrationVersion"
    FROM "PushDeviceToken" t
    WHERE t."userId"=${outbox.recipientId}::uuid AND t."isActive" AND t."provider"='EXPO'
      AND NOT EXISTS (
        SELECT 1 FROM "PushDeliveryReceipt" r
        WHERE r."pushOutboxId"=${outbox.id}::uuid AND r."tokenId"=t."id"
          AND r."ticketId" IS NOT NULL AND r."status" IN ('PENDING','OK')
      )
    ORDER BY t."id"
  `;
}
