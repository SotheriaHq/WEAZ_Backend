import { requireBillingAction } from './billing-action-authority';
import {
  createSecurityLease,
  securityRequestContext,
} from './security-request-context';

describe('subscription instruction authority', () => {
  const operation = () => ({
    actor: { id: 'actor', sid: 'session', authVersion: 1, role: 'User' },
    policy: {
      action: 'brand.billing.change',
      sensitivity: 'CRITICAL_CHANGE' as const,
      scope: 'BRAND_OWNER' as const,
      brandId: 'brand',
    },
    method: 'POST',
    route: '/brands/:brandId/subscription/cancel-renewal',
    path: '/brands/brand/subscription/cancel-renewal',
    body: {},
    requiredAdminPermissions: [],
    operationDigest: 'fixture',
    requestId: 'request',
  });
  it('denies a direct call with no authenticated action context', () => {
    expect(() =>
      requireBillingAction('actor', 'brand', 'cancel-renewal'),
    ).toThrow('live approval');
  });
  it.each(['actor', 'brand', 'route'] as const)(
    'denies a mismatch in %s',
    (field) => {
      const op = operation();
      if (field === 'actor') op.actor.id = 'other';
      if (field === 'brand') op.policy.brandId = 'other';
      if (field === 'route')
        op.route = '/brands/:brandId/subscription/checkout';
      expect(() =>
        securityRequestContext.run(
          { operation: op, request: createSecurityLease() },
          () => requireBillingAction('actor', 'brand', 'cancel-renewal'),
        ),
      ).toThrow('live approval');
    },
  );
  it('returns the exact operation for a matching live request', () => {
    const op = operation();
    expect(
      securityRequestContext.run(
        { operation: op, request: createSecurityLease() },
        () => requireBillingAction('actor', 'brand', 'cancel-renewal'),
      ),
    ).toBe(op);
  });
  it('rejects an inherited transaction before any provider dispatch can occur', () => {
    expect(() =>
      securityRequestContext.run(
        {
          operation: operation(),
          request: createSecurityLease(),
          transaction: {} as any,
          transactionLease: createSecurityLease(),
        },
        () => requireBillingAction('actor', 'brand', 'cancel-renewal'),
      ),
    ).toThrow('outside another transaction');
  });
});
