import type { Prisma } from '@prisma/client';

/** All credential changes lock the account before any session/token row. */
export async function lockSecurityAccount(tx: Prisma.TransactionClient, userId: string): Promise<void> {
  await tx.$queryRaw`SELECT "_id" FROM "User" WHERE "_id" = ${userId}::uuid FOR UPDATE`;
}
