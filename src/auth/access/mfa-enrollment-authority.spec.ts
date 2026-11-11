import { classifyAdaptiveAction } from './adaptive-action-policy';
import {
  createSecurityLease,
  securityRequestContext,
} from './security-request-context';
import { requireMfaEnrollmentAction, requireMfaManagementAction } from './mfa-enrollment-authority';

describe('MFA setup authority', () => {
  const actor = { id: 'owner', sid: 'session', authVersion: 3, role: 'User' };
  const operation = () =>
    ({
      actor,
      policy: {
        scope: 'SELF',
        sensitivity: 'CRITICAL_CHANGE',
        action: 'authentication.factor.add',
      },
      method: 'POST',
      route: '/auth/security/mfa/passkeys/begin',
    }) as any;
  it('keeps bootstrap and challenge verification reachable while requiring one-use authority for additional factors', () => {
    expect(
      classifyAdaptiveAction('POST', '/auth/security/mfa/passkeys/begin')
        .sensitivity,
    ).toBe('ACCOUNT');
    expect(
      classifyAdaptiveAction(
        'POST',
        '/auth/security/mfa/passkeys/begin',
        {},
        { enrolledMfa: true },
      ).sensitivity,
    ).toBe('CRITICAL_CHANGE');
    expect(
      classifyAdaptiveAction(
        'POST',
        '/auth/security/mfa/challenges/:id/verify',
        {},
        { enrolledMfa: true },
      ).sensitivity,
    ).toBe('ACCOUNT');
  });
  it('rejects a viewing window, another action, another session, and a different enrollment method', () => {
    expect(() => requireMfaEnrollmentAction(actor, 'passkeys')).toThrow(
      'Verify the exact',
    );
    for (const bad of [
      {
        ...operation(),
        policy: {
          scope: 'SELF',
          sensitivity: 'SENSITIVE_READ',
          action: 'account.access',
        },
      },
      {
        ...operation(),
        policy: { ...operation().policy, action: 'account.security.change' },
      },
      { ...operation(), actor: { ...actor, sid: 'other-session' } },
      { ...operation(), route: '/auth/security/mfa/totp/begin' },
    ])
      expect(() =>
        securityRequestContext.run(
          { operation: bad, request: createSecurityLease() },
          () => requireMfaEnrollmentAction(actor, 'passkeys'),
        ),
      ).toThrow('Verify the exact');
  });
  it('accepts only the matching live operation and rejects its ended request', () => {
    const request = createSecurityLease();
    securityRequestContext.run({ operation: operation(), request }, () => {
      expect(() => requireMfaEnrollmentAction(actor, 'passkeys')).not.toThrow();
      request.close();
      expect(() => requireMfaEnrollmentAction(actor, 'passkeys')).toThrow(
        'This request ended',
      );
    });
  });
  it('binds an authenticator replacement to its approved target', () => {
    const op = { ...operation(), route: '/auth/security/mfa/totp/begin', body: { replacesFactorId: 'original-factor' } };
    securityRequestContext.run({ operation: op, request: createSecurityLease() }, () => {
      expect(() => requireMfaEnrollmentAction(actor, 'totp', 'original-factor')).not.toThrow();
      expect(() => requireMfaEnrollmentAction(actor, 'totp', 'another-factor')).toThrow('exact authenticator replacement');
      expect(() => requireMfaEnrollmentAction(actor, 'totp')).toThrow('exact authenticator replacement');
    });
  });
  it('keeps factor removal and recovery-code regeneration distinct and binds the actual factor address', () => {
    const route = '/auth/security/mfa/factors/:id/revoke';
    const op = { ...operation(), route, path: '/auth/security/mfa/factors/target-factor/revoke',
      policy: classifyAdaptiveAction('POST', route) };
    expect(op.policy.sensitivity).toBe('CRITICAL_CHANGE');
    securityRequestContext.run({ operation: op, request: createSecurityLease() }, () => {
      expect(() => requireMfaManagementAction(actor, 'remove', 'target-factor')).not.toThrow();
      expect(() => requireMfaManagementAction(actor, 'remove', 'different-factor')).toThrow('exact authentication security change');
      expect(() => requireMfaManagementAction(actor, 'recovery-codes')).toThrow('exact authentication security change');
    });
    const resetRoute = '/auth/security/mfa/recovery-codes/regenerate';
    const reset = { ...operation(), route: resetRoute, path: resetRoute, policy: classifyAdaptiveAction('POST', resetRoute) };
    expect(reset.policy.sensitivity).toBe('CRITICAL_CHANGE');
    securityRequestContext.run({ operation: reset, request: createSecurityLease() }, () => {
      expect(() => requireMfaManagementAction(actor, 'recovery-codes')).not.toThrow();
      expect(() => requireMfaManagementAction(actor, 'remove', 'target-factor')).toThrow('exact authentication security change');
    });
  });
});
