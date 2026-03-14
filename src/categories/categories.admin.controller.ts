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

// Simple decorator for roles without repeating metadata logic inline
import { SetMetadata } from '@nestjs/common';
const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

@ApiTags('admin-categories')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SuperAdmin)
@Controller('admin/categories')
export class CategoriesAdminController {
  constructor(private readonly categories: CategoriesService) { }

  @Get()
  @ApiOperation({ summary: 'List categories (optionally include inactive)' })
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.categories.adminList(includeInactive === 'true');
  }

  @Post()
  @ApiOperation({ summary: 'Create category' })
  async create(
    @Body() dto: UpsertCategoryDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.create(dto, req.user.id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update category fields' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpsertCategoryDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.update(id, dto, req.user.id);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate category' })
  async activate(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.activate(id, req.user.id);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate category' })
  async deactivate(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.deactivate(id, req.user.id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete category (only if unused)' })
  async remove(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.remove(id, req.user.id);
  }

  @Get(':id/sub-categories')
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
  @ApiOperation({ summary: 'Create sub-category under a main category' })
  async createSubCategory(
    @Param('id') id: string,
    @Body() dto: UpsertSubCategoryDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.createSubCategory(id, dto, req.user.id);
  }

  @Patch('sub-categories/:subCategoryId')
  @ApiOperation({ summary: 'Update sub-category fields' })
  async updateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Body() dto: UpsertSubCategoryDto,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.updateSubCategory(subCategoryId, dto, req.user.id);
  }

  @Patch('sub-categories/:subCategoryId/activate')
  @ApiOperation({ summary: 'Activate sub-category' })
  async activateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.activateSubCategory(subCategoryId, req.user.id);
  }

  @Patch('sub-categories/:subCategoryId/deactivate')
  @ApiOperation({ summary: 'Deactivate sub-category' })
  async deactivateSubCategory(
    @Param('subCategoryId') subCategoryId: string,
    @Req() req: Request & { user: { id: string } },
  ) {
    return this.categories.deactivateSubCategory(subCategoryId, req.user.id);
  }

  @Get('filters/dimensions')
  @ApiOperation({ summary: 'List all filter dimensions with values' })
  async filterDimensions() {
    return this.categories.getFilterDimensions();
  }
}
