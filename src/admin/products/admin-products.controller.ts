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
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Request } from 'express';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminProductsService } from './admin-products.service';

@Controller('admin/products')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminProductsController {
  constructor(private readonly productsService: AdminProductsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.PRODUCTS_READ)
  list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('search') search?: string,
    @Query('brandId') brandId?: string,
    @Query('isActive') isActive?: string,
  ) {
    return this.productsService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      search,
      brandId,
      isActive:
        isActive !== undefined ? isActive.toLowerCase() === 'true' : undefined,
    });
  }

  @Patch(':id/moderate')
  @RequirePermissions(ADMIN_PERMISSIONS.PRODUCTS_MODERATE)
  moderate(
    @Param('id') id: string,
    @Body() dto: { isActive?: boolean; isFeatured?: boolean },
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.productsService.moderate(id, dto, actorId, req);
  }
}
