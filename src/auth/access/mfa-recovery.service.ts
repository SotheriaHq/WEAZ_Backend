import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
  ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt, randomUUID } from 'crypto';
import type { Prisma, SecurityMfaRecoveryDecision } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { EmailService } from 'src/email/email.service';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { PasswordService } from '../helper/password.service';
import { lockCurrentSecurityActor, type SecurityActor } from './security-actor';
import { mfaPasswordProof } from './mfa-password-proof';
import { operationDigest, matchesOperationDigest, randomSecuritySecret, secretDigest } from './security-factor-crypto';
import { requireApprovedMfaRecovery, MFA_RECOVERY_REVIEW_MS, MFA_RECOVERY_APPROVAL_MS, MFA_RECOVERY_EMAIL_MS } from './mfa-recovery-state';
import { getLiveSecurityContext } from './security-request-context';
import { withSecurityTransaction } from './transactional-enforcement';
import { requiredRecoveryApprovals } from './mfa-environment-policy';

const openStates = ['PENDING_REVIEW', 'NEEDS_INFORMATION', 'APPROVED'] as const;
const text = (value: string, max: number) => {
  const cleaned = typeof value === 'string' ? value.trim() : '';
  if (!cleaned || cleaned.length > max) throw new BadRequestException(`Enter a description of at most ${max} characters.`);
  return cleaned;
};
export type MfaRecoveryReviewInput = { revision: number; decision: SecurityMfaRecoveryDecision;
  identityVerified?: boolean; evidenceReference: string; message?: string };

@Injectable()
export class MfaRecoveryService {
  constructor(private readonly prisma: PrismaService, private readonly config: ConfigService,
    private readonly passwords: PasswordService, private readonly email: EmailService) {}

  private async notice(tx: Prisma.TransactionClient, userId: string, event: string, message: string) {
    const user = await tx.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const content = `${message} No WIEZ support agent should ask for your password, authenticator setup key, or recovery codes. If you did not request this, change your password and revoke other sessions in Settings.`;
    const queued = await this.email.send(user.email, 'Your WIEZ verification recovery', `<p>${content}</p>`, content,
      { recipientUserId: userId, scenarioKey: 'auth.mfa.recovery', priority: 'P0_SECURITY', idempotencyKey: `mfa-recovery:${event}` }, tx);
    if (!['QUEUED', 'SENT'].includes(queued.dispatchStatus))
      throw new ServiceUnavailableException('The security notice could not be saved. No recovery change was committed.');
  }
  private expire(tx: Prisma.TransactionClient, actor: SecurityActor) {
    return tx.securityMfaRecoveryRequest.updateMany({ where: { userId: actor.id, status: { in: [...openStates] },
      OR: [{ expiresAt: { lte: new Date() } }, { authVersion: { not: actor.authVersion } },
        { status: 'APPROVED', approvedUntil: { lte: new Date() } }] }, data: { status: 'EXPIRED' } });
  }
  private present(request: {
    id: string; status: string; revision: number; reason: string; publicMessage: string | null;
    expiresAt: Date; approvedUntil: Date | null; createdAt: Date; completedAt: Date | null;
  }, approvals: number, requiredApprovals = 2) {
    return { id: request.id, status: request.status, revision: request.revision, reason: request.reason,
      message: request.publicMessage, approvals, requiredApprovals, expiresAt: request.expiresAt,
      approvedUntil: request.approvedUntil, createdAt: request.createdAt, completedAt: request.completedAt };
  }
  async status(actor: SecurityActor) {
    return this.prisma.$transaction(async tx => {
      const { user } = await lockCurrentSecurityActor(tx, actor); await this.expire(tx, actor);
      const request = await tx.securityMfaRecoveryRequest.findFirst({ where: { userId: actor.id }, orderBy: { createdAt: 'desc' } });
      if (!request) return { request: null };
      const approvals = await tx.securityMfaRecoveryReview.count({ where: { requestId: request.id, revision: request.revision, decision: 'APPROVE' } });
      let reviewChanged = false;
      if (request.status === 'APPROVED') {
        try { await requireApprovedMfaRecovery(tx, actor, request.id); }
        catch (error) {
          if (!(error instanceof ForbiddenException || error instanceof ConflictException)) throw error;
          reviewChanged = true;
        }
      }
      return { request: { ...this.present(request, approvals, requiredRecoveryApprovals(user.role)), reviewChanged } };
    });
  }
  async request(actor: SecurityActor, password: string, reason: string) {
    const description = text(reason, 1000);
    const hash = await mfaPasswordProof(this.prisma, this.passwords, actor, password);
    await this.prisma.$transaction(async tx => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== hash) throw new ConflictException('Account security changed. Sign in again.');
      if (!(await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { isEmailVerified: true } })).isEmailVerified)
        throw new BadRequestException('Verify your account email before asking for recovery.');
      if (!(await tx.securityFactor.count({ where: { userId: actor.id, verifiedAt: { not: null }, revokedAt: null } })))
        throw new ConflictException('No verification methods need recovery. Set up your first method instead.');
      await this.expire(tx, actor);
      const requiredApprovals = requiredRecoveryApprovals(user.role);
      const existing = await tx.securityMfaRecoveryRequest.findFirst({ where: { userId: actor.id, status: { in: [...openStates] } } });
      if (existing) {
        if (requiredApprovals === 0 && existing.status !== 'APPROVED') {
          await tx.securityMfaRecoveryRequest.update({ where: { id: existing.id }, data: { status: 'APPROVED',
            approvedUntil: new Date(Math.min(Date.now() + MFA_RECOVERY_APPROVAL_MS, existing.expiresAt.getTime())), publicMessage: null } });
          await this.notice(tx, actor.id, `${existing.id}:test-policy-approved`,
            'Your test-environment SuperAdmin recovery may continue without independent review. Your password, verified-email code and a verified replacement method are still required. Existing verification methods remain active until replacement succeeds.');
        }
        return;
      }
      if (await tx.securityMfaRecoveryRequest.count({ where: { userId: actor.id, authVersion: actor.authVersion, createdAt: { gt: new Date(Date.now() - 86_400_000) } } }) >= 3)
        throw new BadRequestException('Three recovery requests have already been created today. Wait before starting another.');
      const recovery = await tx.securityMfaRecoveryRequest.create({ data: { userId: actor.id, authVersion: actor.authVersion,
        reason: description, expiresAt: new Date(Date.now() + MFA_RECOVERY_REVIEW_MS),
        ...(requiredApprovals === 0 ? { status: 'APPROVED' as const, approvedUntil: new Date(Date.now() + MFA_RECOVERY_APPROVAL_MS) } : {}),
      } });
      await this.notice(tx, actor.id, `${recovery.id}:requested`, requiredApprovals === 0
        ? 'An account recovery request was submitted. This test-environment SuperAdmin is exempt from independent review. Your password, verified-email code and a verified replacement method are still required. Existing verification methods remain active until replacement succeeds.'
        : 'An account recovery request was submitted. Existing verification methods remain active. Two independent administrator approvals are required.');
    });
    return this.status(actor);
  }
  async update(actor: SecurityActor, id: string, password: string, information: string | null) {
    const hash = await mfaPasswordProof(this.prisma, this.passwords, actor, password);
    const reason = information === null ? null : text(information, 1000);
    await this.prisma.$transaction(async tx => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== hash) throw new ConflictException('Account security changed. Sign in again.');
      await this.expire(tx, actor);
      const request = await tx.securityMfaRecoveryRequest.findFirst({ where: { id, userId: actor.id } });
      if (!request) throw new NotFoundException('Recovery request not found.');
      if (reason !== null && request.status !== 'NEEDS_INFORMATION') throw new ConflictException('Support has not requested more information. Reload the request.');
      if (!openStates.some(state => state === request.status)) throw new ConflictException('This recovery request has already ended.');
      await tx.securityMfaRecoveryRequest.update({ where: { id }, data: reason === null ? { status: 'CANCELLED' } : {
        reason, publicMessage: null, status: 'PENDING_REVIEW', revision: { increment: 1 }, approvedUntil: null } });
      // An old pending setup or email proof cannot outlive a cancellation/revision.
      await tx.securityFactor.deleteMany({ where: { userId: actor.id, recoveryRequestId: id, verifiedAt: null } });
      await this.notice(tx, actor.id, `${id}:${request.revision}:${reason === null ? 'cancelled' : 'information'}`,
        reason === null ? 'Your recovery request was cancelled. Your existing verification methods remain active.' : 'Your recovery information was updated. Both approvals must be collected again.');
    });
    return this.status(actor);
  }
  async requestCode(actor: SecurityActor, id: string, password: string) {
    const hash = await mfaPasswordProof(this.prisma, this.passwords, actor, password);
    return this.prisma.$transaction(async tx => {
      const { user } = await lockCurrentSecurityActor(tx, actor);
      if (user.password !== hash) throw new ConflictException('Account security changed. Sign in again.');
      const recovery = await requireApprovedMfaRecovery(tx, actor, id);
      const userState = await tx.user.findUniqueOrThrow({ where: { id: actor.id }, select: { isEmailVerified: true } });
      if (!userState.isEmailVerified) throw new BadRequestException('Verify your account email first.');
      const digest = `RECOVERY:${id}:${recovery.revision}`;
      if (await tx.securityStepUpChallenge.count({ where: { userId: actor.id, operationDigest: digest,
        createdAt: { gt: new Date(Date.now() - 900_000) } } }) >= 3)
        throw new BadRequestException('Wait 15 minutes before asking for more recovery emails.');
      const challengeId = randomUUID(), nonce = randomSecuritySecret(), code = randomInt(0, 100_000_000).toString().padStart(8, '0');
      await tx.securityStepUpChallenge.create({ data: { id: challengeId, userId: actor.id, sessionId: actor.sid,
        authVersion: actor.authVersion, operationDigest: digest, method: 'POST', route: 'mfa-reviewed-recovery',
        sensitivity: 'CRITICAL_CHANGE', nonce, proofHash: operationDigest(this.config, {
          purpose: 'MFA_REVIEWED_RECOVERY', userId: actor.id, sessionId: actor.sid, nonce, code }),
        expiresAt: new Date(Math.min(Date.now() + MFA_RECOVERY_EMAIL_MS, recovery.approvedUntil!.getTime(), recovery.expiresAt.getTime())) } });
      await this.notice(tx, actor.id, `${challengeId}:code`, `Your reviewed recovery code is ${code}. It expires in at most 10 minutes. Use it only to set up your replacement authenticator.`);
      return { challengeId, expiresInSeconds: Math.max(0, Math.floor(Math.min(MFA_RECOVERY_EMAIL_MS,
        recovery.approvedUntil!.getTime() - Date.now(), recovery.expiresAt.getTime() - Date.now()) / 1000)) };
    });
  }
  async confirmCode(actor: SecurityActor, id: string, challengeId: string, code: string) {
    const result = await this.prisma.$transaction(async tx => {
      await lockCurrentSecurityActor(tx, actor);
      const recovery = await requireApprovedMfaRecovery(tx, actor, id);
      const challenge = await tx.securityStepUpChallenge.findFirst({ where: { id: challengeId, userId: actor.id,
        sessionId: actor.sid, authVersion: actor.authVersion, operationDigest: `RECOVERY:${id}:${recovery.revision}`,
        usedAt: null, verifiedAt: null, expiresAt: { gt: new Date() }, attempts: { lt: 5 } } });
      if (!challenge) throw new BadRequestException('Recovery code expired, was used, or has too many failed attempts. Request another code.');
      await tx.securityStepUpChallenge.update({ where: { id: challengeId }, data: { attempts: { increment: 1 } } });
      if (!matchesOperationDigest(this.config, challenge.proofHash ?? '', { purpose: 'MFA_REVIEWED_RECOVERY', userId: actor.id,
        sessionId: actor.sid, nonce: challenge.nonce, code })) return null;
      const secret = randomSecuritySecret();
      await tx.securityStepUpChallenge.update({ where: { id: challengeId }, data: { verifiedAt: new Date(), proofHash: secretDigest(secret) } });
      return { enrollmentProof: `${challengeId}.${secret}` };
    });
    if (!result) throw new BadRequestException('Incorrect recovery email code. Check the latest email and retry.');
    return result;
  }

  async queue(cursor?: string) {
    const rows = await this.prisma.securityMfaRecoveryRequest.findMany({
      where: { status: { in: ['PENDING_REVIEW', 'NEEDS_INFORMATION', 'APPROVED'] }, expiresAt: { gt: new Date() } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: 21, ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      include: { user: { select: { id: true, role: true, status: true, username: true } },
        reviews: { orderBy: { createdAt: 'desc' }, take: 20 } },
    });
    return { items: rows.slice(0, 20), nextCursor: rows.length > 20 ? rows[19].id : null };
  }
  async review(actor: SecurityActor, id: string, input: MfaRecoveryReviewInput) {
    const context = getLiveSecurityContext();
    if (!context || context.operation.actor.id !== actor.id || context.operation.policy.scope !== 'ADMIN' ||
      context.operation.policy.sensitivity !== 'CRITICAL_CHANGE' || !context.operation.requiredAdminPermissions.includes(ADMIN_PERMISSIONS.USERS_MFA_RECOVER))
      throw new ForbiddenException('A current, exact recovery-review approval is required.');
    const reference = text(input.evidenceReference, 200);
    if (input.decision === 'APPROVE' && input.identityVerified !== true)
      throw new BadRequestException('Independently verify the account holder before approving recovery. Email access alone is insufficient.');
    const message = input.decision === 'APPROVE' ? null : text(input.message ?? '', 1000);
    return withSecurityTransaction(this.prisma, async tx => {
      await tx.$queryRaw`SELECT "id" FROM "SecurityMfaRecoveryRequest" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const request = await tx.securityMfaRecoveryRequest.findUnique({ where: { id }, include: { user: { select: { status: true, authVersion: true } } } });
      if (!request) throw new NotFoundException('Recovery request not found.');
      if (request.userId === actor.id) throw new ForbiddenException('You cannot review your own recovery.');
      if (request.status !== 'PENDING_REVIEW' || request.revision !== input.revision || request.expiresAt.getTime() <= Date.now() ||
        request.authVersion !== request.user.authVersion || request.user.status !== 'ACTIVE')
        throw new ConflictException('The request changed or is no longer open for review.');
      if (await tx.securityMfaRecoveryReview.findUnique({ where: { requestId_revision_reviewerId: { requestId: id, revision: input.revision, reviewerId: actor.id } } }))
        throw new ConflictException('You already reviewed this revision. A different authorised administrator must provide the next approval.');
      await tx.securityMfaRecoveryReview.create({ data: { requestId: id, revision: input.revision, reviewerId: actor.id,
        reviewerAuthVersion: actor.authVersion, decision: input.decision, evidenceReference: reference } });
      const approvals = await tx.securityMfaRecoveryReview.count({ where: { requestId: id, revision: input.revision, decision: 'APPROVE' } });
      const status = input.decision === 'REJECT' ? 'REJECTED' : input.decision === 'REQUEST_INFORMATION' ? 'NEEDS_INFORMATION'
        : approvals >= 2 ? 'APPROVED' : 'PENDING_REVIEW';
      await tx.securityMfaRecoveryRequest.update({ where: { id }, data: { status, publicMessage: message,
        approvedUntil: status === 'APPROVED' ? new Date(Math.min(Date.now() + MFA_RECOVERY_APPROVAL_MS, request.expiresAt.getTime())) : null } });
      await this.notice(tx, request.userId, `${id}:${input.revision}:${actor.id}:${input.decision}`,
        status === 'APPROVED' ? 'Two administrators approved your recovery. Your existing methods remain active until you verify a replacement. Open WIEZ security settings to continue.'
          : status === 'NEEDS_INFORMATION' ? 'Support requested more information for your recovery. Open WIEZ security settings to view the request.'
          : status === 'REJECTED' ? 'Your recovery request was not approved. Open WIEZ security settings to view the decision.'
          : 'One administrator reviewed your recovery. A second independent approval is still required. Your verification methods have not changed.');
      return { status, approvals, requiredApprovals: 2 };
    });
  }
}
