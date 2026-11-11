import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { assertCurrentSelfCommand } from './access/current-self-command';

type Cursor = { time: Date; key: string };
const encode = (time: Date, key: string) => Buffer.from(JSON.stringify([time.toISOString(), key])).toString('base64url');
function decode(value?: string): Cursor | null {
  if (!value) return null;
  try {
    if (value.length > 512) throw new Error();
    const [time, key] = JSON.parse(Buffer.from(value, 'base64url').toString());
    if (typeof time !== 'string' || typeof key !== 'string' || key.length > 100) throw new Error();
    const date = new Date(time);
    if (!Number.isFinite(date.getTime())) throw new Error();
    return { time: date, key };
  } catch { throw new BadRequestException('Invalid session cursor'); }
}

@Injectable()
export class SecuritySessionsService {
  constructor(private readonly prisma: PrismaService) {}

  private deviceFilter(key: string): { deviceKey: string | null } {
    if (/^[a-f0-9]{64}$/.test(key)) return { deviceKey: key };
    if (key === 'unidentified') return { deviceKey: null };
    throw new BadRequestException('Invalid device identifier');
  }

  async listDevices(userId: string, sid: string, cursor?: string) {
    const after = decode(cursor);
    if (after) this.deviceFilter(after.key);
    const boundary = after ? Prisma.sql`WHERE ("lastUsedAt", "key") < (${after.time}, ${after.key})` : Prisma.empty;
    const rows = await this.prisma.$queryRaw<Array<{
      key: string; deviceName: string | null; sessionCount: bigint; activeSessionCount: bigint; lastUsedAt: Date; isCurrentDevice: boolean;
    }>>(Prisma.sql`
      WITH devices AS (
        SELECT COALESCE(r."deviceKey", 'unidentified') AS "key",
          (ARRAY_AGG(r."deviceName" ORDER BY COALESCE(r."lastUsedAt", r."createdAt") DESC)
            FILTER (WHERE r."deviceName" IS NOT NULL))[1] AS "deviceName", COUNT(*) AS "sessionCount",
          COUNT(*) FILTER (WHERE r."endedAt" IS NULL AND r."expiresAt" > NOW()) AS "activeSessionCount",
          MAX(COALESCE(r."lastUsedAt", r."createdAt")) AS "lastUsedAt",
          BOOL_OR(r."id" = ${sid}::uuid) AS "isCurrentDevice"
        FROM "SecuritySessionHistory" r
        WHERE r."userId" = ${userId}::uuid AND
          ((r."endedAt" IS NULL AND r."expiresAt" > NOW()) OR COALESCE(r."endedAt", r."expiresAt") > NOW() - INTERVAL '30 days')
        GROUP BY COALESCE(r."deviceKey", 'unidentified')
      ) SELECT * FROM devices ${boundary} ORDER BY "lastUsedAt" DESC, "key" DESC LIMIT 11
    `);
    const items = rows.slice(0, 10).map((row) => ({ ...row, sessionCount: Number(row.sessionCount), activeSessionCount: Number(row.activeSessionCount) }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > 10 && last ? encode(last.lastUsedAt, last.key) : null };
  }

  async listDeviceSessions(userId: string, sid: string, key: string, cursor?: string) {
    const device = this.deviceFilter(key);
    const after = decode(cursor);
    if (after && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(after.key)) throw new BadRequestException('Invalid session cursor');
    const now = new Date();
    const current = await this.prisma.refreshToken.findFirst({ where: { id: sid, userId }, select: { parentSessionId: true } });
    const rows = await this.prisma.securitySessionHistory.findMany({
      where: { userId, ...device, AND: [
        { OR: [{ endedAt: null, expiresAt: { gt: now } },
          { endedAt: { gt: new Date(now.getTime() - 30 * 86400000) } },
          { endedAt: null, expiresAt: { gt: new Date(now.getTime() - 30 * 86400000) } }] },
        ...(after ? [{ OR: [{ createdAt: { lt: after.time } }, { createdAt: after.time, id: { lt: after.key } }] }] : []),
      ] },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: 21,
      select: { id: true, userAgent: true, deviceName: true, ipAddressMasked: true,
        createdAt: true, lastUsedAt: true, expiresAt: true, parentSessionId: true, endedAt: true, endedReason: true },
    });
    const items = rows.slice(0, 20).map(({ parentSessionId, ...row }) => ({
      ...row, isCurrentSession: row.id === sid, isCurrentSource: row.id === current?.parentSessionId,
      isActive: !row.endedAt && row.expiresAt > now,
      context: parentSessionId ? 'Studio' : 'Sign-in',
    }));
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > 20 && last ? encode(last.createdAt, last.id) : null };
  }

  async revokeDevice(userId: string, sid: string, key: string) {
    const device = this.deviceFilter(key);
    return this.prisma.$transaction(async (tx) => {
      const finish = await assertCurrentSelfCommand(tx, userId, sid);
      await tx.$queryRaw`SELECT "_id" FROM "User" WHERE "_id" = ${userId}::uuid FOR UPDATE`;
      const current = await tx.refreshToken.findFirst({ where: { id: sid, userId }, select: { parentSessionId: true } });
      if (!current) throw new UnauthorizedException('Session is no longer valid');
      const keep = [sid, current.parentSessionId].filter((id): id is string => Boolean(id));
      const result = await tx.refreshToken.deleteMany({ where: { userId, ...device, id: { notIn: keep } } });
      finish();
      return { revokedCount: result.count };
    });
  }
}
