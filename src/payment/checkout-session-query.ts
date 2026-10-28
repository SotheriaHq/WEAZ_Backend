import { CheckoutSession, Prisma } from '@prisma/client';

/** Lock and return the current session before reading its dependent lines. */
export async function lockCheckoutSession(
  tx: Prisma.TransactionClient,
  id: string,
) {
  const rows = await tx.$queryRaw<
    CheckoutSession[]
  >`SELECT * FROM "CheckoutSession" WHERE id = ${id}::uuid FOR UPDATE`;
  const session = rows[0];
  if (!session) return null;
  const lines = await tx.checkoutSessionLine.findMany({
    where: { checkoutSessionId: id },
    orderBy: { lineOrder: 'asc' },
  });
  return { ...session, lines };
}
