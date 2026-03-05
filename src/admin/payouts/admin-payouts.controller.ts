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
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Role, PayoutStatus } from '@prisma/client';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPayoutsService } from './admin-payouts.service';
import { Request } from 'express';
import { ADMIN_PERMISSIONS } from '../constants/permissions';

@Controller('admin/payouts')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminPayoutsController {
  constructor(private readonly payoutsService: AdminPayoutsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  list(
    @Query('status') status?: PayoutStatus,
    @Query('brandId') brandId?: string,
    @Query('cursor') cursor?: string,
    @Query('take') take?: string,
  ) {
    return this.payoutsService.list({
      status,
      brandId,
      cursor,
      take: take ? parseInt(take, 10) : undefined,
    });
  }

  @Patch(':id/status')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  updateStatus(
    @Param('id') id: string,
    @Body() dto: { status: PayoutStatus },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.payoutsService.updateStatus(id, dto.status, actorId, req);
  }
}
