import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  UseGuards,
  Req,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminSlaService } from './admin-sla.service';
import { Request } from 'express';
import { ADMIN_PERMISSIONS } from '../constants/permissions';

@Controller('admin/sla-config')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminSlaController {
  constructor(private readonly slaService: AdminSlaService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SLA_READ)
  list() {
    return this.slaService.list();
  }

  @Post()
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SLA_WRITE)
  create(
    @Body() dto: { area: string; targetHours: number; startDate?: string; endDate?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.slaService.create(dto, actorId, req);
  }

  @Patch(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SLA_WRITE)
  update(
    @Param('id') id: string,
    @Body() dto: { targetHours?: number; isActive?: boolean; endDate?: string },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.slaService.update(id, dto, actorId, req);
  }

  @Delete(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_SLA_WRITE)
  delete(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.slaService.delete(id, actorId, req);
  }
}
