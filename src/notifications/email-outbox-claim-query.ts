import { EmailOutbox, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';

export const EMAIL_OUTBOX_MAX_ATTEMPTS = 8;

/** Re-check current eligibility and return current content/attempt after obtaining ownership. */
export async function claimEmailOutbox(
  tx: Prisma.TransactionClient,
  id: string,
): Promise<EmailOutbox | null> {
  const token = randomUUID();
  const rows = await tx.$queryRaw<EmailOutbox[]>`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT e."id" FROM "EmailOutbox" e, clock
      WHERE e."id"=${id}::uuid AND e."attempts"<${EMAIL_OUTBOX_MAX_ATTEMPTS}
        AND (
          (e."status" IN ('PENDING','FAILED') AND e."availableAt"<=clock.now)
          OR (e."status"='PROCESSING' AND e."lockExpiresAt"<=clock.now)
          OR (e."status"='FAILED'
            AND e."scenarioKey" IN ('auth.password_reset','auth.admin_password_reset')
            AND e."lastError" ILIKE '%timeout%')
        )
      FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE "EmailOutbox" e SET "status"='PROCESSING',"attempts"=e."attempts"+1,
      "lockedAt"=clock.now,"lockOwner"=${token},
      "lockExpiresAt"=clock.now+INTERVAL '60 seconds',
      "lastError"=NULL,"updatedAt"=clock.now
    FROM due, clock WHERE e."id"=due."id" RETURNING e.*
  `;
  return rows[0] ?? null;
}

/** A crash on the last allowed attempt must not leave a permanent PROCESSING row. */
export async function reapExhaustedEmailOutbox(tx: Prisma.TransactionClient) {
  return tx.$executeRaw`
    WITH clock AS (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now), due AS (
      SELECT e."id" FROM "EmailOutbox" e, clock
      WHERE e."status"='PROCESSING' AND e."attempts">=${EMAIL_OUTBOX_MAX_ATTEMPTS}
        AND e."lockExpiresAt"<=clock.now
      ORDER BY e."lockExpiresAt",e."id" LIMIT 150 FOR UPDATE OF e SKIP LOCKED
    )
    UPDATE "EmailOutbox" e SET "status"='FAILED',
      "lastError"='DLQ_EXHAUSTED:worker lease expired',
      "lockedAt"=NULL,"lockOwner"=NULL,"lockExpiresAt"=NULL,"updatedAt"=clock.now
    FROM due, clock WHERE e."id"=due."id"
  `;
}

export function finishEmailOutboxClaim(
  prisma: PrismaService,
  row: Pick<EmailOutbox, 'id' | 'lockOwner'>,
  data: Prisma.EmailOutboxUpdateManyMutationInput,
  attempt: Prisma.EmailDeliveryAttemptUncheckedCreateInput,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.emailOutbox.updateMany({
      where: { id: row.id, status: 'PROCESSING', lockOwner: row.lockOwner },
      data: { ...data, lockedAt: null, lockOwner: null, lockExpiresAt: null },
    });
    if (!updated.count) return false;
    await tx.emailDeliveryAttempt.create({ data: attempt });
    return true;
  });
}

export function emailOutboxBackoffSeconds(
  scenario: string,
  attempt: number,
): number {
  const reset =
    scenario === 'auth.password_reset' ||
    scenario === 'auth.admin_password_reset';
  return Math.min(reset ? 300 : 3600, Math.pow(2, attempt) * 15);
}

export async function withEmailDeliveryTimeout<T>(
  operation: Promise<T>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Email provider timeout')),
          30_000,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
