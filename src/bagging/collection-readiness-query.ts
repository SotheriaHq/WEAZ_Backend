import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

type Configuration = Prisma.CustomOrderConfigurationGetPayload<{
  select: {
    id: true;
    sourceType: true;
    sourceId: true;
    requiredMeasurementKeys: true;
    requiredFreeformPointIds: true;
  };
}>;
type Cart = Prisma.CartItemGetPayload<{
  select: { id: true; selectedSize: true; selectedColor: true; quantity: true };
}>;
type Session = Pick<
  Prisma.CustomOrderCheckoutSessionGetPayload<{}>,
  'id' | 'checkoutIntentId' | 'status' | 'customOrderId'
>;
type CustomOrder = Pick<
  Prisma.CustomOrderGetPayload<{}>,
  'id' | 'status' | 'paymentStatus'
>;
export type CollectionSizeFitProfile = Prisma.UserSizeFitProfileGetPayload<{
  select: {
    measurements: true;
    lastUpdatedAt: true;
    updatedAt: true;
    requireUpdateEveryDays: true;
  };
}> | null;
export type CollectionReadinessRow = {
  productId: string;
  cartItem: Cart | null;
  customConfiguration: Configuration | null;
  previousStandardOrder: { id: string } | null;
  previousCustomOrder: { id: string } | null;
  checkoutSessions: Session[];
  customOrders: CustomOrder[];
};

/** One indexed projection per bounded group; history is reduced by duplicate class. */
export async function loadCollectionReadiness(
  prisma: PrismaService,
  productIds: string[],
  userId?: string,
): Promise<Map<string, CollectionReadinessRow>> {
  const ids = [...new Set(productIds)];
  const result = new Map<string, CollectionReadinessRow>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    const batch = ids.slice(offset, offset + 500);
    const rows = await prisma.$queryRaw<CollectionReadinessRow[]>(Prisma.sql`
      SELECT input.id AS "productId", to_jsonb(cart) AS "cartItem",
        to_jsonb(config) AS "customConfiguration",
        to_jsonb(standard_order) AS "previousStandardOrder",
        to_jsonb(previous_custom) AS "previousCustomOrder",
        COALESCE(sessions.items, '[]'::jsonb) AS "checkoutSessions",
        COALESCE(orders.items, '[]'::jsonb) AS "customOrders"
      FROM unnest(ARRAY[${Prisma.join(batch)}]::uuid[]) AS input(id)
      LEFT JOIN LATERAL (
        SELECT c.id, c."sourceType", c."sourceId", c."requiredMeasurementKeys", c."requiredFreeformPointIds"
        FROM "CustomOrderConfiguration" c
        WHERE c."sourceType"='PRODUCT' AND c."sourceId"=input.id AND c."isActive"=true
        ORDER BY c."createdAt" DESC, c.id DESC LIMIT 1
      ) config ON true
      LEFT JOIN LATERAL (
        SELECT c."_id" AS id, c."selectedSize", c."selectedColor", c.quantity
        FROM "CartItem" c WHERE c."userId"=${userId ?? null}::uuid AND c."productId"=input.id
        ORDER BY c."createdAt" DESC, c."_id" DESC LIMIT 1
      ) cart ON true
      LEFT JOIN LATERAL (
        SELECT o.id FROM "OrderItem" o
        WHERE o."buyerId"=${userId ?? null}::uuid AND o."productId"=input.id LIMIT 1
      ) standard_order ON true
      LEFT JOIN LATERAL (
        SELECT o.id FROM "CustomOrder" o
        WHERE o."buyerId"=${userId ?? null}::uuid AND o."sourceType"='PRODUCT' AND o."sourceId"=input.id LIMIT 1
      ) previous_custom ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(s) ORDER BY s."createdAt" DESC) AS items FROM (
          SELECT DISTINCT ON (s.status, (s."customOrderId" IS NULL))
            s.id, s."checkoutIntentId", s.status, s."customOrderId", s."lastAttemptStatus", s."createdAt"
          FROM "CustomOrderCheckoutSession" s
          JOIN "CustomOrderCheckoutIntent" i ON i.id=s."checkoutIntentId"
          JOIN "CustomOrderConfiguration" c ON c.id=i."configurationId"
          WHERE s."buyerId"=${userId ?? null}::uuid AND c."sourceType"='PRODUCT' AND c."sourceId"=input.id
          ORDER BY s.status, (s."customOrderId" IS NULL), s."createdAt" DESC, s.id DESC
        ) s
      ) sessions ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(to_jsonb(o)) AS items FROM (
          SELECT DISTINCT ON (o.status, o."paymentStatus") o.id, o.status, o."paymentStatus"
          FROM "CustomOrder" o
          WHERE o."buyerId"=${userId ?? null}::uuid AND o."sourceType"='PRODUCT' AND o."sourceId"=input.id
            AND EXISTS (SELECT 1 FROM "CustomOrderConfiguration" c WHERE c."sourceType"='PRODUCT' AND c."sourceId"=input.id)
          ORDER BY o.status, o."paymentStatus", o.id
        ) o
      ) orders ON true
    `);
    for (const row of rows) result.set(row.productId, row);
  }
  return result;
}
