import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes } from 'crypto';
import { Request, Response } from 'express';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { UserType } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { TokenService } from './helper/general.helper';

const HANDOFF_TTL_MS = 60_000;
const HANDOFF_BCRYPT_ROUNDS = 10;
const ALLOWED_STUDIO_TABS = new Set([
  'overview',
  'store',
  'orders',
  'messages',
  'customers',
  'analytics',
  'finance',
]);

const ALLOWED_STUDIO_PATHS = [
  /^\/studio$/,
  /^\/studio\/store$/,
  /^\/studio\/verification$/,
  /^\/studio\/verification\/apply$/,
  /^\/studio\/verification\/submitted$/,
  /^\/studio\/store\/collections\/new$/,
  /^\/studio\/store\/products\/new$/,
  /^\/studio\/store\/products\/[A-Za-z0-9_-]+$/,
  /^\/studio\/store\/products\/[A-Za-z0-9_-]+\/edit$/,
  /^\/studio\/custom-orders$/,
  /^\/studio\/custom-orders\/[A-Za-z0-9_-]+$/,
  /^\/studio\/messages$/,
  /^\/studio\/store\/setup$/,
  /^\/studio\/store\/essentials$/,
];

type RequestUser = {
  id: string;
  type?: string | null;
  authVersion?: number;
  sid?: string;
};

@Injectable()
export class StudioHandoffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tokenService: TokenService,
  ) {}

  private extractClientIp(req: Request): string | null {
    return req.ip || req.socket?.remoteAddress || null;
  }

  private normalizeStudioPath(path: string): string {
    const trimmed = String(path ?? '').trim();
    if (!trimmed.startsWith('/studio')) {
      throw new BadRequestException('Studio handoff requires a Studio path');
    }

    try {
      const parsed = new URL(trimmed, 'https://wiez.local');
      if (
        parsed.pathname !== '/studio' &&
        !parsed.pathname.startsWith('/studio/')
      ) {
        throw new BadRequestException('Studio handoff requires a Studio path');
      }
      if (
        !ALLOWED_STUDIO_PATHS.some((pattern) => pattern.test(parsed.pathname))
      ) {
        throw new BadRequestException('Studio handoff path is not allowed');
      }
      const tab = parsed.searchParams.get('tab');
      const queryKeys = Array.from(parsed.searchParams.keys());
      if (parsed.pathname !== '/studio' && queryKeys.length > 0) {
        throw new BadRequestException(
          'Studio handoff query is not allowed for this path',
        );
      }
      if (
        parsed.pathname === '/studio' &&
        queryKeys.some((key) => key !== 'tab')
      ) {
        throw new BadRequestException('Studio handoff query is not allowed');
      }
      if (
        parsed.pathname === '/studio' &&
        tab &&
        !ALLOWED_STUDIO_TABS.has(tab)
      ) {
        throw new BadRequestException('Studio handoff tab is not allowed');
      }
      return `${parsed.pathname}${parsed.search}${parsed.hash}`;
    } catch {
      throw new BadRequestException('Invalid Studio path');
    }
  }

  private parseCode(rawCode: string) {
    const [id, secret, ...extra] = String(rawCode ?? '').split('.');
    if (extra.length > 0 || !id || !secret) {
      throw new BadRequestException('Malformed Studio handoff code');
    }
    return { id, secret };
  }

  async create(user: RequestUser, intendedPath: string, req: Request) {
    if (!user?.id) {
      throw new UnauthorizedException('Authentication required');
    }
    if (user.type !== UserType.BRAND) {
      throw new ForbiddenException(
        'Studio handoff is only available for brand accounts',
      );
    }

    const normalizedPath = this.normalizeStudioPath(intendedPath);
    const id = uuidv4();
    const secret = randomBytes(32).toString('base64url');
    const codeHash = await bcrypt.hash(secret, HANDOFF_BCRYPT_ROUNDS);
    const expiresAt = new Date(Date.now() + HANDOFF_TTL_MS);

    void this.prisma.studioHandoffCode
      .deleteMany({
        where: {
          expiresAt: { lt: new Date(Date.now() - 60 * 60 * 1000) },
        },
      })
      .catch(() => undefined);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "_id" FROM "User" WHERE "_id" = ${user.id}::uuid FOR UPDATE`;
      const authority = await tx.user.findUnique({ where: { id: user.id }, select: { authVersion: true, status: true, type: true } });
      if (!authority || authority.status !== 'ACTIVE' || authority.type !== 'BRAND' || authority.authVersion !== user.authVersion || !user.sid) {
        throw new UnauthorizedException('Source session is no longer valid');
      }
      const source = await tx.refreshToken.findFirst({ where: { id: user.sid, userId: user.id,
        sessionVersion: 1, issuedAuthVersion: authority.authVersion, riskState: 'NORMAL', expiresAt: { gt: new Date() },
        OR: [{ parentSessionId: null }, { parentSession: { userId: user.id, expiresAt: { gt: new Date() },
          sessionVersion: 1, issuedAuthVersion: authority.authVersion, riskState: 'NORMAL' } }] } });
      if (!source) throw new UnauthorizedException('Source session is no longer valid');
      await tx.studioHandoffCode.create({ data: {
        id, codeHash, userId: user.id, intendedPath: normalizedPath,
        sourceSessionId: source.id, sourceAuthVersion: authority.authVersion,
        userAgent: req.headers['user-agent'] ?? null, ipAddress: this.extractClientIp(req), expiresAt,
      } });
    });

    return {
      code: `${id}.${secret}`,
      expiresAt: expiresAt.toISOString(),
      intendedPath: normalizedPath,
    };
  }

  async exchange(rawCode: string, req: Request, res: Response) {
    const { id, secret } = this.parseCode(rawCode);
    const handoff = await this.prisma.studioHandoffCode.findUnique({
      where: { id },
      include: {
        user: {
          select: {
            id: true,
            type: true,
            status: true,
          },
        },
      },
    });

    if (!handoff || handoff.usedAt || handoff.expiresAt <= new Date()) {
      throw new UnauthorizedException(
        'Studio handoff code is invalid or expired',
      );
    }

    const valid = await bcrypt.compare(secret, handoff.codeHash);
    if (!valid) {
      throw new UnauthorizedException('Studio handoff code is invalid');
    }

    if (handoff.user?.type !== UserType.BRAND) {
      throw new ForbiddenException(
        'Studio handoff is only available for brand accounts',
      );
    }
    if (handoff.user?.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is not active');
    }

    const tokens = await this.tokenService.generateWebSessionForUserId(
      handoff.userId,
      req,
      res,
      handoff.id,
    );

    return {
      accessToken: tokens.accessToken,
      intendedPath: handoff.intendedPath,
    };
  }
}
