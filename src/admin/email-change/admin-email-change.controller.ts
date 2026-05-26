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
import { AdminEmailChangeService } from './admin-email-change.service';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Role } from '@prisma/client';

class RequestEmailChangeDto {
  newEmail: string;
  currentPassword: string;
}

class VerifyOtpDto {
  otp: string;
}

class RejectRequestDto {
  reason?: string;
}

@Controller('admin/email-change')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AdminEmailChangeController {
  constructor(private readonly service: AdminEmailChangeService) {}

  @Post('request')
  @Roles(Role.Admin, Role.SuperAdmin)
  requestChange(@Request() req: any, @Body() body: RequestEmailChangeDto) {
    return this.service.requestEmailChange(req.user.id, body.newEmail, body.currentPassword);
  }

  @Post('verify-otp')
  @Roles(Role.Admin, Role.SuperAdmin)
  verifyOtp(@Request() req: any, @Body() body: VerifyOtpDto) {
    return this.service.verifyOtp(req.user.id, body.otp);
  }

  @Get('my-request')
  @Roles(Role.Admin, Role.SuperAdmin)
  getMyRequest(@Request() req: any) {
    return this.service.getMyRequest(req.user.id);
  }

  @Delete('my-request')
  @Roles(Role.Admin, Role.SuperAdmin)
  cancelMyRequest(@Request() req: any) {
    return this.service.cancelMyRequest(req.user.id);
  }

  @Get('requests')
  @Roles(Role.SuperAdmin)
  listRequests(@Query('page') page?: string, @Query('limit') limit?: string) {
    return this.service.listPendingRequests(Number(page) || 1, Number(limit) || 20);
  }

  @Post('requests/:id/approve')
  @Roles(Role.SuperAdmin)
  approveRequest(@Param('id') id: string, @Request() req: any) {
    return this.service.approveRequest(id, req.user.id);
  }

  @Post('requests/:id/reject')
  @Roles(Role.SuperAdmin)
  rejectRequest(
    @Param('id') id: string,
    @Request() req: any,
    @Body() body: RejectRequestDto,
  ) {
    return this.service.rejectRequest(id, req.user.id, body.reason ?? '');
  }
}
