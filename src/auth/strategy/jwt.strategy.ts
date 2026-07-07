import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthJwtClaims } from '../dto/auth-response.dto';
import { ConfigService } from '@nestjs/config';
import { getJwtVerificationSecrets } from 'src/common/config/jwt-secrets';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {
    const accessTokenCookie = configService.get<string>(
      'ACCESS_TOKEN_COOKIE',
      'accessToken',
    );
    const verificationSecrets = getJwtVerificationSecrets(configService);
    super({
      // Try cookie first (useful for browser flows), then fall back to Authorization header
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: any) => {
          try {
            return req && req.cookies ? req.cookies[accessTokenCookie] : null;
          } catch {
            return null;
          }
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKeyProvider: (
        _request: unknown,
        rawJwtToken: string,
        done: (error: Error | null, secret?: string) => void,
      ) => {
        for (const secret of verificationSecrets) {
          try {
            jwt.verify(rawJwtToken, secret);
            done(null, secret);
            return;
          } catch {
            // try next secret during rotation window
          }
        }
        done(null, verificationSecrets[0]);
      },
    });
  }

  async validate(payload: AuthJwtClaims) {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: {
        id: true,
        role: true,
        username: true,
        type: true,
        isActive: true,
        status: true,
        mustResetPassword: true,
        authVersion: true,
      },
    });

    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is inactive or missing');
    }

    if (
      user.mustResetPassword &&
      (user.role === 'Admin' || user.role === 'SuperAdmin')
    ) {
      throw new UnauthorizedException(
        'Password reset required for this admin account',
      );
    }

    if ((payload.authVersion ?? 0) !== user.authVersion) {
      throw new UnauthorizedException('Session is no longer valid');
    }

    // Return user data for req.user using fresh DB state.
    // Permissions come from the JWT payload (embedded at token issuance time).
    return {
      id: user.id,
      sub: payload.sub,
      role: user.role,
      username: user.username,
      type: user.type,
      permissions: payload.permissions ?? [],
      mustResetPassword: user.mustResetPassword,
    };
  }
}
