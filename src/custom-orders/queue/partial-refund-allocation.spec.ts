import { Prisma } from '@prisma/client';
import { allocatePartialRefund } from './partial-refund-allocation';
const row = (id: string, gross: number, net: number, status = 'HELD') => ({ id, amount: new Prisma.Decimal(gross), netBrandAmount: new Prisma.Decimal(net), commissionAmount: new Prisma.Decimal(gross).minus(net), status, eligibleAt: null, paidOutAt: null });
describe('partial refund milestone conservation', () => {
  it('reduces released and held milestones without releasing held money', () => {
    const result = allocatePartialRefund([row('upfront', 600, 540, 'PAYOUT_ELIGIBLE'), row('final', 400, 360)], 10000, 100000);
    expect(result).toEqual([
      expect.objectContaining({ id: 'upfront', refundGross: 6000, refundNet: 5400, refundCommission: 600, released: true, amount: 540, netBrandAmount: 486 }),
      expect.objectContaining({ id: 'final', refundGross: 4000, released: false, amount: 360, netBrandAmount: 324 }),
    ]);
  });
  it('conserves every minor unit across awkward fractional allocations', () => {
    const result = allocatePartialRefund([row('one', 0.33, 0.3), row('two', 0.33, 0.29), row('three', 0.34, 0.31)], 41, 100);
    expect(result.reduce((sum, item) => sum + item.refundGross, 0)).toBe(41);
    expect(result.every(item => item.refundGross === item.refundNet + item.refundCommission && item.netBrandAmount >= 0 && item.commissionAmount >= 0)).toBe(true);
  });
  it('rejects a full refund or incomplete financial allocation under the partial path', () => {
    expect(() => allocatePartialRefund([row('one', 10, 9)], 1000, 1000)).toThrow('RECONCILIATION_REQUIRED');
    expect(() => allocatePartialRefund([row('one', 10, 9)], 100, 1100)).toThrow('RECONCILIATION_REQUIRED');
  });
});
