export const SESSION_RISK_POLICY_VERSION = 'session-risk-v1';

/** Signals must be produced by a trusted server boundary, never request headers. */
export type SessionRiskEvidence = {
  actorId: string;
  sessionId: string;
  authVersion: number;
  observedAt: number;
  sequence: number;
  /** A cryptographically verified credential/session replay, not a refresh race. */
  credentialCompromised?: boolean;
  revoked?: boolean;
  deviceChanged?: boolean;
  networkChanged?: boolean;
  deniedPrivilegeAttempts?: number;
  sensitiveReads?: number;
  /** Country/time alone are intentionally not accepted as block signals. */
  verifiedImpossibleTravel?: boolean;
};
export type SessionRiskState = {
  actorId: string;
  sessionId: string;
  authVersion: number;
  sequence: number;
  observedAt: number;
  score: number;
  state: 'NORMAL' | 'CHALLENGE' | 'REVOKED';
  reasons: string[];
  reauthenticatedAt?: number;
};
export type RiskThresholds = { deniedPrivilegeAttempts: number; sensitiveReads: number };
export const DEFAULT_RISK_THRESHOLDS: Readonly<RiskThresholds> = Object.freeze({ deniedPrivilegeAttempts: 5, sensitiveReads: 120 });
const finiteCount = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;

/** Bounded, deterministic evaluation; revocation cannot decay into trust. */
export function evaluateSessionRisk(
  previous: SessionRiskState | null,
  evidence: SessionRiskEvidence,
  now: number,
  thresholds: RiskThresholds = DEFAULT_RISK_THRESHOLDS,
): SessionRiskState {
  if (!evidence.actorId || !evidence.sessionId || !Number.isSafeInteger(evidence.authVersion) || evidence.authVersion < 0 ||
    (previous && (previous.actorId !== evidence.actorId || previous.sessionId !== evidence.sessionId || previous.authVersion !== evidence.authVersion))) {
    throw new Error('Security evidence belongs to a different authority');
  }
  const binding = { actorId: evidence.actorId, sessionId: evidence.sessionId, authVersion: evidence.authVersion };
  if (previous && (!['NORMAL', 'CHALLENGE', 'REVOKED'].includes(previous.state) ||
    !Number.isSafeInteger(previous.sequence) || previous.sequence < 0 || !Number.isFinite(previous.score) ||
    previous.score < 0 || previous.score > 100 || !Number.isFinite(previous.observedAt))) throw new Error('Invalid stored security state');
  if (!Number.isFinite(now) || !Number.isSafeInteger(evidence.sequence) || evidence.sequence < 0 ||
    !Number.isFinite(evidence.observedAt) || evidence.observedAt > now + 5_000) {
    throw new Error('Invalid or stale security evidence');
  }
  if (!Number.isSafeInteger(thresholds.deniedPrivilegeAttempts) || thresholds.deniedPrivilegeAttempts < 1 ||
    !Number.isSafeInteger(thresholds.sensitiveReads) || thresholds.sensitiveReads < 1) throw new Error('Invalid risk thresholds');
  if (previous?.state === 'REVOKED' || evidence.revoked || evidence.credentialCompromised) {
    return { ...binding, sequence: Math.max(evidence.sequence, previous?.sequence ?? 0), observedAt: Math.max(evidence.observedAt, previous?.observedAt ?? 0), score: 100, state: 'REVOKED',
      reasons: evidence.credentialCompromised ? ['CREDENTIAL_COMPROMISED'] : ['SESSION_REVOKED'] };
  }
  if (now - evidence.observedAt > 120_000) throw new Error('Invalid or stale security evidence');
  if (previous && (evidence.sequence <= previous.sequence || evidence.observedAt <= (previous.reauthenticatedAt ?? -Infinity))) return previous;
  const reasons: string[] = [];
  let score = 0;
  // Device/network hints require corroboration; mobile IP changes are routine.
  if (evidence.deviceChanged) { score += 20; reasons.push('DEVICE_CONTEXT_CHANGED'); }
  if (evidence.networkChanged) { score += 10; reasons.push('NETWORK_CONTEXT_CHANGED'); }
  if (finiteCount(evidence.deniedPrivilegeAttempts) >= thresholds.deniedPrivilegeAttempts) {
    score += 70; reasons.push('REPEATED_PRIVILEGE_DENIAL');
  }
  if (finiteCount(evidence.sensitiveReads) > thresholds.sensitiveReads) {
    score += 70; reasons.push('SENSITIVE_ACCESS_VOLUME');
  }
  if (evidence.verifiedImpossibleTravel) { score += 40; reasons.push('VERIFIED_TRAVEL_ANOMALY'); }
  score = Math.min(100, score);
  // Challenge is sticky until an explicit successful stronger-auth transition.
  const challenge = score >= 70 || previous?.state === 'CHALLENGE';
  return { ...binding, sequence: evidence.sequence, observedAt: evidence.observedAt, reauthenticatedAt: previous?.reauthenticatedAt,
    score: challenge ? Math.max(score, previous?.state === 'CHALLENGE' ? previous.score : 0) : score,
    state: challenge ? 'CHALLENGE' : 'NORMAL',
    reasons: challenge && reasons.length === 0 ? previous?.reasons ?? ['REAUTHENTICATION_REQUIRED'] : reasons };
}

export function acknowledgeStrongAuthentication(state: SessionRiskState, now: number): SessionRiskState {
  if (state.state === 'REVOKED') throw new Error('Revoked sessions cannot be rehabilitated');
  if (!Number.isFinite(now) || now < state.observedAt) throw new Error('Invalid verification time');
  return { ...state, observedAt: now, reauthenticatedAt: now, score: 0, state: 'NORMAL', reasons: [] };
}
