import { Prisma } from '@prisma/client';

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
type Capture = Pick<Prisma.PaymentAttemptGetPayload<{ include: { exchangeRateSnapshot: true } }>, 'amount' | 'currency' | 'settlementAmount' | 'settlementCurrency' | 'exchangeRateSnapshot'>;
export type RefundSettlement = { status: 'RECORDED'; amount: number; currency: string; rate: string; exchangeRateSnapshotId: string | null; rounding: 'CUMULATIVE_HALF_UP' } | { status: 'REQUIRES_RECONCILIATION'; reason: string };

/** Called while holding the parent capture lock. Cumulative rounding preserves the captured minor-unit budget across siblings. */
export function refundSettlement(capture: Capture, refundAmount: number, previous: Array<{ amount: Prisma.Decimal; breakdownJson: unknown }> = []): RefundSettlement {
  const unavailable = (reason: string): RefundSettlement => ({ status: 'REQUIRES_RECONCILIATION', reason });
  try {
    const currency = capture.settlementCurrency || capture.currency;
    const sameCurrency = currency === capture.currency;
    const snapshot = capture.exchangeRateSnapshot;
    if (!sameCurrency && (!snapshot || snapshot.baseCurrency !== capture.currency || snapshot.quoteCurrency !== currency)) return unavailable('REFUND_ORIGINAL_FX_SNAPSHOT_MISSING');
    const rate = new Prisma.Decimal(sameCurrency ? 1 : snapshot!.rate);
    if (!rate.isFinite() || !rate.isPositive()) return unavailable('REFUND_ORIGINAL_FX_SNAPSHOT_INVALID');
    const captured = new Prisma.Decimal(capture.amount).times(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if ((!sameCurrency && capture.settlementAmount === null) || capture.settlementAmount !== null && capture.settlementAmount !== undefined && !captured.equals(capture.settlementAmount)) return unavailable('REFUND_CAPTURE_SETTLEMENT_MISMATCH');
    let priorOriginal = new Prisma.Decimal(0), priorSettlement = new Prisma.Decimal(0);
    for (const prior of previous) {
      priorOriginal = priorOriginal.plus(prior.amount);
      const saved = object(object(prior.breakdownJson).settlement);
      if (saved.status === 'RECORDED' && saved.currency === currency && typeof saved.amount === 'number') priorSettlement = priorSettlement.plus(saved.amount);
      else if (sameCurrency && !Object.keys(saved).length) priorSettlement = priorSettlement.plus(prior.amount);
      else return unavailable('REFUND_PRIOR_SETTLEMENT_REQUIRES_REVIEW');
    }
    const totalOriginal = priorOriginal.plus(refundAmount);
    const amount = totalOriginal.times(rate).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).minus(priorSettlement);
    if (totalOriginal.greaterThan(capture.amount) || amount.isNegative() || priorSettlement.plus(amount).greaterThan(captured)) return unavailable('REFUND_SETTLEMENT_EXCEEDS_CAPTURE');
    return { status: 'RECORDED', amount: amount.toNumber(), currency, rate: rate.toFixed(), exchangeRateSnapshotId: sameCurrency ? null : snapshot!.id, rounding: 'CUMULATIVE_HALF_UP' };
  } catch { return unavailable('REFUND_ORIGINAL_FX_SNAPSHOT_INVALID'); }
}
