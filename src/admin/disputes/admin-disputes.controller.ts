import {
  Controller,
  Get,
  Post,
  Patch,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { Role, AdminDisputeStatus } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminDisputesService } from './admin-disputes.service';
import { Request } from 'express';

@ApiTags('admin/disputes')
@ApiBearerAuth()
@Controller('admin/disputes')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminDisputesController {
  constructor(private readonly service: AdminDisputesService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_READ)
  @ApiOperation({ summary: 'List disputes (paginated)' })
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: AdminDisputeStatus,
    @Query('type') type?: string,
  ) {
    return this.service.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      status,
      type,
    });
  }

  @Post()
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  @ApiOperation({ summary: 'Create a dispute' })
  async create(
    @Body()
    dto: {
      type: string;
      reporterId: string;
      targetType: string;
      targetId: string;
      description: string;
    },
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.service.create(dto, req.user.id, req);
  }

  @Patch(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  @ApiOperation({ summary: 'Update a dispute' })
  async update(
    @Param('id') id: string,
    @Body()
    dto: {
      status?: AdminDisputeStatus;
      resolution?: string;
      adminNotes?: string;
      assignedToId?: string;
    },
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.service.update(id, dto, req.user.id, req.user.role as Role, req);
  }

  @Post(':id/claim')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  @ApiOperation({ summary: 'Claim a dispute for the current admin' })
  async claim(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.service.claim(id, req.user.id, req.user.role, req);
  }

  @Post(':id/release')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  @ApiOperation({ summary: 'Release a claimed dispute' })
  async release(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.service.release(id, req.user.id, req.user.role, req, reason);
  }

  @Post(':id/reopen')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  @ApiOperation({ summary: 'Reopen a closed/resolved dispute' })
  async reopen(
    @Param('id') id: string,
    @Body('reason') reason: string,
    @Req() req: Request & { user: { id: string; role: Role } },
  ) {
    return this.service.reopen(id, reason, req.user.id, req.user.role, req);
  }
}
