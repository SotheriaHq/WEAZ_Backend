import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { MarketCatalogReadService } from '../catalog/market-catalog-read.service';
import { MarketCatalogService } from '../catalog/market-catalog.service';
import {
  createMarketCatalogScope,
  MarketCatalogViewer,
} from '../catalog/market-catalog-scope';
import { MarketPublicMediaService } from '../catalog/market-public-media.service';
import { CanonicalMarketFilters } from '../catalog/market-filters';
import { parseMarketCatalogRequest } from '../catalog/market-catalog-request';
import { PipelineCandidateCache } from './market-pipeline.cache';
import { defaultPipelineSpecs } from './market-pipeline.defaults';
import { MarketPipelineMediaResolver } from './market-pipeline.media';
import { buildMarketPipelinePage } from './market-pipeline.page';
import { resolvePipelineSectionSource } from './market-pipeline.section-source';
import { readPipelineSourceSection } from './market-pipeline.section-reader';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import { PipelineSource, PipelineSurface } from './market-pipeline.types';

export const MARKET_PIPELINE_CACHE = Symbol('MARKET_PIPELINE_CACHE');

export interface MarketPipelinePageInput {
  readonly viewer: MarketCatalogViewer;
  readonly surface?: PipelineSurface;
  readonly filters?: CanonicalMarketFilters;
  readonly productId?: string;
  readonly specs?: readonly unknown[];
  readonly signal?: AbortSignal;
  readonly sectionLimit?: number;
}

/** Hash validated definitions, never caller-selected version text or preview IDs. */
export function marketPipelineSpecHash(input: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(parsePipelineSpec(input)))
    .digest('hex');
}

export function marketPipelinePublicSpecs(inputs: readonly unknown[]) {
  const specs = inputs.map(parsePipelineSpec);
  validatePipelineGraph(specs);
  return specs
    .filter((spec) => spec.status === 'ACTIVE')
    .map((spec) => ({
      key: spec.key,
      version: spec.version,
      hash: marketPipelineSpecHash(spec),
      template: spec.template,
      surface: spec.placement.surface,
      sorts: spec.sorts,
    }));
}

function productSource(source: PipelineSource): source is Extract<
  PipelineSource,
  {
    kind: 'catalog' | 'low_stock' | 'curated' | 'similar' | 'complements';
  }
> {
  return ['catalog', 'low_stock', 'curated', 'similar', 'complements'].includes(
    source.kind,
  );
}

/** Request-local composition; no singleton stores viewer state or hydrated media. */
@Injectable()
export class MarketPipelineService {
  constructor(
    private readonly reads: MarketCatalogReadService,
    private readonly media: MarketPublicMediaService,
    private readonly catalogue: MarketCatalogService,
    @Optional()
    @Inject(MARKET_PIPELINE_CACHE)
    private readonly cache?: PipelineCandidateCache,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private async build(input: MarketPipelinePageInput) {
    return buildMarketPipelinePage({
      read: this.reads,
      media: new MarketPipelineMediaResolver(this.media),
      viewer: input.viewer,
      surface: input.surface ?? 'HOME',
      filters: input.filters ?? {},
      productId: input.productId,
      specs: input.specs ?? defaultPipelineSpecs(),
      useDefaultSpecs: input.specs === undefined,
      signal: input.signal,
      sectionLimit: input.sectionLimit,
      cache: this.cache,
    });
  }

  async getPage(input: MarketPipelinePageInput) {
    return (await this.build(input)).public;
  }

  /** Server delivery hook for the receipt writer; only `.public` is serialized. */
  async preparePage(input: MarketPipelinePageInput) {
    return this.build(input);
  }

  /** Internal use only. HTTP accepts a section key; it never accepts this scope. */
  async getScope(input: MarketPipelinePageInput & { readonly key: string }) {
    const resolved = await resolvePipelineSectionSource({
      reads: this.reads,
      specs:
        input.specs ??
        defaultPipelineSpecs(input.key === 'explore-market' ? 0 : undefined),
      key: input.key,
      viewer: input.viewer,
      surface: input.surface,
      productId: input.productId,
      signal: input.signal,
    });
    const { original, effective, source } = resolved;
    const section = {
      key: original.key,
      title: effective.title,
      subtitle: effective.subtitle,
      policy: effective.rankingPolicy,
      metadata: {
        fallbackUsed:
          effective.template !== original.template ||
          resolved.fallbackReason !== null,
        fallbackReason: resolved.fallbackReason,
        candidateCount: resolved.candidateCount,
        minItems: effective.capacity.minItems,
      },
      template: effective.template,
      viewAll: {
        enabled: true,
        sectionKey: original.key,
        specVersion: original.version,
        effectiveTemplate: effective.template,
        availableSorts: effective.sorts,
      },
      scope: { source, fixedFilterLayers: resolved.fixedFilterLayers },
    };
    if (!productSource(source))
      return { kind: 'legacy' as const, section, resolved };
    const [fixedFilters = {}, ...filterLayers] =
      section.scope.fixedFilterLayers;
    const sourceHash = createHash('sha256')
      .update(
        JSON.stringify({
          source,
          layers: section.scope.fixedFilterLayers,
          template: section.template,
        }),
      )
      .digest('hex');
    const scope = createMarketCatalogScope({
      key: section.key,
      version: `${original.version}.${marketPipelineSpecHash(original).slice(0, 16)}.${sourceHash}`,
      viewer: input.viewer,
      source,
      filterLayers,
      ...(effective.template === 'TREND' && resolved.context.epoch
        ? {
            trendEvidence: {
              epochId: resolved.context.epoch.id,
              actorFloor: effective.params.evidenceFloorActors,
            },
          }
        : {}),
    });
    return {
      kind: 'catalogue' as const,
      scope,
      fixedFilters,
      section,
      resolved,
    };
  }

  async getSection(
    input: MarketPipelinePageInput & {
      readonly key: string;
      readonly query: URLSearchParams;
    },
  ) {
    const request = parseMarketCatalogRequest(input.query);
    const trusted = await this.getScope(input);
    // Source-order lists require their dedicated cursor reader. The facade keeps
    // its existing route until that full-set reader is available.
    if (
      request.sort &&
      !trusted.section.viewAll.availableSorts.some(
        (sort) => sort === request.sort,
      )
    )
      throw new BadRequestException({
        code: 'UNSUPPORTED_SORT',
        message: 'Choose an available section sort.',
      });
    const sourceOrdering =
      !request.sort &&
      [
        'CURATED_LIST',
        'COMPLEMENTS',
        'SIMILAR_ITEMS',
        'LOW_STOCK',
        'LOOKS',
        'CATEGORY_TILES',
        'NEW_DESIGNERS',
        'FROM_RUNWAY',
      ].includes(trusted.section.template);
    if (sourceOrdering) {
      if (!this.config)
        throw new ServiceUnavailableException({
          code: 'CATALOGUE_CURSOR_UNAVAILABLE',
          message: 'The catalogue is updating. Please try again shortly.',
        });
      const resolved =
        'resolved' in trusted && trusted.resolved
          ? trusted.resolved
          : await resolvePipelineSectionSource({
              reads: this.reads,
              specs: input.specs ?? defaultPipelineSpecs(),
              key: input.key,
              viewer: input.viewer,
              surface: input.surface,
              productId: input.productId,
              signal: input.signal,
            });
      if (request.includeFacets && trusted.kind !== 'catalogue')
        throw new BadRequestException({
          code: 'INVALID_FILTER',
          message: 'Facet counts are available for product lists.',
        });
      const data = await readPipelineSourceSection({
        reads: this.reads,
        media: this.media,
        config: this.config,
        resolved,
        viewer: input.viewer,
        filters: request.filters,
        limit: request.limit,
        cursor: request.cursor,
        signal: input.signal,
      });
      const facetQuery = new URLSearchParams(input.query);
      for (const key of ['sort', 'limit', 'cursor', 'includeFacets'])
        facetQuery.delete(key);
      const facets =
        request.includeFacets && trusted.kind === 'catalogue'
          ? await this.catalogue.facets(facetQuery, input.viewer, {
              scope: trusted.scope,
              fixedFilters: trusted.fixedFilters,
            })
          : undefined;
      return {
        kind: 'catalogue' as const,
        data: { ...data, ...(facets ? { facets } : {}) },
        section: {
          key: trusted.section.key,
          title: trusted.section.title,
          subtitle: trusted.section.subtitle,
          policy: trusted.section.policy,
          metadata: trusted.section.metadata,
          template: trusted.section.template,
          viewAll: trusted.section.viewAll,
        },
      };
    }
    if (trusted.kind !== 'catalogue') return trusted;
    const query = new URLSearchParams(input.query);
    if (!request.sort)
      query.set(
        'sort',
        trusted.section.template === 'TREND'
          ? 'trending'
          : trusted.section.template === 'CATALOG_POPULAR'
            ? 'popular'
            : 'newest',
      );
    const data = await this.catalogue.getPage(query, input.viewer, {
      scope: trusted.scope,
      fixedFilters: trusted.fixedFilters,
    });
    return {
      kind: 'catalogue' as const,
      data,
      section: {
        key: trusted.section.key,
        title: trusted.section.title,
        subtitle: trusted.section.subtitle,
        policy: trusted.section.policy,
        metadata: trusted.section.metadata,
        template: trusted.section.template,
        viewAll: trusted.section.viewAll,
      },
    };
  }
}
