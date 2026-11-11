import type { AdaptiveOperation } from './adaptive-access.service';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const amount = (value: unknown) => typeof value === 'string' && /^\d{1,10}(?:\.\d{1,2})?$/.test(value) ? value : undefined;

/** Public verification summary: whitelist server-approved fields, never echo request bodies. */
export function adaptiveActionReview(operation: AdaptiveOperation) {
  const action = operation.policy.action;
  if (action === 'brand.billing.change' && operation.route.endsWith('/checkout')) {
    const quote = record(record(operation.serverState).subscriptionQuote);
    return {
      title: 'Confirm subscription change',
      plan: ['THREAD','ASO_OKE','ARU','IGWE'].includes(String(quote.tierKey)) ? String(quote.tierKey) : undefined,
      amountNgn: amount(quote.amountNgn),
      monthlyPriceNgn: amount(quote.monthlyPriceNgn),
      paymentTiming: quote.kind === 'DOWNGRADE' ? 'renewal' : 'now',
    };
  }
  if (action === 'authentication.factor.add') return { title: record(operation.body).replacesFactorId
    ? 'Replace your authenticator' : 'Add a sign-in method' };
  if (action === 'authentication.factor.remove') return { title: 'Remove a sign-in method' };
  if (action === 'authentication.recovery-codes.replace') return { title: 'Replace your recovery codes' };
  if (action === 'brand.payout-account.change') {
    const account = record(operation.body).accountNumber;
    return { title: 'Change your payout bank account',
      accountEnding: typeof account === 'string' && /^\d{10}$/.test(account) ? account.slice(-4) : undefined };
  }
  if (action === 'brand.payout.change') return { title: 'Confirm your payout action' };
  if (action === 'account.security.change') return { title: 'Confirm your account security change' };
  if (action === 'brand.permissions.change') return { title: 'Confirm brand access changes' };
  if (action === 'admin.critical-change') return { title: 'Confirm this administration change' };
  return { title: 'Verify your access' };
}
