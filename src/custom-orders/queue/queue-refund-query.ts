import {
  CustomOrder,
  CustomOrderQueueRefund,
  PaymentAttempt,
  Prisma,
} from '@prisma/client';

type Capture = Pick<
  PaymentAttempt,
  | 'id'
  | 'reference'
  | 'provider'
  | 'providerMode'
  | 'providerTransactionId'
  | 'amount'
  | 'currency'
  | 'settlementAmount'
  | 'settlementCurrency'
  | 'status'
>;
type Order = Pick<
  CustomOrder,
  'id' | 'buyerId' | 'brandId' | 'lane' | 'cancelledAt'
>;
export type QueueRefundContext = CustomOrderQueueRefund & {
  paymentAttempt: Capture;
  customOrder: Order;
};
type Gateway = 'PAYSTACK' | 'FLUTTERWAVE';
type Lookup =
  | { id: string }
  | { gateway: Gateway; providerRefundId: string }
  | { gateway: Gateway; paymentReference: string };

/** Native refund/capture facts and current order identity in one relational read. */
export async function loadQueueRefundContexts(
  tx: Prisma.TransactionClient,
  lookup: Lookup,
): Promise<QueueRefundContext[]> {
  const predicate =
    'id' in lookup
      ? Prisma.sql`r.id = ${lookup.id}::uuid`
      : 'providerRefundId' in lookup
        ? Prisma.sql`r."providerRefundId" = ${lookup.providerRefundId} AND p.provider = ${lookup.gateway}`
        : Prisma.sql`p.reference = ${lookup.paymentReference} AND p.provider = ${lookup.gateway} AND r.status = 'PROCESSING' AND r."providerRefundId" IS NOT NULL`;
  const rows = await tx.$queryRaw<
    Array<
      CustomOrderQueueRefund & {
        captureReference: string;
        captureProvider: string;
        captureMode: string;
        captureTransactionId: string | null;
        captureAmount: Prisma.Decimal;
        captureCurrency: string;
        captureSettlementAmount: Prisma.Decimal | null;
        captureSettlementCurrency: string;
        captureStatus: string;
        orderBuyerId: string;
        orderBrandId: string;
        orderLane: CustomOrder['lane'];
        orderCancelledAt: Date | null;
      }
    >
  >(Prisma.sql`
    SELECT r.*, p.reference AS "captureReference", p.provider AS "captureProvider",
      p."providerMode" AS "captureMode", p."providerTransactionId" AS "captureTransactionId",
      p.amount AS "captureAmount", p.currency AS "captureCurrency",
      p."settlementAmount" AS "captureSettlementAmount", p."settlementCurrency" AS "captureSettlementCurrency",
      p.status AS "captureStatus", o."buyerId" AS "orderBuyerId",
      o."brandId" AS "orderBrandId", o.lane AS "orderLane", o."cancelledAt" AS "orderCancelledAt"
    FROM "CustomOrderQueueRefund" r
    JOIN "PaymentAttempt" p ON p.id = r."paymentAttemptId"
    JOIN "CustomOrder" o ON o.id = r."customOrderId"
    WHERE ${predicate} ORDER BY r."createdAt", r.id
    LIMIT ${'paymentReference' in lookup ? 20 : 1}
  `);
  return rows.map((row) => {
    const {
      captureReference,
      captureProvider,
      captureMode,
      captureTransactionId,
      captureAmount,
      captureCurrency,
      captureSettlementAmount,
      captureSettlementCurrency,
      captureStatus,
      orderBuyerId,
      orderBrandId,
      orderLane,
      orderCancelledAt,
      ...refund
    } = row;
    return {
      ...refund,
      paymentAttempt: {
        id: refund.paymentAttemptId,
        reference: captureReference,
        provider: captureProvider,
        providerMode: captureMode,
        providerTransactionId: captureTransactionId,
        amount: captureAmount,
        currency: captureCurrency,
        settlementAmount: captureSettlementAmount,
        settlementCurrency: captureSettlementCurrency,
        status: captureStatus,
      },
      customOrder: {
        id: refund.customOrderId,
        buyerId: orderBuyerId,
        brandId: orderBrandId,
        lane: orderLane,
        cancelledAt: orderCancelledAt,
      },
    };
  });
}
