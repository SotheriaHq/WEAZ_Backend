import {
  BadRequestException,
  Controller,
  Get,
  Header,
  NotFoundException,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request } from 'express';
import { IsPublic } from '../auth/decorator/is-public.decorator';
import { OptionalJwtAuthGuard } from '../auth/guard/optional-jwt-auth.guard';
import { parseMarketFilters } from './catalog/market-filters';
import { MarketCatalogViewer } from './catalog/market-catalog-scope';
import { MarketFlagsService } from './market-flags.service';
import { MarketPipelineDeliveryService } from './market-pipeline-delivery.service';

type PageRequest = Request & { user?: { id?: string; sub?: string } };

export function parseMarketPageRequest(
  query: URLSearchParams,
  userId?: string,
) {
  const clean = new URLSearchParams(query);
  if (
    clean.toString().length > 16384 ||
    ['surface', 'limit', 'anonymousSessionId'].some(
      (key) => clean.getAll(key).length > 1,
    )
  )
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: 'Use a bounded Market request without repeated controls.',
    });
  const surface = clean.get('surface') ?? 'HOME';
  const limit = clean.get('limit') ?? '8';
  const anonymous = clean.get('anonymousSessionId');
  if (
    surface !== 'HOME' ||
    !/^[1-8]$/.test(limit) ||
    (anonymous !== null && !/^[A-Za-z0-9_-]{16,128}$/.test(anonymous))
  )
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: 'Choose a supported Market surface, section limit and session.',
    });
  for (const key of ['surface', 'limit', 'anonymousSessionId'])
    clean.delete(key);
  const viewer: MarketCatalogViewer = userId
    ? { userId }
    : anonymous
      ? { anonymousSessionId: anonymous }
      : {};
  return {
    viewer,
    surface: 'HOME' as const,
    limit: Number(limit),
    filters: parseMarketFilters(clean),
  };
}

@Controller('market')
@IsPublic()
@UseGuards(OptionalJwtAuthGuard)
export class MarketPageController {
  constructor(
    private readonly delivery: MarketPipelineDeliveryService,
    private readonly flags: MarketFlagsService,
  ) {}
  @Get('page')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 60, ttl: 60000 } })
  async page(@Req() req: PageRequest) {
    if (!this.flags.isEnabled('HOME')) throw new NotFoundException();
    const input = parseMarketPageRequest(
      new URL(req.originalUrl, 'https://market.invalid').searchParams,
      req.user?.id ?? req.user?.sub,
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    const close = () => {
      if (!req.res?.writableEnded) abort();
    };
    req.once('aborted', abort);
    req.res?.once('close', close);
    if (req.aborted) abort();
    try {
      return await this.delivery.page({ ...input, signal: controller.signal });
    } finally {
      req.off('aborted', abort);
      req.res?.off('close', close);
    }
  }
}
