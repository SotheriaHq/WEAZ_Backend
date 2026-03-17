import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { CollectionStatus, Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { resolveSearchQuery } from 'src/common/utils/search-query';
import { AdminDesignsService } from 'src/admin/designs/admin-designs.service';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';

@Controller('admin/designs')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminDesignsController {
  constructor(private readonly designsService: AdminDesignsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.COLLECTIONS_READ)
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('q') q?: string,
    @Query('search') search?: string,
    @Query('ownerId') ownerId?: string,
    @Query('status') status?: CollectionStatus,
  ) {
    return this.designsService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search: resolveSearchQuery(q, search),
      ownerId,
      status,
    });
  }

  @Patch(':id/moderate')
  @RequirePermissions(ADMIN_PERMISSIONS.COLLECTIONS_MODERATE)
  moderate(
    @Param('id') id: string,
    @Body()
    dto: {
      status?: CollectionStatus;
      action?: 'UNPUBLISH' | 'REPUBLISH' | 'HARD_DELETE';
      reason?: string;
    },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.id ?? (req as any).user.sub;
    return this.designsService.moderate(id, dto, actorId, req);
  }
}
