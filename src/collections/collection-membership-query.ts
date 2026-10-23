import { Prisma } from '@prisma/client';

const MEMBERSHIP_BATCH_SIZE = 500;
export type CollectionMembership = {
  productId: string;
  collectionId: string;
  isPrimary: boolean;
  createdAt: Date;
  orderIndex: number;
};

const uniqueIds = (ids: string[]) => [...new Set(ids)].sort();

export async function lockMembershipProducts(
  tx: Prisma.TransactionClient,
  productIds: string[],
): Promise<void> {
  const ids = uniqueIds(productIds);
  for (let offset = 0; offset < ids.length; offset += MEMBERSHIP_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MEMBERSHIP_BATCH_SIZE);
    await tx.$queryRaw(Prisma.sql`
      SELECT "_id" FROM "Product"
      WHERE "_id" IN (${Prisma.join(batch.map((id) => Prisma.sql`${id}::uuid`))})
      ORDER BY "_id" FOR UPDATE
    `);
  }
}

export async function readProductMemberships(
  tx: Prisma.TransactionClient,
  productIds: string[],
): Promise<Map<string, CollectionMembership[]>> {
  const ids = uniqueIds(productIds);
  const grouped = new Map<string, CollectionMembership[]>(
    ids.map((id) => [id, []]),
  );
  for (let offset = 0; offset < ids.length; offset += MEMBERSHIP_BATCH_SIZE) {
    const rows = await tx.storeCollectionProduct.findMany({
      where: {
        productId: { in: ids.slice(offset, offset + MEMBERSHIP_BATCH_SIZE) },
      },
      orderBy: [
        { isPrimary: 'desc' },
        { createdAt: 'asc' },
        { orderIndex: 'asc' },
        { collectionId: 'asc' },
      ],
      select: {
        productId: true,
        collectionId: true,
        isPrimary: true,
        createdAt: true,
        orderIndex: true,
      },
    });
    for (const row of rows) grouped.get(row.productId)?.push(row);
  }
  return grouped;
}

/** Caller holds the affected product locks until its surrounding transaction commits. */
export async function synchronizePrimaryMemberships(
  tx: Prisma.TransactionClient,
  productIds: string[],
): Promise<void> {
  const grouped = await readProductMemberships(tx, productIds);
  const ids = [...grouped.keys()];
  for (let offset = 0; offset < ids.length; offset += MEMBERSHIP_BATCH_SIZE) {
    const batch = ids.slice(offset, offset + MEMBERSHIP_BATCH_SIZE);
    const choices = batch.map((productId) => ({
      productId,
      collectionId: grouped.get(productId)?.[0]?.collectionId ?? null,
    }));
    await tx.storeCollectionProduct.updateMany({
      where: { productId: { in: batch }, isPrimary: true },
      data: { isPrimary: false },
    });
    const winners = choices.filter((choice) => choice.collectionId !== null);
    if (winners.length) {
      await tx.$executeRaw(Prisma.sql`
        UPDATE "StoreCollectionProduct" AS membership SET "isPrimary" = TRUE
        FROM (VALUES ${Prisma.join(
          winners.map(
            (choice) => Prisma.sql`
          (${choice.productId}::uuid, ${choice.collectionId}::uuid)
        `,
          ),
        )}) AS chosen("productId", "collectionId")
        WHERE membership."productId" = chosen."productId"
          AND membership."collectionId" = chosen."collectionId"
      `);
    }
    await tx.$executeRaw(Prisma.sql`
      UPDATE "Product" AS product SET "collectionId" = chosen."collectionId", "updatedAt" = NOW()
      FROM (VALUES ${Prisma.join(
        choices.map(
          (choice) => Prisma.sql`
        (${choice.productId}::uuid, ${choice.collectionId}::uuid)
      `,
        ),
      )}) AS chosen("productId", "collectionId")
      WHERE product."_id" = chosen."productId"
        AND product."collectionId" IS DISTINCT FROM chosen."collectionId"
    `);
  }
}
