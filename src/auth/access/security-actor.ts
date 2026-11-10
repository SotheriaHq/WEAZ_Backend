import { HttpException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { lockSecurityAccount } from './lock-security-account';

export type SecurityActor = { id: string; sid: string; authVersion: number; role: string };

/** Recheck at the transaction boundary; access-JWT verification alone is insufficient. */
export async function lockCurrentSecurityActor(tx: Prisma.TransactionClient, actor: SecurityActor) {
  await lockSecurityAccount(tx, actor.id);
  const user = await tx.user.findUnique({ where: { id: actor.id }, select: {
    id: true, status: true, authVersion: true, role: true, password: true,
    mustResetPassword: true, username: true, email: true,
  } });
  if (!user || user.status !== 'ACTIVE' || user.authVersion !== actor.authVersion || user.role !== actor.role ||
    (user.mustResetPassword && ['Admin', 'SuperAdmin'].includes(user.role))) throw new UnauthorizedException('Session is no longer valid');
  const session = await tx.refreshToken.findFirst({ where: {
    id: actor.sid, userId: actor.id, sessionVersion: 1, issuedAuthVersion: actor.authVersion, expiresAt: { gt: new Date() }, riskState: { not: 'REVOKED' },
    OR: [{ parentSessionId: null }, { parentSession: { userId: actor.id, sessionVersion: 1, issuedAuthVersion: actor.authVersion, expiresAt: { gt: new Date() }, riskState: { not: 'REVOKED' } } }],
  } });
  if (!session) throw new UnauthorizedException('Session is no longer valid');
  if (session.parentSessionId) {
    const parent = await tx.refreshToken.findFirst({ where: { id: session.parentSessionId, userId: actor.id,
      sessionVersion: 1, issuedAuthVersion: actor.authVersion, expiresAt: { gt: new Date() }, riskState: { not: 'REVOKED' } },
      select: { id: true, riskState: true } });
    if (!parent) throw new UnauthorizedException('Session is no longer valid');
    if (parent.riskState !== 'NORMAL') {
      const serverNow = Date.now();
      throw new HttpException({ code: 'PARENT_SESSION_VERIFICATION_REQUIRED',
        parentSessionId: parent.id, sensitivity: 'SENSITIVE_READ', serverNow: new Date(serverNow).toISOString(),
        expiresAt: new Date(serverNow + 300_000).toISOString(),
        message: 'Verify the flagged phone session before resuming Studio.',
        review: { title: 'Verify your phone session to resume Studio' } }, 428);
    }
  }
  return { user, session };
}
