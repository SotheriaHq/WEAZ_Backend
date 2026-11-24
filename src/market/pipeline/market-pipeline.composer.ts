import {
  encodeMarketFilters,
  parseMarketFilters,
} from '../catalog/market-filters';
import { isEligibleProduct } from '../eligibility/market-eligibility';
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
/** New releases widen to 60 days below this many candidates (Home and See All). */
export const NEW_RELEASES_WIDEN_BELOW = 8;
/** ...and to 90 days below this many. */
export const NEW_RELEASES_WIDEN_AGAIN_BELOW = 4;
/** Extra ranked candidates captured per planned rail, so a card that fails
 * final media/eligibility checks is replaced instead of shortening the rail. */
export const PIPELINE_CAPTURE_RESERVE = 2;
/** Largest preview a validated spec may request (see the spec parser). */
export const PIPELINE_MAX_PREVIEW = 12;
/** Upper bound of distinct cards one page can capture and sign. */
export const PIPELINE_CAPTURE_LIMIT =
  PIPELINE_MAX_SECTIONS * (PIPELINE_MAX_PREVIEW + PIPELINE_CAPTURE_RESERVE);

export interface MarketPipelineComposerOptions {
  /** Select cards from captured candidate rows without hydration. Used to
   * decide which cards to capture before the real composition runs. */
  readonly planning?: boolean;
  /** Stop after this many rendered sections (1-8, default 8). */
  readonly sectionLimit?: number;
  /** Monotonic clock in milliseconds; injectable for deterministic tests. */
  readonly now?: () => number;
}

/** Shared by capture and composition so both address the same source pool. */
export function pipelineSuppressionMode(
  context: Pick<PipelineContext, 'surface' | 'filters' | 'productId'>,
): 'public_pool' | 'viewer' {
  return context.surface === 'HOME' &&
    !Object.keys(context.filters).length &&
    !context.productId
    ? 'public_pool'
    : 'viewer';
}

class PipelineReadUnavailable extends Error {}
interface ReadBudget {
  remaining: number;
  readonly deadline: number;
}

async function bounded<T>(
  work: (signal: AbortSignal) => Promise<T>,
  parent: AbortSignal | undefined,
  budget: ReadBudget,
  now: () => number,
  maximumMs = PIPELINE_SECTION_TIMEOUT_MS,
): Promise<T> {
  if (parent?.aborted || budget.remaining <= 0 || now() >= budget.deadline)
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
        Math.max(1, Math.min(maximumMs, budget.deadline - now())),
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

type RankedRow = ReturnType<typeof rerankPipelineCandidates>[number];

function cardKey(row: RankedRow): string {
  return `${row.candidate.entityType}:${row.candidate.id}`;
}

/** No framework singleton stores a viewer, a placed set, suppression or hydrated cards. */
export class MarketPipelineComposer {
  private readonly now: () => number;
  private readonly sectionLimit: number;
  constructor(
    private readonly ports: PipelinePorts,
    private readonly options: MarketPipelineComposerOptions = {},
  ) {
    const limit = options.sectionLimit ?? PIPELINE_MAX_SECTIONS;
    if (!Number.isInteger(limit) || limit < 1 || limit > PIPELINE_MAX_SECTIONS)
      throw new RangeError('Invalid section limit');
    this.sectionLimit = limit;
    this.now = options.now ?? (() => performance.now());
  }

  async compose(
    inputs: readonly unknown[],
    inputContext: PipelineContext,
  ): Promise<{
    generatedAt: string;
    epoch: string | null;
    sections: readonly PipelineSection[];
    metadata: { partial: boolean; cachePolicy: 'private-no-store' };
  }> {
    if (this.options.planning)
      throw new Error('A planning composer cannot render a page');
    return (await this.run(inputs, inputContext)).page;
  }

  /** Card keys (`ENTITY:id`) the real composition will place, plus reserves.
   * Selection uses the same fallback, dedupe, diversity and repeat rules. */
  async plan(
    inputs: readonly unknown[],
    inputContext: PipelineContext,
  ): Promise<ReadonlySet<string>> {
    if (!this.options.planning)
      throw new Error('Composer was not created for planning');
    return (await this.run(inputs, inputContext)).planned;
  }

  private async run(inputs: readonly unknown[], inputContext: PipelineContext) {
    const planning = this.options.planning === true;
    const now = this.now;
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
        now() + PIPELINE_PAGE_TIMEOUT_MS,
      ),
    };
    const suppressionMode = pipelineSuppressionMode(context);
    const placed = new Map<string, string>();
    const planned = new Set<string>();
    const sections: PipelineSection[] = [];
    let builtCount = 0;
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
      let builtRows: RankedRow[] | null = null;
      while (queue.length && !builtRows) {
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
              suppressionMode,
            });
            const retrieve = () =>
              bounded(
                (signal) => this.ports.retrieve({ ...request(), signal }),
                context.signal,
                budget,
                now,
              );
            let candidates = await retrieve();
            validCandidates(candidates, spec, spec.params.candidateLimit);
            // Window extension is a source restriction, not padding with older arbitrary cards.
            if (
              spec.template === 'NEW_RELEASES' &&
              candidates.length < NEW_RELEASES_WIDEN_BELOW &&
              windowDays < 60
            ) {
              windowDays = 60;
              source = pipelineSource(spec, context, windowDays);
              candidates = await retrieve();
              validCandidates(candidates, spec, spec.params.candidateLimit);
            }
            if (
              spec.template === 'NEW_RELEASES' &&
              candidates.length < NEW_RELEASES_WIDEN_AGAIN_BELOW &&
              windowDays < 90
            ) {
              windowDays = 90;
              source = pipelineSource(spec, context, windowDays);
              candidates = await retrieve();
              validCandidates(candidates, spec, spec.params.candidateLimit);
            }
            const scored = scorePipelineCandidates(candidates, spec, context);
            const ranked = rerankPipelineCandidates(scored, spec, context, {
              placed,
              repeats,
            });
            if (ranked.length >= spec.capacity.minItems) {
              let hydratedById: Map<string, PipelineHydrated> | null = null;
              if (!planning) {
                const hydrated = await bounded(
                  (signal) =>
                    this.ports.hydrate(
                      ranked.map((row) => row.candidate),
                      context.asOf,
                      signal,
                      { ...request(), signal },
                    ),
                  context.signal,
                  budget,
                  now,
                );
                if (!Array.isArray(hydrated) || hydrated.length > ranked.length)
                  throw new PipelineReadUnavailable();
                hydratedById = new Map(
                  hydrated.map((row) => [
                    `${row.item?.entityType}:${row.item?.id}`,
                    row,
                  ]),
                );
              }
              const chosen: Array<{
                row: RankedRow;
                value: PipelineHydrated | null;
              }> = [];
              let lastIndex = -1;
              for (let index = 0; index < ranked.length; index++) {
                const row = ranked[index];
                let value: PipelineHydrated | null = null;
                if (hydratedById) {
                  value = hydratedById.get(cardKey(row)) ?? null;
                  if (
                    !value ||
                    !validHydration(value, row.candidate, spec, context)
                  )
                    continue;
                }
                // Missing media can shift positions; repeats never enter the first two.
                if (
                  row.repeatOf &&
                  (chosen.length < 2 ||
                    repeats +
                      chosen.filter((entry) => entry.row.repeatOf).length >=
                      2)
                )
                  continue;
                chosen.push({ row, value });
                lastIndex = index;
                if (chosen.length === spec.capacity.preview) break;
              }
              if (chosen.length >= spec.capacity.minItems) {
                builtRows = chosen.map((entry) => entry.row);
                if (planning) {
                  for (const row of builtRows) planned.add(cardKey(row));
                  for (const row of ranked.slice(
                    lastIndex + 1,
                    lastIndex + 1 + PIPELINE_CAPTURE_RESERVE,
                  ))
                    planned.add(cardKey(row));
                } else {
                  const items: PipelineSection['items'][number][] = chosen.map(
                    ({ row, value }, position) => ({
                      ...value!.item,
                      position,
                      explore: row.explore,
                      samplingProbability: row.samplingProbability,
                      repeatOf: row.repeatOf,
                    }),
                  );
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
                }
              } else reason = 'INSUFFICIENT_RENDERABLE_ITEMS';
            } else reason = 'INSUFFICIENT_ITEMS';
          } catch {
            reason = 'SOURCE_UNAVAILABLE';
            partial = true;
          }
        }
        if (!builtRows) {
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
      if (builtRows) {
        builtCount++;
        if (built) sections.push(built);
        // validHydration guarantees item.sourceId === candidate.id, so planning
        // and rendering record identical placements.
        for (const row of builtRows) {
          if (row.repeatOf) repeats++;
          else placed.set(cardKey(row), original.key);
        }
      }
      if (builtCount === this.sectionLimit) break;
      if (
        context.signal?.aborted ||
        budget.remaining <= 0 ||
        now() >= budget.deadline
      ) {
        partial = true;
        break;
      }
    }
    return {
      planned,
      page: {
        generatedAt: context.asOf.toISOString(),
        epoch: context.epoch?.id ?? null,
        sections,
        metadata: { partial, cachePolicy: 'private-no-store' as const },
      },
    };
  }
}
