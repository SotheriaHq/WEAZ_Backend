import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import { CollectionStatus, Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Request } from 'express';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminCollectionsService } from './admin-collections.service';
import { resolveSearchQuery } from 'src/common/utils/search-query';

@Controller('admin/collections')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminCollectionsController {
  constructor(private readonly collectionsService: AdminCollectionsService) {}

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
    return this.collectionsService.list({
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
    const actorId = (req as any).user.sub;
    return this.collectionsService.moderate(id, dto, actorId, req);
  }
}
