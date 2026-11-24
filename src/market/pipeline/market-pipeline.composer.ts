import {
  encodeMarketFilters,
  parseMarketFilters,
} from '../catalog/market-filters';
import { isEligibleProduct } from '../eligibility/market-eligibility';
import {
  PipelineCandidateCache,
  pipelineCacheKey,
} from './market-pipeline.cache';
import { PIPELINE_TEMPLATES } from './market-pipeline.registry';
import {
  rerankPipelineCandidates,
  scorePipelineCandidates,
} from './market-pipeline.ranking';
import {
  defaultPipelineFallbacks,
  pipelineSource,
  pipelineUnavailableReason,
  resolvePipelineFallback,
} from './market-pipeline.sources';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from './market-pipeline.schema';
import {
  PipelineCandidate,
  PipelineContext,
  PipelineHydrated,
  PipelinePorts,
  PipelineSection,
  PipelineSourceRequest,
  PipelineSpec,
} from './market-pipeline.types';

export const PIPELINE_MAX_SECTIONS = 8;
// Captured-memory port calls are not database round trips. Eight rails can need
// multiple window/fallback reads plus hydration from the same bounded capture.
export const PIPELINE_MAX_PORT_CALLS = 96;
export const PIPELINE_SECTION_TIMEOUT_MS = 250;
export const PIPELINE_PAGE_TIMEOUT_MS = 550;

class PipelineReadUnavailable extends Error {}
interface ReadBudget {
  remaining: number;
  readonly deadline: number;
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  budget: ReadBudget,
  maximumMs = PIPELINE_SECTION_TIMEOUT_MS,
): Promise<T> {
  if (
    parent?.aborted ||
    budget.remaining <= 0 ||
    performance.now() >= budget.deadline
  )
    throw new PipelineReadUnavailable();
  budget.remaining--;
  const controller = new AbortController();
  const abort = () => controller.abort();
  parent?.addEventListener('abort', abort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(new PipelineReadUnavailable());
      controller.signal.addEventListener('abort', onAbort, { once: true });
      timer = setTimeout(
        () => {
          controller.abort();
        },
        Math.max(1, Math.min(maximumMs, budget.deadline - performance.now())),
      );
    });
    return await Promise.race([work(controller.signal), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) controller.signal.removeEventListener('abort', onAbort);
    parent?.removeEventListener('abort', abort);
  }
}

function active(spec: PipelineSpec, context: PipelineContext): boolean {
  return (
    spec.status === 'ACTIVE' &&
    spec.placement.surface === context.surface &&
    (context.signedIn
      ? spec.audience.signedIn
      : spec.audience.guests ||
        PIPELINE_TEMPLATES[spec.template].requiredHistoryHours > 0) &&
    (!spec.schedule.startsAt ||
      Date.parse(spec.schedule.startsAt) <= context.asOf.getTime()) &&
    (!spec.schedule.endsAt ||
      Date.parse(spec.schedule.endsAt) > context.asOf.getTime()) &&
    !context.suppression.sectionKeys.has(spec.key)
  );
}
function validCandidates(
  rows: readonly PipelineCandidate[],
  spec: PipelineSpec,
  limit: number,
): void {
  if (!Array.isArray(rows) || rows.length > limit)
    throw new PipelineReadUnavailable();
  const expectedType = PIPELINE_TEMPLATES[spec.template].entityType;
  const ids = new Set<string>();
  for (const row of rows) {
    if (
      !row ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(
        row.id,
      ) ||
      row.entityType !== expectedType ||
      ids.has(row.id) ||
      !row.features ||
      !Array.isArray(row.tags) ||
      row.tags.length > 64 ||
      !Array.isArray(row.dimensions) ||
      row.dimensions.length > 64 ||
      row.tags.some((value) => typeof value !== 'string') ||
      row.dimensions.some((value) => typeof value !== 'string') ||
      (row.firstPublishedAt !== null &&
        !Number.isFinite(Date.parse(row.firstPublishedAt))) ||
      (row.brandCreatedAt !== null &&
        !Number.isFinite(Date.parse(row.brandCreatedAt))) ||
      Object.values(row.features).some(
        (value) => typeof value === 'number' && !Number.isFinite(value),
      )
    )
      throw new PipelineReadUnavailable();
    ids.add(row.id);
  }
}
function validHydration(
  row: PipelineHydrated,
  candidate: PipelineCandidate,
  spec: PipelineSpec,
  context: PipelineContext,
): boolean {
  const item = row.item;
  if (
    !item ||
    item.id !== candidate.id ||
    item.sourceId !== candidate.id ||
    item.entityType !== candidate.entityType ||
    !item.media?.url ||
    !/^https?:\/\//.test(item.media.url)
  )
    return false;
  if (item.entityType === 'PRODUCT') {
    if (
      !isEligibleProduct(row.product, context.asOf) ||
      !item.price ||
      item.price.currency !== 'NGN' ||
      !Number.isFinite(item.price.effectiveAmount) ||
      item.price.effectiveAmount! <= 0
    )
      return false;
    if (spec.template === 'LOW_STOCK') {
      const stock = row.scarcity;
      if (
        !stock?.trackInventory ||
        !stock.standardCheckoutEnabled ||
        !Number.isSafeInteger(stock.minPositiveStock) ||
        stock.minPositiveStock! < 1 ||
        stock.minPositiveStock! > spec.params.lowStockThreshold
      )
        return false;
    }
  }
  return true;
}
function captureContext(context: PipelineContext): PipelineContext {
  if (
    !(context.asOf instanceof Date) ||
    !Number.isFinite(context.asOf.getTime()) ||
    !Number.isSafeInteger(context.retentionHours) ||
    context.retentionHours < 1
  )
    throw new RangeError('Invalid pipeline context');
  return {
    ...context,
    asOf: new Date(context.asOf.getTime()),
    filters: parseMarketFilters(encodeMarketFilters(context.filters)),
    epoch: context.epoch
      ? (JSON.parse(JSON.stringify(context.epoch)) as PipelineContext['epoch'])
      : null,
    suppression: {
      targetKeys: new Set(context.suppression.targetKeys),
      brandIds: new Set(context.suppression.brandIds),
      categoryIds: new Set(context.suppression.categoryIds),
      sectionKeys: new Set(context.suppression.sectionKeys),
    },
    tenure: new Map(
      [...context.tenure].map(([key, value]) => [key, { ...value }]),
    ),
  };
}

/** No framework singleton stores a viewer, a placed set, suppression or hydrated cards. */
export class MarketPipelineComposer {
  constructor(
    private readonly ports: PipelinePorts,
    private readonly cache?: PipelineCandidateCache,
  ) {}

  async compose(
    inputs: readonly unknown[],
    inputContext: PipelineContext,
  ): Promise<{
    generatedAt: string;
    epoch: string | null;
    sections: readonly PipelineSection[];
    metadata: { partial: boolean; cachePolicy: 'private-no-store' };
  }> {
    const context = captureContext(inputContext);
    const specs = inputs.map(parsePipelineSpec);
    validatePipelineGraph(specs);
    const byKey = new Map(specs.map((spec) => [spec.key, spec]));
    const sorted = specs
      .filter((spec) => active(spec, context))
      .sort(
        (a, b) =>
          a.placement.order - b.placement.order || (a.key < b.key ? -1 : 1),
      );
    const budget: ReadBudget = {
      remaining: PIPELINE_MAX_PORT_CALLS,
      deadline: Math.min(
        context.deadline ?? Infinity,
        performance.now() + PIPELINE_PAGE_TIMEOUT_MS,
      ),
    };
    const placed = new Map<string, string>();
    const sections: PipelineSection[] = [];
    let repeats = 0;
    let partial = false;
    for (const original of sorted) {
      const queue: Array<{
        spec: PipelineSpec;
        depth: number;
        layers: readonly PipelineSpec['filters'][];
      }> = [{ spec: original, depth: 0, layers: [original.filters] }];
      const tried = new Set<string>();
      let fallbackReason: string | null = null;
      let built: PipelineSection | null = null;
      while (queue.length && !built) {
        const attempt = queue.shift()!;
        const spec = attempt.spec;
        const attemptKey = `${spec.key}:${spec.template}`;
        if (tried.has(attemptKey) || attempt.depth > 2) continue;
        tried.add(attemptKey);
        let reason = pipelineUnavailableReason(spec, context);
        if (context.suppression.sectionKeys.has(spec.key)) continue;
        if (!reason) {
          try {
            let windowDays = spec.params.eligibilityWindowDays;
            let source = pipelineSource(spec, context, windowDays);
            const request = (): Omit<PipelineSourceRequest, 'signal'> => ({
              sectionKey: original.key,
              source,
              fixedFilterLayers: attempt.layers,
              filters: context.filters,
              asOf: context.asOf,
              epoch: context.epoch,
              limit: spec.params.candidateLimit,
            });
            const cacheRequest = {
              ...request(),
              signal: context.signal ?? new AbortController().signal,
            };
            const cacheKey = pipelineCacheKey(spec, context, cacheRequest);
            let cachedIds: readonly string[] | undefined;
            if (cacheKey && this.cache) {
              try {
                const cached = await bounded(
                  () => this.cache!.get(cacheKey),
                  context.signal,
                  {
                    remaining: 1,
                    deadline: Math.min(budget.deadline, performance.now() + 30),
                  },
                  30,
                );
                if (
                  cached &&
                  cached.length <= spec.params.candidateLimit &&
                  cached.every(
                    (row) =>
                      typeof row.id === 'string' && Number.isFinite(row.score),
                  )
                )
                  cachedIds = cached.map((row) => row.id);
              } catch {
                /* Cache failure never disables public reads or suppressions. */
              }
            }
            let candidates = await bounded(
              (signal) =>
                this.ports.retrieve({
                  ...request(),
                  suppressionMode: cacheKey ? 'public_pool' : 'viewer',
                  cachedIds,
                  signal,
                }),
              context.signal,
              budget,
            );
            validCandidates(candidates, spec, spec.params.candidateLimit);
            // Window extension is a source restriction, not padding with older arbitrary cards.
            if (
              spec.template === 'NEW_RELEASES' &&
              candidates.length < 8 &&
              windowDays < 60
            ) {
              windowDays = 60;
              source = pipelineSource(spec, context, windowDays);
              candidates = await bounded(
                (signal) =>
                  this.ports.retrieve({
                    ...request(),
                    suppressionMode: cacheKey ? 'public_pool' : 'viewer',
                    signal,
                  }),
                context.signal,
                budget,
              );
              validCandidates(candidates, spec, spec.params.candidateLimit);
            }
            if (
              spec.template === 'NEW_RELEASES' &&
              candidates.length < 4 &&
              windowDays < 90
            ) {
              source = pipelineSource(spec, context, 90);
              candidates = await bounded(
                (signal) =>
                  this.ports.retrieve({
                    ...request(),
                    suppressionMode: cacheKey ? 'public_pool' : 'viewer',
                    signal,
                  }),
                context.signal,
                budget,
              );
              validCandidates(candidates, spec, spec.params.candidateLimit);
            }
            const scored = scorePipelineCandidates(candidates, spec, context);
            if (cacheKey && this.cache && !cachedIds) {
              try {
                await bounded(
                  () =>
                    this.cache!.set(
                      cacheKey,
                      scored.map((row) => ({
                        id: row.candidate.id,
                        score: row.score,
                      })),
                      spec.cache.sharedTtlSeconds,
                    ),
                  context.signal,
                  {
                    remaining: 1,
                    deadline: Math.min(budget.deadline, performance.now() + 30),
                  },
                  30,
                );
              } catch {
                /* Bounded best-effort cache. */
              }
            }
            const ranked = rerankPipelineCandidates(scored, spec, context, {
              placed,
              repeats,
            });
            if (ranked.length >= spec.capacity.minItems) {
              const hydrated = await bounded(
                (signal) =>
                  this.ports.hydrate(
                    ranked.map((row) => row.candidate),
                    context.asOf,
                    signal,
                    {
                      ...request(),
                      suppressionMode: cacheKey ? 'public_pool' : 'viewer',
                      signal,
                    },
                  ),
                context.signal,
                budget,
              );
              if (!Array.isArray(hydrated) || hydrated.length > ranked.length)
                throw new PipelineReadUnavailable();
              const hydratedById = new Map(
                hydrated.map((row) => [
                  `${row.item?.entityType}:${row.item?.id}`,
                  row,
                ]),
              );
              const items: PipelineSection['items'][number][] = [];
              for (const row of ranked) {
                const value = hydratedById.get(
                  `${row.candidate.entityType}:${row.candidate.id}`,
                );
                if (
                  !value ||
                  !validHydration(value, row.candidate, spec, context)
                )
                  continue;
                // Missing media can shift positions; repeats never enter the first two.
                if (
                  row.repeatOf &&
                  (items.length < 2 ||
                    repeats + items.filter((item) => item.repeatOf).length >= 2)
                )
                  continue;
                items.push({
                  ...value.item,
                  position: items.length,
                  explore: row.explore,
                  samplingProbability: row.samplingProbability,
                  repeatOf: row.repeatOf,
                });
                if (items.length === spec.capacity.preview) break;
              }
              if (items.length >= spec.capacity.minItems)
                built = {
                  key: original.key,
                  template: spec.template,
                  title: spec.title,
                  subtitle: spec.subtitle,
                  policy: spec.rankingPolicy,
                  policyVersion: 1,
                  personalization: 'none',
                  items,
                  exposures: items.flatMap((item) => {
                    const candidate = ranked.find(
                      (row) =>
                        row.candidate.id === item.id &&
                        row.candidate.entityType === item.entityType,
                    )?.candidate;
                    const productId =
                      item.entityType === 'PRODUCT'
                        ? item.id
                        : candidate?.exposureProductId;
                    return productId
                      ? [{ productId, position: item.position }]
                      : [];
                  }),
                  viewAll: {
                    enabled:
                      spec.sorts.length > 0 ||
                      ['CURATED_LIST', 'LOOKS', 'NEW_DESIGNERS'].includes(
                        spec.template,
                      ),
                    sectionKey: original.key,
                    specVersion: original.version,
                    effectiveTemplate: spec.template,
                    availableSorts: spec.sorts,
                  },
                  scope: { source, fixedFilterLayers: attempt.layers },
                  metadata: {
                    fallbackUsed: attempt.depth > 0,
                    fallbackReason,
                    candidateCount: candidates.length,
                    minItems: spec.capacity.minItems,
                  },
                };
              else reason = 'INSUFFICIENT_RENDERABLE_ITEMS';
            } else reason = 'INSUFFICIENT_ITEMS';
          } catch {
            reason = 'SOURCE_UNAVAILABLE';
            partial = true;
          }
        }
        if (!built) {
          fallbackReason ??= reason;
          for (const key of defaultPipelineFallbacks(spec)) {
            const fallback = resolvePipelineFallback(spec, key, byKey);
            if (
              fallback &&
              (fallback.key === spec.key || active(fallback, context))
            )
              queue.push({
                spec: fallback,
                depth: attempt.depth + 1,
                layers:
                  fallback.key === spec.key
                    ? attempt.layers
                    : [...attempt.layers, fallback.filters],
              });
          }
        }
      }
      if (built) {
        sections.push(built);
        for (const item of built.items) {
          if (item.repeatOf) repeats++;
          else placed.set(`${item.entityType}:${item.sourceId}`, built.key);
        }
      }
      if (sections.length === PIPELINE_MAX_SECTIONS) break;
      if (
        context.signal?.aborted ||
        budget.remaining <= 0 ||
        performance.now() >= budget.deadline
      ) {
        partial = true;
        break;
      }
    }
    return {
      generatedAt: context.asOf.toISOString(),
      epoch: context.epoch?.id ?? null,
      sections,
      metadata: { partial, cachePolicy: 'private-no-store' },
    };
  }
}
