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
} from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { UpsertCategoryDto } from './dto/upsert-category.dto';
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
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List categories (optionally include inactive)' })
  async list(@Query('includeInactive') includeInactive?: string) {
    return this.categories.adminList(includeInactive === 'true');
  }

  @Post()
  @ApiOperation({ summary: 'Create category' })
  async create(@Body() dto: UpsertCategoryDto) {
    return this.categories.create(dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update category fields' })
  async update(@Param('id') id: string, @Body() dto: UpsertCategoryDto) {
    return this.categories.update(id, dto);
  }

  @Patch(':id/activate')
  @ApiOperation({ summary: 'Activate category' })
  async activate(@Param('id') id: string) {
    return this.categories.activate(id);
  }

  @Patch(':id/deactivate')
  @ApiOperation({ summary: 'Deactivate category' })
  async deactivate(@Param('id') id: string) {
    return this.categories.deactivate(id);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete category (only if unused)' })
  async remove(@Param('id') id: string) {
    return this.categories.remove(id);
  }
}
