import { PaymentStatus, Prisma } from '@prisma/client';

export type RefundAttemptSnapshot = {
  id: string;
  reference: string;
  provider: string;
  providerMode: string;
  amount: Prisma.Decimal;
  currency: string;
  status: string;
};

/** Current order/capture identity; no display, authorization or media hydration. */
export async function loadStandardOrderRefundContext(
  tx: Prisma.TransactionClient,
  orderId: string,
) {
  const rows = await tx.$queryRaw<
    Array<{
      orderId: string;
      paymentStatus: PaymentStatus;
      captureId: string | null;
      reference: string | null;
      provider: string | null;
      providerMode: string | null;
      amount: Prisma.Decimal | null;
      currency: string | null;
      captureStatus: string | null;
    }>
  >(Prisma.sql`
    SELECT o."_id" AS "orderId", o."paymentStatus",
      capture.id AS "captureId", capture.reference, capture.provider,
      capture."providerMode", capture.amount, capture.currency,
      capture.status AS "captureStatus"
    FROM "Order" o
    LEFT JOIN LATERAL (
      SELECT p.id, p.reference, p.provider, p."providerMode",
        p.amount, p.currency, p.status, p."createdAt"
      FROM "PaymentAttempt" p
      WHERE NULLIF(o."paymentReference", '') IS NOT NULL AND p.reference = o."paymentReference"
      UNION ALL
      SELECT p.id, p.reference, p.provider, p."providerMode",
        p.amount, p.currency, p.status, p."createdAt"
      FROM "PaymentAttempt" p
      WHERE NULLIF(o."paymentReference", '') IS NULL AND p."orderIds" @> ARRAY[o."_id"::text]
      ORDER BY "createdAt" DESC, id DESC LIMIT 1
    ) capture ON true
    WHERE o."_id" = ${orderId}::uuid
  `);
  const row = rows[0];
  if (!row) return null;
  return {
    order: { id: row.orderId, paymentStatus: row.paymentStatus },
    attempt: row.captureId
      ? ({
          id: row.captureId,
          reference: row.reference!,
          provider: row.provider!,
          providerMode: row.providerMode!,
          amount: row.amount!,
          currency: row.currency!,
          status: row.captureStatus!,
        } satisfies RefundAttemptSnapshot)
      : null,
  };
}
