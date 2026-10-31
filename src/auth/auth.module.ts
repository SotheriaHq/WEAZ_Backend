import { Module } from '@nestjs/common';
import { AuthService } from './auth.service';
import { AuthController } from './auth.controller';
import { PasswordService } from 'src/auth/helper/password.service';
import { TokenService } from './helper/general.helper';
import { JwtModule } from '@nestjs/jwt';
import { UserHelperService } from './helper/user-helper.service';
import { PassportModule } from '@nestjs/passport';
import { JwtStrategy } from './strategy/jwt.strategy';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EmailVerificationHelperService } from './helper/email-verification-helper.service';
import { NotificationsModule } from 'src/notifications/notifications.module';
import { RefreshTokenCleanupService } from './helper/refresh-token-cleanup.service';
import { TrustedDeviceService } from './helper/trusted-device.service';
import { LoginLockoutService } from './helper/login-lockout.service';
import { StudioHandoffService } from './studio-handoff.service';
import { GoogleTokenVerifierService } from './helper/google-token-verifier.service';
import { LegalModule } from 'src/legal/legal.module';
import { getJwtSigningSecret } from 'src/common/config/jwt-secrets';

@Module({
  imports: [
    ConfigModule,
    LegalModule,
    NotificationsModule,
    PassportModule.register({ defaultStrategy: 'jwt' }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: async (config: ConfigService) => {
        const secret = getJwtSigningSecret(config);
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
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    PasswordService,
    TokenService,
    UserHelperService,
    EmailVerificationHelperService,
    RefreshTokenCleanupService,
    TrustedDeviceService,
    LoginLockoutService,
    StudioHandoffService,
    GoogleTokenVerifierService,
    JwtStrategy,
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
