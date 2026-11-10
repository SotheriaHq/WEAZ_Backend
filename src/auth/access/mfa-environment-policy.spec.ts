import {
  evaluateAccessPolicy,
  type AccessPolicyContext,
} from './access-policy.engine';
import {
  hasSuperAdminTestMfaException,
  requiredRecoveryApprovals,
} from './mfa-environment-policy';

describe('SuperAdmin deployment-tier MFA policy', () => {
  it.each(['sit', 'uat', 'SIT', ' UAT '])(
    'exempts only SuperAdmin in %s',
    (environment) => {
      expect(hasSuperAdminTestMfaException('SuperAdmin', environment)).toBe(
        true,
      );
      for (const role of ['Admin', 'User', 'superadmin', ''])
        expect(hasSuperAdminTestMfaException(role, environment)).toBe(false);
    },
  );
  it.each([
    'production',
    'prod',
    'development',
    'local',
    'test',
    'staging',
    '',
    undefined,
    'sit-production',
  ])(
    'does not waive production or unknown-tier requirements: %s',
    (environment) => {
      // Explicitly clear the process fallback when testing undefined configuration.
      const original = process.env.APP_ENV;
      try {
        delete process.env.APP_ENV;
        expect(hasSuperAdminTestMfaException('SuperAdmin', environment)).toBe(
          false,
        );
      } finally {
        if (original !== undefined) process.env.APP_ENV = original;
      }
    },
  );
  it('uses the server deployment tier for recovery, retaining production and all other roles', () => {
    const original = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'sit';
      expect(requiredRecoveryApprovals('SuperAdmin')).toBe(0);
      expect(requiredRecoveryApprovals('Admin')).toBe(2);
      expect(requiredRecoveryApprovals('User')).toBe(2);
      process.env.APP_ENV = 'production';
      expect(requiredRecoveryApprovals('SuperAdmin')).toBe(2);
    } finally {
      if (original === undefined) delete process.env.APP_ENV;
      else process.env.APP_ENV = original;
    }
  });
  const context = (): AccessPolicyContext => ({
    now: 1000,
    actorId: 'actor',
    sessionId: 'session',
    authVersion: 1,
    accountActive: true,
    sessionActive: true,
    authorityCurrent: true,
    permissionsAllowed: true,
    resourceAllowed: true,
    riskAvailable: true,
    risk: {
      actorId: 'actor',
      sessionId: 'session',
      authVersion: 1,
      observedAt: 1000,
      state: 'NORMAL',
    },
    sensitivity: 'CRITICAL_CHANGE',
    mandatoryMfaExempt: true,
  });
  it.each(['SENSITIVE_READ', 'CRITICAL_CHANGE'] as const)(
    'waives only the mandatory %s factor check',
    (sensitivity) => {
      expect(evaluateAccessPolicy({ ...context(), sensitivity }).reason).toBe(
        'TEST_SUPERADMIN_MFA_EXCEPTION',
      );
    },
  );
  it.each([
    { sessionActive: false },
    { authorityCurrent: false },
    { accountActive: false },
    { permissionsAllowed: false },
    { resourceAllowed: false },
    { riskAvailable: false },
  ])(
    'never bypasses invalid authority, resource or risk state: %j',
    (patch) => {
      expect(evaluateAccessPolicy({ ...context(), ...patch }).outcome).not.toBe(
        'ALLOW',
      );
    },
  );
  it.each(['CHALLENGE', 'REVOKED'] as const)(
    'preserves the behavioral %s decision',
    (state) => {
      const value = context();
      expect(
        evaluateAccessPolicy({ ...value, risk: { ...value.risk!, state } })
          .outcome,
      ).not.toBe('ALLOW');
    },
  );
});
