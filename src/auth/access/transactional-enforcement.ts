import { ConflictException, ForbiddenException, HttpException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import { effectiveBrandPermissions } from 'src/brands/permissions/effective-brand-permissions';
import { hasBrandOwnership } from 'src/brands/brand-ownership';
import type { AdaptiveOperation } from './adaptive-access.service';
import { lockCurrentSecurityActor } from './security-actor';
import { secretDigest } from './security-factor-crypto';
import { createSecurityLease, getLiveSecurityContext, securityRequestContext } from './security-request-context';
import { isSecurityTransactionConflict } from './security-transaction-error';
import { evaluateAccessPolicy } from './access-policy.engine';
import { hasSuperAdminTestMfaException } from './mfa-environment-policy';

/** Ordinary administrator commands still need current authority at execution.
 * Only critical changes consume an exact-action proof. */
export async function enforceAdministrativeTransaction(tx: Prisma.TransactionClient, operation: AdaptiveOperation) {
  const context = getLiveSecurityContext();
  if (!context || context.operation !== operation || operation.policy.scope !== 'ADMIN')
    throw new ForbiddenException('A live authorized administrator request is required');
  const { user, session } = await lockCurrentSecurityActor(tx, operation.actor);
  await assertMandatoryAdaptiveScope(tx, operation);
  const now = Date.now();
  const actor = operation.actor;
  const decision = evaluateAccessPolicy({
    now, actorId: actor.id, sessionId: actor.sid, authVersion: actor.authVersion,
    accountActive: true, sessionActive: true, authorityCurrent: true,
    permissionsAllowed: true, resourceAllowed: true, sensitivity: operation.policy.sensitivity,
    mandatoryMfaExempt: hasSuperAdminTestMfaException(user.role),
    riskAvailable: Boolean(context.riskObservation), risk: context.riskObservation
      ? { ...context.riskObservation, state: session.riskState } : null,
    strongAuthentication: session.strongAuthenticatedAt && session.strongAuthVersion !== null ? {
      actorId: actor.id, sessionId: actor.sid, authVersion: session.strongAuthVersion,
      verifiedAt: session.strongAuthenticatedAt.getTime(),
    } : null,
  });
  if (decision.outcome === 'ALLOW') return;
  if (decision.outcome === 'STEP_UP_REQUIRED' || decision.outcome === 'UNAVAILABLE')
    throw new ConflictException({ code: 'SECURITY_VERIFICATION_RESTART_REQUIRED',
      message: 'Security verification changed before this database step completed. Review the current state, then retry this action.' });
  throw new ForbiddenException('Current administrator authority is required');
}

export async function assertMandatoryAdaptiveScope(tx: Prisma.TransactionClient, operation: AdaptiveOperation) {
  const { actor, policy } = operation;
  if (operation.requiredRoles !== undefined && !operation.requiredRoles.includes(actor.role))
    throw new ForbiddenException('The current account role cannot perform this action');
  if (policy.scope === 'ADMIN') {
    if (!['Admin', 'SuperAdmin'].includes(actor.role)) throw new ForbiddenException('Administrator access is required');
    if (actor.role !== 'SuperAdmin') {
      const grants = await tx.adminPermissionGrant.findMany({ where: { userId: actor.id }, select: { permissionCode: true } });
      if (!operation.requiredAdminPermissions.every((code) => grants.some((grant) => grant.permissionCode === code))) throw new ForbiddenException('Current administrator permissions are required');
    }
  }
  if (policy.scope === 'BRAND_OWNER' || policy.scope === 'BRAND_PAYOUT_READ') {
    if (!policy.brandId) throw new ForbiddenException('Brand access is required');
    await tx.$queryRaw`SELECT "_id" FROM "Brand" WHERE "_id" = ${policy.brandId}::uuid FOR UPDATE`;
    const brand = await tx.brand.findUnique({ where: { id: policy.brandId }, select: { id: true, ownerId: true, verificationStatus: true } });
    if (!brand || (policy.scope === 'BRAND_OWNER' && !(await hasBrandOwnership(tx, actor.id, brand)))) throw new ForbiddenException('Brand access is required');
    if (operation.method === 'POST' && operation.route.replace(/\/$/, '') === '/brands/:brandId/subscription/checkout' &&
      brand.verificationStatus !== 'APPROVED')
      throw new ForbiddenException('Only verified brands are eligible for subscription tier upgrades.');
    if (policy.scope === 'BRAND_PAYOUT_READ' && !(await effectiveBrandPermissions(tx, actor.id, brand.id)).includes('payouts.read')) throw new ForbiddenException('Payout read permission is required');
  }
}

/** One request can contain several transactions; another request cannot reuse its proof. */
export async function enforceCriticalTransaction(tx: Prisma.TransactionClient, operation: AdaptiveOperation) {
  const context = getLiveSecurityContext();
  if (!context || context.operation !== operation) throw new ForbiddenException('A live authorized request is required');
  const { user, session } = await lockCurrentSecurityActor(tx, operation.actor);
  await assertMandatoryAdaptiveScope(tx, operation);
  if (session.riskState !== 'NORMAL') throw new ForbiddenException('Verify your session before continuing');
  if (hasSuperAdminTestMfaException(user.role)) return;
  const [id, secret, extra] = (operation.proof ?? '').split('.');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id ?? '') ||
    !/^[A-Za-z0-9_-]{43}$/.test(secret ?? '') || extra !== undefined) throw new HttpException({ code: 'STEP_UP_REQUIRED', message: 'Verify this exact action before continuing.' }, 428);
  const consumed = await tx.securityStepUpChallenge.updateMany({ where: { id, userId: operation.actor.id, sessionId: operation.actor.sid,
    authVersion: operation.actor.authVersion, operationDigest: operation.operationDigest, proofHash: secretDigest(secret),
    sensitivity: 'CRITICAL_CHANGE', verifiedAt: { not: null }, expiresAt: { gt: new Date() },
    OR: [{ usedAt: null }, { usedByRequestId: operation.requestId }] }, data: { usedAt: new Date(), usedByRequestId: operation.requestId } });
  if (consumed.count !== 1) throw new HttpException({ code: 'STEP_UP_REQUIRED', message: 'This approval expired or was already used. Verify again.' }, 428);
}

/** Workers and ordinary account writes retain their existing unit of work. */
export function withSecurityWrite<T>(prisma: PrismaService, work: (client: Prisma.TransactionClient) => Promise<T>): Promise<T> {
  const context = getLiveSecurityContext();
  if (!context || (context.operation.policy.sensitivity !== 'CRITICAL_CHANGE' && context.operation.policy.scope !== 'ADMIN')) return work(prisma);
  return withSecurityTransaction(prisma, work);
}

/** Explicit unit of work; do not hold a DB transaction around network I/O. */
export async function withSecurityTransaction<T>(prisma: PrismaService, work: (client: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number; isolationLevel?: Prisma.TransactionIsolationLevel }): Promise<T> {
  const context = getLiveSecurityContext();
  if (!context || (context.operation.policy.sensitivity !== 'CRITICAL_CHANGE' && context.operation.policy.scope !== 'ADMIN')) return prisma.$transaction(work, options);
  if (context.transaction) return work(context.transaction);
  try {
    return await prisma.$transaction(async (tx) => {
      if (context.operation.policy.sensitivity === 'CRITICAL_CHANGE') await enforceCriticalTransaction(tx, context.operation);
      else await enforceAdministrativeTransaction(tx, context.operation);
      const transactionLease = createSecurityLease();
      try {
        const result = await securityRequestContext.run({ ...context, transaction: tx, transactionLease }, () => work(tx));
        // Abort/completion during awaited work must roll back before commit.
        getLiveSecurityContext();
        if (context.operation.policy.sensitivity !== 'CRITICAL_CHANGE')
          await enforceAdministrativeTransaction(tx, context.operation);
        getLiveSecurityContext();
        return result;
      } finally { transactionLease.close(); }
    }, { ...options, isolationLevel: context.operation.policy.sensitivity === 'CRITICAL_CHANGE'
      ? 'Serializable' : options?.isolationLevel ?? 'ReadCommitted' });
  } catch (error: unknown) {
    if (isSecurityTransactionConflict(error)) {
      throw new ConflictException({ code: 'SECURITY_TRANSACTION_CONFLICT', message: 'The action changed concurrently. Check its status and retry.' });
    }
    throw error;
  }
}
