import { Notification, NotificationType, Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { CreateNotificationOptions } from './notifications.types';

export type NotificationBatchPolicy = {
  notificationSettings: Prisma.JsonValue | null;
  email: string | null;
  globalEnabled: boolean | null;
  securityCriticalEnabled: boolean | null;
  scenarios: Record<string, boolean>;
  suppressed: boolean;
  patched: boolean;
  candidates: Notification[];
  targetDuplicate?: Notification;
};
type PolicyRow = Omit<
  NotificationBatchPolicy,
  'suppressed' | 'patched' | 'candidates' | 'targetDuplicate'
> & { id: string };

export interface NotificationEvent {
  recipientId: string;
  type: NotificationType;
  opts?: CreateNotificationOptions;
}

/** Different payloads/types/actors still share policy reads; each event keeps its own dedupe scope. */
export async function loadNotificationEventPolicies(
  prisma: Prisma.TransactionClient,
  events: NotificationEvent[],
) {
  if (events.length > 25)
    throw new Error('Notification event batch exceeds 25 events');
  if (!events.length) return new Map<number, NotificationBatchPolicy>();
  const base = await loadNotificationBatchPolicy(
    prisma,
    [...new Set(events.map((event) => event.recipientId))],
    NotificationType.THREAD,
    {
      dedupeMs: 0,
      suppressEmail: events.every((event) => event.opts?.suppressEmail),
    },
  );
  const policies = new Map<number, NotificationBatchPolicy>();
  events.forEach((event, index) => {
    const policy = base.get(event.recipientId);
    if (policy)
      policies.set(index, { ...policy, candidates: [], patched: false });
  });
  const now = Date.now();
  const values = Prisma.join(
    events.map((event, index) => {
      const ms = Math.max(event.opts?.dedupeMs ?? 45_000, 0);
      return Prisma.sql`(${index}::int, ${event.recipientId}::uuid, ${event.type}::"NotificationType", ${event.opts?.actorId ?? null}::uuid,
      ${new Date(now - ms)}::timestamp, ${ms > 0 && !event.opts?.notificationId}::boolean, ${Boolean(event.opts?.dedupeMs && event.opts?.target)}::boolean, ${event.opts?.target?.id ?? null}::text)`;
    }),
  );
  if (
    events.some(
      (event) =>
        event.opts?.actorId && ['TAG_MENTION', 'COMMENT'].includes(event.type),
    )
  ) {
    const connections = await prisma.$queryRaw<
      Array<{ index: number }>
    >(Prisma.sql`
      WITH events(idx, recipient, type, actor, since, dedupe, target_lookup, target) AS (VALUES ${values})
      SELECT e.idx AS index FROM events e WHERE e.type IN ('TAG_MENTION', 'COMMENT') AND e.actor IS NOT NULL
        AND EXISTS (SELECT 1 FROM "PatchConnection" p WHERE p.status = 'ACCEPTED' AND
          ((p."requesterId" = e.actor AND p."targetId" = e.recipient) OR (p."requesterId" = e.recipient AND p."targetId" = e.actor)))
    `);
    for (const row of connections) {
      const policy = policies.get(row.index);
      if (policy) policy.patched = true;
    }
  }
  if (
    events.some(
      (event) =>
        (event.opts?.dedupeMs ?? 45_000) > 0 && !event.opts?.notificationId,
    )
  ) {
    const candidates = await prisma.$queryRaw<
      Array<{
        index: number;
        kind: string;
        notification: Omit<Notification, 'createdAt'> & { createdAt: string };
      }>
    >(Prisma.sql`
      WITH events(idx, recipient, type, actor, since, dedupe, target_lookup, target) AS (VALUES ${values})
      SELECT e.idx AS index, d.kind, (to_jsonb(d) - 'kind' - '_id') || jsonb_build_object('id', d."_id", 'createdAt', d."createdAt" AT TIME ZONE 'UTC') AS notification
      FROM events e CROSS JOIN LATERAL (
        (SELECT n.*, 'SEMANTIC' AS kind FROM "Notification" n WHERE e.dedupe AND n."recipientId" = e.recipient AND n.type = e.type
          AND (e.actor IS NULL OR n."actorId" = e.actor) AND n."createdAt" >= e.since ORDER BY n."createdAt" DESC LIMIT 25)
        UNION ALL
        (SELECT n.*, 'TARGET' AS kind FROM "Notification" n WHERE e.dedupe AND e.target_lookup AND n."recipientId" = e.recipient AND n.type = e.type
          AND (e.actor IS NULL OR n."actorId" = e.actor) AND n."createdAt" >= e.since AND n.payload #>> '{target,id}' = e.target LIMIT 1)
      ) d ORDER BY e.idx, d.kind, d."createdAt" DESC
    `);
    for (const row of candidates) {
      const policy = policies.get(row.index);
      if (!policy) continue;
      const notification = {
        ...row.notification,
        createdAt: new Date(row.notification.createdAt),
      } as Notification;
      if (row.kind === 'TARGET') policy.targetDuplicate = notification;
      else policy.candidates.push(notification);
    }
  }
  return policies;
}

/** Operation-local data only; never cache consent across requests/jobs. */
export async function loadNotificationBatchPolicy(
  prisma: Prisma.TransactionClient,
  recipientIds: string[],
  type: NotificationType,
  opts?: CreateNotificationOptions,
) {
  if (!recipientIds.length) return new Map<string, NotificationBatchPolicy>();
  if (recipientIds.length > 25)
    throw new Error('Notification policy batch exceeds 25 recipients');
  const rows = await prisma.$queryRaw<PolicyRow[]>(Prisma.sql`
    SELECT u."_id" AS id, u.email, u."notificationSettings",
      p."globalEnabled", p."securityCriticalEnabled", COALESCE(s.scenarios, '{}'::jsonb) AS scenarios
    FROM "User" u LEFT JOIN "UserEmailPreference" p ON p."userId" = u."_id"
    LEFT JOIN LATERAL (
      SELECT jsonb_object_agg("scenarioKey", enabled) AS scenarios
      FROM "UserEmailScenarioPreference" WHERE "userId" = u."_id"
    ) s ON TRUE
    WHERE u."_id" IN (${Prisma.join(recipientIds.map((id) => Prisma.sql`${id}::uuid`))})
  `);
  const policy = new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        suppressed: false,
        patched: false,
        candidates: [],
      } as NotificationBatchPolicy,
    ]),
  );
  const hashes = [
    ...new Set(
      rows
        .filter((row) => row.email)
        .map((row) =>
          createHash('sha256')
            .update(row.email!.trim().toLowerCase())
            .digest('hex'),
        ),
    ),
  ];
  if (!opts?.suppressEmail && hashes.length) {
    const suppressed = await prisma.emailSuppression.findMany({
      where: {
        recipientEmailHash: { in: hashes },
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { recipientEmailHash: true },
    });
    const blocked = new Set(suppressed.map((row) => row.recipientEmailHash));
    for (const row of rows)
      if (row.email)
        policy.get(row.id)!.suppressed = blocked.has(
          createHash('sha256')
            .update(row.email.trim().toLowerCase())
            .digest('hex'),
        );
  }
  if (opts?.actorId && (type === 'TAG_MENTION' || type === 'COMMENT')) {
    const connections = await prisma.patchConnection.findMany({
      where: {
        status: 'ACCEPTED',
        OR: [
          { requesterId: opts.actorId, targetId: { in: recipientIds } },
          { targetId: opts.actorId, requesterId: { in: recipientIds } },
        ],
      },
      select: { requesterId: true, targetId: true },
    });
    for (const row of connections) {
      const id =
        row.requesterId === opts.actorId ? row.targetId : row.requesterId;
      if (policy.has(id)) policy.get(id)!.patched = true;
    }
  }
  const dedupeMs = Math.max(opts?.dedupeMs ?? 45_000, 0);
  if (dedupeMs > 0 && !opts?.notificationId) {
    // Each lateral branch has its own per-recipient bound. The target fast path
    // may match an older row than the newest 25 semantic candidates.
    const since = new Date(Date.now() - dedupeMs);
    const candidates = await prisma.$queryRaw<
      Array<{
        recipientId: string;
        kind: string;
        notification: Omit<Notification, 'createdAt'> & { createdAt: string };
      }>
    >(Prisma.sql`
      WITH recipients AS (SELECT unnest(ARRAY[${Prisma.join(recipientIds.map((id) => Prisma.sql`${id}::uuid`))}]) AS id)
      SELECT r.id AS "recipientId", d.kind, (to_jsonb(d) - 'kind' - '_id') || jsonb_build_object('id', d."_id", 'createdAt', d."createdAt" AT TIME ZONE 'UTC') AS notification
      FROM recipients r CROSS JOIN LATERAL (
        (SELECT n.*, 'SEMANTIC' AS kind FROM "Notification" n
          WHERE n."recipientId" = r.id AND n.type = ${type}::"NotificationType"
            AND (${opts?.actorId ?? null}::uuid IS NULL OR n."actorId" = ${opts?.actorId ?? null}::uuid)
            AND n."createdAt" >= ${since} ORDER BY n."createdAt" DESC LIMIT 25)
        UNION ALL
        (SELECT n.*, 'TARGET' AS kind FROM "Notification" n
          WHERE ${Boolean(opts?.dedupeMs && opts.target)} AND n."recipientId" = r.id AND n.type = ${type}::"NotificationType"
            AND (${opts?.actorId ?? null}::uuid IS NULL OR n."actorId" = ${opts?.actorId ?? null}::uuid)
            AND n."createdAt" >= ${since} AND n.payload #>> '{target,id}' = ${opts?.target?.id ?? null}
          LIMIT 1)
      ) d
      ORDER BY r.id, d.kind, d."createdAt" DESC
    `);
    for (const row of candidates) {
      const value = {
        ...row.notification,
        createdAt: new Date(row.notification.createdAt),
      } as Notification;
      const recipient = policy.get(row.recipientId);
      if (!recipient) continue;
      if (row.kind === 'TARGET') recipient.targetDuplicate = value;
      else recipient.candidates.push(value);
    }
  }
  return policy;
}
