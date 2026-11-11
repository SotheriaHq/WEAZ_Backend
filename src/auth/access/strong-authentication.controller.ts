import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { JwtAuthGuard } from '../guard/jwt-auth.guard';
import type { SecurityActor } from './security-actor';
import { StrongAuthenticationService } from './strong-authentication.service';

class PasswordProofDto {
  @IsString() @MinLength(1) @MaxLength(1024) password: string;
}
class PrimaryProofDto extends PasswordProofDto {
  @IsOptional() @IsString() @MaxLength(128) enrollmentProof?: string;
}
class TotpBeginDto extends PrimaryProofDto {
  @IsOptional() @IsUUID() replacesFactorId?: string;
}
class EnrollmentCodeDto {
  @IsUUID() challengeId: string;
  @IsString() @Length(8, 8) code: string;
}
class TotpConfirmDto {
  @IsUUID() factorId: string;
  @IsString() @Length(6, 6) code: string;
}
class StepUpVerifyDto {
  @IsOptional() @IsString() @Length(6, 6) code?: string;
  @IsOptional() @IsString() @MaxLength(64) recoveryCode?: string;
  @IsOptional() @IsObject() passkey?: AuthenticationResponseJSON;
}
class PasskeyBeginDto extends PrimaryProofDto {
  @IsString() @MinLength(1) @MaxLength(80) label: string;
}
class PasskeyConfirmDto {
  @IsUUID() challengeId: string;
  @IsObject() response: RegistrationResponseJSON;
}

@Controller('auth/security/mfa')
@UseGuards(JwtAuthGuard)
@UsePipes(
  new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
  }),
)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class StrongAuthenticationController {
  constructor(private readonly strongAuth: StrongAuthenticationService) {}
  @Get()
  status(@Req() request: { user: SecurityActor }) {
    return this.strongAuth.status(request.user);
  }
  @Post('enrollment/request')
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  requestEnrollment(
    @Req() request: { user: SecurityActor },
    @Body() body: PrimaryProofDto,
  ) {
    return this.strongAuth.requestEnrollmentEmail(request.user, body.password);
  }
  @Post('enrollment/confirm')
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  confirmEnrollment(
    @Req() request: { user: SecurityActor },
    @Body() body: EnrollmentCodeDto,
  ) {
    return this.strongAuth.confirmEnrollmentEmail(
      request.user,
      body.challengeId,
      body.code,
    );
  }
  @Post('totp/begin')
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  beginTotp(
    @Req() request: { user: SecurityActor },
    @Body() body: TotpBeginDto,
  ) {
    return this.strongAuth.beginTotp(
      request.user,
      body.password,
      body.enrollmentProof,
      body.replacesFactorId,
    );
  }
  @Post('totp/confirm')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  confirmTotp(
    @Req() request: { user: SecurityActor },
    @Body() body: TotpConfirmDto,
  ) {
    return this.strongAuth.confirmTotp(request.user, body.factorId, body.code);
  }
  @Post('passkeys/begin')
  @Throttle({ default: { limit: 3, ttl: 900_000 } })
  beginPasskey(
    @Req() request: { user: SecurityActor },
    @Body() body: PasskeyBeginDto,
  ) {
    return this.strongAuth.beginPasskey(
      request.user,
      body.password,
      body.label,
      body.enrollmentProof,
    );
  }
  @Post('passkeys/confirm')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  confirmPasskey(
    @Req() request: { user: SecurityActor },
    @Body() body: PasskeyConfirmDto,
  ) {
    return this.strongAuth.confirmPasskey(
      request.user,
      body.challengeId,
      body.response,
    );
  }
  @Get('challenges/:id/passkey-options')
  passkeyOptions(
    @Req() request: { user: SecurityActor },
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.strongAuth.preparePasskey(request.user, id);
  }
  @Post('challenges/:id/verify')
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  verify(
    @Req() request: { user: SecurityActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: StepUpVerifyDto,
  ) {
    return this.strongAuth.verify(request.user, id, body);
  }
  @Post('factors/:id/revoke')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  revokeFactor(
    @Req() request: { user: SecurityActor },
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PasswordProofDto,
  ) {
    return this.strongAuth.revokeFactor(request.user, id, body.password);
  }
  @Post('recovery-codes/regenerate')
  @Throttle({ default: { limit: 5, ttl: 300_000 } })
  regenerateRecoveryCodes(
    @Req() request: { user: SecurityActor },
    @Body() body: PasswordProofDto,
  ) {
    return this.strongAuth.regenerateRecoveryCodes(request.user, body.password);
  }
}
