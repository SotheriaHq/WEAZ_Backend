import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  Request,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsOptional, IsString, Length, MinLength } from 'class-validator';
import { AdminEmailChangeService } from './admin-email-change.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Role } from '@prisma/client';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';

class RequestEmailChangeDto {
  @IsEmail()
  newEmail: string;

  @IsString()
  @MinLength(8)
  currentPassword: string;
}

class VerifyOtpDto {
  @IsString()
  @Length(6, 6)
  otp: string;
}

class RejectRequestDto {
  @IsOptional()
  @IsString()
  reason?: string;
}

@Controller('admin/email-change')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
export class AdminEmailChangeController {
  constructor(private readonly service: AdminEmailChangeService) {}

  @Post('request')
  @Roles(Role.Admin, Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE)
  @Throttle({ default: { limit: 3, ttl: 900000 } })
  requestChange(@Request() req: any, @Body() body: RequestEmailChangeDto) {
    return this.service.requestEmailChange(req.user.id, body.newEmail, body.currentPassword);
  }

  @Post('verify-otp')
  @Roles(Role.Admin, Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE)
  @Throttle({ default: { limit: 5, ttl: 600000 } })
  verifyOtp(@Request() req: any, @Body() body: VerifyOtpDto) {
    return this.service.verifyOtp(req.user.id, body.otp);
  }

  @Get('my-request')
  @Roles(Role.Admin, Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE)
  getMyRequest(@Request() req: any) {
    return this.service.getMyRequest(req.user.id);
  }

  @Delete('my-request')
  @Roles(Role.Admin, Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.ADMIN_EMAIL_CHANGE)
  cancelMyRequest(@Request() req: any) {
    return this.service.cancelMyRequest(req.user.id);
  }

  @Get('requests')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.PERMISSIONS_MANAGE)
  listRequests(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listPendingRequests(Number(page) || 1, Number(limit) || 20);
  }

  @Post('requests/:id/approve')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.PERMISSIONS_MANAGE)
  approveRequest(@Param('id') id: string, @Request() req: any) {
    return this.service.approveRequest(id, req.user.id);
  }

  @Post('requests/:id/reject')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.PERMISSIONS_MANAGE)
  rejectRequest(
    @Param('id') id: string,
    @Request() req: any,
    @Body() body: RejectRequestDto,
  ) {
    return this.service.rejectRequest(id, req.user.id, body.reason ?? '');
  }
}
