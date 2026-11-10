export type PrincipalState = {
  id: string;
  status: string;
  role: string;
  authVersion: number;
  mustResetPassword: boolean;
};

export type PrincipalDecision =
  | { outcome: 'allow'; reason: 'CURRENT_AUTHORITY' }
  | { outcome: 'deny'; reason: 'INACTIVE_ACCOUNT' | 'REVOKED_AUTHORITY' | 'PASSWORD_RESET_REQUIRED' };

/** Deterministic policy over verified claims and current database authority. */
export function evaluatePrincipalPolicy(
  actor: PrincipalState | null,
  claims: { sub: string; authVersion: number; role?: string; type?: string },
): PrincipalDecision {
  if (!actor || actor.id !== claims.sub || actor.status !== 'ACTIVE') {
    return { outcome: 'deny', reason: 'INACTIVE_ACCOUNT' };
  }
  if (!Number.isSafeInteger(claims.authVersion) || claims.authVersion !== actor.authVersion ||
    (claims.role !== undefined && claims.role !== actor.role)) {
    return { outcome: 'deny', reason: 'REVOKED_AUTHORITY' };
  }
  if (actor.mustResetPassword && (actor.role === 'Admin' || actor.role === 'SuperAdmin')) {
    return { outcome: 'deny', reason: 'PASSWORD_RESET_REQUIRED' };
  }
  return { outcome: 'allow', reason: 'CURRENT_AUTHORITY' };
}
