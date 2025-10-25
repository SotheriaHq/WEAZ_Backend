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

  private extractClientIp(req: Request): string | null {
    const forwarded = req.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
      return forwarded.split(',')[0]?.trim() || null;
    }
    if (Array.isArray(forwarded) && forwarded.length > 0) {
      return forwarded[0];
    }
    return req.ip || null;
  }

  private attachAuthCookies(
    res: Response,
    accessToken: string,
    refreshToken: string,
  ) {
    res.cookie(this.refreshTokenCookieName, refreshToken, {
      httpOnly: true,
      secure: this.isSecureCookie,
      sameSite: 'strict',
      maxAge: this.refreshTokenTtlMilliseconds,
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

  private async issueRefreshToken(userId: string, req: Request) {
    const sessionId = uuidv4();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(secret, this.bcryptRounds);
    const expiresAt = new Date(Date.now() + this.refreshTokenTtlMilliseconds);

    await this.prisma.refreshToken.create({
      data: {
        id: sessionId,
        tokenHash,
        userId,
        userAgent: req.headers['user-agent'] ?? null,
        ipAddress: this.extractClientIp(req),
        lastUsedAt: new Date(),
        expiresAt,
      },
    });

    return `${sessionId}.${secret}`;
  }

  private async rotateRefreshToken(currentToken: RefreshToken, req: Request) {
    const sessionId = uuidv4();
    const secret = randomBytes(32).toString('hex');
    const tokenHash = await bcrypt.hash(secret, this.bcryptRounds);
    const expiresAt = new Date(Date.now() + this.refreshTokenTtlMilliseconds);

    await this.prisma.$transaction(async (tx) => {
      await tx.refreshToken.create({
        data: {
          id: sessionId,
          tokenHash,
          userId: currentToken.userId,
          userAgent: req.headers['user-agent'] ?? null,
          ipAddress: this.extractClientIp(req),
          lastUsedAt: new Date(),
          expiresAt,
        },
      });

      await tx.refreshToken.delete({
        where: { id: currentToken.id },
      });
    });

    return `${sessionId}.${secret}`;
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
    try {
      const accessToken = await this.jwtService.signAsync(payload, {
        secret: this.accessTokenSecret,
        expiresIn: this.accessTokenTtlSeconds,
      });

      const refreshToken = await this.issueRefreshToken(user.id, req);

      this.attachAuthCookies(res, accessToken, refreshToken);

      return { accessToken };
    } catch (error: any) {
      this.logger.error('Token generation failed:', error.message);
      throw new Error('Failed to generate tokens');
    }
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

      const payload = buildAuthTokenPayload(user);
      const accessToken = await this.jwtService.signAsync(payload, {
        secret: this.accessTokenSecret,
        expiresIn: this.accessTokenTtlSeconds,
      });

      const rotatedRefreshToken = await this.rotateRefreshToken(
        storedToken,
        req,
      );

      this.attachAuthCookies(res, accessToken, rotatedRefreshToken);

      return { accessToken };
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
    } catch (error: any) {
      this.logger.warn('Failed to revoke all refresh tokens:', error.message);
    }
  }
}
