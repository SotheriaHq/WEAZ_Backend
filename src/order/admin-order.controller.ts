import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { OrderStatus, Role } from '@prisma/client';
import type { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { OrderService } from './order.service';

@Controller('admin/orders')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminOrderController {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  async findAll(
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: OrderStatus,
    @Query('q') search?: string,
  ) {
    return this.orderService.findAllForAdmin(
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      status,
      search,
    );
  }

  @Get(':orderId')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  async findOne(@Param('orderId') orderId: string) {
    return this.orderService.findOneForAdmin(orderId);
  }

  // Phase 3: admin approves cancel+refund for an SLA-overdue standard order.
  // Paid (initiates a Paystack refund): per-admin cap so a runaway/scripted
  // client can't fire mass refunds (Rule 32). Each order is idempotent anyway.
  @Post(':orderId/sla-cancel')
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  async slaCancel(
    @Param('orderId') orderId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.orderService.cancelOverdueOrderByAdmin(orderId, req.user.id);
  }
}
