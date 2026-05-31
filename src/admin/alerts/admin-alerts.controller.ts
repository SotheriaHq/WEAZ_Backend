import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminAlertsService } from './admin-alerts.service';

@Controller('admin/alerts')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminAlertsController {
  constructor(private readonly alertsService: AdminAlertsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_READ)
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('category') category?: string,
    @Query('severity') severity?: string,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('search') search?: string,
    @Query('entityType') entityType?: string,
    @Query('entityId') entityId?: string,
    @Query('correlationId') correlationId?: string,
  ) {
    return this.alertsService.list({
      cursor,
      limit: limit ? Number(limit) : undefined,
      category,
      severity,
      status,
      from,
      to,
      search,
      entityType,
      entityId,
      correlationId,
    });
  }

  @Get('summary')
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_READ)
  summary() {
    return this.alertsService.summary();
  }

  @Get(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_READ)
  getById(@Param('id') id: string) {
    return this.alertsService.getById(id);
  }

  @Patch(':id/acknowledge')
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_MANAGE)
  acknowledge(@Param('id') id: string, @Req() req: any) {
    return this.alertsService.acknowledge(id, this.resolveActorId(req));
  }

  @Patch(':id/resolve')
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_MANAGE)
  resolve(@Param('id') id: string, @Req() req: any) {
    return this.alertsService.resolve(id, this.resolveActorId(req));
  }

  @Patch(':id/ignore')
  @RequirePermissions(ADMIN_PERMISSIONS.ALERTS_MANAGE)
  ignore(@Param('id') id: string, @Req() req: any) {
    return this.alertsService.ignore(id, this.resolveActorId(req));
  }

  private resolveActorId(req: any): string {
    return String(req?.user?.sub ?? req?.user?.id ?? '');
  }
}
