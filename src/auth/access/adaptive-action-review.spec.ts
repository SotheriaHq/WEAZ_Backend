import { adaptiveActionReview } from './adaptive-action-review';

describe('public action verification summary', () => {
  it('shows only the held server price, never the submitted price or private agreement', () => {
    const result = adaptiveActionReview({ policy: { action: 'brand.billing.change' }, route: '/brands/:brandId/subscription/checkout',
      body: { expectedAmountNgn: 1, password: 'private-password', authorizationCode: 'private-token' },
      serverState: { subscriptionQuote: { tierKey: 'ARU', amountNgn: '12345.67', monthlyPriceNgn: '30000', kind: 'UPGRADE',
        privateAgreement: 'private-agreement' } } } as any);
    expect(result).toEqual({ title: 'Confirm subscription change', plan: 'ARU', amountNgn: '12345.67', monthlyPriceNgn: '30000', paymentTiming: 'now' });
    expect(JSON.stringify(result)).not.toMatch(/private|authorization|password|expectedAmount/);
  });
  it('shows renewal timing and rejects malformed money fields without echoing them', () => {
    const result = adaptiveActionReview({ policy: { action: 'brand.billing.change' }, route: '/brands/:brandId/subscription/checkout',
      serverState: { subscriptionQuote: { kind: 'DOWNGRADE', tierKey: 'unknown', amountNgn: '<script>', monthlyPriceNgn: '-1' } } } as any);
    expect(result).toEqual({ title: 'Confirm subscription change', plan: undefined, amountNgn: undefined, monthlyPriceNgn: undefined, paymentTiming: 'renewal' });
  });
  it('exposes only the bank-account ending and never a full sensitive payload', () => {
    const result = adaptiveActionReview({ policy: { action: 'brand.payout-account.change' }, route: '/store/payment-account',
      body: { accountNumber: '1234567890', password: 'private-password', accountName: 'private-name' } } as any);
    expect(result).toEqual({ title: 'Change your payout bank account', accountEnding: '7890' });
    expect(JSON.stringify(result)).not.toMatch(/1234567890|private/);
  });
});
