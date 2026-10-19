import { Prisma } from '@prisma/client';

type Allocation = { id: string; amount: Prisma.Decimal; netBrandAmount: Prisma.Decimal; commissionAmount: Prisma.Decimal; status: string; eligibleAt: Date | null; paidOutAt: Date | null };
const cents = (value: Prisma.Decimal) => value.times(100).toNumber();

/** Reduce each remaining milestone proportionally, preserving every minor unit. */
export function allocatePartialRefund(rows: Allocation[], amountCents: number, remainingCaptureCents: number) {
  const total = rows.reduce((sum, row) => sum + cents(row.amount), 0);
  if (total !== remainingCaptureCents || amountCents <= 0 || amountCents >= total) throw new Error('CUSTOM_ORDER_PARTIAL_REFUND_RECONCILIATION_REQUIRED');
  let cumulative = 0, allocated = 0;
  return rows.map(row => {
    const gross = cents(row.amount), net = cents(row.netBrandAmount), commission = cents(row.commissionAmount);
    if (gross !== net + commission || [gross, net, commission].some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('CUSTOM_ORDER_PARTIAL_REFUND_RECONCILIATION_REQUIRED');
    cumulative += gross;
    const target = new Prisma.Decimal(amountCents).times(cumulative).dividedBy(total).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber();
    const refundGross = target - allocated;
    allocated = target;
    const refundNet = gross ? new Prisma.Decimal(refundGross).times(net).dividedBy(gross).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP).toNumber() : 0;
    const refundCommission = refundGross - refundNet;
    return { id: row.id, refundGross, refundNet, refundCommission, released: ['PAYOUT_ELIGIBLE', 'PAID_OUT'].includes(row.status) || Boolean(row.eligibleAt || row.paidOutAt), amount: (gross - refundGross) / 100, netBrandAmount: (net - refundNet) / 100, commissionAmount: (commission - refundCommission) / 100 };
  });
}
