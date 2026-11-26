import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Req,
  UseGuards,
  Optional,
  BadRequestException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsPublic } from '../../auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from '../../auth/guard/optional-jwt-auth.guard';
import { MarketFlagsService } from '../market-flags.service';
import { MarketCatalogService } from './market-catalog.service';
import { MarketCatalogViewer } from './market-catalog-scope';
import { MarketPipelineService } from '../pipeline/market-pipeline.service';
import { parseMarketFilters } from './market-filters';

type CatalogRequest = Request & { user?: { id?: string; sub?: string } };
@Controller('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
export class MarketCatalogController {
  constructor(
    private readonly catalog: MarketCatalogService,
    private readonly flags: MarketFlagsService,
    @Optional() private readonly pipeline?: MarketPipelineService,
  ) {}
  private viewer(
    req: CatalogRequest,
    query?: URLSearchParams,
  ): MarketCatalogViewer {
    const anonymous = query?.get('anonymousSessionId');
    if (
      query &&
      (query.toString().length > 16384 ||
        query.getAll('anonymousSessionId').length > 1 ||
        (anonymous !== null &&
          anonymous !== undefined &&
          !/^[A-Za-z0-9_-]{16,128}$/.test(anonymous)))
    )
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Use a valid Market session.',
      });
    query?.delete('anonymousSessionId');
    const id = req.user?.id ?? req.user?.sub;
    return id
      ? { userId: id }
      : anonymous
        ? { anonymousSessionId: anonymous }
        : {};
  }
  private enabled(): void {
    if (!this.flags.isEnabled('CATALOG')) throw new NotFoundException();
  }
  @Get('catalog')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  page(@Req() req: CatalogRequest) {
    this.enabled();
    const query = new URL(req.originalUrl, 'https://catalog.invalid')
      .searchParams;
    return this.catalog.getPage(query, this.viewer(req, query));
  }
  @Get('facets')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 30, ttl: 60000 } })
  facets(@Req() req: CatalogRequest) {
    if (!this.flags.isEnabled('CATALOG') && !this.flags.isEnabled('SEE_ALL'))
      throw new NotFoundException();
    const query = new URL(req.originalUrl, 'https://catalog.invalid')
      .searchParams;
    if (query.get('surface') === 'SEE_ALL') {
      if (!this.flags.isEnabled('SEE_ALL') || !this.pipeline)
        throw new NotFoundException();
      return this.sectionFacets(query, req);
    }
    this.enabled();
    return this.catalog.facets(query, this.viewer(req, query));
  }

  private async sectionFacets(query: URLSearchParams, req: CatalogRequest) {
    const key = query.get('sectionKey');
    const anonymous = query.get('anonymousSessionId');
    if (
      query.toString().length > 16384 ||
      ['surface', 'sectionKey', 'anonymousSessionId'].some(
        (name) => query.getAll(name).length > 1,
      ) ||
      !key ||
      !/^[a-z0-9][a-z0-9-]{0,79}$/.test(key) ||
      (anonymous !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(anonymous))
    )
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Choose a valid Market section and session.',
      });
    const viewer =
      req.user?.id || req.user?.sub
        ? this.viewer(req)
        : anonymous
          ? { anonymousSessionId: anonymous }
          : {};
    for (const name of ['surface', 'sectionKey', 'anonymousSessionId'])
      query.delete(name);
    parseMarketFilters(query);
    const trusted = await this.pipeline!.getScope({ key, viewer });
    if (trusted.kind !== 'catalogue')
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Facet counts are available for product lists.',
      });
    return this.catalog.facets(query, viewer, {
      scope: trusted.scope,
      fixedFilters: trusted.fixedFilters,
    });
  }
}
