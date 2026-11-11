import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query, Req, UseGuards, UsePipes, ValidationPipe } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsBoolean, IsEnum, IsInt, IsOptional, IsString, IsUUID, Length, MaxLength, Min, MinLength } from 'class-validator';
import { Role, SecurityMfaRecoveryDecision } from '@prisma/client';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { Roles } from '../decorator/roles.decorator';
import { JwtAuthGuard } from '../guard/jwt-auth.guard';
import { RolesGuard } from '../guard/role.guard';
import type { SecurityActor } from './security-actor';
import { MfaRecoveryService } from './mfa-recovery.service';
import { StrongAuthenticationService } from './strong-authentication.service';

class PasswordDto { @IsString() @MinLength(1) @MaxLength(1024) password: string; }
class RecoveryRequestDto extends PasswordDto { @IsString() @MinLength(1) @MaxLength(1000) reason: string; }
class RecoveryInformationDto extends PasswordDto { @IsString() @MinLength(1) @MaxLength(1000) information: string; }
class RecoveryCodeDto { @IsUUID() challengeId: string; @IsString() @Length(8, 8) code: string; }
class RecoverySetupDto extends PasswordDto { @IsString() @MinLength(1) @MaxLength(128) enrollmentProof: string; }
class RecoveryReviewDto {
  @IsInt() @Min(1) revision: number;
  @IsEnum(SecurityMfaRecoveryDecision) decision: SecurityMfaRecoveryDecision;
  @IsOptional() @IsBoolean() identityVerified?: boolean;
  @IsString() @MinLength(1) @MaxLength(200) evidenceReference: string;
  @IsOptional() @IsString() @MaxLength(1000) message?: string;
}
class QueueQuery { @IsOptional() @IsUUID() cursor?: string; }
const validation = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
type Request = { user: SecurityActor };

@Controller('auth/security/mfa/recovery')
@UseGuards(JwtAuthGuard)
@UsePipes(validation)
@Throttle({ default: { limit: 20, ttl: 60_000 } })
export class MfaRecoveryController {
  constructor(private readonly recovery: MfaRecoveryService, private readonly strong: StrongAuthenticationService) {}
  @Get() status(@Req() req: Request) { return this.recovery.status(req.user); }
  @Post() @Throttle({ default: { limit: 6, ttl: 3_600_000 } })
  request(@Req() req: Request, @Body() body: RecoveryRequestDto) { return this.recovery.request(req.user, body.password, body.reason); }
  @Post(':id/cancel') cancel(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: PasswordDto) {
    return this.recovery.update(req.user, id, body.password, null);
  }
  @Post(':id/information') information(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecoveryInformationDto) {
    return this.recovery.update(req.user, id, body.password, body.information);
  }
  @Post(':id/code/request') @Throttle({ default: { limit: 3, ttl: 900_000 } })
  requestCode(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: PasswordDto) {
    return this.recovery.requestCode(req.user, id, body.password);
  }
  @Post(':id/code/confirm') @Throttle({ default: { limit: 5, ttl: 600_000 } })
  confirmCode(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecoveryCodeDto) {
    return this.recovery.confirmCode(req.user, id, body.challengeId, body.code);
  }
  @Post(':id/totp/begin') @Throttle({ default: { limit: 3, ttl: 900_000 } })
  begin(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecoverySetupDto) {
    return this.strong.beginRecoveryTotp(req.user, id, body.password, body.enrollmentProof);
  }
}

@Controller('admin/security/mfa-recovery')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.Admin, Role.SuperAdmin)
@RequirePermissions(ADMIN_PERMISSIONS.USERS_MFA_RECOVER)
@UsePipes(validation)
@Throttle({ default: { limit: 30, ttl: 60_000 } })
export class AdminMfaRecoveryController {
  constructor(private readonly recovery: MfaRecoveryService) {}
  @Get() queue(@Query() query: QueueQuery) { return this.recovery.queue(query.cursor); }
  @Post(':id/review') review(@Req() req: Request, @Param('id', ParseUUIDPipe) id: string, @Body() body: RecoveryReviewDto) {
    return this.recovery.review(req.user, id, body);
  }
}
