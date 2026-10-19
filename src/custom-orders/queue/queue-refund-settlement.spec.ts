import { Prisma } from '@prisma/client';
import { refundSettlement } from './queue-refund-settlement';

const capture = (changes = {}) => ({ amount: new Prisma.Decimal(1), currency: 'USD', settlementCurrency: 'NGN', settlementAmount: new Prisma.Decimal(1.5), exchangeRateSnapshot: { id: 'original-rate', baseCurrency: 'USD', quoteCurrency: 'NGN', rate: new Prisma.Decimal(1.5) }, ...changes }) as any;
describe('original-payment refund exchange rate', () => {
  it('conserves the captured settlement across repeated fractional sibling refunds', () => {
    const previous: Array<{ amount: Prisma.Decimal; breakdownJson: unknown }> = [];
    for (const original of [0.33, 0.33, 0.34]) {
      const settlement = refundSettlement(capture(), original, previous);
      expect(settlement.status).toBe('RECORDED');
      previous.push({ amount: new Prisma.Decimal(original), breakdownJson: { settlement } });
    }
    expect(previous.map(row => (row.breakdownJson as any).settlement.amount)).toEqual([0.5, 0.49, 0.51]);
  });
  it('requires reconciliation for missing rates, inconsistent captures or unknown prior refunds', () => {
    expect(refundSettlement(capture({ exchangeRateSnapshot: null }), 0.5).status).toBe('REQUIRES_RECONCILIATION');
    expect(refundSettlement(capture({ settlementAmount: new Prisma.Decimal(2) }), 0.5).status).toBe('REQUIRES_RECONCILIATION');
    expect(refundSettlement(capture(), 0.5, [{ amount: new Prisma.Decimal(0.1), breakdownJson: {} }]).status).toBe('REQUIRES_RECONCILIATION');
  });
  it('supports same-currency historical captures and rejects exceeding the shared capture', () => {
    const same = capture({ currency: 'NGN', settlementAmount: null, exchangeRateSnapshot: null });
    expect(refundSettlement(same, 0.9)).toMatchObject({ status: 'RECORDED', amount: 0.9, rate: '1' });
    expect(refundSettlement(same, 1.01).status).toBe('REQUIRES_RECONCILIATION');
  });
});
