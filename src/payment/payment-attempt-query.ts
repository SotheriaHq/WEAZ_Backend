import { PaymentAttempt, Prisma } from '@prisma/client';

/** Acquire the capture lock and read its current native fields in one command. */
export async function lockPaymentAttempt(
  tx: Prisma.TransactionClient,
  reference: string,
): Promise<PaymentAttempt | null> {
  const rows = await tx.$queryRaw<PaymentAttempt[]>`
    SELECT * FROM "PaymentAttempt" WHERE reference = ${reference} FOR UPDATE
  `;
  return rows[0] ?? null;
}
