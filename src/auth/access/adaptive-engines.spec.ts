import { evaluateAccessPolicy, STRONG_READ_WINDOW_MS, type AccessPolicyContext } from './access-policy.engine';
import { acknowledgeStrongAuthentication, evaluateSessionRisk, type SessionRiskEvidence, type SessionRiskState } from './session-risk.engine';

const now = 1_800_000_000_000;
const binding = { actorId: 'actor-a', sessionId: 'session-a', authVersion: 3 };
const context = (): AccessPolicyContext => ({ now, actorId: 'actor-a', sessionId: 'session-a', authVersion: 3,
  accountActive: true, sessionActive: true, authorityCurrent: true, permissionsAllowed: true, resourceAllowed: true,
  sensitivity: 'ACCOUNT', risk: { ...binding, state: 'NORMAL', observedAt: now }, riskAvailable: true });
const strong = () => ({ actorId: 'actor-a', sessionId: 'session-a', authVersion: 3, verifiedAt: now - 1_000 });
const action = () => ({ actorId: 'actor-a', sessionId: 'session-a', authVersion: 3, operationDigest: 'operation-a', expiresAt: now + 1_000, consumed: false });

describe('authorization decision engine', () => {
  it('allows normal account-owned access only with current authority', () => expect(evaluateAccessPolicy(context()).outcome).toBe('ALLOW'));
  it.each(['accountActive', 'sessionActive', 'authorityCurrent'] as const)('rejects %s=false despite strong proof', (key) => {
    expect(evaluateAccessPolicy({ ...context(), [key]: false, strongAuthentication: strong() }).outcome).toBe('SESSION_REVOKED');
  });
  it.each(['permissionsAllowed', 'resourceAllowed'] as const)('never lets a low risk score override %s=false', (key) => {
    expect(evaluateAccessPolicy({ ...context(), [key]: false, strongAuthentication: strong() }).outcome).toBe('DENY');
  });
  it.each([null, { state: 'NORMAL', observedAt: now - 120_001 }, { state: 'NORMAL', observedAt: NaN }, { state: 'BOGUS', observedAt: now }])('fails closed on unavailable/stale/corrupt risk evidence', (risk) => {
    expect(evaluateAccessPolicy({ ...context(), risk: risk ? { ...binding, ...risk } as any : null }).outcome).toBe('UNAVAILABLE');
  });
  it('requires strong proof for a sensitive read', () => expect(evaluateAccessPolicy({ ...context(), sensitivity: 'SENSITIVE_READ' }).outcome).toBe('STEP_UP_REQUIRED'));
  it('accepts a matching five-minute read proof', () => expect(evaluateAccessPolicy({ ...context(), sensitivity: 'SENSITIVE_READ', strongAuthentication: strong() }).outcome).toBe('ALLOW'));
  it.each([{ actorId: 'actor-b' }, { sessionId: 'session-b' }, { authVersion: 2 }, { verifiedAt: now + 1 }, { verifiedAt: now - STRONG_READ_WINDOW_MS }, { verifiedAt: NaN }])('rejects mismatched, future or expired read proof %j', (patch) => {
    expect(evaluateAccessPolicy({ ...context(), sensitivity: 'SENSITIVE_READ', strongAuthentication: { ...strong(), ...patch } }).outcome).toBe('STEP_UP_REQUIRED');
  });
  it('does not use a read proof to authorize a financial mutation', () => expect(evaluateAccessPolicy({ ...context(), sensitivity: 'CRITICAL_CHANGE', strongAuthentication: strong() }).outcome).toBe('STEP_UP_REQUIRED'));
  it('accepts only an exact unused operation proof', () => expect(evaluateAccessPolicy({ ...context(), sensitivity: 'CRITICAL_CHANGE', operationDigest: 'operation-a', actionProof: action() }).outcome).toBe('ALLOW'));
  it.each([{ actorId: 'actor-b' }, { sessionId: 'session-b' }, { authVersion: 2 }, { operationDigest: 'different-bank-details' }, { consumed: true }, { expiresAt: now }, { expiresAt: NaN }])('rejects an unusable action proof %j', (patch) => {
    expect(evaluateAccessPolicy({ ...context(), sensitivity: 'CRITICAL_CHANGE', operationDigest: 'operation-a', actionProof: { ...action(), ...patch } }).outcome).toBe('STEP_UP_REQUIRED');
  });
  it('does not let an old proof clear a running risk challenge', () => expect(evaluateAccessPolicy({ ...context(), risk: { ...binding, state: 'CHALLENGE', observedAt: now }, strongAuthentication: strong() }).outcome).toBe('STEP_UP_REQUIRED'));
  it('rejects unknown action sensitivity', () => expect(evaluateAccessPolicy({ ...context(), sensitivity: 'unexpected' as any }).outcome).toBe('DENY'));
});

describe('continuous session-risk engine', () => {
  const evidence = (patch: Partial<SessionRiskEvidence> = {}): SessionRiskEvidence => ({ ...binding, sequence: 1, observedAt: now, ...patch });
  it('does not challenge a normal session or a routine mobile network change', () => {
    expect(evaluateSessionRisk(null, evidence(), now).state).toBe('NORMAL');
    expect(evaluateSessionRisk(null, evidence({ networkChanged: true }), now).state).toBe('NORMAL');
  });
  it('never treats a copied device hint alone as trusted identity or automatic compromise', () => expect(evaluateSessionRisk(null, evidence({ deviceChanged: true, networkChanged: true }), now).state).toBe('NORMAL'));
  it.each([{ deniedPrivilegeAttempts: 5 }, { sensitiveReads: 121 }, { verifiedImpossibleTravel: true, networkChanged: true, deviceChanged: true }])('challenges corroborated evidence %j', (patch) => expect(evaluateSessionRisk(null, evidence(patch), now).state).toBe('CHALLENGE'));
  it.each([{ revoked: true }, { credentialCompromised: true }])('revokes confirmed invalid authority %j', (patch) => expect(evaluateSessionRisk(null, evidence(patch), now).state).toBe('REVOKED'));
  it('ignores duplicate and out-of-order observations', () => {
    const previous = evaluateSessionRisk(null, evidence({ sequence: 10 }), now);
    for (const sequence of [10, 9]) expect(evaluateSessionRisk(previous, evidence({ sequence, deniedPrivilegeAttempts: 5 }), now)).toBe(previous);
  });
  it('does not discard a late, verified compromise event', () => {
    const previous = evaluateSessionRisk(null, evidence({ sequence: 10 }), now);
    expect(evaluateSessionRisk(previous, evidence({ sequence: 9, credentialCompromised: true }), now).state).toBe('REVOKED');
  });
  it('does not consume the producer event sequence during stronger authentication', () => {
    const previous = acknowledgeStrongAuthentication(evaluateSessionRisk(null, evidence({ sequence: 10 }), now), now);
    expect(evaluateSessionRisk(previous, evidence({ sequence: 11, observedAt: now + 1, revoked: true }), now + 1).state).toBe('REVOKED');
  });
  it('keeps a challenge across a quiet counter window until stronger authentication', () => {
    const challenged = evaluateSessionRisk(null, evidence({ deniedPrivilegeAttempts: 5 }), now);
    const next = evaluateSessionRisk(challenged, evidence({ sequence: 2 }), now);
    expect(next.state).toBe('CHALLENGE'); expect(acknowledgeStrongAuthentication(next, now).state).toBe('NORMAL');
  });
  it('never rehabilitates a revoked session with time or another factor', () => {
    const revoked = evaluateSessionRisk(null, evidence({ revoked: true }), now);
    expect(evaluateSessionRisk(revoked, evidence({ sequence: 2 }), now).state).toBe('REVOKED');
    expect(() => acknowledgeStrongAuthentication(revoked, now)).toThrow();
  });
  it.each([{ observedAt: now - 120_001 }, { observedAt: now + 5_001 }, { observedAt: NaN }, { sequence: -1 }, { sequence: 1.5 }])('rejects invalid evidence %j', (patch) => expect(() => evaluateSessionRisk(null, evidence(patch), now)).toThrow());
  it('caps the score and rejects malformed configuration', () => {
    expect(evaluateSessionRisk(null, evidence({ deniedPrivilegeAttempts: 100, sensitiveReads: 1000, verifiedImpossibleTravel: true }), now).score).toBe(100);
    expect(() => evaluateSessionRisk(null, evidence(), now, { deniedPrivilegeAttempts: 0, sensitiveReads: 120 })).toThrow();
  });
});
