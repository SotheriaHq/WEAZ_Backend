import { BadRequestException, ForbiddenException, HttpException, Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertMandatoryAdaptiveScope, enforceCriticalTransaction } from './transactional-enforcement';
import { evaluateAccessPolicy } from './access-policy.engine';
import type { AdaptiveActionPolicy } from './adaptive-action-policy';
import { lockCurrentSecurityActor, type SecurityActor } from './security-actor';
import { operationDigest, randomSecuritySecret, secretDigest } from './security-factor-crypto';
import type { SessionRiskState } from './session-risk.engine';
import { adaptiveActionReview } from './adaptive-action-review';
import { hasSuperAdminTestMfaException } from './mfa-environment-policy';

export type AdaptiveOperation = {
  actor: SecurityActor; policy: AdaptiveActionPolicy; method: string; path: string; route: string; body: unknown;
  serverState?: unknown;
  requiredAdminPermissions: string[]; proof?: string; operationDigest: string; requestId: string;
  requiredRoles?: string[];
  readOnlyResponse?: boolean;
};

@Injectable()
export class AdaptiveAccessService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService) {}
  digest(operation: Omit<AdaptiveOperation, 'operationDigest' | 'requestId'>): string {
    return operationDigest(this.config, { actorId: operation.actor.id, sessionId: operation.actor.sid,
      authVersion: operation.actor.authVersion, method: operation.method, path: operation.path,
      readOnlyResponse: operation.readOnlyResponse === true,
      route: operation.route, body: operation.body ?? null, serverState: operation.serverState ?? null,
      policy: { action: operation.policy.action, sensitivity: operation.policy.sensitivity,
        scope: operation.policy.scope, brandId: operation.policy.brandId ?? null },
      requiredAdminPermissions: [...new Set(operation.requiredAdminPermissions)].sort(),
      requiredRoles: operation.requiredRoles === undefined ? null : [...new Set(operation.requiredRoles)].sort(),
      policyVersion: 'adaptive-access-v1' });
  }
  async authorize(operation: AdaptiveOperation, risk: SessionRiskState) {
    return this.authorizeCurrent(operation, risk);
  }
  /** Reads may finish after a grant/session/window changes. Recheck their
   * current database state without consuming a mutation's one-use approval. */
  async revalidateRead(operation: AdaptiveOperation) {
    if ((!['GET', 'HEAD'].includes(operation.method) &&
      !(operation.method === 'POST' && operation.readOnlyResponse === true)) ||
      operation.policy.sensitivity === 'CRITICAL_CHANGE')
      throw new BadRequestException('Read authorization requires a read operation');
    return this.authorizeCurrent(operation, null);
  }
  /** Completion is not another admission. In particular a consumed/deleted
   * critical-action proof must not create a new428 and replay a committed command. */
  async revalidateCommand(operation: AdaptiveOperation, replacement?: Readonly<SecurityActor>) {
    await this.prisma.$transaction(async tx => {
      const actor = replacement ?? operation.actor;
      const { user, session } = await lockCurrentSecurityActor(tx, actor);
      await assertMandatoryAdaptiveScope(tx, { ...operation, actor });
      const recovery = !replacement && operation.policy.scope === 'SELF' &&
        operation.policy.sensitivity === 'ACCOUNT' && /^\/auth\/security\/mfa(?:\/|$)/.test(operation.route);
      if (session.riskState !== 'NORMAL' && !recovery) throw new ForbiddenException('Verify this session before continuing');
      if (!replacement && operation.policy.sensitivity === 'SENSITIVE_READ' && !hasSuperAdminTestMfaException(user.role)) {
        const verified = session.strongAuthenticatedAt?.getTime();
        if (session.strongAuthVersion !== actor.authVersion || !verified ||
          verified > Date.now() || Date.now() - verified >= 300_000)
          throw new ForbiddenException('Current strong verification is required');
      }
    });
  }
  private async authorizeCurrent(operation: AdaptiveOperation, risk: SessionRiskState | null) {
    const result = await this.prisma.$transaction(async (tx) => {
      const { user, session } = await lockCurrentSecurityActor(tx, operation.actor);
      await assertMandatoryAdaptiveScope(tx, operation);
      const proof = await this.findProof(tx, operation);
      // Recovery/status reads remain reachable while challenged, but never
      // after revocation. The actor/parent/account checks above still apply.
      const recoveryRead = !risk && operation.policy.scope === 'SELF' && operation.policy.sensitivity === 'ACCOUNT' &&
        /^\/auth\/security\/mfa(?:\/|$)/.test(operation.route);
      const currentRisk = risk ?? { actorId: operation.actor.id, sessionId: operation.actor.sid,
        authVersion: operation.actor.authVersion, observedAt: Date.now(), state: recoveryRead ? 'NORMAL' as const : session.riskState };
      const ctx = {
        now: Date.now(), actorId: operation.actor.id, sessionId: operation.actor.sid, authVersion: operation.actor.authVersion,
        accountActive: true, sessionActive: true, authorityCurrent: true, permissionsAllowed: true, resourceAllowed: true,
        sensitivity: operation.policy.sensitivity, risk: currentRisk, riskAvailable: true,
        mandatoryMfaExempt: hasSuperAdminTestMfaException(user.role),
        strongAuthentication: session.strongAuthenticatedAt && session.strongAuthVersion !== null ? {
          actorId: operation.actor.id, sessionId: operation.actor.sid, authVersion: session.strongAuthVersion, verifiedAt: session.strongAuthenticatedAt.getTime(),
        } : null,
        operationDigest: operation.operationDigest,
        actionProof: proof ? { actorId: proof.userId, sessionId: proof.sessionId, authVersion: proof.authVersion,
          operationDigest: proof.operationDigest, expiresAt: proof.expiresAt.getTime(), consumed: proof.usedAt !== null } : null,
      };
      const decision = evaluateAccessPolicy(ctx);
      if (decision.outcome === 'ALLOW') return { decision };
      if (decision.outcome !== 'STEP_UP_REQUIRED') return { decision };
      const enrolled = await tx.securityFactor.count({ where: { userId: operation.actor.id, revokedAt: null, verifiedAt: { not: null } } });
      if (!enrolled) return { decision, enrollmentRequired: true };
      let challenge = await tx.securityStepUpChallenge.findFirst({ where: { userId: operation.actor.id, sessionId: operation.actor.sid,
        authVersion: operation.actor.authVersion, operationDigest: operation.operationDigest, usedAt: null, verifiedAt: null,
        expiresAt: { gt: new Date() }, attempts: { lt: 5 } }, select: { id: true, expiresAt: true } });
      if (!challenge) {
        const outstanding = await tx.securityStepUpChallenge.count({ where: { userId: operation.actor.id, usedAt: null, expiresAt: { gt: new Date() } } });
        if (outstanding >= 20) throw new BadRequestException('Finish an existing verification before starting another.');
        challenge = await tx.securityStepUpChallenge.create({ data: { userId: operation.actor.id, sessionId: operation.actor.sid,
          authVersion: operation.actor.authVersion, operationDigest: operation.operationDigest, method: operation.method,
          route: operation.route, sensitivity: operation.policy.sensitivity === 'CRITICAL_CHANGE' ? 'CRITICAL_CHANGE' : 'SENSITIVE_READ',
          nonce: randomSecuritySecret(), expiresAt: new Date(Date.now() + 300_000) }, select: { id: true, expiresAt: true } });
      }
      return { decision, challenge };
    });
    if (result.decision.outcome === 'ALLOW') return;
    if (result.decision.outcome === 'STEP_UP_REQUIRED') throw new HttpException({ code: result.enrollmentRequired ? 'MFA_ENROLLMENT_REQUIRED' : 'STEP_UP_REQUIRED',
      message: result.enrollmentRequired ? 'Set up an authenticator app or passkey before continuing.' : 'Verify this action with your authenticator app, passkey or recovery code.',
      action: operation.policy.action, challengeId: result.challenge?.id, expiresAt: result.challenge?.expiresAt,
      sensitivity: operation.policy.sensitivity === 'CRITICAL_CHANGE' ? 'CRITICAL_CHANGE' : 'SENSITIVE_READ',
      serverNow: new Date().toISOString(), review: adaptiveActionReview(operation) }, 428);
    if (result.decision.outcome === 'SESSION_REVOKED') throw new UnauthorizedException('Session is no longer valid');
    if (result.decision.outcome === 'UNAVAILABLE') throw new ServiceUnavailableException('Security checks are temporarily unavailable');
    throw new ForbiddenException('This action is not allowed');
  }
  private async findProof(tx: Prisma.TransactionClient, operation: AdaptiveOperation) {
    if (!operation.proof) return null;
    const [id, secret, extra] = operation.proof.split('.');
    if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) || !/^[A-Za-z0-9_-]{43}$/.test(secret ?? '') || extra !== undefined) return null;
    return tx.securityStepUpChallenge.findFirst({ where: { id, userId: operation.actor.id, sessionId: operation.actor.sid,
      authVersion: operation.actor.authVersion, operationDigest: operation.operationDigest, proofHash: secretDigest(secret),
      sensitivity: 'CRITICAL_CHANGE', verifiedAt: { not: null }, usedAt: null, expiresAt: { gt: new Date() } } });
  }
  /** Must run INSIDE the existing protected mutation's transaction, before writes. */
  async consumeInTransaction(tx: Prisma.TransactionClient, operation: AdaptiveOperation) {
    return enforceCriticalTransaction(tx, operation);
  }
}
