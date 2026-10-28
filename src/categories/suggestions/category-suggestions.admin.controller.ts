import {
  Controller,
  Get,
  Patch,
  Param,
  Body,
  Query,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CategorySuggestionListQueryDto } from './dto/category-suggestion-list-query.dto';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../../auth/guard/role.guard';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { CategorySuggestionsService } from './category-suggestions.service';
import { ModerateCategorySuggestionDto } from './dto/moderate-category-suggestion.dto';
import { Role } from '@prisma/client';
import { Req } from '@nestjs/common';
import { Roles } from '../../auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../../admin/guards/admin-permission.guard';
import { RequirePermissions } from '../../admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../../admin/constants/permissions';

@ApiTags('admin-category-suggestions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
@Controller('admin/categories/suggestions')
export class CategorySuggestionsAdminController {
  constructor(private readonly suggestions: CategorySuggestionsService) {}

  @Get()
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_READ)
  @ApiOperation({
    summary: 'List category suggestions (filter by status optional)',
  })
  async list(@Query() query: CategorySuggestionListQueryDto): Promise<any> {
    return this.suggestions.adminList(query.status, query.cursor, query.limit);
  }

  @Patch(':id')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_SUGGESTIONS_MODERATE)
  @ApiOperation({ summary: 'Moderate a suggestion (approve or reject)' })
  async moderate(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: ModerateCategorySuggestionDto,
    @Req() req: any,
  ): Promise<any> {
    return this.suggestions.moderate(id, req.user?.id ?? req.user?.sub, dto);
  }
}
