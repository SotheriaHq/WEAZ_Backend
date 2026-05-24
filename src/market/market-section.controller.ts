import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { MarketSectionService } from './market-section.service';

@ApiTags('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('market')
export class MarketSectionController {
  constructor(private readonly marketSectionService: MarketSectionService) {}

  @Get('sections')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get bounded market section previews' })
  async getSections(@Query('limit') limit?: string) {
    return this.marketSectionService.getSections({
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }

  @Get('sections/:key')
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get one market section with bounded pagination' })
  async getSectionDetail(
    @Param('key') key: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.marketSectionService.getSectionDetail(key, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
    });
  }
}
