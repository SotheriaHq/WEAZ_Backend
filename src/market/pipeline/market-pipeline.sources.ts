import { hasTemplate, PIPELINE_TEMPLATES } from './market-pipeline.registry';
import { parsePipelineSpec } from './market-pipeline.schema';
import {
  PipelineContext,
  PipelineSource,
  PipelineSpec,
  PipelineTemplate,
} from './market-pipeline.types';

export function pipelineEpochReady(context: PipelineContext): boolean {
  const epoch = context.epoch;
  const now = context.asOf.getTime();
  if (
    !epoch ||
    epoch.stateKey !== 'market.features.v1.r1' ||
    epoch.status !== 'READY' ||
    epoch.featureSchemaVersion !== 1 ||
    epoch.policyVersion !== 1 ||
    !epoch.complete ||
    typeof epoch.complete.popularity !== 'boolean' ||
    typeof epoch.complete.trend !== 'boolean' ||
    typeof epoch.complete.quality !== 'boolean' ||
    !Number.isSafeInteger(epoch.intentProductCount) ||
    epoch.intentProductCount < 0
  )
    return false;
  const source = Date.parse(epoch.sourceAsOf);
  const start = Date.parse(epoch.epochStart);
  const end = Date.parse(epoch.epochEnd);
  const accept = Date.parse(epoch.acceptUntil);
  return (
    [source, start, end, accept].every(Number.isFinite) &&
    start <= now &&
    end > start &&
    accept > now &&
    source <= now &&
    now - source <= 7200000
  );
}
export function pipelineUnavailableReason(
  spec: PipelineSpec,
  context: PipelineContext,
): string | null {
  const definition = PIPELINE_TEMPLATES[spec.template];
  // WP11/12 own activation. Neither a flag nor a spec can activate these here.
  if (definition.requiredHistoryHours)
    return context.retentionHours < definition.requiredHistoryHours
      ? 'RETENTION_POLICY'
      : 'PERSONALIZATION_UNAVAILABLE';
  if (definition.regional) return 'REGIONAL_UNAVAILABLE';
  if (['TREND', 'CATALOG_POPULAR', 'STARTER_PICKS'].includes(spec.template)) {
    if (!pipelineEpochReady(context)) return 'FEATURES_UNAVAILABLE';
    if (spec.template === 'TREND' && !context.epoch!.complete.trend)
      return 'TREND_EVIDENCE_UNAVAILABLE';
    if (
      spec.template === 'CATALOG_POPULAR' &&
      (!context.epoch!.complete.popularity ||
        context.epoch!.intentProductCount < 8)
    )
      return 'POPULARITY_EVIDENCE_UNAVAILABLE';
    if (spec.template === 'STARTER_PICKS' && !context.epoch!.complete.quality)
      return 'QUALITY_EVIDENCE_UNAVAILABLE';
  }
  if (
    ['SIMILAR_ITEMS', 'COMPLEMENTS'].includes(spec.template) &&
    !context.productId
  )
    return 'CONTEXT_UNAVAILABLE';
  return null;
}
export function pipelineSource(
  spec: PipelineSpec,
  context: PipelineContext,
  windowDays = spec.params.eligibilityWindowDays,
): PipelineSource {
  const epochTime = Math.floor(context.asOf.getTime() / 21600000) * 21600000;
  switch (spec.template) {
    case 'NEW_RELEASES':
      return {
        kind: 'catalog',
        sort: 'newest',
        firstPublishedAfter: new Date(
          epochTime - windowDays * 86400000,
        ).toISOString(),
      };
    case 'TREND':
      return { kind: 'catalog', sort: 'trending', firstPublishedAfter: null };
    case 'CATALOG_POPULAR':
      return { kind: 'catalog', sort: 'popular', firstPublishedAfter: null };
    case 'LOW_STOCK':
      return { kind: 'low_stock', threshold: spec.params.lowStockThreshold };
    case 'CURATED_LIST':
      return { kind: 'curated', placementKey: spec.curated!.placementKey };
    case 'SIMILAR_ITEMS':
      return { kind: 'similar', productId: context.productId! };
    case 'COMPLEMENTS':
      return { kind: 'complements', productId: context.productId! };
    case 'FROM_RUNWAY':
      return { kind: 'from_runway' };
    case 'LOOKS':
      return {
        kind: 'looks',
        minEligibleProducts: 2,
        minEligibleRatio: 0.7,
        ...(spec.curated ? { placementKey: spec.curated.placementKey } : {}),
      };
    case 'NEW_DESIGNERS':
      return { kind: 'new_designers', maxAgeDays: 180, minEligibleProducts: 3 };
    case 'CATEGORY_TILES':
      return { kind: 'category_tiles', minEligibleProducts: 2 };
    default:
      return { kind: 'catalog', sort: 'newest', firstPublishedAfter: null };
  }
}
export function templateFallback(
  spec: PipelineSpec,
  template: PipelineTemplate,
): PipelineSpec {
  const definition = PIPELINE_TEMPLATES[template];
  return parsePipelineSpec({
    ...spec,
    title: definition.title,
    subtitle: null,
    template,
    rankingPolicy: definition.policy,
    sorts: definition.sorts,
    fallback: [],
    curated: template === 'CURATED_LIST' ? spec.curated : null,
    audience: { guests: !definition.requiredHistoryHours, signedIn: true },
    diversity: { pageDedupe: spec.diversity.pageDedupe, allowRepeat: false },
  });
}
export function defaultPipelineFallbacks(
  spec: PipelineSpec,
): readonly string[] {
  if (spec.fallback.length) return spec.fallback;
  if (spec.template === 'TREND') return ['CATALOG_POPULAR', 'NEW_RELEASES'];
  if (spec.template === 'AFFINITY') return ['STARTER_PICKS', 'NEW_RELEASES'];
  if (
    spec.template === 'REGIONAL_POPULAR' ||
    spec.template === 'CATALOG_POPULAR' ||
    spec.template === 'STARTER_PICKS'
  )
    return ['NEW_RELEASES'];
  return [];
}
export function resolvePipelineFallback(
  spec: PipelineSpec,
  key: string,
  byKey: ReadonlyMap<string, PipelineSpec>,
): PipelineSpec | null {
  return (
    byKey.get(key) ?? (hasTemplate(key) ? templateFallback(spec, key) : null)
  );
}
