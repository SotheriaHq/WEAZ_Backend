import { Controller, Get, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../../auth/guard/role.guard';
import { SetMetadata } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CategorySuggestionsService, CategorySuggestionStatus } from './category-suggestions.service';
import { ModerateCategorySuggestionDto } from './dto/moderate-category-suggestion.dto';
import { Role } from '@prisma/client';
import { Req } from '@nestjs/common';

const Roles = (...roles: Role[]) => SetMetadata('roles', roles);

@ApiTags('admin-category-suggestions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.SuperAdmin)
@Controller('admin/categories/suggestions')
export class CategorySuggestionsAdminController {
  constructor(private readonly suggestions: CategorySuggestionsService) {}

  @Get()
  @ApiOperation({ summary: 'List category suggestions (filter by status optional)' })
  async list(@Query('status') status?: CategorySuggestionStatus): Promise<any> {
    return this.suggestions.adminList(status);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Moderate a suggestion (approve or reject)' })
  async moderate(@Param('id') id: string, @Body() dto: ModerateCategorySuggestionDto, @Req() req: any): Promise<any> {
    return this.suggestions.moderate(id, req.user.id, dto);
  }
}
