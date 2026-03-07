import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { FeatureFlagsService } from './feature-flags.service';
import { Request } from 'express';

@ApiTags('admin/feature-flags')
@ApiBearerAuth()
@Controller('admin/feature-flags')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin)
export class FeatureFlagsController {
  constructor(private readonly service: FeatureFlagsService) {}

  @Get()
  @ApiOperation({ summary: 'List all feature flags' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_FEATURE_FLAGS_WRITE)
  async list() {
    return this.service.list();
  }

  @Post()
  @ApiOperation({ summary: 'Create a feature flag' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_FEATURE_FLAGS_WRITE)
  async create(
    @Body() dto: { key: string; description?: string; isEnabled?: boolean },
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.create(dto, req.user.id, req);
  }

  @Patch(':id/toggle')
  @ApiOperation({ summary: 'Toggle a feature flag' })
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_FEATURE_FLAGS_WRITE)
  async toggle(
    @Param('id') id: string,
    @Body('isEnabled') isEnabled: boolean,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.toggle(id, isEnabled, req.user.id, req);
  }
}
