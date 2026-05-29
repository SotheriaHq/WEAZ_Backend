import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MarketSuggestionContext,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';

export const SUPPORTED_MARKET_SECTION_KEYS = [
  'fresh-drops',
  'hot-right-now',
  'latest-collections',
  'shop-by-style',
  'custom-ready',
  'new-designers-to-watch',
] as const;

export type SupportedMarketSectionKey =
  (typeof SUPPORTED_MARKET_SECTION_KEYS)[number];

export const SUPPORTED_SUGGESTION_CONTEXTS = Object.values(
  MarketSuggestionContext,
);

export const SUPPORTED_SUGGESTION_TARGET_TYPES = Object.values(
  MarketSuggestionTargetType,
);

export const SUPPORTED_SUGGESTION_SOURCE_TYPES = [
  'PRODUCT',
  'COLLECTION',
  'BRAND',
  'CATEGORY',
  'MIXED',
] as const;

export const SUPPORTED_FORMULA_STATUSES = [
  'DRAFT',
  'ACTIVE',
  'DEPRECATED',
  'ROLLED_BACK',
] as const;

export const ALLOWED_FORMULA_WEIGHT_KEYS = [
  'section',
  'sectionRelevance',
  'freshness',
  'interaction',
  'commerce',
  'exploration',
  'deterministic',
  'brandDiversity',
] as const;

export const MARKET_GOVERNANCE_LIMITS = {
  sectionTitleMax: 120,
  sectionSubtitleMax: 240,
  displayOrderMin: 0,
  displayOrderMax: 100,
  previewItemLimitMin: 1,
  previewItemLimitMax: 12,
  detailPageLimitMin: 1,
  detailPageLimitMax: 60,
  minimumItemsMin: 0,
  minimumItemsMax: 12,
  suggestionBlockKeyMax: 120,
  suggestionItemLimitMin: 1,
  suggestionItemLimitMax: 12,
  explorationPercentMin: 0,
  explorationPercentMax: 25,
  brandMaxShareMin: 10,
  brandMaxShareMax: 50,
  aggregateTimeoutMsMin: 25,
  aggregateTimeoutMsMax: 500,
  rolloutPercentMin: 0,
  rolloutPercentMax: 0,
  profileKeyMax: 80,
  versionKeyMax: 80,
  nameMax: 120,
  descriptionMax: 500,
  reasonMax: 500,
};

export type MarketSectionConfigView = {
  sectionKey: SupportedMarketSectionKey;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  displayOrder: number;
  previewItemLimit: number;
  detailPageLimit: number;
  minimumItems: number;
  viewAllEnabled: boolean;
  fallbackMode: string;
  metadata: Record<string, unknown> | null;
  source: 'code-default' | 'db';
};

export type MarketSuggestionBlockConfigView = {
  blockKey: string;
  context: MarketSuggestionContext;
  targetType: MarketSuggestionTargetType;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  displayOrder: number;
  sourceType: string;
  fallbackSourceType: string | null;
  itemLimit: number;
  metadata: Record<string, unknown> | null;
  source: 'code-default' | 'db';
};

export const MARKET_SECTION_CODE_DEFAULTS: MarketSectionConfigView[] = [
  {
    sectionKey: 'fresh-drops',
    title: 'Fresh Drops',
    subtitle: 'New products from open Threadly stores.',
    enabled: true,
    displayOrder: 10,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'hot-right-now',
    title: 'Hot Right Now',
    subtitle: 'Deterministic V1 heat from product views and thread activity.',
    enabled: true,
    displayOrder: 20,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'latest-collections',
    title: 'Latest Collections',
    subtitle: 'Recently published store collections with visible products.',
    enabled: true,
    displayOrder: 30,
    previewItemLimit: 6,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'shop-by-style',
    title: 'Shop by Style',
    subtitle:
      'Browse active market categories without making Market category-only.',
    enabled: true,
    displayOrder: 40,
    previewItemLimit: 10,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'custom-ready',
    title: 'Custom Ready',
    subtitle: 'Products available for custom-order bags.',
    enabled: true,
    displayOrder: 50,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'new-designers-to-watch',
    title: 'New Designers to Watch',
    subtitle: 'Newer open stores with market-ready products.',
    enabled: true,
    displayOrder: 60,
    previewItemLimit: 6,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    fallbackMode: 'CODE_DEFAULTS',
    metadata: null,
    source: 'code-default',
  },
];

export const MARKET_SUGGESTION_BLOCK_CODE_DEFAULTS: MarketSuggestionBlockConfigView[] =
  [
    {
      blockKey: 'product-detail-more-like-this',
      context: MarketSuggestionContext.PRODUCT_DETAIL,
      targetType: MarketSuggestionTargetType.PRODUCT,
      title: 'More Like This',
      subtitle: 'Similar market-ready pieces',
      enabled: true,
      displayOrder: 10,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'product-detail-more-from-brand',
      context: MarketSuggestionContext.PRODUCT_DETAIL,
      targetType: MarketSuggestionTargetType.PRODUCT,
      title: 'More From This Brand',
      subtitle: 'Other pieces from the same store',
      enabled: true,
      displayOrder: 20,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'collection-detail-pieces-from-edit',
      context: MarketSuggestionContext.COLLECTION_DETAIL,
      targetType: MarketSuggestionTargetType.COLLECTION,
      title: 'Pieces From This Edit',
      subtitle: 'Market-ready products in the collection',
      enabled: true,
      displayOrder: 10,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'brand-detail-best-from-brand',
      context: MarketSuggestionContext.BRAND_DETAIL,
      targetType: MarketSuggestionTargetType.BRAND,
      title: 'Best From This Brand',
      subtitle: 'Available products from this store',
      enabled: true,
      displayOrder: 10,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'search-empty-relaxed-products',
      context: MarketSuggestionContext.SEARCH_EMPTY,
      targetType: MarketSuggestionTargetType.QUERY,
      title: 'Try These Instead',
      subtitle: 'Relaxed matches from the market',
      enabled: true,
      displayOrder: 10,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
  ];

@Injectable()
export class MarketGovernanceConfigService {
  private readonly logger = new Logger(MarketGovernanceConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  isSupportedSectionKey(key: string): key is SupportedMarketSectionKey {
    return SUPPORTED_MARKET_SECTION_KEYS.includes(
      key as SupportedMarketSectionKey,
    );
  }

  getCodeDefaultSectionConfigs(): MarketSectionConfigView[] {
    return MARKET_SECTION_CODE_DEFAULTS.map((config) => ({ ...config }));
  }

  getCodeDefaultSuggestionBlockConfigs(): MarketSuggestionBlockConfigView[] {
    return MARKET_SUGGESTION_BLOCK_CODE_DEFAULTS.map((config) => ({
      ...config,
    }));
  }

  async getSectionConfigsWithFallback(): Promise<{
    items: MarketSectionConfigView[];
    configReadStatus: 'db' | 'code-defaults' | 'fallback-code-defaults';
  }> {
    try {
      const rows = await this.prisma.marketSectionConfig.findMany({
        orderBy: [{ displayOrder: 'asc' }, { sectionKey: 'asc' }],
      });
      if (rows.length === 0) {
        return {
          items: this.getCodeDefaultSectionConfigs(),
          configReadStatus: 'code-defaults',
        };
      }

      const rowByKey = new Map(rows.map((row) => [row.sectionKey, row]));
      const merged = this.getCodeDefaultSectionConfigs().map(
        (defaultConfig) => {
          const row = rowByKey.get(defaultConfig.sectionKey);
          if (!row) return defaultConfig;
          return {
            sectionKey: defaultConfig.sectionKey,
            title: row.title,
            subtitle: row.subtitle,
            enabled: row.enabled,
            displayOrder: row.displayOrder,
            previewItemLimit: row.previewItemLimit,
            detailPageLimit: row.detailPageLimit,
            minimumItems: row.minimumItems,
            viewAllEnabled: row.viewAllEnabled,
            fallbackMode: row.fallbackMode,
            metadata: this.asRecord(row.metadata),
            source: 'db' as const,
          };
        },
      );

      return {
        items: merged.sort((left, right) => {
          if (left.displayOrder !== right.displayOrder) {
            return left.displayOrder - right.displayOrder;
          }
          return left.sectionKey.localeCompare(right.sectionKey);
        }),
        configReadStatus: 'db',
      };
    } catch (error) {
      this.logger.warn(
        `Market section config read failed, using code defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        items: this.getCodeDefaultSectionConfigs(),
        configReadStatus: 'fallback-code-defaults',
      };
    }
  }

  async getSuggestionBlockConfigsWithFallback(): Promise<{
    items: MarketSuggestionBlockConfigView[];
    configReadStatus: 'db' | 'code-defaults' | 'fallback-code-defaults';
  }> {
    try {
      const rows = await this.prisma.marketSuggestionBlockConfig.findMany({
        orderBy: [
          { context: 'asc' },
          { displayOrder: 'asc' },
          { blockKey: 'asc' },
        ],
      });
      if (rows.length === 0) {
        return {
          items: this.getCodeDefaultSuggestionBlockConfigs(),
          configReadStatus: 'code-defaults',
        };
      }

      return {
        items: rows.map((row) => ({
          blockKey: row.blockKey,
          context: row.context as MarketSuggestionContext,
          targetType: row.targetType as MarketSuggestionTargetType,
          title: row.title,
          subtitle: row.subtitle,
          enabled: row.enabled,
          displayOrder: row.displayOrder,
          sourceType: row.sourceType,
          fallbackSourceType: row.fallbackSourceType,
          itemLimit: row.itemLimit,
          metadata: this.asRecord(row.metadata),
          source: 'db',
        })),
        configReadStatus: 'db',
      };
    } catch (error) {
      this.logger.warn(
        `Market suggestion block config read failed, using code defaults: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return {
        items: this.getCodeDefaultSuggestionBlockConfigs(),
        configReadStatus: 'fallback-code-defaults',
      };
    }
  }

  private asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    return value as Record<string, unknown>;
  }
}
