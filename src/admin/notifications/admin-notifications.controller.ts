import { Controller, Get, Post, Body, UseGuards, Req } from '@nestjs/common';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminNotificationsService } from './admin-notifications.service';
import { Request } from 'express';
import { ADMIN_PERMISSIONS } from '../constants/permissions';

@Controller('admin/notifications')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminNotificationsController {
  constructor(
    private readonly notificationsService: AdminNotificationsService,
  ) {}

  @Get('templates')
  @RequirePermissions(ADMIN_PERMISSIONS.NOTIFICATIONS_SEND)
  getTemplates() {
    return this.notificationsService.getTemplates();
  }

  @Post('send')
  @RequirePermissions(ADMIN_PERMISSIONS.NOTIFICATIONS_SEND)
  send(
    @Body()
    dto: {
      targetUserId: string;
      channel: string;
      relatedAuditLogId?: string;
      messageTemplate: string;
      customMessage?: string;
    },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.notificationsService.send(dto, actorId, req);
  }
}
