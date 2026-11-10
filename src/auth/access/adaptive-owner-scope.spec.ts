import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { assertMandatoryAdaptiveScope } from './transactional-enforcement';
import type { AdaptiveOperation } from './adaptive-access.service';

const operation: AdaptiveOperation = {
  actor: { id: 'actor', sid: 'session', role: 'User', authVersion: 1 },
  policy: { sensitivity: 'CRITICAL_CHANGE', scope: 'BRAND_OWNER', action: 'brand.permissions.change', brandId: 'brand' },
  method: 'POST', route: '/brands/:brandId/staff', path: '/brands/brand/staff', body: {},
  requiredAdminPermissions: [], requestId: 'request', operationDigest: 'fixture',
};
const client = (ownerId: string, membership: unknown) => ({
  $queryRaw: jest.fn(async () => []),
  brand: { findUnique: jest.fn(async () => ({ id: 'brand', ownerId })) },
  brandMember: { findUnique: jest.fn(async () => membership) },
}) as any;

describe('mandatory brand ownership scope', () => {
  it('allows the registered brand owner without another membership lookup', async () => {
    const tx = client('actor', null);
    await expect(assertMandatoryAdaptiveScope(tx, operation)).resolves.toBeUndefined();
    expect(tx.brandMember.findUnique).not.toHaveBeenCalled();
  });
  it('preserves active co-owner access', async () => {
    await expect(assertMandatoryAdaptiveScope(client('primary', { role: BrandMemberRole.OWNER, status: BrandMemberStatus.ACTIVE }), operation))
      .resolves.toBeUndefined();
  });
  it.each(Object.values(BrandMemberStatus).filter((status) => status !== BrandMemberStatus.ACTIVE))
    ('rejects an owner membership with status %s', async (status) => {
      await expect(assertMandatoryAdaptiveScope(client('primary', { role: BrandMemberRole.OWNER, status }), operation))
        .rejects.toMatchObject({ status: 403 });
    });
  it.each(Object.values(BrandMemberRole).filter((role) => role !== BrandMemberRole.OWNER))
    ('does not turn an active %s membership into ownership', async (role) => {
      await expect(assertMandatoryAdaptiveScope(client('primary', { role, status: BrandMemberStatus.ACTIVE }), operation))
        .rejects.toMatchObject({ status: 403 });
    });
  it('rejects a missing membership', async () => {
    await expect(assertMandatoryAdaptiveScope(client('primary', null), operation)).rejects.toMatchObject({ status: 403 });
  });
});
