import { ConfigService } from '@nestjs/config';
import { AdaptiveAccessService, type AdaptiveOperation } from './adaptive-access.service';
import type { PrismaService } from 'src/prisma/prisma.service';
import { BrandAccessService } from 'src/brands/brand-access.service';
import { createSecurityLease, securityRequestContext } from './security-request-context';

type Candidate = Omit<AdaptiveOperation, 'operationDigest' | 'requestId'>;
const candidate = (): Candidate => ({
  actor: { id: 'actor', sid: 'session', authVersion: 3, role: 'Admin' },
  policy: { sensitivity: 'CRITICAL_CHANGE', action: 'brand.payout-account.change', scope: 'BRAND_OWNER', brandId: 'brand-a' },
  method: 'POST', path: '/store/payment-account', route: '/store/payment-account',
  body: { bankCode: '001', accountNumber: 'fixture-account' }, requiredAdminPermissions: ['PAYOUTS_WRITE'],
});

describe('exact operation authorization binding', () => {
  const config = new ConfigService({ SECURITY_FACTOR_ENCRYPTION_KEY: Buffer.alloc(32, 11).toString('base64') });
  const service = new AdaptiveAccessService({} as PrismaService, config);

  it.each([
    ['resolved brand', (op: Candidate) => { op.policy.brandId = 'brand-b'; }],
    ['authority scope', (op: Candidate) => { op.policy.scope = 'ADMIN'; }],
    ['sensitivity', (op: Candidate) => { op.policy.sensitivity = 'SENSITIVE_READ'; }],
    ['permission requirements', (op: Candidate) => { op.requiredAdminPermissions = ['PAYOUTS_READ']; }],
    ['role requirements', (op: Candidate) => { op.requiredRoles = ['SuperAdmin']; }],
    ['route template', (op: Candidate) => { op.route = '/admin/payouts/:id'; }],
    ['resource path', (op: Candidate) => { op.path = '/brands/brand-a/payouts/another-transfer'; }],
    ['beneficiary', (op: Candidate) => { op.body = { bankCode: '001', accountNumber: 'another-account' }; }],
    ['actor', (op: Candidate) => { op.actor.id = 'another-actor'; }],
    ['session', (op: Candidate) => { op.actor.sid = 'another-session'; }],
    ['authority revision', (op: Candidate) => { op.actor.authVersion += 1; }],
    ['server-resolved account version', (op: Candidate) => { op.serverState = { payoutAccount: { updatedAt: 'changed-after-verification' } }; }],
  ] as const)('requires a new approval after changing %s', (_label, change) => {
    const original = candidate(); const changed = candidate(); change(changed);
    expect(service.digest(changed)).not.toBe(service.digest(original));
  });

  it('treats permission order and duplicates as the same requirement', () => {
    const first = candidate(); const second = candidate();
    first.requiredAdminPermissions = ['PAYOUTS_WRITE', 'PAYOUTS_READ'];
    second.requiredAdminPermissions = ['PAYOUTS_READ', 'PAYOUTS_WRITE', 'PAYOUTS_WRITE'];
    expect(service.digest(first)).toBe(service.digest(second));
    first.requiredRoles = ['Admin', 'SuperAdmin']; second.requiredRoles = ['SuperAdmin', 'Admin', 'Admin'];
    expect(service.digest(first)).toBe(service.digest(second));
  });

  it('distinguishes an absent role restriction from a deny-everyone role list', () => {
    const first = candidate(); const second = candidate(); second.requiredRoles = [];
    expect(service.digest(first)).not.toBe(service.digest(second));
  });

  it('rejects a different primary brand after operation authorization', async () => {
    const brands = new BrandAccessService({
      brand: { findMany: jest.fn().mockResolvedValue([{ id: 'brand-b', name: 'Other brand' }]) },
      brandMember: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService);
    const operation = { ...candidate(), requestId: 'request', operationDigest: 'fixture-digest' };
    await expect(securityRequestContext.run({ operation, request: createSecurityLease() }, () => brands.getPrimaryBrandContext('actor')))
      .rejects.toMatchObject({ status: 409 });
  });

  it('rejects an explicit domain brand that differs from the approved brand', async () => {
    const brands = new BrandAccessService({
      brand: { findFirst: jest.fn().mockResolvedValue({ id: 'brand-b', ownerId: 'actor' }) },
    } as unknown as PrismaService);
    const operation = { ...candidate(), requestId: 'request', operationDigest: 'fixture-digest' };
    await expect(securityRequestContext.run({ operation, request: createSecurityLease() }, () => brands.resolveBrandContext('brand-b')))
      .rejects.toMatchObject({ status: 409 });
  });
});
