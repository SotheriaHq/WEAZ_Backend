import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MarketCatalogReadService } from '../catalog/market-catalog-read.service';
import { MarketCatalogViewer } from '../catalog/market-catalog-scope';
import { CanonicalMarketFilters } from '../catalog/market-filters';
import {
  readPipelineEpochContext,
  pipelineRequestKey,
} from './market-pipeline.database';
import {
  pipelineBatchSourcesSql,
  PipelineDatabaseRow,
} from './market-pipeline.database.sql';
import {
  PipelineContext,
  PipelineSpec,
  PipelineSurface,
  PipelineSourceRequest,
} from './market-pipeline.types';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import {
  defaultPipelineFallbacks,
  pipelineSource,
  pipelineUnavailableReason,
  resolvePipelineFallback,
} from './market-pipeline.sources';
import { ResolvedPipelineSection } from './market-pipeline.section-reader';
import { eligibleProductSql } from '../eligibility/market-eligibility';

function available(spec: PipelineSpec, context: PipelineContext): boolean {
  const now = context.asOf.getTime();
  return (
    spec.status === 'ACTIVE' &&
    spec.placement.surface === context.surface &&
    (context.signedIn ? spec.audience.signedIn : spec.audience.guests) &&
    (!spec.schedule.startsAt || Date.parse(spec.schedule.startsAt) <= now) &&
    (!spec.schedule.endsAt || Date.parse(spec.schedule.endsAt) > now)
  );
}
/** Source meaning is determined independently from a rendered preview. A
 * short/empty See All page cannot disappear merely because media was omitted
 * from a home preview, or because another section exhausted the home cap. */
export async function resolvePipelineSectionSource(input: {
  reads: MarketCatalogReadService;
  specs: readonly unknown[];
  key: string;
  viewer: MarketCatalogViewer;
  surface?: PipelineSurface;
  productId?: string;
  signal?: AbortSignal;
}): Promise<ResolvedPipelineSection> {
  const definitions = input.specs.map(parsePipelineSpec);
  validatePipelineGraph(definitions);
  const original = definitions.find(
    (spec) => spec.key === input.key && spec.status === 'ACTIVE',
  );
  if (!original)
    throw new NotFoundException({
      code: 'UNKNOWN_SECTION',
      message: 'This Market section is unavailable.',
    });
  return input.reads.run(async (tx) => {
    const epoch = await readPipelineEpochContext(tx);
    const context: PipelineContext = {
      ...epoch,
      surface: input.surface ?? 'HOME',
      signedIn: Boolean(input.viewer.userId),
      filters: {},
      ...(input.productId ? { productId: input.productId } : {}),
      signal: input.signal,
      retentionHours: 24,
      personalEnabled: false,
      regionalEnabled: false,
      suppression: {
        targetKeys: new Set(),
        brandIds: new Set(),
        categoryIds: new Set(),
        sectionKeys: new Set(),
      },
      tenure: new Map(),
    };
    if (!available(original, context))
      throw new NotFoundException({
        code: 'UNKNOWN_SECTION',
        message: 'This Market section is unavailable.',
      });
    const byKey = new Map(definitions.map((spec) => [spec.key, spec]));
    const queue: Array<{
      spec: PipelineSpec;
      layers: readonly CanonicalMarketFilters[];
      depth: number;
      reason: string | null;
    }> = [
      { spec: original, layers: [original.filters], depth: 0, reason: null },
    ];
    const sources: Array<{
      key: string;
      request: PipelineSourceRequest;
      spec: PipelineSpec;
      layers: readonly CanonicalMarketFilters[];
      reason: string | null;
    }> = [];
    const tried = new Set<string>();
    while (queue.length) {
      const current = queue.shift()!;
      const label = `${current.spec.key}:${current.spec.template}`;
      if (current.depth > 2 || tried.has(label)) continue;
      tried.add(label);
      const unavailable = pipelineUnavailableReason(current.spec, context);
      if (!unavailable) {
        const windows =
          current.spec.template === 'NEW_RELEASES'
            ? [
                ...new Set([
                  current.spec.params.eligibilityWindowDays,
                  Math.max(current.spec.params.eligibilityWindowDays, 60),
                  90,
                ]),
              ]
            : [current.spec.params.eligibilityWindowDays];
        for (const days of windows) {
          const request: PipelineSourceRequest = {
            sectionKey: original.key,
            source: pipelineSource(current.spec, context, days),
            fixedFilterLayers: current.layers,
            filters: {},
            epoch: context.epoch,
            asOf: context.asOf,
            limit: current.spec.capacity.minItems,
            signal: input.signal ?? new AbortController().signal,
            suppressionMode: 'viewer',
          };
          sources.push({
            key: pipelineRequestKey(request),
            request,
            spec: current.spec,
            layers: current.layers,
            reason: current.reason,
          });
        }
      }
      for (const name of defaultPipelineFallbacks(current.spec)) {
        const fallback = resolvePipelineFallback(current.spec, name, byKey);
        if (fallback && fallback.status === 'ACTIVE')
          queue.push({
            spec: fallback,
            layers:
              fallback.key === current.spec.key
                ? current.layers
                : [...current.layers, fallback.filters],
            depth: current.depth + 1,
            reason: current.reason ?? unavailable ?? 'INSUFFICIENT_CANDIDATES',
          });
      }
    }
    if (!sources.length)
      throw new NotFoundException({
        code: 'UNKNOWN_SECTION',
        message: 'This Market section is unavailable.',
      });
    const rows = await tx.$queryRaw<PipelineDatabaseRow[]>(
      pipelineBatchSourcesSql(sources, input.viewer),
    );
    const qualifying = (source: (typeof sources)[number]) =>
      rows.filter(
        (row) =>
          row.requestKey === source.key &&
          (source.spec.template !== 'TREND' ||
            (row.candidate.features.trendEligible &&
              (row.candidate.features.actors7d ?? -1) >=
                source.spec.params.evidenceFloorActors)),
      );
    const selected =
      sources.find(
        (source) => qualifying(source).length >= source.spec.capacity.minItems,
      ) ?? sources[sources.length - 1];
    const targetFingerprint = input.productId
      ? ((
          await tx.$queryRaw<Array<{ value: string }>>(Prisma.sql`
          SELECT md5(jsonb_build_object('updated',p."updatedAt",'category',p."categoryId",'type',p."categoryTypeId",'price',p.price::text,'sale',p."salePrice"::text,'saleStart',p."saleStartAt",'saleEnd',p."saleEndAt",
            'tags',(SELECT COALESCE(sum(hashtextextended(binding."tagId"::text,0)),0)::text FROM "TagBinding" binding WHERE binding."entityType"='PRODUCT' AND binding."entityId"=p."_id"),
            'dimensions',(SELECT COALESCE(sum(hashtextextended(binding."filterValueId"::text,0)),0)::text FROM "EntityFilter" binding WHERE binding."entityType"='PRODUCT' AND binding."entityId"=p."_id"))::text) AS value
          FROM "Product" p WHERE p."_id"=${input.productId}::uuid AND ${eligibleProductSql(context.asOf)} LIMIT 1`)
        )[0]?.value ?? null)
      : null;
    return {
      original,
      effective: selected.spec,
      source: selected.request.source,
      fixedFilterLayers: selected.layers,
      context,
      fallbackReason: selected.reason,
      candidateCount: qualifying(selected).length,
      targetFingerprint,
    };
  });
}
