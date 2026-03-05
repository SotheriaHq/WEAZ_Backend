import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
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
import { AdminModerationService } from './admin-moderation.service';
import { Request } from 'express';

@ApiTags('admin/moderation')
@ApiBearerAuth()
@Controller('admin/moderation')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminModerationController {
  constructor(private readonly service: AdminModerationService) {}

  @Get('queue')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  @ApiOperation({ summary: 'Get moderation queue' })
  async getQueue(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('type') type?: string,
  ) {
    return this.service.getQueue({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      type,
    });
  }

  @Patch('items/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
  @ApiOperation({ summary: 'Review a moderation item' })
  async reviewItem(
    @Param('id') id: string,
    @Body() body: { action: string; reason?: string },
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.reviewItem(id, body, req.user.id, req);
  }
}
