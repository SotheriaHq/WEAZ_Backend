import { Controller, Post, Body, UseGuards, Get, Req } from '@nestjs/common';
import { JwtAuthGuard } from '../../auth/guard/jwt-auth.guard';
import { CategorySuggestionsService } from './category-suggestions.service';
import { SubmitCategorySuggestionDto } from './dto/submit-category-suggestion.dto';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';

@ApiTags('category-suggestions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('categories/suggestions')
export class CategorySuggestionsController {
  constructor(private readonly suggestions: CategorySuggestionsService) {}

  @Post()
  @ApiOperation({ summary: 'Submit a new category suggestion' })
  async submit(@Req() req: any, @Body() dto: SubmitCategorySuggestionDto): Promise<any> {
    return this.suggestions.submit(req.user.id, dto);
  }

  @Get('mine')
  @ApiOperation({ summary: 'List suggestions submitted by current user' })
  async mine(@Req() req: any): Promise<any> {
    return this.suggestions.listMine(req.user.id);
  }
}
