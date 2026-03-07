import {
  Controller,
  Get,
  Post,
  Delete,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  Req,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { Request } from 'express';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { AdminFeaturedService } from './admin-featured.service';
import { CreateFeaturedDto } from './dto';

@Controller('admin/featured')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminFeaturedController {
  constructor(private readonly featuredService: AdminFeaturedService) {}

  @Post()
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async featureItem(
    @Body(new ValidationPipe({ whitelist: true })) dto: CreateFeaturedDto,
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.featuredService.featureItem(dto, actorId, req);
  }

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async list(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
    @Query('entityType') entityType?: string,
    @Query('brandId') brandId?: string,
  ) {
    return this.featuredService.list({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      status: status as any,
      entityType,
      brandId,
    });
  }

  @Get('active')
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async listActive() {
    return this.featuredService.listActive();
  }

  @Get('slots')
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async getSlots() {
    return this.featuredService.getSlotsSummary();
  }

  @Get('search')
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async searchEligible(
    @Query('entityType') entityType?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    return this.featuredService.searchEligible({
      entityType,
      search,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('history')
  @Roles(Role.SuperAdmin)
  async history(
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('brandId') brandId?: string,
    @Query('entityType') entityType?: string,
    @Query('removeReason') removeReason?: string,
  ) {
    return this.featuredService.history({
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      brandId,
      entityType,
      removeReason,
    });
  }

  @Get(':id/performance')
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async getPerformance(@Param('id') id: string) {
    return this.featuredService.getPerformance(id);
  }

  @Delete(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.FEATURED_MANAGE)
  async remove(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.featuredService.remove(id, actorId, req);
  }

  // ── SuperAdmin Blocking ──

  @Patch('block/product/:id')
  @Roles(Role.SuperAdmin)
  async toggleBlockProduct(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.featuredService.toggleBlockProduct(id, actorId, req);
  }

  @Patch('block/collection/:id')
  @Roles(Role.SuperAdmin)
  async toggleBlockCollection(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.featuredService.toggleBlockCollection(id, actorId, req);
  }

  @Patch('block/brand/:id')
  @Roles(Role.SuperAdmin)
  async toggleBlockBrand(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.featuredService.toggleBlockBrand(id, actorId, req);
  }
}
