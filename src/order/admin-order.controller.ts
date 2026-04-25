import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { OrderStatus, Role } from '@prisma/client';
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
}
