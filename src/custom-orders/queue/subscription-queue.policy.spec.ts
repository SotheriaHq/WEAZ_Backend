import {
  canRetainPosition,
  decideQueueAdmission,
  effectiveActiveCap,
  massCancelNeedsAttention,
  openOrderWarning,
  preActiveRefund,
  retainedExpiry,
  splitJumpFee,
  SUBSCRIPTION_TIERS,
} from './subscription-queue.policy';

describe('subscription queue policy', () => {
  const now = new Date('2026-10-18T12:00:00.000Z');

  it('seeds the four sold tiers at the opening naira prices', () => {
    const sold = SUBSCRIPTION_TIERS.filter((tier) => tier.key !== 'LEGACY');
    expect(sold.map((tier) => [tier.name, tier.monthlyPriceNgn, tier.maxActive, tier.maxInDelivery])).toEqual([
      ['Thread', 10_000, 2, 2],
      ['Aso-oke', 15_000, 3, 4],
      ['Aru', 30_000, 4, 5],
      ['Igwe', 50_000, 6, 5],
    ]);
    expect(sold.every((tier) => tier.maxUpNext === 1)).toBe(true);
  });

  it('lets a brand override beat the tier and the campaign', () => {
    expect(effectiveActiveCap({ tier: 'THREAD', brandOverride: 9, campaignDelta: 3 })).toBe(9);
  });

  it('adds a campaign delta when the brand has no override', () => {
    expect(effectiveActiveCap({ tier: 'ASO_OKE', brandOverride: null, campaignDelta: -1 })).toBe(2);
    expect(effectiveActiveCap({ tier: 'THREAD', brandOverride: null, campaignDelta: -9 })).toBe(0);
  });

  it('starts production when an Active seat is free and nobody is Up Next', () => {
    expect(decideQueueAdmission({ activeCount: 1, upNextCount: 0, activeCap: 2, now }).lane).toBe('ACTIVE');
  });

  it('does not let a new order pass the shopper who is already Up Next', () => {
    expect(decideQueueAdmission({ activeCount: 0, upNextCount: 1, activeCap: 2, now }).lane).toBe('PENDING');
  });

  it('makes the new order Up Next when Active is full and that seat is empty', () => {
    const decision = decideQueueAdmission({ activeCount: 2, upNextCount: 0, activeCap: 2, now });
    expect(decision.lane).toBe('UP_NEXT');
    expect(decision.queueExpiresAt?.toISOString()).toBe('2026-11-29T12:00:00.000Z');
  });

  it('charges a jump fee of 20% and keeps 10% of that fee', () => {
    expect(splitJumpFee(100_000_00)).toEqual({
      feeKobo: 20_000_00,
      platformKobo: 2_000_00,
      brandKobo: 18_000_00,
    });
  });

  it('withholds VAT and 10% on every pre-active cancel', () => {
    expect(preActiveRefund({ captureKobo: 107_500_00, garmentSubtotalKobo: 100_000_00, vatKobo: 7_500_00, deliveryKobo: 0, jumpFeeKobo: 0 })).toEqual({
      withheldKobo: 17_500_00,
      refundKobo: 90_000_00,
      systemChargeKobo: 10_000_00,
      jumpChargeKobo: 0,
      vatKobo: 7_500_00,
    });
  });

  it('does not refund more than was captured', () => {
    expect(() => preActiveRefund({ captureKobo: 1_000, garmentSubtotalKobo: 0, vatKobo: 5_000, deliveryKobo: 0, jumpFeeKobo: 0 })).toThrow();
  });

  it('allows one retain while at least 12 hours remain', () => {
    const expires = new Date(now.getTime() + 12 * 60 * 60 * 1000);
    expect(canRetainPosition({ now, queueExpiresAt: expires, retainCount: 0 })).toBe(true);
    expect(canRetainPosition({ now, queueExpiresAt: new Date(expires.getTime() - 1), retainCount: 0 })).toBe(false);
    expect(canRetainPosition({ now, queueExpiresAt: expires, retainCount: 1 })).toBe(false);
    expect(retainedExpiry(now).toISOString()).toBe('2026-11-29T12:00:00.000Z');
  });

  it('alerts only when one action cancels more than 5 pending orders', () => {
    expect(massCancelNeedsAttention(5)).toBe(false);
    expect(massCancelNeedsAttention(6)).toBe(true);
  });

  it('warns about open orders without blocking another one', () => {
    expect(openOrderWarning(0, 'Ada')).toBeNull();
    expect(openOrderWarning(2, 'Ada')).toBe(
      'You already have 2 open custom orders with Ada. This new order joins the back of their queue.',
    );
  });
});
