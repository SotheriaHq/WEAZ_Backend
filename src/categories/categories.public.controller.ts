import { Controller, Get, Param } from '@nestjs/common';
import { CategoriesService } from './categories.service';
import { ApiTags, ApiOperation } from '@nestjs/swagger';

/**
 * Public-facing category endpoints (no auth required).
 * Used by frontend creation forms to populate dropdowns and filters.
 */
@ApiTags('categories')
@Controller('categories')
export class CategoriesPublicController {
  constructor(private readonly categories: CategoriesService) {}

  @Get()
  @ApiOperation({ summary: 'List active categories with sub-categories' })
  async list() {
    return this.categories.listCategoriesWithSubCategories();
  }

  @Get('filters')
  @ApiOperation({ summary: 'List active filter dimensions with values' })
  async filters() {
    return this.categories.getFilterDimensions();
  }

  @Get(':id/sub-categories')
  @ApiOperation({ summary: 'Get sub-categories for a main category' })
  async subCategories(@Param('id') id: string) {
    return this.categories.getSubCategoriesByCategoryId(id);
  }
}
