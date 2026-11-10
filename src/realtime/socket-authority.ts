import type { Socket } from 'socket.io';
import { Prisma } from '@prisma/client';
import type { PrismaService } from 'src/prisma/prisma.service';
import { evaluatePrincipalPolicy } from 'src/auth/access/principal-policy';
import { resourceUuid } from 'src/common/content-audience';

type CurrentSocketAuthority = {
  id: string; userId: string; sessionVersion: number; issuedAuthVersion: number; riskState: string;
  expiresAt: Date; parentSessionId: string | null; parentUserId: string | null;
  parentSessionVersion: number | null; parentIssuedAuthVersion: number | null; parentRiskState: string | null;
  parentExpiresAt: Date | null; role: string; status: string; authVersion: number; mustResetPassword: boolean;
};

/** One bounded relational query per batch, never one query per socket. Socket
 * claims were signature-verified at connect; current DB authority still wins. */
export async function authorizedSockets(prisma: PrismaService, sockets: readonly Socket[]): Promise<Socket[]> {
  if (sockets.length > 100) throw new RangeError('Socket authority requires bounded batches');
  const ids = [...new Set(sockets.map(socket => socket.data.principalClaims?.sid).filter(id => typeof id === 'string' && resourceUuid.test(id)))];
  if (!ids.length) return [];
  const sessions = await prisma.$queryRaw<CurrentSocketAuthority[]>(Prisma.sql`
    SELECT s."_id" AS id, s."userId", s."sessionVersion", s."issuedAuthVersion", s."riskState", s."expiresAt", s."parentSessionId",
      p."userId" AS "parentUserId", p."sessionVersion" AS "parentSessionVersion", p."issuedAuthVersion" AS "parentIssuedAuthVersion",
      p."riskState" AS "parentRiskState", p."expiresAt" AS "parentExpiresAt",
      u."role", u."status", u."authVersion", u."mustResetPassword"
    FROM "RefreshToken" s JOIN "User" u ON u."_id" = s."userId"
      LEFT JOIN "RefreshToken" p ON p."_id" = s."parentSessionId"
    WHERE s."_id" = ANY(${ids}::uuid[])`);
  const byId = new Map(sessions.map(session => [session.id, session]));
  const now = Date.now(); const allowed: Socket[] = [];
  for (const socket of sockets) {
    const claims = socket.data.principalClaims, session = byId.get(claims?.sid);
    const parentValid = !session?.parentSessionId || (session.parentUserId === session.userId && session.parentSessionVersion === 1 &&
      session.parentIssuedAuthVersion === claims.authVersion && session.parentExpiresAt && session.parentExpiresAt.getTime() > now && session.parentRiskState !== 'REVOKED');
    const valid = socket.connected && Number.isFinite(socket.data.accessExpiresAt) && socket.data.accessExpiresAt > now &&
      session && session.userId === claims?.sub && socket.data.userId === claims.sub && session.sessionVersion === 1 &&
      session.issuedAuthVersion === claims.authVersion && session.expiresAt.getTime() > now && session.riskState !== 'REVOKED' &&
      parentValid && evaluatePrincipalPolicy({ id: session.userId, role: session.role, status: session.status,
        authVersion: session.authVersion, mustResetPassword: session.mustResetPassword }, claims).outcome === 'allow';
    if (!valid) { if (socket.connected) socket.disconnect(true); continue; }
    // A challenge keeps MFA recovery reachable over HTTP but pauses content
    // delivery/presence until stronger verification normalizes the session.
    if (session.riskState === 'NORMAL' && (!session.parentSessionId || session.parentRiskState === 'NORMAL')) allowed.push(socket);
  }
  return allowed;
}
