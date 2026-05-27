import { Controller, Get, UseGuards } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminDashboardService } from './admin-dashboard.service';

@Controller('admin/dashboard')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminDashboardController {
  constructor(private readonly dashboardService: AdminDashboardService) {}

  @Get('stats')
  @RequirePermissions(ADMIN_PERMISSIONS.DASHBOARD_READ)
  async getStats() {
    return this.dashboardService.getStats();
  }
}
