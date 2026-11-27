import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  type CanonicalMarketFilters,
  marketFilterHash,
  parseMarketFilters,
} from '../../market/catalog/market-filters';
import { MARKET_FEATURE_STATE_KEY } from '../../market/intelligence/market-intelligence.contracts';
import {
  parseSearchQuery,
  type SearchParsedQuery,
} from '../lexicon/search-lexicon.parser';
import { SearchLexiconReader } from '../lexicon/search-lexicon.reader';
import {
  SEARCH_PRODUCT_SORTS,
  type SearchProductSort,
  searchProductSql,
} from './search-product.sql';

/** Rollback switch: anything but exactly "true" keeps the previous search path. */
export const searchLexiconEnabled = () =>
  process.env.SEARCH_LEXICON_V1 === 'true';

export interface SearchProductRequest {
  readonly sort: SearchProductSort;
  readonly filters: CanonicalMarketFilters;
  /** Canonical hash of the filters; part of every cache key. */
  readonly filterKey: string;
  readonly includeFacets: boolean;
}

export interface SearchProductRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly thumbnail: string | null;
  readonly images: string[] | null;
  readonly price: number | string | null;
  readonly salePrice: number | string | null;
  readonly effectivePrice: number | string | null;
  readonly currency: string | null;
  readonly slug: string | null;
  readonly brandId: string;
  readonly brandName: string | null;
  readonly brandOwnerId: string | null;
  readonly tier: number;
  readonly score: number | string;
  readonly exact: boolean;
  readonly lowStock: { size: string; left: number } | null;
}

export interface SearchProductPage {
  readonly total: number;
  readonly items: readonly SearchProductRow[];
  readonly facets: unknown;
}

/**
 * Validates the v2 controls once at the boundary. `filters` carries the
 * canonical catalogue encoding (the same keys `/market/catalog` takes), so
 * every filter rule and limit is the catalogue's own.
 */
export function parseSearchProductRequest(input: {
  sort?: string;
  filters?: string;
  includeFacets?: string;
}): SearchProductRequest {
  const sort = input.sort ?? 'relevance';
  if (!SEARCH_PRODUCT_SORTS.includes(sort as SearchProductSort))
    throw new BadRequestException({
      code: 'UNSUPPORTED_SORT',
      message: 'Choose an available search sort.',
    });
  if (
    input.includeFacets !== undefined &&
    input.includeFacets !== '0' &&
    input.includeFacets !== '1'
  )
    throw new BadRequestException({
      code: 'INVALID_FILTER',
      message: 'Use a valid includeFacets toggle.',
    });
  const filters = parseMarketFilters(new URLSearchParams(input.filters ?? ''));
  return Object.freeze({
    sort: sort as SearchProductSort,
    filters,
    filterKey: marketFilterHash(filters),
    includeFacets: input.includeFacets === '1',
  });
}

@Injectable()
export class SearchProductIntelligence {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lexicon: SearchLexiconReader,
  ) {}

  /** Query understanding; explicit request filters win over parsed ones. */
  async understand(
    rawQuery: string,
    request: SearchProductRequest,
  ): Promise<SearchParsedQuery> {
    const index = await this.lexicon.index();
    return parseSearchQuery(rawQuery, index, {
      explicitKeys: new Set(
        Object.keys(request.filters) as (keyof CanonicalMarketFilters)[],
      ),
    });
  }

  /**
   * One statement for the page, its exact total and optional facets; the
   * popular order adds one indexed read of the current READY epoch.
   */
  async page(
    parsed: SearchParsedQuery,
    request: SearchProductRequest,
    page: { limit: number; offset: number; brandId?: string; facets: boolean },
  ): Promise<SearchProductPage> {
    const epochId =
      request.sort === 'popular' ? await this.readyEpochId() : null;
    const layers: CanonicalMarketFilters[] = [request.filters, parsed.filters];
    const exactNameLayers: CanonicalMarketFilters[] = [request.filters];
    if (page.brandId) {
      layers.push({ brandIds: [page.brandId] });
      exactNameLayers.push({ brandIds: [page.brandId] });
    }
    const [row] = await this.prisma.$queryRaw<
      Array<{ total: number; items: SearchProductRow[]; facets: unknown }>
    >(
      searchProductSql({
        now: new Date(),
        layers,
        residual: parsed.residual,
        residualGroups: parsed.residualGroups,
        fullQuery: parsed.normalizedQuery,
        exactNameLayers,
        boosts: parsed.boosts,
        showLessBrandIds: [],
        sort: request.sort,
        epochId,
        limit: page.limit,
        offset: page.offset,
        facets: page.facets,
      }),
    );
    return {
      total: Number(row?.total ?? 0),
      items: row?.items ?? [],
      facets: page.facets ? (row?.facets ?? null) : null,
    };
  }

  private async readyEpochId(): Promise<string | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT epoch.id::text AS id FROM market_feature_state state
      JOIN market_feature_epochs epoch ON epoch.id=state."currentEpochId" AND epoch."stateKey"=state.key
      WHERE state.key=${MARKET_FEATURE_STATE_KEY} AND epoch.status='READY'`);
    return rows[0]?.id ?? null;
  }
}
