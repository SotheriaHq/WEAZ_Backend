import { PATH_METADATA, METHOD_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { classifyAdaptiveAction } from './adaptive-action-policy';
import { PhysicalVerificationAdminController } from 'src/brand-verification/physical-verification.controller';
import { ADMIN_PERMISSIONS_KEY } from 'src/admin/decorators/require-permissions.decorator';
import { AdminJobsController } from 'src/admin/jobs/admin-jobs.controller';
import { NotificationsController } from 'src/notifications/notifications.controller';
import { ROLES_KEY } from 'src/auth/decorator/roles.decorator';
import { READ_ONLY_RESPONSE_KEY } from '../decorator/read-only-response.decorator';
import { assertMandatoryAdaptiveScope } from './transactional-enforcement';
import type { AdaptiveOperation } from './adaptive-access.service';

describe('server-declared administrator policy', () => {
  it('denies every role when its explicit allowed-role list is empty', async () => {
    const operation: AdaptiveOperation = { actor: { id: 'fixture', sid: 'fixture', role: 'SuperAdmin', authVersion: 1 },
      policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' }, method: 'GET', path: '/fixture', route: '/fixture',
      body: null, requiredAdminPermissions: [], requiredRoles: [], requestId: 'fixture', operationDigest: 'fixture' };
    await expect(assertMandatoryAdaptiveScope({} as never, operation)).rejects.toMatchObject({ status: 403 });
    await expect(assertMandatoryAdaptiveScope({} as never, { ...operation, requiredRoles: undefined })).resolves.toBeUndefined();
  });
  it('selects strong administrator access for the actual physical-verification handlers', () => {
    const prefix = Reflect.getMetadata(PATH_METADATA, PhysicalVerificationAdminController);
    let inspected = 0;
    for (const name of Object.getOwnPropertyNames(PhysicalVerificationAdminController.prototype)) {
      const handler = PhysicalVerificationAdminController.prototype[name];
      const adminPermissions = Reflect.getMetadata(ADMIN_PERMISSIONS_KEY, handler);
      if (!adminPermissions?.length) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler)];
      const route = `/${prefix}/${Reflect.getMetadata(PATH_METADATA, handler) ?? ''}`;
      const state = { enrolledMfa: false, actorRole: 'Admin', adminPermissions };
      expect(classifyAdaptiveAction(method, route, {}, state))
        .toMatchObject({ scope: 'ADMIN', sensitivity: 'SENSITIVE_READ' });
      inspected++;
    }
    expect(inspected).toBeGreaterThanOrEqual(7);
  });

  it('honors permission metadata independently of route names and client-facing role labels', () => {
    const state = { enrolledMfa: false, actorRole: 'User', adminPermissions: ['verification.physical.read'] };
    expect(classifyAdaptiveAction('GET', '/somewhere/:id', {}, state))
      .toMatchObject({ scope: 'ADMIN', sensitivity: 'SENSITIVE_READ' });
    expect(classifyAdaptiveAction('GET', '/somewhere/:id', {}, { enrolledMfa: false, actorRole: 'Admin' }))
      .toMatchObject({ scope: 'SELF', sensitivity: 'ACCOUNT' });
  });

  it('retains exact-approval admin changes and reachable self-service MFA bootstrap', () => {
    const state = { enrolledMfa: false, actorRole: 'Admin', adminPermissions: ['users.mfa_recover'] };
    expect(classifyAdaptiveAction('POST', '/admin/security/mfa-recovery/:id/review', {}, state).sensitivity)
      .toBe('CRITICAL_CHANGE');
    expect(classifyAdaptiveAction('GET', '/auth/security/mfa').scope).toBe('SELF');
    expect(classifyAdaptiveAction('POST', '/auth/security/mfa/totp/begin').sensitivity).toBe('ACCOUNT');
    expect(classifyAdaptiveAction('POST', '/another-admin/permission-change', {}, state).sensitivity)
      .toBe('CRITICAL_CHANGE');
    expect(classifyAdaptiveAction('POST', '/uploads/signed-urls-by-source', {}, state).sensitivity)
      .toBe('CRITICAL_CHANGE');
    expect(classifyAdaptiveAction('GET', '/auth/security/mfa', {}, state).scope).toBe('ADMIN');
  });

  it('selects administrator policy for actual role-only jobs and push metrics', () => {
    const requiredRoles = Reflect.getMetadata(ROLES_KEY, AdminJobsController);
    expect(requiredRoles).toEqual(['SuperAdmin']);
    expect(classifyAdaptiveAction('POST', '/v1/admin/jobs/clock-state', {}, { enrolledMfa: false, requiredRoles }))
      .toMatchObject({ scope: 'ADMIN', sensitivity: 'SENSITIVE_READ' });
    expect(Reflect.getMetadata(READ_ONLY_RESPONSE_KEY, AdminJobsController.prototype.clockState)).toBe(true);
    const pushRoles = Reflect.getMetadata(ROLES_KEY, NotificationsController.prototype.pushMetrics);
    expect(classifyAdaptiveAction('GET', '/notifications/push/metrics', {}, { enrolledMfa: false, requiredRoles: pushRoles }))
      .toMatchObject({ scope: 'ADMIN', sensitivity: 'SENSITIVE_READ' });
    expect(classifyAdaptiveAction('GET', '/ordinary-user-path', {}, { enrolledMfa: false,
      requiredRoles: ['User', 'Admin', 'SuperAdmin'] }).scope).toBe('SELF');
    expect(classifyAdaptiveAction('GET', '/auth/security/mfa', {}, { enrolledMfa: false, requiredRoles })
      .scope).toBe('SELF');
    expect(classifyAdaptiveAction('POST', '/auth/security/mfa/totp/begin', {}, { enrolledMfa: false, requiredRoles })
      .sensitivity).toBe('ACCOUNT');
  });
});
