import { assertBrandPayoutSafe } from './brand-financial-safety';

describe('brand payout safety', () => {
  it.each(['SUSPENDED', 'DEACTIVATED', 'DELETED'])('blocks a %s owner before funds can leave', async status => {
    const client = { brand: { findUnique: jest.fn().mockResolvedValue({ verificationStatus: 'APPROVED', owner: { status } }) } };
    await expect(assertBrandPayoutSafe(client as any, 'brand')).rejects.toMatchObject({ response: { code: 'PAYOUT_SAFETY_HOLD' } });
  });
  it('blocks lost verification', async () => {
    const client = { brand: { findUnique: jest.fn().mockResolvedValue({ verificationStatus: 'REJECTED', owner: { status: 'ACTIVE' } }) } };
    await expect(assertBrandPayoutSafe(client as any, 'brand')).rejects.toMatchObject({ response: { code: 'PAYOUT_SAFETY_HOLD' } });
  });
  it('keeps earned funds accessible during an ordinary intake block or subscription lapse', async () => {
    const client = { brand: { findUnique: jest.fn().mockResolvedValue({ verificationStatus: 'APPROVED', owner: { status: 'ACTIVE' }, customOrderIntakeBlockedAt: new Date(), subscriptionStatus: 'PAST_DUE' }) } };
    await expect(assertBrandPayoutSafe(client as any, 'brand')).resolves.toBeUndefined();
  });
});
