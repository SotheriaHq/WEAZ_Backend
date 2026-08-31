import { ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import {
  ThrottlerGuard,
  ThrottlerModuleOptions,
  ThrottlerStorage,
} from '@nestjs/throttler';
import { shouldEnforceThrottling } from 'src/common/logging/pino.config';
import { getJwtVerificationSecrets } from 'src/common/config/jwt-secrets';
import {
  buildTracker,
  extractAccessToken,
  resolveVerifiedUserId,
} from './throttler-identity';

@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly cookieName: string;
  private verificationSecrets: readonly string[] | null = null;

  constructor(
    options: ThrottlerModuleOptions,
    storageService: ThrottlerStorage,
    reflector: Reflector,
    private readonly configService: ConfigService,
  ) {
    super(options, storageService, reflector);
    this.cookieName = this.configService.get<string>(
      'ACCESS_TOKEN_COOKIE',
      'accessToken',
    );
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!shouldEnforceThrottling()) {
      return true;
    }

    return Boolean(await super.canActivate(context));
  }

  /**
   * Resolved once, lazily, and cached.
   *
   * `getJwtVerificationSecrets` THROWS when `JWT_ACCESS_SECRET` is missing.
   * Calling it in the constructor would make a misconfigured secret crash the
   * whole application at boot through the rate limiter, which is a confusing
   * place to discover it. Resolving here — and treating a throw as "no
   * secrets" — means a broken secret degrades throttling to IP-based counting
   * instead of taking the API down. Authentication still fails closed
   * separately, in `JwtStrategy`, which is where that error belongs.
   */
  private getSecrets(): readonly string[] {
    if (this.verificationSecrets) return this.verificationSecrets;
    try {
      this.verificationSecrets = getJwtVerificationSecrets(this.configService);
    } catch {
      this.verificationSecrets = [];
    }
    return this.verificationSecrets;
  }

  /**
   * Identify the caller for counting purposes.
   *
   * Signed-in callers are counted per ACCOUNT, anonymous ones per IP. The
   * reasoning for both — and the rule that the signature is always verified —
   * lives in `throttler-identity.ts`.
   *
   * `req.user` is checked first even though nothing populates it this early
   * today: it costs one property read, and if a future global guard ever does
   * authenticate before this one, that identity should win over re-verifying
   * the token ourselves.
   */
  protected async getTracker(req: Record<string, unknown>): Promise<string> {
    const ip = String(
      req.ip ?? (req.ips as string[] | undefined)?.[0] ?? 'unknown',
    );

    const attached = req.user as { id?: string; sub?: string } | undefined;
    const attachedId = attached?.id ?? attached?.sub;
    if (attachedId) {
      return buildTracker(attachedId, ip);
    }

    const token = extractAccessToken(req, this.cookieName);
    const userId = resolveVerifiedUserId(token, this.getSecrets());
    return buildTracker(userId, ip);
  }
}
