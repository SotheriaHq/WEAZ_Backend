import { BadRequestException } from '@nestjs/common';
import {
  CanonicalMarketFilters,
  encodeMarketFilters,
  parseMarketFilters,
} from '../catalog/market-filters';
import { hasTemplate, PIPELINE_TEMPLATES } from './market-pipeline.registry';
import { PipelineSpec, PipelineSurface } from './market-pipeline.types';

const slug = /^[a-z0-9][a-z0-9-]{0,79}$/;
function invalid(): never {
  throw new BadRequestException({
    code: 'INVALID_SECTION_SPEC',
    message: 'Review the section configuration.',
  });
}
function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    invalid();
  return value.trim();
}
function number(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const result = value === undefined ? fallback : value;
  if (
    typeof result !== 'number' ||
    !Number.isSafeInteger(result) ||
    result < min ||
    result > max
  )
    invalid();
  return result;
}
function boolean(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') invalid();
  return value;
}
function date(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (
    typeof value !== 'string' ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    invalid();
  return value;
}

/** The same strict parser is used by serving, draft preview and eventual publish. */
export function parsePipelineSpec(input: unknown): PipelineSpec {
  const value = object(input, [
    'key',
    'version',
    'title',
    'subtitle',
    'status',
    'template',
    'rankingPolicy',
    'placement',
    'audience',
    'schedule',
    'filters',
    'curated',
    'capacity',
    'params',
    'sorts',
    'fallback',
    'diversity',
    'cache',
  ]);
  const key = text(value.key, 80);
  if (!slug.test(key)) invalid();
  if (typeof value.template !== 'string' || !hasTemplate(value.template))
    invalid();
  const template = value.template;
  const definition = PIPELINE_TEMPLATES[template];
  if (
    value.rankingPolicy !== undefined &&
    value.rankingPolicy !== definition.policy
  )
    invalid();
  const title =
    value.title === undefined ? definition.title : text(value.title, 120);
  const subtitle = value.subtitle == null ? null : text(value.subtitle, 240);
  const claim = `${title} ${subtitle ?? ''}`;
  if (
    /\b(for you|near you|you like|your|picked for)\b/i.test(claim) &&
    !definition.requiredHistoryHours &&
    !definition.regional
  )
    invalid();
  if (/\b(trending|hot)\b/i.test(claim) && template !== 'TREND') invalid();
  if (
    /\bnew\b/i.test(claim) &&
    !['NEW_RELEASES', 'NEW_DESIGNERS', 'CURATED_LIST'].includes(template)
  )
    invalid();
  const placement = object(value.placement ?? {}, ['surface', 'order']);
  const surface = placement.surface ?? 'HOME';
  if (
    ![
      'HOME',
      'PRODUCT',
      'STORE',
      'SEARCH_EMPTY',
      'WISHLIST',
      'COLLECTION',
    ].includes(String(surface))
  )
    invalid();
  const audience = object(value.audience ?? {}, ['guests', 'signedIn']);
  const guests = boolean(audience.guests, !definition.requiredHistoryHours);
  const signedIn = boolean(audience.signedIn, true);
  if (
    (!guests && !signedIn) ||
    (definition.requiredHistoryHours && (guests || !signedIn))
  )
    invalid();
  const schedule = object(value.schedule ?? {}, ['startsAt', 'endsAt']);
  const startsAt = date(schedule.startsAt);
  const endsAt = date(schedule.endsAt);
  if (startsAt && endsAt && startsAt >= endsAt) invalid();
  const capacity = object(value.capacity ?? {}, [
    'preview',
    'page',
    'minItems',
  ]);
  const preview = number(capacity.preview, 8, 1, 12);
  const minItems = number(capacity.minItems, 2, 1, preview);
  const params = object(value.params ?? {}, [
    'candidateLimit',
    'eligibilityWindowDays',
    'evidenceFloorActors',
    'maxPerBrand',
    'maxPerCategory',
    'newDesignerSlots',
    'explorationShare',
    'maxTenureEpochs',
    'reentryCooldownEpochs',
    'lowStockThreshold',
  ]);
  const diversity = object(value.diversity ?? {}, [
    'pageDedupe',
    'allowRepeat',
  ]);
  const allowRepeat = boolean(diversity.allowRepeat, false);
  if (allowRepeat && !['LOW_STOCK', 'RECENTLY_VIEWED'].includes(template))
    invalid();
  const fallback = value.fallback ?? [];
  if (
    !Array.isArray(fallback) ||
    fallback.length > 2 ||
    fallback.some(
      (item) =>
        typeof item !== 'string' || (!slug.test(item) && !hasTemplate(item)),
    ) ||
    new Set(fallback).size !== fallback.length
  )
    invalid();
  const sorts = value.sorts ?? definition.sorts;
  if (
    !Array.isArray(sorts) ||
    sorts.some((sort) => !definition.sorts.includes(sort)) ||
    new Set(sorts).size !== sorts.length
  )
    invalid();
  const cache = object(value.cache ?? {}, ['sharedTtlSeconds']);
  let curated: PipelineSpec['curated'] = null;
  if (value.curated != null) {
    const raw = object(value.curated, ['placementKey']);
    const placementKey = text(raw.placementKey, 80);
    if (!/^[A-Z0-9_:-]+$/.test(placementKey)) invalid();
    curated = { placementKey };
  }
  if (
    (template === 'CURATED_LIST' && !curated) ||
    (curated && !['CURATED_LIST', 'LOOKS'].includes(template))
  )
    invalid();
  const status = value.status ?? 'DRAFT';
  if (!['DRAFT', 'ACTIVE', 'PAUSED', 'ARCHIVED'].includes(String(status)))
    invalid();
  return {
    key,
    version: number(value.version, 1, 1, 2147483647),
    title,
    subtitle,
    template,
    rankingPolicy: definition.policy,
    status: status as PipelineSpec['status'],
    placement: {
      surface: surface as PipelineSurface,
      order: number(placement.order, 0, 0, 100),
    },
    audience: { guests, signedIn },
    schedule: { startsAt, endsAt },
    filters: parseMarketFilters(
      encodeMarketFilters((value.filters ?? {}) as CanonicalMarketFilters),
    ),
    curated,
    capacity: { preview, page: number(capacity.page, 24, 12, 60), minItems },
    params: {
      candidateLimit: number(params.candidateLimit, 100, 24, 300),
      eligibilityWindowDays: number(params.eligibilityWindowDays, 30, 7, 90),
      evidenceFloorActors: number(params.evidenceFloorActors, 5, 5, 50),
      maxPerBrand: number(params.maxPerBrand, 2, 1, 8),
      maxPerCategory: number(params.maxPerCategory, 3, 1, 8),
      newDesignerSlots: number(params.newDesignerSlots, 0, 0, 2),
      explorationShare: number(params.explorationShare, 10, 0, 25),
      maxTenureEpochs: number(params.maxTenureEpochs, 4, 1, 12),
      reentryCooldownEpochs: number(params.reentryCooldownEpochs, 2, 0, 6),
      lowStockThreshold: number(params.lowStockThreshold, 3, 1, 3),
    },
    sorts: [...sorts],
    fallback: [...fallback],
    diversity: { pageDedupe: boolean(diversity.pageDedupe, true), allowRepeat },
    cache: { sharedTtlSeconds: number(cache.sharedTtlSeconds, 120, 30, 120) },
  };
}

export function validatePipelineGraph(specs: readonly PipelineSpec[]): void {
  if (
    specs.length > 32 ||
    new Set(specs.map((spec) => spec.key)).size !== specs.length
  )
    invalid();
  const byKey = new Map(specs.map((spec) => [spec.key, spec]));
  function walk(spec: PipelineSpec, path: Set<string>, depth: number): void {
    if (depth > 2 || path.has(spec.key)) invalid();
    const next = new Set(path).add(spec.key);
    for (const key of spec.fallback) {
      const target = byKey.get(key);
      if (target) {
        if (target.status !== 'ACTIVE') invalid();
        walk(target, next, depth + 1);
      } else if (!hasTemplate(key)) invalid();
    }
  }
  for (const spec of specs) walk(spec, new Set(), 0);
}
