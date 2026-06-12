import { Controller, Get, Header, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { FeedCategoryService } from './feed-category.service';

@ApiTags('feed')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('feed')
export class FeedCategoryController {
  constructor(private readonly feedCategoryService: FeedCategoryService) {}

  @Get('categories')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get active runway/feed category configuration' })
  getCategories(@Req() req: any) {
    return this.feedCategoryService.listCategories({
      userId: req?.user?.id ?? req?.user?.sub ?? null,
    });
  }
}
