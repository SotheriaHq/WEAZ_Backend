import { Controller, Post, Body, Req, ValidationPipe } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { BreakGlassService } from './break-glass.service';
import { Request } from 'express';
import { AttemptBreakGlassDto } from './dto/attempt-break-glass.dto';
import { RecoverSuperAdminDto } from './dto/recover-superadmin.dto';

@ApiTags('admin/break-glass')
@Controller('admin/break-glass')
export class BreakGlassController {
  constructor(private readonly service: BreakGlassService) {}

  @Post()
  @Throttle({ default: { limit: 3, ttl: 900000 } })
  @ApiOperation({ summary: 'Emergency break-glass access (no auth required)' })
  async attempt(
    @Body(ValidationPipe) body: AttemptBreakGlassDto,
    @Req() req: Request,
  ) {
    return this.service.attempt(body.code, req);
  }

  @Post('recover-superadmin')
  @Throttle({ default: { limit: 2, ttl: 900000 } })
  @ApiOperation({
    summary:
      'Recover/create SuperAdmin account using break-glass recovery token',
  })
  async recoverSuperAdmin(
    @Body(ValidationPipe) body: RecoverSuperAdminDto,
    @Req() req: Request,
  ) {
    return this.service.recoverSuperAdmin(
      body.recoveryToken,
      {
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
      },
      req,
    );
  }
}
