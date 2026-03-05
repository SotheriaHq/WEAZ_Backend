import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthJwtClaims } from '../dto/auth-response.dto';
import { ConfigService } from '@nestjs/config';

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
    const jwtSecret = configService.get<string>('JWT_ACCESS_SECRET');
    if (!jwtSecret) {
      throw new Error('JWT_ACCESS_SECRET must be configured for JwtStrategy');
    }
    super({
      // Try cookie first (useful for browser flows), then fall back to Authorization header
      jwtFromRequest: ExtractJwt.fromExtractors([
        (req: any) => {
          try {
            return req && req.cookies ? req.cookies[accessTokenCookie] : null;
          } catch (e) {
            return null;
          }
        },
        ExtractJwt.fromAuthHeaderAsBearerToken(),
      ]),
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
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
      },
    });

    if (!user || user.isActive === 'Inactive') {
      throw new UnauthorizedException('User account is inactive or missing');
    }

    // Admin-specific: reject suspended/deactivated users via new status field
    if (user.status && user.status !== 'ACTIVE') {
      throw new UnauthorizedException('User account is suspended or deactivated');
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
    };
  }
}
