import { resolveCurrentPrincipal } from './current-principal';
import { evaluatePrincipalPolicy } from './principal-policy';

const actor = { id: 'user', status: 'ACTIVE', role: 'Admin', authVersion: 4, mustResetPassword: false };
const claims = { sub: 'user', sid: '00000000-0000-4000-8000-000000000001', role: 'Admin', authVersion: 4, permissions: ['removed.grant'] } as any;

describe('current authority policy', () => {
  it.each(['SUSPENDED', 'DEACTIVATED'])('rejects %s despite a valid JWT', (status) => {
    expect(evaluatePrincipalPolicy({ ...actor, status }, claims).outcome).toBe('deny');
  });
  it.each([3, undefined, NaN, -1])('rejects stale or malformed token revision %s', (authVersion) => {
    expect(evaluatePrincipalPolicy(actor, { ...claims, authVersion }).outcome).toBe('deny');
  });
  it('rejects forced admin password reset and changed roles', () => {
    expect(evaluatePrincipalPolicy({ ...actor, mustResetPassword: true }, claims).outcome).toBe('deny');
    expect(evaluatePrincipalPolicy({ ...actor, role: 'User' }, claims).outcome).toBe('deny');
  });
  it('requires a fresh sign-in for unbound tokens', async () => {
    await expect(resolveCurrentPrincipal({} as any, { ...claims, sid: undefined })).rejects.toThrow('Sign in again');
  });
  it('does not use a deleted grant from the old JWT', async () => {
    const prisma = { user: { findUnique: jest.fn().mockResolvedValue({ ...actor, username: 'owner', type: 'BRAND', adminPermissionGrants: [], refreshTokens: [{ id: claims.sid }] }) } };
    const current = await resolveCurrentPrincipal(prisma as any, claims);
    expect(current.permissions).toEqual([]);
    expect(prisma.user.findUnique).toHaveBeenCalledTimes(1);
  });
  it('fails closed if authority cannot be read', async () => {
    const prisma = { user: { findUnique: jest.fn().mockRejectedValue(new Error('database unavailable')) } };
    await expect(resolveCurrentPrincipal(prisma as any, claims)).rejects.toThrow();
  });
});
