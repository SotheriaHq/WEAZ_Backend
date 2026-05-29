import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { CategoriesService } from './categories.service';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
import { UpsertSubCategoryDto } from './dto/upsert-sub-category.dto';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guard/role.guard';
import { Role } from '@prisma/client';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '../auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequirePermissions } from '../admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../admin/constants/permissions';

const actorIdFromRequest = (
  req: Request & { user?: { id?: string; sub?: string } },
) => req.user?.id ?? req.user?.sub;

@ApiTags('admin-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
@Controller('admin/categories')
export class CategoriesAdminController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_READ)
  @ApiOperation({ summary: 'List categories (optionally include inactive)' })
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.categories.adminList(includeInactive === 'true');
  }

  @Post()
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Create category' })
  async create(
    @Body() dto: UpsertCategoryDto,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.create(dto, actorIdFromRequest(req));
  }

  @Patch(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Update category fields' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpsertCategoryDto,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.update(id, dto, actorIdFromRequest(req));
  }

  @Patch(':id/activate')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Activate category' })
  async activate(
    @Param('id') id: string,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.activate(id, actorIdFromRequest(req));
  }

  @Patch(':id/deactivate')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Deactivate category' })
  async deactivate(
    @Param('id') id: string,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.deactivate(id, actorIdFromRequest(req));
  }

  @Delete(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Delete category (only if unused)' })
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.remove(id, actorIdFromRequest(req));
  }

  @Get(':id/sub-categories')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_READ)
  @ApiOperation({ summary: 'List sub-categories for a main category' })
  async subCategories(
    @Param('id') id: string,
    @Query('includeInactive') includeInactive?: string,
  ) {
    return this.categories.getSubCategoriesByCategoryId(
      id,
      includeInactive === 'true',
    );
  }

  @Post(':id/sub-categories')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Create sub-category under a main category' })
  async createSubCategory(
    @Param('id') id: string,
    @Body() dto: UpsertSubCategoryDto,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.createSubCategory(id, dto, actorIdFromRequest(req));
  }

  @Patch('sub-categories/:subCategoryId')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Update sub-category fields' })
  async updateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Body() dto: UpsertSubCategoryDto,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.updateSubCategory(
      subCategoryId,
      dto,
      actorIdFromRequest(req),
    );
  }

  @Patch('sub-categories/:subCategoryId/activate')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Activate sub-category' })
  async activateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.activateSubCategory(
      subCategoryId,
      actorIdFromRequest(req),
    );
  }

  @Patch('sub-categories/:subCategoryId/deactivate')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  @ApiOperation({ summary: 'Deactivate sub-category' })
  async deactivateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Req() req: Request & { user: { id?: string; sub?: string } },
  ) {
    return this.categories.deactivateSubCategory(
      subCategoryId,
      actorIdFromRequest(req),
    );
  }

  @Get('filters/dimensions')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_READ)
  @ApiOperation({ summary: 'List all filter dimensions with values' })
  async filterDimensions() {
    return this.categories.getFilterDimensions();
  }
}
