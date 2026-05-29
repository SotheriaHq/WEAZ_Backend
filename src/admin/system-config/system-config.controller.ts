import { Controller, Get, Patch, Body, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { SystemConfigService } from './system-config.service';
import { Request } from 'express';

@ApiTags('admin/system-config')
@ApiBearerAuth()
@Controller('admin/system-config')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin)
export class SystemConfigController {
  constructor(private readonly service: SystemConfigService) {}

  @Get()
  @ApiOperation({ summary: 'List all system config entries' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SETTINGS_WRITE)
  async list() {
    return this.service.listAll();
  }

  @Get('upload-limits')
  @ApiOperation({ summary: 'Get all upload size limits (bytes)' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SETTINGS_WRITE)
  async getUploadLimits() {
    return this.service.getUploadLimits();
  }

  @Patch()
  @ApiOperation({ summary: 'Bulk update config entries' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SETTINGS_WRITE)
  async bulkUpdate(
    @Body() dto: { entries: { key: string; value: string }[] },
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.bulkUpdate(dto.entries, req.user.id, req);
  }
}
