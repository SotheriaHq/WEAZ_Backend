import { ForbiddenException } from '@nestjs/common';
import type { SecurityActor } from './security-actor';
import { getLiveSecurityContext } from './security-request-context';

/** A recent viewing verification cannot add a new way to sign in. */
export function requireMfaEnrollmentAction(
  actor: SecurityActor,
  kind: 'totp' | 'passkeys',
  replacesFactorId?: string,
) {
  const context = getLiveSecurityContext();
  const operation = context?.operation;
  if (
    !operation ||
    operation.actor.id !== actor.id ||
    operation.actor.sid !== actor.sid ||
    operation.actor.authVersion !== actor.authVersion ||
    operation.actor.role !== actor.role ||
    operation.policy.scope !== 'SELF' ||
    operation.policy.sensitivity !== 'CRITICAL_CHANGE' ||
    operation.policy.action !== 'authentication.factor.add' ||
    operation.method !== 'POST' ||
    operation.route !== `/auth/security/mfa/${kind}/begin`
  ) {
    throw new ForbiddenException(
      'Verify the exact authentication-method setup before adding another sign-in method.',
    );
  }
  const body = operation.body as { replacesFactorId?: string } | null;
  if ((body?.replacesFactorId ?? null) !== (replacesFactorId ?? null))
    throw new ForbiddenException(
      'Verify the exact authenticator replacement before continuing.',
    );
}

export function requireMfaManagementAction(
  actor: SecurityActor,
  action: 'remove' | 'recovery-codes',
  factorId?: string,
) {
  const context = getLiveSecurityContext(),
    operation = context?.operation;
  const route =
    action === 'remove'
      ? '/auth/security/mfa/factors/:id/revoke'
      : '/auth/security/mfa/recovery-codes/regenerate';
  if (
    !operation ||
    operation.actor.id !== actor.id ||
    operation.actor.sid !== actor.sid ||
    operation.actor.authVersion !== actor.authVersion ||
    operation.actor.role !== actor.role ||
    operation.policy.scope !== 'SELF' ||
    operation.policy.sensitivity !== 'CRITICAL_CHANGE' ||
    operation.method !== 'POST' ||
    operation.route !== route ||
    operation.policy.action !==
      (action === 'remove'
        ? 'authentication.factor.remove'
        : 'authentication.recovery-codes.replace') ||
    (action === 'remove' &&
      operation.path.split('?')[0] !==
        `/auth/security/mfa/factors/${factorId}/revoke`)
  )
    throw new ForbiddenException(
      'Verify this exact authentication security change before continuing.',
    );
  return operation;
}
