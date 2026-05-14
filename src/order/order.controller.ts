import {
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
  Body,
} from '@nestjs/common';
import { OrderService } from './order.service';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { OrderStatus } from '@prisma/client';
import { BrandPermissionService } from 'src/brands/permissions/brand-permission.service';
import { BRAND_PERMISSIONS } from 'src/brands/permissions/brand-permissions';
import { OrderAccessService } from './order-access.service';

@Controller('brands/:brandId/orders')
@UseGuards(JwtAuthGuard)
export class OrderController {
  constructor(
    private readonly orderService: OrderService,
    private readonly orderAccessService: OrderAccessService,
    private readonly brandPermissionService: BrandPermissionService,
  ) {}

  @Get()
  async findAll(
    @Param('brandId') brandId: string,
    @Req() req: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: OrderStatus,
    @Query('q') search?: string,
  ) {
    await this.brandPermissionService.assertPermission(
      req.user.id,
      brandId,
      BRAND_PERMISSIONS.ORDERS_READ,
    );
    return this.orderService.findAll(
      brandId,
      page ? parseInt(page, 10) : 1,
      limit ? parseInt(limit, 10) : 20,
      status,
      search,
    );
  }

  @Get(':orderId')
  async findOne(
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Req() req: any,
  ) {
    await this.orderAccessService.assertOrderBrandRead(req.user.id, orderId);
    return this.orderService.findOne(brandId, orderId);
  }

  @Patch(':orderId/status')
  async updateStatus(
    @Param('brandId') brandId: string,
    @Param('orderId') orderId: string,
    @Body() body: { status: OrderStatus },
    @Req() req: any,
  ) {
    await this.orderAccessService.assertOrderBrandUpdate(req.user.id, orderId);
    return this.orderService.updateStatus(brandId, orderId, body.status, req.user.id);
  }
}
