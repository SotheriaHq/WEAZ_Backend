import {
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminAuditAction, Role } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminAuditService } from '../services/admin-audit.service';
import { ADMIN_PERMISSIONS } from '../constants/permissions';

@Controller('admin/audit-logs')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminAuditController {
  constructor(private readonly auditService: AdminAuditService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.AUDIT_READ)
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('actorUserId') actorUserId?: string,
    @Query('action') action?: AdminAuditAction,
    @Query('targetType') targetType?: string,
  ) {
    return this.auditService.findMany({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      actorUserId,
      action,
      targetType,
    });
  }
}
