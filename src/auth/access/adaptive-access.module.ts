import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { EmailModule } from 'src/email/email.module';
import { PasswordService } from '../helper/password.service';
import { AdaptiveAccessInterceptor } from './adaptive-access.interceptor';
import { AdaptiveAccessService } from './adaptive-access.service';
import { SessionRiskService } from './session-risk.service';
import { StrongAuthenticationController } from './strong-authentication.controller';
import { StrongAuthenticationService } from './strong-authentication.service';
import { MfaRecoveryService } from './mfa-recovery.service';
import { AdminMfaRecoveryController, MfaRecoveryController } from './mfa-recovery.controller';

@Global()
@Module({ imports: [ConfigModule, EmailModule], controllers: [StrongAuthenticationController, MfaRecoveryController, AdminMfaRecoveryController],
  providers: [PasswordService, AdaptiveAccessService, SessionRiskService, StrongAuthenticationService, MfaRecoveryService,
    { provide: APP_INTERCEPTOR, useClass: AdaptiveAccessInterceptor }],
  exports: [AdaptiveAccessService, SessionRiskService, StrongAuthenticationService] })
export class AdaptiveAccessModule {}
