import { MessageThread, Prisma } from '@prisma/client';

export type PlacementThreadOrigin = 'LINKED' | 'PAIR' | 'LEGACY';

/** Lock the selected row; callers read its current data in a new statement after any wait. */
export async function lockStandardPlacementThread(
  tx: Prisma.TransactionClient,
  input: { orderId: string; brandId: string; buyerId: string; pairKey: string },
) {
  const rows = await tx.$queryRaw<
    Array<{ id: string; origin: PlacementThreadOrigin }>
  >(Prisma.sql`
    WITH linked AS (
      SELECT t.id, 'LINKED'::text AS origin FROM "MessageThreadOrderLink" l
      JOIN "MessageThread" t ON t.id = l."threadId"
      WHERE l."orderId" = ${input.orderId}::uuid LIMIT 1
    ), paired AS (
      SELECT t.id, 'PAIR'::text AS origin FROM "MessageThread" t
      WHERE t."pairKey" = ${input.pairKey} AND NOT EXISTS (SELECT 1 FROM linked)
      ORDER BY t."createdAt", t.id LIMIT 1
    ), adopted AS (
      SELECT t.id, 'LEGACY'::text AS origin FROM "MessageThread" t
      WHERE t."pairKey" IS NULL AND t."brandId" = ${input.brandId}::uuid
        AND t."buyerId" = ${input.buyerId}::uuid
        AND NOT EXISTS (SELECT 1 FROM linked) AND NOT EXISTS (SELECT 1 FROM paired)
      ORDER BY t."lastMessageAt" DESC, t."createdAt" DESC, t.id DESC LIMIT 1
    )
    SELECT t.id, chosen.origin FROM (
      SELECT * FROM linked UNION ALL SELECT * FROM paired UNION ALL SELECT * FROM adopted
    ) chosen JOIN "MessageThread" t ON t.id = chosen.id FOR UPDATE OF t
  `);
  return rows[0] ?? null;
}

export async function loadStandardPlacementContext(
  tx: Prisma.TransactionClient,
  threadId: string,
  orderId: string,
) {
  const rows = await tx.$queryRaw<
    Array<MessageThread & { placementMessageId: string | null }>
  >(Prisma.sql`
    SELECT t.*, placement.id AS "placementMessageId" FROM "MessageThread" t
    LEFT JOIN LATERAL (
      SELECT m.id FROM "Message" m WHERE m."threadId" = t.id
        AND m."orderId" = ${orderId}::uuid AND m.kind = 'SYSTEM'
        AND m."metadataJson" #>> '{eventType}' = 'STANDARD_ORDER_PLACED'
      ORDER BY m."createdAt" DESC, m.id DESC LIMIT 1
    ) placement ON TRUE WHERE t.id = ${threadId}::uuid
  `);
  return rows[0] ?? null;
}
