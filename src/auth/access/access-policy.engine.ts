import type { SessionRiskState } from './session-risk.engine';

export const ACCESS_POLICY_VERSION = 'adaptive-access-v1';
export const STRONG_READ_WINDOW_MS = 5 * 60 * 1000;
export type AccessSensitivity = 'ACCOUNT' | 'SENSITIVE_READ' | 'CRITICAL_CHANGE';
export type AccessPolicyContext = {
  now: number;
  actorId: string;
  sessionId: string;
  authVersion: number;
  accountActive: boolean;
  sessionActive: boolean;
  authorityCurrent: boolean;
  permissionsAllowed: boolean;
  resourceAllowed: boolean;
  sensitivity: AccessSensitivity;
  risk: Pick<SessionRiskState, 'state' | 'observedAt' | 'actorId' | 'sessionId' | 'authVersion'> | null;
  riskAvailable: boolean;
  /** Server-recorded, session-scoped proof; never decoded from a client flag. */
  strongAuthentication?: { actorId: string; sessionId: string; authVersion: number; verifiedAt: number } | null;
  /** Exact request/body/resource proof, atomically consumed by the service boundary. */
  actionProof?: { actorId: string; sessionId: string; authVersion: number; operationDigest: string;
    expiresAt: number; consumed: boolean } | null;
  operationDigest?: string;
  /** Computed from server environment plus current database role after locking.
   * Does not waive session, ownership, permission or behavioral-risk checks. */
  mandatoryMfaExempt?: boolean;
};
export type AccessDecision = { outcome: 'ALLOW' | 'DENY' | 'STEP_UP_REQUIRED' | 'SESSION_REVOKED' | 'UNAVAILABLE'; reason: string; policyVersion: typeof ACCESS_POLICY_VERSION };
const decision = (outcome: AccessDecision['outcome'], reason: string): AccessDecision => ({ outcome, reason, policyVersion: ACCESS_POLICY_VERSION });

/** Missing ownership/permission evidence is a denial, even with a perfect risk score. */
export function evaluateAccessPolicy(ctx: AccessPolicyContext): AccessDecision {
  if (!ctx.accountActive || !ctx.sessionActive || !ctx.authorityCurrent || ctx.risk?.state === 'REVOKED') return decision('SESSION_REVOKED', 'CURRENT_AUTHORITY_REQUIRED');
  if (!ctx.permissionsAllowed || !ctx.resourceAllowed) return decision('DENY', 'RESOURCE_PERMISSION_REQUIRED');
  if (!Number.isFinite(ctx.now) || !Number.isSafeInteger(ctx.authVersion) || ctx.authVersion < 0 ||
    !ctx.actorId || !ctx.sessionId || !['ACCOUNT', 'SENSITIVE_READ', 'CRITICAL_CHANGE'].includes(ctx.sensitivity)) return decision('DENY', 'INVALID_AUTHORITY_CONTEXT');
  if (!ctx.riskAvailable || !ctx.risk || !['NORMAL', 'CHALLENGE'].includes(ctx.risk.state) ||
    ctx.risk.actorId !== ctx.actorId || ctx.risk.sessionId !== ctx.sessionId || ctx.risk.authVersion !== ctx.authVersion ||
    !Number.isFinite(ctx.risk.observedAt) || ctx.risk.observedAt > ctx.now + 5_000 ||
    ctx.now - ctx.risk.observedAt > 120_000) return decision('UNAVAILABLE', 'RISK_STATE_UNAVAILABLE');
  if (ctx.risk.state === 'CHALLENGE') return decision('STEP_UP_REQUIRED', 'SESSION_REAUTHENTICATION_REQUIRED');
  if (ctx.mandatoryMfaExempt === true) return decision('ALLOW', 'TEST_SUPERADMIN_MFA_EXCEPTION');
  const proof = ctx.strongAuthentication;
  const fresh = proof && proof.actorId === ctx.actorId && proof.sessionId === ctx.sessionId &&
    proof.authVersion === ctx.authVersion && Number.isFinite(proof.verifiedAt) &&
    proof.verifiedAt <= ctx.now && ctx.now - proof.verifiedAt < STRONG_READ_WINDOW_MS;
  if (ctx.sensitivity === 'CRITICAL_CHANGE') {
    const action = ctx.actionProof;
    if (!ctx.operationDigest || !action || action.actorId !== ctx.actorId || action.sessionId !== ctx.sessionId ||
      action.authVersion !== ctx.authVersion || action.operationDigest !== ctx.operationDigest ||
      !Number.isFinite(action.expiresAt) || action.expiresAt <= ctx.now || action.consumed !== false) return decision('STEP_UP_REQUIRED', 'EXACT_ACTION_PROOF_REQUIRED');
    return decision('ALLOW', 'EXACT_ACTION_PROOF_VERIFIED');
  }
  if (ctx.sensitivity === 'SENSITIVE_READ' && !fresh) return decision('STEP_UP_REQUIRED', 'FRESH_STRONG_AUTHENTICATION_REQUIRED');
  return decision('ALLOW', 'CURRENT_AUTHORITY_AND_CONTEXT');
}
