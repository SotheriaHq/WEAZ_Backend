import { randomBytes } from 'crypto';
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import {
  AuthUser,
  authUserSelect,
  buildAuthTokenPayload,
} from './prisma-select.helper';
import { ConfigService } from '@nestjs/config';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'accessToken';
const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_REFRESH_TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours for admin roles
const ADMIN_ABSOLUTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours absolute cap
const DEFAULT_BCRYPT_ROUNDS = 10;

@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);

  constructor(
    private readonly jwtService: JwtService,
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  private parsePositiveNumber(
    value: string | undefined,
    fallback: number,
  ): number {
    if (!value) {
      return fallback;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return fallback;
    }
    return parsed;
  }

  private get accessTokenSecret(): string {
    const secret = this.configService.get<string>('JWT_ACCESS_SECRET');
    if (!secret) {
      this.logger.error('JWT_ACCESS_SECRET is not configured');
      throw new Error('Authentication configuration error');
    }
    return secret;
  }

  private get accessTokenCookieName(): string {
    return this.configService.get<string>(
      'ACCESS_TOKEN_COOKIE',
      DEFAULT_ACCESS_TOKEN_COOKIE,
    );
  }

  private get refreshTokenCookieName(): string {
    return this.configService.get<string>(
      'REFRESH_TOKEN_COOKIE',
      DEFAULT_REFRESH_TOKEN_COOKIE,
    );
  }

  private get isSecureCookie(): boolean {
    return (
      this.configService.get<string>('NODE_ENV', '').toLowerCase() ===
      'production'
    );
  }

  private get accessTokenTtlSeconds(): number {
    return this.parsePositiveNumber(
      this.configService.get<string>('JWT_ACCESS_TTL_SECONDS'),
      DEFAULT_ACCESS_TOKEN_TTL_SECONDS,
    );
  }

  private get refreshTokenTtlMilliseconds(): number {
    return this.parsePositiveNumber(
      this.configService.get<string>('JWT_REFRESH_TTL_MS'),
      DEFAULT_REFRESH_TOKEN_TTL_MS,
    );
  }

  private get bcryptRounds(): number {
    return this.parsePositiveNumber(
      this.configService.get<string>('REFRESH_TOKEN_BCRYPT_ROUNDS'),
      DEFAULT_BCRYPT_ROUNDS,
    );
  }

  private isMobileClient(req: Request): boolean {
    const platformHeader = req.headers['x-client-platform'];
    const value = Array.isArray(platformHeader)
      ? platformHeader[0]
      : platformHeader;
    return typeof value === 'string' && value.toLowerCase().includes('mobile');
  }

  private extractClientIp(req: Request): string | null {
    return req.ip || req.socket?.remoteAddress || null;
  }

  private describeRequestLocation(req: Request): string | null {
    const readHeaderValue = (name: string) => {
      const value = req.headers[name];
      if (Array.isArray(value)) {
        return String(value[0] ?? '').trim();
      }
      return typeof value === 'string' ? value.trim() : '';
    };
    const city =
      readHeaderValue('x-vercel-ip-city') || readHeaderValue('cf-ipcity');
    const country =
      readHeaderValue('x-vercel-ip-country') ||
      readHeaderValue('cf-ipcountry') ||
      readHeaderValue('x-appengine-country');
    const parts = [city, country].filter(Boolean);
    return parts.length > 0 ? parts.join(', ') : null;
  }

  private attachAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
    refreshTokenTtlMs: number,
  ) {
    res.cookie(this.refreshTokenCookieName, refreshToken, {
      httpOnly: true,
      secure: this.isSecureCookie,
      sameSite: 'strict',
      maxAge: refreshTokenTtlMs,
      path: '/',
    });

    res.cookie(this.accessTokenCookieName, accessToken, {
      httpOnly: true,
      secure: this.isSecureCookie,
      sameSite: 'strict',
      maxAge: this.accessTokenTtlSeconds * 1000,
      path: '/',
    });
  }

  private getRefreshTtlForUser(user: AuthUser): number {
    if (user.role === 'SuperAdmin' || user.role === 'Admin') {
      return ADMIN_REFRESH_TOKEN_TTL_MS;
    }
    return this.refreshTokenTtlMilliseconds;
  }

  private isAdminRole(role: string): boolean {
    return role === 'SuperAdmin' || role === 'Admin';
  }

  private async issueRefreshToken(
    userId: string,
    req: Request,
    ttlMs?: number,
  ) {
    const sessionId = uuidv4();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(secret, this.bcryptRounds);
    const expiresAt = new Date(
      Date.now() + (ttlMs ?? this.refreshTokenTtlMilliseconds),
    );

    await this.prisma.refreshToken.create({
      data: {
        id: sessionId,
        tokenHash,
        userId,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: this.extractClientIp(req),
        locationLabel: this.describeRequestLocation(req),
        lastUsedAt: new Date(),
        expiresAt,
      },
    } as any);

    return `${sessionId}.${secret}`;
  }

  private async rotateRefreshToken(
    currentToken: RefreshToken,
    req: Request,
    ttlMs: number,
  ) {
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(secret, this.bcryptRounds);
    const expiresAt = new Date(Date.now() + ttlMs);

    await this.prisma.refreshToken.update({
      where: { id: currentToken.id },
      data: {
        tokenHash,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: this.extractClientIp(req),
        locationLabel: this.describeRequestLocation(req),
        lastUsedAt: new Date(),
        expiresAt,
      },
    } as any);

    return `${currentToken.id}.${secret}`;
  }

  private parseRefreshToken(raw: string) {
    const parts = raw?.split('.');
    if (!parts || parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new UnauthorizedException('Malformed refresh token');
    }
    return { sessionId: parts[0], secret: parts[1] };
  }

  async generateTokens(user: AuthUser, req: Request, res: Response) {
    const payload = buildAuthTokenPayload(user);
    const refreshTtl = this.getRefreshTtlForUser(user);
    try {
      const accessToken = await this.jwtService.signAsync(payload, {
        secret: this.accessTokenSecret,
        expiresIn: this.accessTokenTtlSeconds,
      });

      const refreshToken = await this.issueRefreshToken(
        user.id,
        req,
        refreshTtl,
      );

      this.attachAuthCookies(res, accessToken, refreshToken, refreshTtl);

      return {
        accessToken,
        refreshToken: this.isMobileClient(req) ? refreshToken : undefined,
      };
    } catch (error: any) {
      this.logger.error('Token generation failed:', error.message);
      throw new Error('Failed to generate tokens');
    }
  }

  async generateWebSessionForUserId(
    userId: string,
    req: Request,
    res: Response,
  ) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: authUserSelect,
    });

    if (!user) {
      throw new UnauthorizedException('User not found');
    }
    if (user.status !== 'ACTIVE') {
      throw new UnauthorizedException(
        'User account is suspended or deactivated',
      );
    }

    const payload = buildAuthTokenPayload(user);
    const refreshTtl = this.getRefreshTtlForUser(user);
    const accessToken = await this.jwtService.signAsync(payload, {
      secret: this.accessTokenSecret,
      expiresIn: this.accessTokenTtlSeconds,
    });
    const refreshToken = await this.issueRefreshToken(user.id, req, refreshTtl);

    this.attachAuthCookies(res, accessToken, refreshToken, refreshTtl);

    return { accessToken };
  }

  async refreshToken(rawRefreshToken: string, req: Request, res: Response) {
    try {
      const { sessionId, secret } = this.parseRefreshToken(rawRefreshToken);

      const storedToken = await this.prisma.refreshToken.findUnique({
        where: { id: sessionId },
      });

      if (!storedToken || storedToken.expiresAt <= new Date()) {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const isValid = await bcrypt.compare(secret, storedToken.tokenHash);
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: storedToken.userId },
        select: authUserSelect,
      });

      if (!user) {
        throw new UnauthorizedException('User not found');
      }

      if (user.status !== 'ACTIVE') {
        await this.prisma.refreshToken.delete({
          where: { id: storedToken.id },
        });
        throw new UnauthorizedException(
          'User account is suspended or deactivated',
        );
      }

      if (
        user.mustResetPassword &&
        (user.role === 'Admin' || user.role === 'SuperAdmin')
      ) {
        await this.prisma.refreshToken.delete({
          where: { id: storedToken.id },
        });
        throw new UnauthorizedException(
          'Password reset required for this admin account',
        );
      }

      if (
        this.isAdminRole(user.role) &&
        Date.now() - storedToken.createdAt.getTime() >
          ADMIN_ABSOLUTE_SESSION_TTL_MS
      ) {
        await this.prisma.refreshToken.delete({
          where: { id: storedToken.id },
        });
        throw new UnauthorizedException(
          'Admin session expired. Please log in again',
        );
      }

      const payload = buildAuthTokenPayload(user);
      const accessToken = await this.jwtService.signAsync(payload, {
        secret: this.accessTokenSecret,
        expiresIn: this.accessTokenTtlSeconds,
      });

      const refreshTtl = this.getRefreshTtlForUser(user);
      const rotatedRefreshToken = await this.rotateRefreshToken(
        storedToken,
        req,
        refreshTtl,
      );

      this.attachAuthCookies(res, accessToken, rotatedRefreshToken, refreshTtl);

      return {
        accessToken,
        refreshToken: this.isMobileClient(req)
          ? rotatedRefreshToken
          : undefined,
      };
    } catch (error: any) {
      this.logger.error('Refresh token error:', error.message, error.stack);
      throw new UnauthorizedException(`Refresh token failed: ${error.message}`);
    }
  }

  async revokeRefreshToken(rawRefreshToken?: string | null) {
    if (!rawRefreshToken) {
      return;
    }

    try {
      const { sessionId } = this.parseRefreshToken(rawRefreshToken);
      await this.prisma.refreshToken.delete({ where: { id: sessionId } });
    } catch (error: any) {
      this.logger.warn('Failed to revoke refresh token:', error.message);
    }
  }

  async revokeAllRefreshTokens(userId: string) {
    try {
      await this.prisma.refreshToken.deleteMany({ where: { userId } });
      // Increment authVersion so all previously-issued JWTs become invalid immediately
      await this.prisma.user.update({
        where: { id: userId },
        data: { authVersion: { increment: 1 } },
      });
    } catch (error: any) {
      this.logger.warn('Failed to revoke all refresh tokens:', error.message);
    }
  }

  async revokeOtherRefreshTokens(
    userId: string,
    currentRawRefreshToken?: string | null,
  ) {
    let currentSessionId: string | null = null;
    if (currentRawRefreshToken) {
      try {
        currentSessionId = this.parseRefreshToken(
          currentRawRefreshToken,
        ).sessionId;
      } catch {
        currentSessionId = null;
      }
    }

    const result = await this.prisma.refreshToken.deleteMany({
      where: currentSessionId
        ? { userId, id: { not: currentSessionId } }
        : { userId },
    });

    return {
      revokedCount: result.count,
      currentSessionId,
    };
  }
}
