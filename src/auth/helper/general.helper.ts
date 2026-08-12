import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable, UnauthorizedException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { RefreshToken } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import {
  AuthUser,
  authTokenClaimsSelect,
  authUserSelect,
  buildAuthTokenPayload,
} from './prisma-select.helper';
import { ConfigService } from '@nestjs/config';
import { isNonLocalEnvironment } from 'src/common/utils/web-app-url';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'accessToken';
const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_REFRESH_TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours for admin roles
const ADMIN_ABSOLUTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours absolute cap
const DEFAULT_BCRYPT_ROUNDS = 10;

/**
 * Prefix marking a refresh-token hash as HMAC-SHA256 rather than legacy bcrypt.
 *
 * Refresh secrets are `randomBytes(32)` — 256 bits from a CSPRNG. bcrypt's work
 * factor exists to make GUESSING expensive for low-entropy human passwords; a
 * 256-bit random secret is not guessable at any work factor, so the cost bought
 * nothing and was paid on every single refresh: one `bcrypt.compare` to verify
 * plus one `bcrypt.hash` to rotate, ~80-100ms each on a small box. That is the
 * dominant cost of the most frequently called endpoint in the whole API.
 *
 * HMAC keyed with a server-side pepper gives the property that actually
 * matters — someone who reads the `refresh_tokens` table still cannot derive a
 * usable token — because the key lives in the environment, not the database. If
 * that key also leaks, the attacker can mint access tokens directly, so bcrypt
 * would not have saved the session either.
 *
 * Existing bcrypt rows keep verifying (see `verifyRefreshSecret`) and are
 * rewritten in the new format the first time they rotate. No migration, no
 * forced logout.
 */
const HMAC_REFRESH_HASH_PREFIX = 'hmac1:';

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

  /**
   * HMAC key used to WRITE refresh-token hashes.
   *
   * This used to fall back to `JWT_ACCESS_SECRET` in every environment, on the
   * reasoning that it is the same trust boundary and already mandatory. That
   * reasoning missed something the codebase states outright: the access secret
   * is designed to be ROTATED. `common/config/jwt-secrets.ts` exists to make
   * rotation zero-downtime, accepting `JWT_ACCESS_SECRET_PREVIOUS` during the
   * window. Peppering refresh hashes with that same value silently coupled the
   * two, so rotating the access secret — an operation that is supposed to be
   * invisible — would have invalidated every stored refresh hash and signed
   * every user out.
   *
   * A deployed environment must therefore configure its own key. Local dev
   * still falls back, because there is nothing to protect and no rotation
   * story, and forcing the variable would just be a setup tax.
   */
  private get refreshTokenHashSecret(): string {
    const configured = this.configService
      .get<string>('REFRESH_TOKEN_HASH_SECRET')
      ?.trim();
    if (configured) return configured;

    if (isNonLocalEnvironment()) {
      // Loud, not silent. Borrowing the JWT secret here is exactly the coupling
      // this property exists to prevent, so a deployed environment that has not
      // set the key must be told, not quietly given the wrong default.
      this.logger.error(
        'REFRESH_TOKEN_HASH_SECRET is not configured. Refusing to pepper refresh tokens with JWT_ACCESS_SECRET: rotating that secret would sign out every user.',
      );
      throw new Error('Authentication configuration error');
    }

    return this.accessTokenSecret;
  }

  /**
   * Every key a stored HMAC hash could legitimately have been written with.
   *
   * Ordered current-first. Three sources, and each is here for a reason:
   *   1. the current key;
   *   2. `REFRESH_TOKEN_HASH_SECRET_PREVIOUS`, so this key can itself be
   *      rotated the same zero-downtime way the JWT secret already can;
   *   3. the access secrets, because hashes written before this change used
   *      `JWT_ACCESS_SECRET` as the pepper. Without this, the very act of
   *      adopting a proper key would log out everyone holding a session — the
   *      outage the change is meant to prevent.
   *
   * Only ever used to VERIFY. Writes always use the current key, so each
   * session migrates onto it at its next rotation and the legacy path drains
   * on its own.
   */
  private get refreshTokenHashVerificationSecrets(): string[] {
    const candidates = [
      this.configService.get<string>('REFRESH_TOKEN_HASH_SECRET')?.trim(),
      this.configService
        .get<string>('REFRESH_TOKEN_HASH_SECRET_PREVIOUS')
        ?.trim(),
      this.configService.get<string>('JWT_ACCESS_SECRET')?.trim(),
      this.configService.get<string>('JWT_ACCESS_SECRET_PREVIOUS')?.trim(),
    ];

    return Array.from(
      new Set(candidates.filter((value): value is string => Boolean(value))),
    );
  }

  private hashRefreshSecretWith(secret: string, key: string): string {
    const digest = createHmac('sha256', key).update(secret).digest('hex');
    return `${HMAC_REFRESH_HASH_PREFIX}${digest}`;
  }

  private hashRefreshSecret(secret: string): string {
    return this.hashRefreshSecretWith(secret, this.refreshTokenHashSecret);
  }

  private async verifyRefreshSecret(
    secret: string,
    storedHash: string,
  ): Promise<boolean> {
    if (storedHash?.startsWith(HMAC_REFRESH_HASH_PREFIX)) {
      const actual = Buffer.from(storedHash);
      // Compare against every accepted key. `timingSafeEqual` on each keeps the
      // comparison constant-time per candidate; the candidate list is at most
      // four entries and is not attacker-influenced.
      let matched = false;
      for (const key of this.refreshTokenHashVerificationSecrets) {
        const expected = Buffer.from(this.hashRefreshSecretWith(secret, key));
        if (
          expected.length === actual.length &&
          timingSafeEqual(expected, actual)
        ) {
          matched = true;
        }
      }
      return matched;
    }
    // Session issued before the format change. Still valid; rotation below
    // rewrites it as HMAC, so each session pays the bcrypt cost at most once
    // more.
    return bcrypt.compare(secret, storedHash);
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

  private getRefreshTtlForUser(user: Pick<AuthUser, 'role'>): number {
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
    const tokenHash = this.hashRefreshSecret(secret);
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
    const tokenHash = this.hashRefreshSecret(secret);
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

      const isValid = await this.verifyRefreshSecret(
        secret,
        storedToken.tokenHash,
      );
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Claims-only projection. This used to load `authUserSelect` — the full
      // brand profile, every brand membership with its brand join, and the user
      // profile with both image-file joins — to build a JWT that carries eight
      // scalar fields and then discard the rest. Refresh returns no user object,
      // so none of it was ever read.
      const user = await this.prisma.user.findUnique({
        where: { id: storedToken.userId },
        select: authTokenClaimsSelect,
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
