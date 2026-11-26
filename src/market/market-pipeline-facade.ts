import {
  MarketSectionItemDto,
  MarketSectionLayout,
  MarketSectionSourceType,
} from './dto/market-section.dto';
import { PipelineTemplate } from './pipeline/market-pipeline.types';

interface PublicSection {
  key: string;
  title: string;
  subtitle?: string | null;
  template: PipelineTemplate;
  policy?: string;
  items: readonly MarketSectionItemDto[];
  viewAll: { enabled: boolean; route?: string; label?: string };
  metadata?: {
    fallbackUsed: boolean;
    fallbackReason: string | null;
    candidateCount?: number;
    minItems?: number;
  };
}
export function legacyPipelineSection(
  section: PublicSection,
  pagination?: {
    limit: number;
    hasNextPage: boolean;
    nextCursor: string | null;
    reanchored?: boolean;
  },
) {
  const layout: MarketSectionLayout =
    section.template === 'CATEGORY_TILES'
      ? 'CATEGORY_GRID'
      : section.template === 'LOOKS'
        ? 'COLLECTION_RAIL'
        : section.template === 'NEW_DESIGNERS'
          ? 'BRAND_RAIL'
          : 'HORIZONTAL_RAIL';
  const types = new Set(section.items.map((item) => item.sourceType));
  const sourceType: MarketSectionSourceType =
    types.size === 1 ? [...types][0] : 'MIXED';
  return {
    key: section.key,
    title: section.title,
    subtitle: section.subtitle ?? null,
    emotionalLabel: null,
    layout,
    sourceType,
    items: [...section.items],
    supportsViewAll: section.viewAll.enabled,
    viewAllLabel: section.viewAll.label ?? 'View all',
    viewAll: {
      enabled: section.viewAll.enabled,
      key: section.key,
      route:
        section.viewAll.route ??
        `/market/sections/${encodeURIComponent(section.key)}`,
      label: section.viewAll.label ?? 'View all',
    },
    pagination: pagination ?? {
      limit: section.items.length,
      hasNextPage: false,
      nextCursor: null,
    },
    metadata: {
      ranking:
        section.policy === 'recency' ? 'deterministic-v1' : 'aggregate-v1',
      personalization: 'disabled',
      fallbackUsed: section.metadata?.fallbackUsed ?? false,
      fallbackReason: section.metadata?.fallbackReason ?? null,
      rankingVersion: null,
      shadowMode: false,
      rankingEnabled:
        section.policy !== undefined && section.policy !== 'recency',
      minimumItems: section.metadata?.minItems ?? 1,
      previewItemLimit: section.items.length,
      engine: 'pipeline-v2',
    },
  };
}
