import { CustomOrderNotificationOutbox, Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';

export const CUSTOM_ORDER_OUTBOX_MAX_ATTEMPTS = 8;
export const CUSTOM_ORDER_OUTBOX_LEASE_MS = 60_000;

/** Claim only the immediately processed bounded group, using database UTC time. */
export function claimCustomOrderOutbox(
  tx: Pick<Prisma.TransactionClient, '$queryRaw'>,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error('Invalid outbox claim size');
  const owner = randomUUID();
  return tx.$queryRaw<CustomOrderNotificationOutbox[]>(Prisma.sql`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now),
    candidates AS (
      SELECT event.id FROM "CustomOrderNotificationOutbox" event CROSS JOIN moment
      WHERE event.attempts < ${CUSTOM_ORDER_OUTBOX_MAX_ATTEMPTS}
        AND ((event.status IN ('PENDING', 'FAILED') AND event."availableAt" <= moment.now)
          OR (event.status = 'PROCESSING' AND event."lockExpiresAt" <= moment.now))
      ORDER BY event."availableAt", event."createdAt", event.id
      LIMIT ${limit} FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE "CustomOrderNotificationOutbox" event SET status = 'PROCESSING', attempts = event.attempts + 1,
      "lockedAt" = moment.now, "lockOwner" = ${owner} || ':' || event.id::text,
      "lockExpiresAt" = moment.now + (${CUSTOM_ORDER_OUTBOX_LEASE_MS}::int * INTERVAL '1 millisecond'),
      "updatedAt" = moment.now, "lastError" = NULL
    FROM candidates, moment WHERE event.id = candidates.id RETURNING event.*
  `);
}

/** Bounded dead-letter transition for a worker that died on its final attempt. */
export function reapExhaustedCustomOrderOutbox(
  tx: Pick<Prisma.TransactionClient, '$executeRaw'>,
  limit: number,
) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200)
    throw new Error('Invalid outbox reap size');
  return tx.$executeRaw(Prisma.sql`
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now),
    stale AS (
      SELECT event.id FROM "CustomOrderNotificationOutbox" event CROSS JOIN moment
      WHERE event.status = 'PROCESSING' AND event.attempts >= ${CUSTOM_ORDER_OUTBOX_MAX_ATTEMPTS}
        AND event."lockExpiresAt" <= moment.now
      ORDER BY event."lockExpiresAt", event.id LIMIT ${limit} FOR UPDATE OF event SKIP LOCKED
    )
    UPDATE "CustomOrderNotificationOutbox" event SET status = 'FAILED', "lockOwner" = NULL,
      "lockExpiresAt" = NULL, "lastError" = 'DLQ_EXHAUSTED:claim expired before acknowledgement', "updatedAt" = moment.now
    FROM stale, moment WHERE event.id = stale.id
  `);
}
