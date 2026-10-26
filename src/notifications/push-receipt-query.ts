import { Prisma } from '@prisma/client';

/** Only the first pending-receipt resolution can change its matching token registration. */
export async function applyPushReceipt(
  tx: Prisma.TransactionClient,
  receipt: {
    id: string;
    ticketId: string;
    status: 'OK' | 'ERROR';
    errorCode?: string;
    errorMessage?: string;
  },
) {
  const rows = await tx.$queryRaw<
    Array<{ resolved: bigint; deactivated: bigint }>
  >`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), resolved AS (
      UPDATE "PushDeliveryReceipt" r SET "status"=${receipt.status}::"PushReceiptStatus",
        "errorCode"=${receipt.errorCode ?? null}::text,
        "errorMessage"=${receipt.errorMessage ?? null}::text,
        "checkedAt"=clock.now,"updatedAt"=clock.now
      FROM clock WHERE r."id"=${receipt.id}::uuid AND r."ticketId"=${receipt.ticketId}
        AND r."status"='PENDING'
      RETURNING r."tokenId",r."tokenRegistrationVersion",r."pushOutboxId",r."errorCode"
    ), disabled AS (
      UPDATE "PushDeviceToken" t SET "isActive"=false,
        "lastFailureAt"=clock.now,"failureCount"=t."failureCount"+1,
        "disabledReason"='DEVICE_NOT_REGISTERED',"updatedAt"=clock.now
      FROM resolved r JOIN "PushOutbox" p ON p."id"=r."pushOutboxId", clock
      WHERE r."errorCode"='DeviceNotRegistered' AND t."id"=r."tokenId"
        AND t."userId"=p."recipientId" AND t."isActive"
        AND t."registrationVersion"=r."tokenRegistrationVersion"
      RETURNING t."id"
    ) SELECT (SELECT count(*) FROM resolved) AS resolved,
        (SELECT count(*) FROM disabled) AS deactivated
  `;
  return {
    resolved: Number(rows[0]?.resolved ?? 0),
    deactivated: Number(rows[0]?.deactivated ?? 0),
  };
}

/** Claim completion against current state; a stale scan cannot finish an active retry. */
export function completeResolvedPushOutbox(tx: Prisma.TransactionClient) {
  return tx.$executeRaw`
    WITH due AS (
      SELECT p."id" FROM "PushOutbox" p
      WHERE p."status"='SENT' AND NOT EXISTS (
        SELECT 1 FROM "PushDeliveryReceipt" r WHERE r."pushOutboxId"=p."id" AND r."status"='PENDING'
      ) ORDER BY p."sentAt",p."id" LIMIT 500 FOR UPDATE OF p SKIP LOCKED
    ) UPDATE "PushOutbox" p SET "status"='COMPLETED',"updatedAt"=clock_timestamp() AT TIME ZONE 'UTC'
    FROM due WHERE p."id"=due."id" AND p."status"='SENT'
  `;
}

/** Expo receipts have a finite polling window; preserve an explicit unknown-delivery error. */
export function expireOldPushReceipts(
  tx: Prisma.TransactionClient,
  take: number,
) {
  if (!Number.isInteger(take) || take < 1 || take > 500)
    throw new Error('Invalid push receipt expiry batch');
  return tx.$executeRaw`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT r."id" FROM "PushDeliveryReceipt" r, clock
      WHERE r."status"='PENDING' AND r."createdAt"<clock.now-INTERVAL '23 hours'
      ORDER BY r."createdAt",r."id" LIMIT ${take} FOR UPDATE OF r SKIP LOCKED
    ) UPDATE "PushDeliveryReceipt" r SET "status"='ERROR',"errorCode"='ReceiptExpired',
      "errorMessage"='Delivery outcome unavailable after the receipt polling window',
      "checkedAt"=clock.now,"updatedAt"=clock.now
    FROM due, clock WHERE r."id"=due."id" AND r."status"='PENDING'
  `;
}
