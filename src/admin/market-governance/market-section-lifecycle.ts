import { MarketSectionConfig, Prisma } from '@prisma/client';
import {
  MARKET_SECTION_CODE_DEFAULTS,
  SUPPORTED_MARKET_SECTION_KEYS,
} from 'src/market/market-governance-config.service';
import { defaultPipelineSpecs } from 'src/market/pipeline/market-pipeline.defaults';
import {
  parsePipelineSpec,
  validatePipelineGraph,
} from 'src/market/pipeline/market-pipeline.schema';
import { PipelineSpec } from 'src/market/pipeline/market-pipeline.types';

/**
 * The exact JSON object `wiez_market_section_presentation(row)` builds in
 * migration 20261115090500_market_section_spec. The publish triggers compare
 * the stored snapshot with that projection using jsonb equality, so every key
 * and value type here must match the SQL function.
 */
export interface MarketSectionPresentation {
  sectionKey: string;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  sourceType: string;
  rankingProfileKey: string | null;
  displayOrder: number;
  previewItemLimit: number;
  detailPageLimit: number;
  minimumItems: number;
  viewAllEnabled: boolean;
  viewAllLabel: string | null;
  fallbackMode: string;
  fallbackSectionKey: string | null;
  guestEnabled: boolean;
  requiresAuth: boolean;
  newBrandReservedRatio: number;
  metadata: Prisma.JsonValue | null;
  startsAt: string | null;
  endsAt: string | null;
}

export interface MarketSectionDraftDefinition {
  spec: PipelineSpec;
  presentation: MarketSectionPresentation;
}

/** Columns a spec does not own; they keep the row's (or the code default's) value. */
type CarriedColumns = Pick<
  MarketSectionPresentation,
  | 'sourceType'
  | 'rankingProfileKey'
  | 'viewAllEnabled'
  | 'viewAllLabel'
  | 'fallbackMode'
  | 'fallbackSectionKey'
  | 'newBrandReservedRatio'
  | 'metadata'
>;

export function isClassicSectionKey(key: string): boolean {
  return (SUPPORTED_MARKET_SECTION_KEYS as readonly string[]).includes(key);
}

export function carriedColumns(
  key: string,
  row: MarketSectionConfig | null,
): CarriedColumns {
  if (row)
    return {
      sourceType: row.sourceType,
      rankingProfileKey: row.rankingProfileKey,
      viewAllEnabled: row.viewAllEnabled,
      viewAllLabel: row.viewAllLabel,
      fallbackMode: row.fallbackMode,
      fallbackSectionKey: row.fallbackSectionKey,
      newBrandReservedRatio: row.newBrandReservedRatio,
      metadata: row.metadata ?? null,
    };
  const fallback = MARKET_SECTION_CODE_DEFAULTS.find(
    (config) => config.sectionKey === key,
  );
  return {
    sourceType: fallback?.sourceType ?? 'PRODUCT',
    rankingProfileKey: fallback?.rankingProfileKey ?? null,
    viewAllEnabled: fallback?.viewAllEnabled ?? true,
    viewAllLabel: fallback?.viewAllLabel ?? null,
    fallbackMode: fallback?.fallbackMode ?? 'CODE_DEFAULTS',
    fallbackSectionKey: fallback?.fallbackSectionKey ?? null,
    newBrandReservedRatio: fallback?.newBrandReservedRatio ?? 0,
    metadata: (fallback?.metadata as Prisma.JsonValue | undefined) ?? null,
  };
}

/**
 * Presentation is derived from the spec on the server, never typed by an
 * admin. A classic key also moves the classic rail (pausing pauses both); a
 * V2-only key stays hidden from the classic Market.
 */
export function derivePresentation(
  spec: PipelineSpec,
  carried: CarriedColumns,
): MarketSectionPresentation {
  const classic = isClassicSectionKey(spec.key);
  return {
    sectionKey: spec.key,
    title: spec.title,
    subtitle: spec.subtitle,
    enabled: classic && spec.status === 'ACTIVE',
    status: classic ? spec.status : 'DRAFT',
    sourceType: carried.sourceType,
    rankingProfileKey: carried.rankingProfileKey,
    displayOrder: spec.placement.order,
    previewItemLimit: spec.capacity.preview,
    detailPageLimit: spec.capacity.page,
    minimumItems: spec.capacity.minItems,
    viewAllEnabled: carried.viewAllEnabled,
    viewAllLabel: carried.viewAllLabel,
    fallbackMode: carried.fallbackMode,
    fallbackSectionKey: carried.fallbackSectionKey,
    guestEnabled: spec.audience.guests,
    requiresAuth: !spec.audience.guests,
    newBrandReservedRatio: carried.newBrandReservedRatio,
    metadata: carried.metadata,
    startsAt: spec.schedule.startsAt,
    endsAt: spec.schedule.endsAt,
  };
}

/** Row columns that must equal the published snapshot after a publish. */
export function presentationColumns(presentation: MarketSectionPresentation) {
  return {
    title: presentation.title,
    subtitle: presentation.subtitle,
    enabled: presentation.enabled,
    status: presentation.status,
    sourceType: presentation.sourceType as MarketSectionConfig['sourceType'],
    rankingProfileKey: presentation.rankingProfileKey,
    displayOrder: presentation.displayOrder,
    previewItemLimit: presentation.previewItemLimit,
    detailPageLimit: presentation.detailPageLimit,
    minimumItems: presentation.minimumItems,
    viewAllEnabled: presentation.viewAllEnabled,
    viewAllLabel: presentation.viewAllLabel,
    fallbackMode: presentation.fallbackMode,
    fallbackSectionKey: presentation.fallbackSectionKey,
    guestEnabled: presentation.guestEnabled,
    requiresAuth: presentation.requiresAuth,
    newBrandReservedRatio: presentation.newBrandReservedRatio,
    metadata:
      presentation.metadata === null
        ? Prisma.JsonNull
        : (presentation.metadata as Prisma.InputJsonValue),
    startsAt: presentation.startsAt ? new Date(presentation.startsAt) : null,
    endsAt: presentation.endsAt ? new Date(presentation.endsAt) : null,
  };
}

/**
 * The set serving would see: code defaults, each overridden by its published
 * spec, plus an optional candidate. The graph check runs over the whole set so
 * a publish can never strand another section's fallback.
 */
export function mergeSectionSpecs(
  published: readonly unknown[],
  candidate?: PipelineSpec,
): PipelineSpec[] {
  const byKey = new Map<string, PipelineSpec>();
  for (const spec of defaultPipelineSpecs()) byKey.set(spec.key, spec);
  for (const raw of published) {
    const spec = parsePipelineSpec(raw);
    byKey.set(spec.key, spec);
  }
  if (candidate) byKey.set(candidate.key, candidate);
  const specs = [...byKey.values()];
  validatePipelineGraph(specs);
  return specs;
}
