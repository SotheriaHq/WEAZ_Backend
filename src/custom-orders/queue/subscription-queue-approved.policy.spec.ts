import {
  canRetainPosition,
  preActiveRefund,
  retainedExpiry,
  selectQueueCandidate,
  SUBSCRIPTION_TIERS,
} from './subscription-queue.policy';

describe('approved paid queue policy', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  it('allows retain only in the inclusive 48-to-12-hour window', () => {
    const eligible = (hours: number) => canRetainPosition({ now, queueExpiresAt: new Date(+now + hours * 3600000), retainCount: 0 });
    expect(eligible(49)).toBe(false);
    expect(eligible(48)).toBe(true);
    expect(eligible(12)).toBe(true);
    expect(eligible(12 - 1 / 3600000)).toBe(false);
  });
  it('adds 42 days to the existing expiry, not to click time', () => {
    const expiry = new Date('2026-10-20T12:00:00Z');
    expect(retainedExpiry(expiry).toISOString()).toBe('2026-12-01T12:00:00.000Z');
  });
  it('refunds full delivery, 90% garment and 90% jump, with actual VAT withheld', () => {
    const result = preActiveRefund({ captureKobo: 13_250_000, garmentSubtotalKobo: 10_000_000, vatKobo: 750_000, deliveryKobo: 500_000, jumpFeeKobo: 2_000_000 });
    expect(result.refundKobo).toBe(11_300_000);
    expect(result.systemChargeKobo).toBe(1_000_000);
    expect(result.jumpChargeKobo).toBe(200_000);
    expect(result.withheldKobo).toBe(1_950_000);
  });
  it('does not invent VAT on a snapshot without it', () => {
    expect(preActiveRefund({ captureKobo: 1_050_000, garmentSubtotalKobo: 1_000_000, vatKobo: 0, deliveryKobo: 50_000, jumpFeeKobo: 0 }).refundKobo).toBe(950_000);
  });
  it('rejects corrupt money rather than silently clamping a refund', () => {
    expect(() => preActiveRefund({ captureKobo: 100, garmentSubtotalKobo: 200, vatKobo: 0, deliveryKobo: 0, jumpFeeKobo: 0 })).toThrow();
  });
  it('restricts paid jumps to Aru and Igwe', () => {
    expect(SUBSCRIPTION_TIERS.filter(t => t.queueJumpAllowed).map(t => t.key)).toEqual(['ARU', 'IGWE']);
  });
  it('represents Legacy capacity as unlimited', () => {
    expect(SUBSCRIPTION_TIERS.find(t => t.key === 'LEGACY')?.maxActive).toBeNull();
  });
  it('serves an ordinary order after two priority activations', () => {
    const rows = [{ id: 'jump-a', queuePriority: 1 }, { id: 'jump-b', queuePriority: 1 }, { id: 'normal', queuePriority: 0 }];
    expect(selectQueueCandidate(rows, 2)?.id).toBe('normal');
    expect(selectQueueCandidate(rows, 1)?.id).toBe('jump-a');
  });
  it('never selects an admin-held order', () => {
    expect(selectQueueCandidate([{ id: 'held', queuePriority: 1, adminPromotionHeld: true }, { id: 'next', queuePriority: 0 }], 0)?.id).toBe('next');
  });
});
