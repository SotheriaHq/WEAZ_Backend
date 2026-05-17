import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PrismaService } from 'src/prisma/prisma.service';
import { PasswordService } from 'src/auth/helper/password.service';
import { TokenService } from './helper/general.helper';
import { JwtModule } from '@nestjs/jwt';
import { UserHelperService } from './helper/user-helper.service';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategy/jwt.strategy';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { RefreshTokenCleanupService } from './helper/refresh-token-cleanup.service';
import { TrustedDeviceService } from './helper/trusted-device.service';
import { AppThrottlerGuard } from './guard/app-throttler.guard';
import { StudioHandoffService } from './studio-handoff.service';
import { GoogleTokenVerifierService } from './helper/google-token-verifier.service';

@Module({
  imports: [
    ConfigModule,
    NotificationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const secret = config.get<string>('JWT_ACCESS_SECRET');
        if (!secret) {
          throw new Error('JWT_ACCESS_SECRET must be configured');
        }
        const accessTtlSeconds = Number(
          config.get<string>('JWT_ACCESS_TTL_SECONDS', '900'),
        );
        return {
          secret,
          signOptions: {
            expiresIn:
              Number.isFinite(accessTtlSeconds) && accessTtlSeconds > 0
                ? accessTtlSeconds
                : 900,
          },
        };
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 20,
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 60,
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 180,
      },
    ]),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PrismaService,
    PasswordService,
    TokenService,
    UserHelperService,
    EmailVerificationHelperService,
    RefreshTokenCleanupService,
    TrustedDeviceService,
    StudioHandoffService,
    GoogleTokenVerifierService,
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    UserHelperService,
    StudioHandoffService,
    GoogleTokenVerifierService,
    JwtStrategy,
    PassportModule,
    JwtModule,
  ],
})
export class AuthModule {}
