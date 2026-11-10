import { UnauthorizedException } from '@nestjs/common';
import type { PrismaService } from 'src/prisma/prisma.service';
import type { AuthJwtClaims } from '../dto/auth-response.dto';
import { evaluatePrincipalPolicy } from './principal-policy';

/** One projected read, shared by HTTP and realtime; never trusts JWT grants. */
export async function resolveCurrentPrincipal(prisma: PrismaService, claims: AuthJwtClaims) {
  if (typeof claims.sid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.sid)) {
    throw new UnauthorizedException('Sign in again to secure this session');
  }
  const now = new Date();
  const actor = await prisma.user.findUnique({
    where: { id: claims.sub },
    select: {
      id: true, role: true, username: true, type: true, status: true,
      mustResetPassword: true, authVersion: true,
      refreshTokens: {
        where: { id: claims.sid, sessionVersion: 1, issuedAuthVersion: claims.authVersion, riskState: { not: 'REVOKED' }, expiresAt: { gt: now },
          OR: [{ parentSessionId: null }, { parentSession: { userId: claims.sub, sessionVersion: 1, issuedAuthVersion: claims.authVersion, riskState: { not: 'REVOKED' }, expiresAt: { gt: now } } }] },
        select: { id: true, userId: true, sessionVersion: true, issuedAuthVersion: true, parentSessionId: true, userAgent: true,
          ipAddress: true, locationLabel: true, lastUsedAt: true, expiresAt: true, createdAt: true, updatedAt: true,
          deviceKey: true, deviceName: true, riskState: true, riskScore: true, riskSequence: true,
          riskObservedAt: true, riskReasons: true, strongAuthenticatedAt: true, strongAuthVersion: true },
      },
      adminPermissionGrants: { select: { permissionCode: true } },
    },
  });
  const decision = evaluatePrincipalPolicy(actor, claims);
  if (decision.outcome !== 'allow' || !actor || actor.refreshTokens.length !== 1) {
    throw new UnauthorizedException('Session is no longer valid');
  }
  return {
    id: actor.id, sub: actor.id, sid: claims.sid, role: actor.role, username: actor.username,
    type: actor.type, authVersion: actor.authVersion,
    permissions: actor.adminPermissionGrants.map((grant) => grant.permissionCode),
    mustResetPassword: actor.mustResetPassword,
    securitySession: actor.refreshTokens[0],
  };
}
