import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import type { SecurityActor } from './security-actor';
import { requiredRecoveryApprovals } from './mfa-environment-policy';

export const MFA_RECOVERY_REVIEW_MS = 7 * 24 * 60 * 60_000;
export const MFA_RECOVERY_APPROVAL_MS = 24 * 60 * 60_000;
export const MFA_RECOVERY_EMAIL_MS = 10 * 60_000;

export function recoveryApprovalIsLive(review: {
  reviewerId: string | null; reviewerAuthVersion: number;
  reviewer: null | { id: string; authVersion: number; status: string; role: string; mustResetPassword: boolean;
    adminPermissionGrants: Array<{ permissionCode: string }> };
}, targetUserId: string) {
  const user = review.reviewer;
  return Boolean(user && review.reviewerId === user.id && user.id !== targetUserId &&
    user.status === 'ACTIVE' && !user.mustResetPassword && user.authVersion === review.reviewerAuthVersion &&
    (user.role === 'SuperAdmin' || (user.role === 'Admin' &&
      user.adminPermissionGrants.some(grant => grant.permissionCode === ADMIN_PERMISSIONS.USERS_MFA_RECOVER))));
}

export async function requireApprovedMfaRecovery(tx: Prisma.TransactionClient, actor: SecurityActor, id: string) {
  const recovery = await tx.securityMfaRecoveryRequest.findFirst({ where: { id, userId: actor.id }, include: {
    user: { select: { role: true, status: true, authVersion: true } },
    reviews: { where: { decision: 'APPROVE' }, orderBy: { createdAt: 'desc' }, take: 2, include: { reviewer: { select: {
      id: true, authVersion: true, status: true, role: true, mustResetPassword: true,
      adminPermissionGrants: { where: { permissionCode: ADMIN_PERMISSIONS.USERS_MFA_RECOVER }, select: { permissionCode: true } },
    } } } },
  } });
  if (!recovery || recovery.status !== 'APPROVED' || recovery.authVersion !== actor.authVersion ||
    recovery.user.role !== actor.role || recovery.user.status !== 'ACTIVE' || recovery.user.authVersion !== actor.authVersion ||
    recovery.expiresAt.getTime() <= Date.now() || !recovery.approvedUntil || recovery.approvedUntil.getTime() <= Date.now())
    throw new ConflictException({ code: 'MFA_RECOVERY_NOT_APPROVED', message: 'Recovery is not approved, has expired, or account security changed. Request a new review.' });
  const approvals = recovery.reviews.filter(review => review.revision === recovery.revision && recoveryApprovalIsLive(review, actor.id));
  if (new Set(approvals.map(review => review.reviewerId)).size < requiredRecoveryApprovals(recovery.user.role))
    throw new ForbiddenException({ code: 'MFA_RECOVERY_REVIEW_CHANGED', message: 'Two current independent approvals are required. Cancel this request and ask support for a new review.' });
  return recovery;
}

/** Called only after a replacement code has been verified, in the same account-locked transaction. */
export async function completeMfaRecovery(tx: Prisma.TransactionClient, actor: SecurityActor, recoveryId: string,
  factorId: string, parentSessionId: string | null) {
  await requireApprovedMfaRecovery(tx, actor, recoveryId);
  const consumed = await tx.securityMfaRecoveryRequest.updateMany({ where: { id: recoveryId, userId: actor.id,
    status: 'APPROVED', authVersion: actor.authVersion, approvedUntil: { gt: new Date() }, expiresAt: { gt: new Date() } },
    data: { status: 'COMPLETED', completedAt: new Date() } });
  if (consumed.count !== 1) throw new ConflictException('Recovery changed. Reload its status before continuing.');
  await tx.securityFactor.updateMany({ where: { userId: actor.id, id: { not: factorId }, revokedAt: null, verifiedAt: { not: null } },
    data: { revokedAt: new Date(), secretCiphertext: null } });
  await tx.securityRecoveryCode.deleteMany({ where: { userId: actor.id } });
  // Preserve the confirming session and its native parent so backup codes can be saved.
  // All other access tokens become invalid through the live sid lookup.
  await tx.refreshToken.updateMany({ where: { userId: actor.id,
    id: { notIn: [actor.sid, ...(parentSessionId ? [parentSessionId] : [])] } },
    data: { riskState: 'REVOKED', expiresAt: new Date(), strongAuthenticatedAt: null, strongAuthVersion: null } });
}
