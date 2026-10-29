import { Notification, NotificationType, Prisma } from '@prisma/client';

/** The caller must run both statements in one READ COMMITTED transaction. */
export async function loadCurrentNotificationDuplicates(
  tx: Prisma.TransactionClient,
  args: {
    recipientId: string;
    type: NotificationType;
    actorId: string | null;
    windowMs: number;
    explicitTargetId?: string;
  },
) {
  // A null actor matches every actor in the existing policy, so actor-specific
  // locks would not serialize all competing commands in the same dedupe scope.
  await tx.$executeRaw(Prisma.sql`
    /* notification-semantic-lock */
    SELECT pg_advisory_xact_lock(hashtextextended(${`notification-dedupe:${args.recipientId.toLowerCase()}:${args.type}`}, 0))
  `);
  // A separate statement is essential: a snapshot taken before a lock wait
  // cannot see the notification committed by the previous lock owner.
  const rows = await tx.$queryRaw<
    Array<
      Notification & { observedAt: Date; kind: 'SEMANTIC' | 'TARGET' | null }
    >
  >(Prisma.sql`
    /* notification-semantic-current */
    WITH moment AS MATERIALIZED (SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now)
    SELECT moment.now AS "observedAt", n."_id" AS id, n."recipientId", n."actorId",
      n.type, n.payload, n.html, n."isRead", n."createdAt", n.kind
    FROM moment LEFT JOIN LATERAL (
      (SELECT candidate.*, 'SEMANTIC' AS kind FROM "Notification" candidate
        WHERE candidate."recipientId" = ${args.recipientId}::uuid
          AND candidate.type = ${args.type}::"NotificationType"
          AND (${args.actorId}::uuid IS NULL OR candidate."actorId" = ${args.actorId}::uuid)
          AND candidate."createdAt" >= moment.now - ${args.windowMs} * INTERVAL '1 millisecond'
        ORDER BY candidate."createdAt" DESC, candidate."_id" DESC LIMIT 25)
      UNION ALL
      (SELECT candidate.*, 'TARGET' AS kind FROM "Notification" candidate
        WHERE ${args.explicitTargetId !== undefined}
          AND candidate."recipientId" = ${args.recipientId}::uuid
          AND candidate.type = ${args.type}::"NotificationType"
          AND (${args.actorId}::uuid IS NULL OR candidate."actorId" = ${args.actorId}::uuid)
          AND candidate."createdAt" >= moment.now - ${args.windowMs} * INTERVAL '1 millisecond'
          AND candidate.payload #>> '{target,id}' = ${args.explicitTargetId ?? null}
        ORDER BY candidate."createdAt" DESC, candidate."_id" DESC LIMIT 1)
    ) n ON TRUE
  `);
  const notification = (row: (typeof rows)[number]): Notification => {
    return {
      id: row.id,
      recipientId: row.recipientId,
      actorId: row.actorId,
      type: row.type,
      payload: row.payload,
      html: row.html,
      isRead: row.isRead,
      createdAt: row.createdAt,
    };
  };
  const target = rows.find((row) => row.id && row.kind === 'TARGET');
  return {
    observedAt: rows[0].observedAt,
    candidates: rows
      .filter((row) => row.id && row.kind === 'SEMANTIC')
      .map(notification),
    targetDuplicate: target ? notification(target) : undefined,
  };
}
