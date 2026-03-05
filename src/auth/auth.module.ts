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
        return {
          secret,
          signOptions: {
            expiresIn: config.get<string>('JWT_ACCESS_EXPIRES_IN', '15m'),
          },
        };
      },
    }),
    ThrottlerModule.forRoot([
      {
        name: 'short',
        ttl: 1000,
        limit: 100, // Increased for development
      },
      {
        name: 'medium',
        ttl: 10000,
        limit: 200, // Increased for development
      },
      {
        name: 'long',
        ttl: 60000,
        limit: 1000, // Increased for development
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
    JwtStrategy,
    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
  exports: [
    AuthService,
    TokenService,
    PasswordService,
    UserHelperService,
    JwtStrategy,
    PassportModule,
    JwtModule,
  ],
})
export class AuthModule {}
