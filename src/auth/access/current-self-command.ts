import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { getLiveCommandOperation } from './command-response-boundary';
import { getLiveSecurityContext } from './security-request-context';
import { lockCurrentSecurityActor } from './security-actor';
import { lockSecurityAccount } from './lock-security-account';

/** Ordinary session commands do not consume MFA proofs, but their original
 * principal must still be current when they write. Never adopt a later
 * account revision merely because the retained session has the same ID. */
export async function assertCurrentSelfCommand(tx: Prisma.TransactionClient, userId: string, sid?: string) {
  const operation = getLiveSecurityContext()?.operation ?? getLiveCommandOperation();
  if (!operation) return () => undefined;
  if (operation.actor.id !== userId || (sid && operation.actor.sid !== sid))
    throw new ForbiddenException('This session cannot modify another account.');
  await lockSecurityAccount(tx, userId);
  // Risk observations update session rows without taking the account lock.
  // Lock the caller and its source in deterministic order before reading their
  // authority, so an observation cannot overtake this committed instruction.
  const locked = await tx.$queryRaw<Array<{ _id: string; expiresAt: Date; createdAt: Date }>>`
    SELECT "_id", "expiresAt", "createdAt" FROM "RefreshToken"
    WHERE "_id" = ${operation.actor.sid}::uuid OR "_id" =
      (SELECT "parentSessionId" FROM "RefreshToken" WHERE "_id" = ${operation.actor.sid}::uuid)
    ORDER BY "_id" FOR UPDATE`;
  const current = await lockCurrentSecurityActor(tx, operation.actor);
  if (current.session.riskState !== 'NORMAL')
    throw new ForbiddenException('Verify this session before changing its security settings.');
  const deadlines = locked.map(row => row.expiresAt.getTime());
  if (['Admin', 'SuperAdmin'].includes(current.user.role)) {
    const source = locked.find(row => row._id === (current.session.parentSessionId ?? current.session.id));
    if (!source) throw new UnauthorizedException('Session is no longer valid');
    deadlines.push(source.createdAt.getTime() + 24 * 60 * 60 * 1000);
  }
  const deadline = Math.min(...deadlines);
  // Called after all writes, including intentional deletion of the source by
  // logout-all. A deleted source cannot be re-read, but its locked deadline and
  // the live request must still be valid; expiry rolls the transaction back.
  return () => {
    if ((getLiveSecurityContext()?.operation ?? getLiveCommandOperation()) !== operation || Date.now() >= deadline)
      throw new UnauthorizedException('Session is no longer valid');
  };
}
