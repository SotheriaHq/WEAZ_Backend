import {
  Controller,
  Get,
  Header,
  Param,
  Query,
  Req,
  UseGuards,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsPublic } from 'src/auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from 'src/auth/guard/optional-jwt-auth.guard';
import { MarketSectionService } from './market-section.service';
import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';
import { MarketPipelineService } from './pipeline/market-pipeline.service';
import { defaultPipelineSpecs } from './pipeline/market-pipeline.defaults';
import { MarketFlagsService } from './market-flags.service';
import { legacyPipelineSection } from './market-pipeline-facade';
import { Throttle } from '@nestjs/throttler';
import { MarketCatalogViewer } from './catalog/market-catalog-scope';
import {
  parseMarketPageRequest,
  requestAbortScope,
} from './market-page.controller';

@ApiTags('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
@Controller('market')
export class MarketSectionController {
  constructor(
    private readonly marketSectionService: MarketSectionService,
    @Optional() private readonly pipeline?: MarketPipelineService,
    @Optional() private readonly flags?: MarketFlagsService,
    @Optional() private readonly delivery?: MarketPipelineDeliveryService,
  ) {}

  private viewer(req: any, anonymous?: string): MarketCatalogViewer {
    if (anonymous !== undefined && !/^[A-Za-z0-9_-]{16,128}$/.test(anonymous))
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Use a valid Market session.',
      });
    const id = req?.user?.id ?? req?.user?.sub;
    return id
      ? { userId: id }
      : anonymous
        ? { anonymousSessionId: anonymous }
        : {};
  }

  private legacyQuery(req: any, detail: boolean): void {
    if (!req?.originalUrl) return;
    const query = new URL(req.originalUrl, 'https://market.invalid')
      .searchParams;
    const allowed = new Set([
      'limit',
      'anonymousSessionId',
      ...(detail ? ['cursor'] : []),
    ]);
    if (
      [...query.keys()].some(
        (key) => !allowed.has(key) || query.getAll(key).length > 1,
      )
    )
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Refresh this list before changing its filters.',
      });
  }

  @Get('sections')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get bounded market section previews' })
  async getSections(
    @Query('limit') limit?: string,
    @Query('anonymousSessionId') anonymousSessionId?: string,
    @Req() req?: any,
  ) {
    // Older clients use `limit` as per-rail preview capacity. Preserve that
    // contract until their release switches to the explicit /market/page API.
    if (limit === undefined && this.flags?.isEnabled('HOME') && this.delivery) {
      const query = req?.originalUrl
        ? new URL(req.originalUrl, 'https://market.invalid').searchParams
        : new URLSearchParams(anonymousSessionId ? { anonymousSessionId } : {});
      const input = parseMarketPageRequest(
        query,
        req?.user?.id ?? req?.user?.sub,
      );
      const scope = requestAbortScope(req);
      let page: Awaited<ReturnType<MarketPipelineDeliveryService['page']>>;
      try {
        page = await this.delivery.page({ ...input, signal: scope.signal });
      } finally {
        scope.dispose();
      }
      return {
        generatedAt: page.generatedAt,
        sections: page.sections.map((section) =>
          legacyPipelineSection(section),
        ),
        metadata: {
          version: 'phase1.v1',
          personalization: 'disabled',
          cachePolicy: 'private-no-store',
          engine: 'pipeline-v2',
        },
      };
    }
    this.legacyQuery(req, false);
    return this.marketSectionService.getSections({
      limit: limit ? parseInt(limit, 10) : undefined,
      userId: req?.user?.id ?? req?.user?.sub ?? null,
      anonymousSessionId,
    });
  }

  @Get('sections/:key')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  @Header('Cache-Control', 'private, no-store')
  @ApiOperation({ summary: 'Get one market section with bounded pagination' })
  async getSectionDetail(
    @Param('key') key: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('anonymousSessionId') anonymousSessionId?: string,
    @Req() req?: any,
  ) {
    const known =
      key === 'explore-market' ||
      defaultPipelineSpecs().some((spec) => spec.key === key);
    const legacyCursor =
      !!cursor && (/^[0-9]+$/.test(cursor) || /^[a-f0-9-]{36}$/i.test(cursor));
    const canonicalCursor = !!cursor && cursor.includes('.');
    if (
      known &&
      !legacyCursor &&
      this.flags?.isEnabled('SEE_ALL') &&
      this.pipeline &&
      req?.originalUrl
    ) {
      const query = new URL(req.originalUrl, 'https://market.invalid')
        .searchParams;
      if (query.getAll('anonymousSessionId').length > 1)
        throw new BadRequestException({
          code: 'INVALID_FILTER',
          message: 'Do not repeat Market controls.',
        });
      query.delete('anonymousSessionId');
      const viewer = this.viewer(req, anonymousSessionId);
      const scope = requestAbortScope(req);
      let result: Awaited<ReturnType<MarketPipelineService['getSection']>>;
      try {
        result = await this.pipeline.getSection({
          key,
          viewer,
          query,
          signal: scope.signal,
        });
      } finally {
        scope.dispose();
      }
      if (result.kind === 'catalogue')
        return {
          generatedAt: result.data.meta?.asOf ?? new Date().toISOString(),
          section: legacyPipelineSection(
            { ...result.section, items: result.data.items },
            result.data.pagination,
          ),
          availableSorts: result.data.availableSorts,
          appliedFilters: result.data.appliedFilters,
          sort: result.data.sort,
          meta: result.data.meta,
          ...('facets' in result.data ? { facets: result.data.facets } : {}),
        };
    }
    if (canonicalCursor)
      throw new BadRequestException({
        code: 'INVALID_CURSOR',
        message: 'Refresh this list to continue.',
      });
    this.legacyQuery(req, true);
    return this.marketSectionService.getSectionDetail(key, {
      cursor,
      limit: limit ? parseInt(limit, 10) : undefined,
      userId: req?.user?.id ?? req?.user?.sub ?? null,
      anonymousSessionId,
    });
  }
}
