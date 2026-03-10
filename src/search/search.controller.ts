import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { SearchQueryDto } from './dto/search-query.dto';
import { SearchSuggestQueryDto } from './dto/search-suggest-query.dto';
import { SearchService } from './search.service';
import { SEARCH_ENTITY_TYPES, type SearchEntityType } from './search.types';

@ApiTags('search')
@Controller('v1/search')
export class SearchController {
  constructor(private readonly searchService: SearchService) {}

  private parseTypes(input?: string): SearchEntityType[] | undefined {
    if (!input) {
      return undefined;
    }

    const parts = Array.from(
      new Set(
        input
      .split(',')
      .map((item) => item.trim().toLowerCase())
          .filter(Boolean),
      ),
    );

    if (parts.includes('all')) {
      if (parts.length > 1) {
        throw new BadRequestException(
          'The all search type cannot be combined with other types',
        );
      }
      return undefined;
    }

    const invalid = parts.filter(
      (item) => !SEARCH_ENTITY_TYPES.includes(item as SearchEntityType),
    );

    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unsupported search type(s): ${invalid.join(', ')}`,
      );
    }

    return parts as SearchEntityType[];
  }

  @Get()
  @ApiOperation({ summary: 'Search across public Threadly entities' })
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 120, ttl: 60000 } })
  async search(@Query() query: SearchQueryDto, @Req() req: any) {
    const searchTerm = query.q ?? query.search ?? '';
    return this.searchService.search({
      query: searchTerm,
      types: this.parseTypes(query.type),
      page: query.page,
      limit: query.limit,
      brandId: query.brandId,
      userId: req?.user?.id ?? req?.user?.sub,
    });
  }

  @Get('suggest')
  @ApiOperation({ summary: 'Return public search suggestions and recent/trending queries' })
  @UseGuards(OptionalJwtAuthGuard)
  @Throttle({ default: { limit: 300, ttl: 60000 } })
  async suggest(@Query() query: SearchSuggestQueryDto, @Req() req: any) {
    const searchTerm = query.q ?? query.search ?? '';
    return this.searchService.suggest(
      searchTerm,
      req?.user?.id ?? req?.user?.sub,
      query.brandId,
    );
  }

  @Get('health')
  @ApiOperation({ summary: 'Report search subsystem readiness' })
  async health() {
    return this.searchService.health();
  }
}