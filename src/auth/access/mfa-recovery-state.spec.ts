import { ADMIN_PERMISSIONS, DEFAULT_ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { classifyAdaptiveAction } from './adaptive-action-policy';
import { recoveryApprovalIsLive } from './mfa-recovery-state';

describe('independent MFA recovery approval', () => {
  const reviewer = { id: 'reviewer', authVersion: 4, status: 'ACTIVE', role: 'Admin', mustResetPassword: false,
    adminPermissionGrants: [{ permissionCode: ADMIN_PERMISSIONS.USERS_MFA_RECOVER }] };
  const vote = () => ({ reviewerId: reviewer.id, reviewerAuthVersion: 4, reviewer: { ...reviewer } });
  it('requires an active independent reviewer with explicit recovery authority', () => {
    expect(recoveryApprovalIsLive(vote(), 'owner')).toBe(true);
    expect(recoveryApprovalIsLive(vote(), 'reviewer')).toBe(false);
    expect(recoveryApprovalIsLive({ ...vote(), reviewer: null }, 'owner')).toBe(false);
    expect(recoveryApprovalIsLive({ ...vote(), reviewer: { ...reviewer, adminPermissionGrants: [] } }, 'owner')).toBe(false);
  });
  it.each([
    { authVersion: 5 }, { status: 'SUSPENDED' }, { role: 'User' }, { mustResetPassword: true },
  ])('invalidates approval when reviewer authority changes: %j', change => {
    expect(recoveryApprovalIsLive({ ...vote(), reviewer: { ...reviewer, ...change } }, 'owner')).toBe(false);
  });
  it('does not automatically grant recovery to newly created administrators', () => {
    expect(DEFAULT_ADMIN_PERMISSIONS).not.toContain(ADMIN_PERMISSIONS.USERS_MFA_RECOVER);
  });
  it('requires an exact one-use approval for reviewer decisions and keeps applicant recovery reachable', () => {
    expect(classifyAdaptiveAction('POST', '/admin/security/mfa-recovery/:id/review').sensitivity).toBe('CRITICAL_CHANGE');
    expect(classifyAdaptiveAction('POST', '/auth/security/mfa/recovery/:id/totp/begin').sensitivity).toBe('ACCOUNT');
  });
});
