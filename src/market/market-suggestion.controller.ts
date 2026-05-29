import { Controller, Get, Header, Query, Req, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { MarketSuggestionQueryDto } from './dto/market-suggestion.dto';
import { MarketSuggestionService } from './market-suggestion.service';

@ApiTags('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('market')
export class MarketSuggestionController {
  constructor(
    private readonly marketSuggestionService: MarketSuggestionService,
  ) {}

  @Get('suggestions')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  @ApiOperation({
    summary: 'Get deterministic context-aware market suggestions',
  })
  async getSuggestions(
    @Query() query: MarketSuggestionQueryDto,
    @Req() req: any,
  ) {
    return this.marketSuggestionService.getSuggestions(query, {
      userId: req?.user?.id ?? req?.user?.sub ?? null,
      anonymousSessionId: query.anonymousSessionId,
    });
  }
}
