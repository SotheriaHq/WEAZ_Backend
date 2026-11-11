import { withSecurityTransaction } from 'src/auth/access/transactional-enforcement';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { Injectable, UnauthorizedException, ConflictException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { Prisma, RefreshToken } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import * as bcrypt from 'bcrypt';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response } from 'express';
import {
  AuthUser,
  authTokenClaimsSelect,
  buildAuthTokenPayload,
} from './prisma-select.helper';
import { ConfigService } from '@nestjs/config';
import { isNonLocalEnvironment } from 'src/common/utils/web-app-url';
import { isHttpsRequest } from 'src/common/middleware/security-headers';
import { getJwtVerificationSecrets } from 'src/common/config/jwt-secrets';
import { lockSecurityAccount } from '../access/lock-security-account';
import { lockCurrentSecurityActor, type SecurityActor } from '../access/security-actor';
import { rememberPasswordCommand } from '../access/command-response-boundary';
import { getLiveCommandOperation } from '../access/command-response-boundary';
import { assertCurrentSelfCommand } from '../access/current-self-command';
import { getLiveSecurityContext } from '../access/security-request-context';

const DEFAULT_ACCESS_TOKEN_COOKIE = 'accessToken';
const DEFAULT_REFRESH_TOKEN_COOKIE = 'refreshToken';
const DEFAULT_ACCESS_TOKEN_TTL_SECONDS = 15 * 60; // 15 minutes
const DEFAULT_REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const ADMIN_REFRESH_TOKEN_TTL_MS = 5 * 60 * 60 * 1000; // 5 hours for admin roles
const ADMIN_ABSOLUTE_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours absolute cap
const DEFAULT_BCRYPT_ROUNDS = 10;

export type PasswordSessionRotation = {
  accessToken: string;
  refreshToken: string;
  ttl: number;
  originalActor: SecurityActor;
  replacementActor: SecurityActor;
};

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

  /**
   * Secure in production, and on any request that arrived over HTTPS. SIT runs
   * behind TLS without `NODE_ENV=production`, so keying on the environment
   * alone sent session cookies there without `Secure` (ZAP, CWE-614). Plain
   * http on localhost still gets a cookie the browser will keep.
   */
  private isSecureCookieFor(res: Response): boolean {
    return (
      this.configService.get<string>('NODE_ENV', '').toLowerCase() ===
        'production' || isHttpsRequest(res.req)
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
    const secure = this.isSecureCookieFor(res);
    res.cookie(this.refreshTokenCookieName, refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'strict',
      maxAge: refreshTokenTtlMs,
      path: '/',
    });

    res.cookie(this.accessTokenCookieName, accessToken, {
      httpOnly: true,
      secure,
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

  private securityDevice(req: Request, userId: string) {
    const raw = req.headers['x-wiez-security-device'];
    const deviceId = typeof raw === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(raw) ? raw : null;
    const name = req.headers['x-wiez-device-name'];
    return {
      deviceKey: deviceId ? createHash('sha256').update(`${userId}:${deviceId}`).digest('hex') : null,
      deviceName: typeof name === 'string' ? name.replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80).trim() || null : null,
    };
  }

  private async issueRefreshToken(
    userId: string, issuedAuthVersion: number, req: Request, ttlMs: number,
    tx: Prisma.TransactionClient, parent?: RefreshToken | null,
  ) {
    const sessionId = uuidv4();
    const secret = randomBytes(32).toString('hex');
    const expiresAt = new Date(Math.min(Date.now() + ttlMs, parent?.expiresAt.getTime() ?? Infinity));
    const device = parent ? { deviceKey: parent.deviceKey, deviceName: parent.deviceName } : this.securityDevice(req, userId);
    await tx.refreshToken.create({ data: {
      id: sessionId, tokenHash: this.hashRefreshSecret(secret), userId, sessionVersion: 1, issuedAuthVersion,
      ...device, parentSessionId: parent?.id ?? null,
      userAgent: req.headers['user-agent'] ?? null, ipAddress: this.extractClientIp(req),
      locationLabel: this.describeRequestLocation(req), lastUsedAt: new Date(), expiresAt,
    } });
    return `${sessionId}.${secret}`;
  }

  private async rotateRefreshToken(
    currentToken: RefreshToken, req: Request, ttlMs: number, tx: Prisma.TransactionClient,
    parent?: RefreshToken | null,
  ) {
    const secret = randomBytes(32).toString('hex');
    const expiresAt = new Date(Math.min(Date.now() + ttlMs, parent?.expiresAt.getTime() ?? Infinity));
    const rotation = await tx.refreshToken.updateMany({
      where: { id: currentToken.id, tokenHash: currentToken.tokenHash, sessionVersion: 1,
        issuedAuthVersion: currentToken.issuedAuthVersion, riskState: { not: 'REVOKED' }, expiresAt: { gt: new Date() } },
      data: { tokenHash: this.hashRefreshSecret(secret), userAgent: req.headers['user-agent'] ?? null,
        ipAddress: this.extractClientIp(req), locationLabel: this.describeRequestLocation(req), lastUsedAt: new Date(), expiresAt },
    });
    if (rotation.count !== 1) throw new ConflictException({ code: 'REFRESH_ROTATED', message: 'This refresh was already consumed. Retry with the current session.' });
    return `${currentToken.id}.${secret}`;
  }

  private async lockAccount(tx: Prisma.TransactionClient, userId: string) {
    await tx.$queryRaw`SELECT "_id" FROM "User" WHERE "_id" = ${userId}::uuid FOR UPDATE`;
    const user = await tx.user.findUnique({ where: { id: userId }, select: authTokenClaimsSelect });
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedException('User account is not active');
    return user;
  }

  private async createBoundSession(userId: string, req: Request, res: Response, handoffId?: string, expectedAuthVersion?: number) {
    const tokens = await withSecurityTransaction(this.prisma, async (tx) => {
      // Account-first lock order is shared by refresh, handoff and logout-all.
      const user = await this.lockAccount(tx, userId);
      if (!handoffId && (!Number.isSafeInteger(expectedAuthVersion) || expectedAuthVersion !== user.authVersion)) {
        throw new UnauthorizedException('Account security changed. Please sign in again.');
      }
      let parent: RefreshToken | null = null;
      if (handoffId) {
        const code = await tx.studioHandoffCode.findUnique({ where: { id: handoffId } });
        if (!code || code.userId !== userId || code.sourceAuthVersion !== user.authVersion ||
          !code.sourceSessionId || code.usedAt || code.expiresAt <= new Date() || user.type !== 'BRAND') {
          throw new UnauthorizedException('Studio handoff is no longer valid');
        }
        const source = await tx.refreshToken.findFirst({ where: {
          id: code.sourceSessionId, userId, sessionVersion: 1, issuedAuthVersion: user.authVersion, riskState: 'NORMAL', expiresAt: { gt: new Date() },
        } });
        if (!source) throw new UnauthorizedException('Source session is no longer valid');
        parent = source.parentSessionId ? await tx.refreshToken.findFirst({ where: {
          id: source.parentSessionId, userId, sessionVersion: 1, issuedAuthVersion: user.authVersion, riskState: 'NORMAL', expiresAt: { gt: new Date() },
        } }) : source;
        if (!parent) throw new UnauthorizedException('Parent session is no longer valid');
        const claim = await tx.studioHandoffCode.updateMany({ where: {
          id: code.id, usedAt: null, expiresAt: { gt: new Date() }, sourceAuthVersion: user.authVersion,
        }, data: { usedAt: new Date() } });
        if (claim.count !== 1) throw new UnauthorizedException('Studio handoff was already used');
      }
      const ttl = this.getRefreshTtlForUser(user);
      const refreshToken = await this.issueRefreshToken(userId, user.authVersion, req, ttl, tx, parent);
      const sid = this.parseRefreshToken(refreshToken).sessionId;
      const accessToken = await this.jwtService.signAsync({ ...buildAuthTokenPayload(user), sid }, {
        secret: this.accessTokenSecret, expiresIn: this.accessTokenTtlSeconds,
      });
      return { accessToken, refreshToken, ttl };
    });
    this.attachAuthCookies(res, tokens.accessToken, tokens.refreshToken, tokens.ttl);
    return tokens;
  }

  private parseRefreshToken(raw: string) {
    const parts = typeof raw === 'string' ? raw.split('.') : null;
    if (!parts || parts.length !== 2 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0]) || !/^[a-f0-9]{64}$/.test(parts[1])) {
      throw new UnauthorizedException('Malformed refresh token');
    }
    return { sessionId: parts[0], secret: parts[1] };
  }

  async generateTokens(user: AuthUser, req: Request, res: Response) {
    const tokens = await this.createBoundSession(user.id, req, res, undefined, user.authVersion);
    return { accessToken: tokens.accessToken, refreshToken: this.isMobileClient(req) ? tokens.refreshToken : undefined };
  }

  async generateWebSessionForUserId(userId: string, req: Request, res: Response, handoffId?: string) {
    const tokens = await this.createBoundSession(userId, req, res, handoffId);
    return { accessToken: tokens.accessToken };
  }

  async refreshToken(rawRefreshToken: string, req: Request, res: Response) {
    try {
      const { sessionId, secret } = this.parseRefreshToken(rawRefreshToken);

      const storedToken = await this.prisma.refreshToken.findUnique({
        where: { id: sessionId },
      });

      if (!storedToken || storedToken.expiresAt <= new Date() || storedToken.riskState === 'REVOKED') {
        throw new UnauthorizedException('Invalid or expired refresh token');
      }

      const isValid = await this.verifyRefreshSecret(
        secret,
        storedToken.tokenHash,
      );
      if (!isValid) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      if (storedToken.sessionVersion !== 1) throw new UnauthorizedException('Sign in again to secure this session');
      const tokens = await withSecurityTransaction(this.prisma, async (tx) => {
        const user = await this.lockAccount(tx, storedToken.userId);
        if (storedToken.issuedAuthVersion !== user.authVersion)
          throw new UnauthorizedException('Account security changed. Please sign in again.');
        if (user.mustResetPassword && this.isAdminRole(user.role)) throw new UnauthorizedException('Password reset required');
        let parent: RefreshToken | null = null;
        if (storedToken.parentSessionId) {
          parent = await tx.refreshToken.findFirst({ where: { id: storedToken.parentSessionId, userId: storedToken.userId,
            sessionVersion: 1, issuedAuthVersion: user.authVersion, riskState: { not: 'REVOKED' }, expiresAt: { gt: new Date() } } });
          if (!parent) throw new UnauthorizedException('Parent session is no longer valid');
        }
        const origin = parent ?? storedToken;
        if (this.isAdminRole(user.role) && Date.now() - origin.createdAt.getTime() > ADMIN_ABSOLUTE_SESSION_TTL_MS) {
          throw new UnauthorizedException('Admin session expired. Please log in again');
        }
        const refreshTtl = Math.min(this.getRefreshTtlForUser(user), this.isAdminRole(user.role) ? ADMIN_ABSOLUTE_SESSION_TTL_MS - (Date.now() - origin.createdAt.getTime()) : Infinity);
        const rotatedRefreshToken = await this.rotateRefreshToken(storedToken, req, refreshTtl, tx, parent);
        const accessToken = await this.jwtService.signAsync({ ...buildAuthTokenPayload(user), sid: storedToken.id }, {
          secret: this.accessTokenSecret, expiresIn: this.accessTokenTtlSeconds,
        });
        return { accessToken, rotatedRefreshToken, refreshTtl };
      });
      const { accessToken, rotatedRefreshToken, refreshTtl } = tokens;

      this.attachAuthCookies(res, accessToken, rotatedRefreshToken, refreshTtl);

      return {
        accessToken,
        refreshToken: this.isMobileClient(req)
          ? rotatedRefreshToken
          : undefined,
      };
    } catch (error: any) {
      if (error instanceof UnauthorizedException || error instanceof ConflictException) throw error;
      this.logger.error('Session refresh unavailable', { code: error?.code ?? error?.name ?? 'UNKNOWN' });
      throw new ServiceUnavailableException('Session could not be renewed. Please retry.');
    }
  }

  async revokeCurrentSession(userId: string, sessionId: string) {
    return withSecurityTransaction(this.prisma, async (tx) => {
      await this.lockAccount(tx, userId);
      // A native/root logout revokes its Studio children through the FK. A
      // Studio child logout does not revoke the native/root session.
      await tx.refreshToken.deleteMany({ where: { id: sessionId, userId } });
    });
  }

  /** Revocation-only credential verification. Expiry never grants API access;
   * an authentic, bound access token may only destroy its own session. */
  private revocationClaims(raw: unknown): { sub: string; sid: string; authVersion: number } | null {
    if (typeof raw !== 'string' || raw.length > 16384) return null;
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const secret of getJwtVerificationSecrets(this.configService)) {
      try {
        const claims = this.jwtService.verify(raw, { secret, algorithms: ['HS256'], ignoreExpiration: true });
        if (uuid.test(claims.sub) && uuid.test(claims.sid) && Number.isSafeInteger(claims.authVersion) &&
          claims.authVersion >= 0 && Number.isSafeInteger(claims.exp)) return claims;
      } catch { /* A previous signing key may still be accepted during rotation. */ }
    }
    return null;
  }

  cookiesBelongToActor(req: Request, actor: { id: string; sid: string; authVersion: number }): boolean {
    let found = false;
    const refresh = req.cookies?.[this.refreshTokenCookieName];
    if (refresh !== undefined) {
      if (typeof refresh !== 'string') return false;
      try { if (this.parseRefreshToken(refresh).sessionId !== actor.sid) return false; }
      catch { return false; }
      found = true;
    }
    const access = req.cookies?.[this.accessTokenCookieName];
    if (access !== undefined) {
      const claims = this.revocationClaims(access);
      if (!claims || claims.sub !== actor.id || claims.sid !== actor.sid || claims.authVersion !== actor.authVersion) return false;
      found = true;
    }
    return found;
  }

  async revokePresentedSession(req: Request): Promise<{ userId: string; sid: string; revoked: boolean; clearCookies: boolean } | null> {
    const authorization = req.headers.authorization;
    let actor: { sub: string; sid: string; authVersion: number } | null = null;
    let expectedHash: string | undefined;
    if (authorization !== undefined) {
      // An explicit account credential must never fall back to another tab's cookies.
      const bearer = typeof authorization === 'string' ? /^Bearer ([^\s]+)$/i.exec(authorization)?.[1] : null;
      actor = this.revocationClaims(bearer);
      if (!actor) return null;
    } else {
      const explicitRefresh = req.body && Object.prototype.hasOwnProperty.call(req.body, 'refreshToken');
      const raw = explicitRefresh ? req.body.refreshToken : req.cookies?.[this.refreshTokenCookieName];
      if (raw !== undefined) {
        if (typeof raw !== 'string') return null;
        let parsed: { sessionId: string; secret: string };
        try { parsed = this.parseRefreshToken(raw); } catch { return null; }
        const session = await this.prisma.refreshToken.findUnique({ where: { id: parsed.sessionId } });
        if (!session || session.sessionVersion !== 1 || session.issuedAuthVersion < 0 ||
          !(await this.verifyRefreshSecret(parsed.secret, session.tokenHash))) return null;
        actor = { sub: session.userId, sid: session.id, authVersion: session.issuedAuthVersion };
        expectedHash = session.tokenHash;
      } else {
        actor = this.revocationClaims(req.cookies?.[this.accessTokenCookieName]);
        if (!actor) return null;
      }
    }
    const target = actor;
    const result = await withSecurityTransaction(this.prisma, async tx => {
      await lockSecurityAccount(tx, target.sub);
      const existing = await tx.refreshToken.findUnique({ where: { id: target.sid },
        select: { userId: true, issuedAuthVersion: true, sessionVersion: true } });
      if (existing && (existing.userId !== target.sub || existing.issuedAuthVersion !== target.authVersion || existing.sessionVersion !== 1))
        return null;
      return tx.refreshToken.deleteMany({ where: { id: target.sid, userId: target.sub, sessionVersion: 1,
        issuedAuthVersion: target.authVersion, ...(expectedHash ? { tokenHash: expectedHash } : {}) } });
    });
    if (!result) return null;
    // A consumed refresh credential cannot authorize even revocation after it rotates.
    if (expectedHash && result.count === 0) return null;
    const cookieSessions: string[] = [];
    const refreshCookie = req.cookies?.[this.refreshTokenCookieName];
    if (typeof refreshCookie === 'string') {
      try { cookieSessions.push(this.parseRefreshToken(refreshCookie).sessionId); } catch { cookieSessions.push('invalid'); }
    }
    const accessCookie = req.cookies?.[this.accessTokenCookieName];
    if (typeof accessCookie === 'string') cookieSessions.push(this.revocationClaims(accessCookie)?.sid ?? 'invalid');
    return { userId: target.sub, sid: target.sid, revoked: result.count > 0,
      clearCookies: cookieSessions.length > 0 && cookieSessions.every(id => id === target.sid) };
  }

  async revokeAllRefreshTokens(userId: string) {
    // One transaction: a failed revocation must never report success.
    await withSecurityTransaction(this.prisma, async (tx) => {
      const operation = getLiveSecurityContext()?.operation ?? getLiveCommandOperation();
      const finish = operation?.policy.scope === 'SELF' || operation?.actor.id === userId
        ? await assertCurrentSelfCommand(tx, userId) : () => undefined;
      await tx.user.updateMany({ where: { id: userId }, data: { authVersion: { increment: 1 } } });
      await tx.refreshToken.deleteMany({ where: { userId } });
      await tx.studioHandoffCode.deleteMany({ where: { userId } });
      finish();
    });
  }

  async revokeOtherRefreshTokens(userId: string, currentSessionId?: string | null, transaction?: Prisma.TransactionClient) {
    if (!currentSessionId) throw new UnauthorizedException('Current session is required');
    const work = async (tx: Prisma.TransactionClient) => {
      const user = await this.lockAccount(tx, userId);
      const finish = await assertCurrentSelfCommand(tx, userId, currentSessionId);
      const current = await tx.refreshToken.findFirst({ where: { id: currentSessionId, userId, issuedAuthVersion: user.authVersion,
        sessionVersion: 1, riskState: { not: 'REVOKED' }, expiresAt: { gt: new Date() },
        OR: [{ parentSessionId: null }, { parentSession: { userId, issuedAuthVersion: user.authVersion,
          sessionVersion: 1, riskState: { not: 'REVOKED' }, expiresAt: { gt: new Date() } } }] }, select: { parentSessionId: true } });
      if (!current) throw new UnauthorizedException('Session is no longer valid');
      const keep = [currentSessionId, current.parentSessionId].filter((id): id is string => Boolean(id));
      const result = await tx.refreshToken.deleteMany({ where: { userId, id: { notIn: keep } } });
      finish();
      return { revokedCount: result.count, currentSessionId };
    };
    return transaction ? work(transaction) : withSecurityTransaction(this.prisma, work);
  }

  /** A verified password change is an explicit authority transition, never an
   * ordinary refresh adopting whatever account revision happens to exist. */
  async rotatePasswordSessionInTransaction(
    tx: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
    req: Request,
    changePassword: (current: { id: string; authVersion: number; role: string }) => Promise<void>,
  ): Promise<PasswordSessionRotation> {
    const before = await this.lockAccount(tx, userId);
    const originalActor = { id: userId, sid: sessionId, authVersion: before.authVersion, role: before.role };
    const { session } = await lockCurrentSecurityActor(tx, originalActor);
    if (session.riskState !== 'NORMAL') throw new UnauthorizedException('Verify this session before changing your password.');
    if (session.parentSessionId) throw new ConflictException({
      code: 'PASSWORD_CHANGE_ON_SOURCE_DEVICE_REQUIRED',
      message: 'Change your password from Password & security in the WIEZ app. Your password has not changed.',
    });
    const absoluteExpiresAt = this.isAdminRole(before.role)
      ? session.createdAt.getTime() + ADMIN_ABSOLUTE_SESSION_TTL_MS : Infinity;
    if (absoluteExpiresAt <= Date.now()) throw new UnauthorizedException('Admin session expired. Sign in again.');
    await changePassword(before);
    const after = await this.lockAccount(tx, userId);
    if (after.authVersion !== before.authVersion + 1 || after.role !== before.role)
      throw new ConflictException('Account security changed unexpectedly. No password change was committed.');
    const now = Date.now();
    const expiresAt = Math.min(now + this.getRefreshTtlForUser(after), absoluteExpiresAt);
    const ttl = expiresAt - now;
    if (ttl <= 0) throw new UnauthorizedException('Admin session expired. Sign in again.');
    const secret = randomBytes(32).toString('hex');
    const updated = await tx.refreshToken.updateMany({ where: {
      id: sessionId, userId, tokenHash: session.tokenHash, issuedAuthVersion: before.authVersion,
      sessionVersion: 1, riskState: 'NORMAL', parentSessionId: null, expiresAt: { gt: new Date() },
    }, data: {
      tokenHash: this.hashRefreshSecret(secret), issuedAuthVersion: after.authVersion,
      expiresAt: new Date(expiresAt), lastUsedAt: new Date(now),
      userAgent: req.headers['user-agent'] ?? null, ipAddress: this.extractClientIp(req),
      locationLabel: this.describeRequestLocation(req), strongAuthenticatedAt: null, strongAuthVersion: null,
    } });
    if (updated.count !== 1) throw new ConflictException('This session changed. No password change was committed.');
    // This one explicit transition has already verified the old actor and
    // advanced exactly one revision. Ordinary revocation helpers must never
    // adopt the replacement revision on behalf of an older request.
    await tx.refreshToken.deleteMany({ where: { userId, id: { not: sessionId } } });
    await tx.studioHandoffCode.deleteMany({ where: { userId } });
    await tx.securityStepUpChallenge.deleteMany({ where: { userId } });
    await tx.securityFactor.deleteMany({ where: { userId, verifiedAt: null } });
    const replacementActor = { ...originalActor, authVersion: after.authVersion };
    const accessToken = await this.jwtService.signAsync({ ...buildAuthTokenPayload(after), sid: sessionId }, {
      secret: this.accessTokenSecret, expiresIn: this.accessTokenTtlSeconds,
    });
    return { accessToken, refreshToken: `${sessionId}.${secret}`, ttl, originalActor, replacementActor };
  }

  async deliverPasswordSessionRotation(rotation: PasswordSessionRotation, req: Request, res: Response) {
    // Use the explicitly committed replacement binding, not an arbitrary latest
    // revision. A concurrent logout/role change must withhold the credentials.
    try {
      const current = await this.prisma.$transaction(tx => lockCurrentSecurityActor(tx, rotation.replacementActor));
      if (current.session.riskState !== 'NORMAL') throw new Error('Replacement session requires verification');
    } catch {
      throw new ConflictException({ code: 'SECURITY_RESPONSE_WITHHELD',
        message: 'Your password may have changed, but this session could not be renewed. Sign in with your new password before retrying.' });
    }
    const finishHeaders = () => this.attachAuthCookies(res, rotation.accessToken, rotation.refreshToken, rotation.ttl);
    if (!rememberPasswordCommand(rotation.originalActor, rotation.replacementActor, finishHeaders)) finishHeaders();
    return { message: 'Password updated successfully', accessToken: rotation.accessToken,
      ...(this.isMobileClient(req) ? { refreshToken: rotation.refreshToken } : {}) };
  }
}
