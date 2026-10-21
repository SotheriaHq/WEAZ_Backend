import { Prisma, type PrismaClient } from '@prisma/client';
import { retryDatabaseTransaction } from '../common/transaction-retry.util';

/** One buyer's bag mutations serialize across replicas; unrelated buyers proceed. */
export async function lockBuyerCart(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(180215, hashtext(${userId}))`;
}

export function withCartTransaction<T>(
  prisma: Pick<PrismaClient, '$transaction'>,
  userId: string,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return retryDatabaseTransaction(() => prisma.$transaction(async (tx) => {
    await lockBuyerCart(tx, userId);
    return operation(tx);
  }));
}

/** Consume the paid snapshot only, retaining quantities added while checkout was open. */
export async function consumePaidCartLines(
  tx: Prisma.TransactionClient,
  userId: string,
  lines: readonly { cartItemId: string | null; quantity: number }[],
): Promise<void> {
  const selected = lines.filter((line) => line.cartItemId);
  if (!selected.length) return;
  if (selected.some((line) => !Number.isSafeInteger(line.quantity) || line.quantity <= 0)) {
    throw new Error('Invalid paid cart quantity');
  }
  await lockBuyerCart(tx, userId);
  await tx.$executeRaw(Prisma.sql`
    WITH paid AS (
      SELECT id, SUM(quantity)::integer AS quantity
      FROM unnest(${selected.map((line) => line.cartItemId)}::uuid[], ${selected.map((line) => line.quantity)}::integer[]) AS lines(id, quantity)
      GROUP BY id
    ), removed AS (
      DELETE FROM "CartItem" cart USING paid
      WHERE cart."_id" = paid.id AND cart."userId" = ${userId}::uuid AND cart.quantity <= paid.quantity
      RETURNING cart."_id"
    )
    UPDATE "CartItem" cart SET quantity = cart.quantity - paid.quantity, "updatedAt" = CURRENT_TIMESTAMP
    FROM paid WHERE cart."_id" = paid.id AND cart."userId" = ${userId}::uuid AND cart.quantity > paid.quantity
  `);
}
