import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import * as jwt from 'jsonwebtoken';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthJwtClaims } from '../dto/auth-response.dto';
import { resolveCurrentPrincipal } from '../access/current-principal';
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
      // Explicit bearer identity wins over an unrelated or stale browser cookie.
      jwtFromRequest: ExtractJwt.fromExtractors([
        ExtractJwt.fromAuthHeaderAsBearerToken(),
        (req: any) => {
          try {
            return req && req.cookies ? req.cookies[accessTokenCookie] : null;
          } catch {
            return null;
          }
        },
      ]),
      ignoreExpiration: false,
      algorithms: ['HS256'],
      secretOrKeyProvider: (
        _request: unknown,
        rawJwtToken: string,
        done: (error: Error | null, secret?: string) => void,
      ) => {
        for (const secret of verificationSecrets) {
          try {
            jwt.verify(rawJwtToken, secret, { algorithms: ['HS256'] });
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
    return resolveCurrentPrincipal(this.prisma, payload);
  }
}
