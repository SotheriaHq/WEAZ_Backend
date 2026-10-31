import { Prisma } from '@prisma/client';

/** Holds one logical action to a single runner until the surrounding transaction ends. */
export const lockForTransaction = (
  tx: Prisma.TransactionClient,
  key: string,
) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
