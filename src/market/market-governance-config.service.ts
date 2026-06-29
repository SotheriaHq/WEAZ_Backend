import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MarketSuggestionContext,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';

export const SUPPORTED_MARKET_SECTION_KEYS = [
  'hot-right-now',
  'fresh-drops',
  'picked-for-you',
  'new-designers-to-watch',
  'shop-by-style',
  'loved-near-you',
  'shop-the-look',
  'almost-gone',
  'still-thinking-about-these',
  'more-from-brands-you-like',
  'style-picks-of-the-week',
] as const;

export type SupportedMarketSectionKey =
  (typeof SUPPORTED_MARKET_SECTION_KEYS)[number];

export type MarketSectionConfigKey = SupportedMarketSectionKey | string;

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
  sectionKey: MarketSectionConfigKey;
  title: string;
  subtitle: string | null;
  enabled: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  sourceType: 'PRODUCT' | 'COLLECTION' | 'DESIGN' | 'BRAND' | 'MIXED';
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
    sectionKey: 'hot-right-now',
    title: 'Hot Right Now',
    subtitle: 'Deterministic V1 heat from product views and thread activity.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 10,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: "See What's Hot",
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'fresh-drops',
    title: 'Fresh Drops',
    subtitle: 'New products from open WEAZ stores.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 20,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View All Drops',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'hot-right-now',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'picked-for-you',
    title: 'Picked For You',
    subtitle: 'Deterministic starter picks until full personalization ships.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 30,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View All Picks',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'new-designers-to-watch',
    title: 'New Designers to Watch',
    subtitle: 'Newer open stores with market-ready products.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'BRAND',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 40,
    previewItemLimit: 6,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'Meet More Designers',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 20,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'shop-by-style',
    title: 'Shop by Style',
    subtitle:
      'Browse active market categories without making Market category-only.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'MIXED',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 50,
    previewItemLimit: 10,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'Explore Styles',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'loved-near-you',
    title: 'Loved Near You',
    subtitle: 'Location-aware ranking is deferred; using market heat for now.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 60,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View Loved Pieces',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'hot-right-now',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'shop-the-look',
    title: 'Shop the Look',
    subtitle: 'Recently published store collections with visible products.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'COLLECTION',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 70,
    previewItemLimit: 6,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View All Looks',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'almost-gone',
    title: 'Almost Gone',
    subtitle: 'Low-stock products from open WEAZ stores.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 80,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View Almost Gone',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'still-thinking-about-these',
    title: 'Still Thinking About These',
    subtitle:
      'Non-personalized revisit candidates until history ranking ships.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 90,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View More',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'more-from-brands-you-like',
    title: 'More From Brands You Like',
    subtitle:
      'Brand-affinity ranking is deferred; using fresh products for now.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 100,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View More From Brands',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
    metadata: null,
    source: 'code-default',
  },
  {
    sectionKey: 'style-picks-of-the-week',
    title: 'Style Picks of the Week',
    subtitle: 'Curated-style rail backed by deterministic fresh products.',
    enabled: true,
    status: 'ACTIVE',
    sourceType: 'PRODUCT',
    rankingProfileKey: 'deterministic-v1',
    displayOrder: 110,
    previewItemLimit: 8,
    detailPageLimit: 24,
    minimumItems: 1,
    viewAllEnabled: true,
    viewAllLabel: 'View Weekly Picks',
    fallbackMode: 'CODE_DEFAULTS',
    fallbackSectionKey: 'fresh-drops',
    guestEnabled: true,
    requiresAuth: false,
    newBrandReservedRatio: 0,
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
      blockKey: 'product-detail-complete-the-look',
      context: MarketSuggestionContext.PRODUCT_DETAIL,
      targetType: MarketSuggestionTargetType.PRODUCT,
      title: 'Complete the Look',
      subtitle: 'Pieces from the same edit or store',
      enabled: true,
      displayOrder: 20,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'product-detail-new-designers-to-watch',
      context: MarketSuggestionContext.PRODUCT_DETAIL,
      targetType: MarketSuggestionTargetType.PRODUCT,
      title: 'New Designers to Watch',
      subtitle: 'Fresh stores with market-ready pieces',
      enabled: true,
      displayOrder: 30,
      sourceType: 'BRAND',
      fallbackSourceType: 'BRAND',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'collection-detail-pieces-that-match-this-edit',
      context: MarketSuggestionContext.COLLECTION_DETAIL,
      targetType: MarketSuggestionTargetType.COLLECTION,
      title: 'Pieces That Match This Edit',
      subtitle: 'Market-ready products in this collection',
      enabled: true,
      displayOrder: 10,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'collection-detail-more-from-this-style',
      context: MarketSuggestionContext.COLLECTION_DETAIL,
      targetType: MarketSuggestionTargetType.COLLECTION,
      title: 'More From This Style',
      subtitle: 'Related pieces with similar category or tags',
      enabled: true,
      displayOrder: 20,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'brand-store-more-from-this-brand',
      context: MarketSuggestionContext.BRAND_DETAIL,
      targetType: MarketSuggestionTargetType.BRAND,
      title: 'More From This Brand',
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
      blockKey: 'brand-store-similar-brands-to-explore',
      context: MarketSuggestionContext.BRAND_STORE,
      targetType: MarketSuggestionTargetType.BRAND,
      title: 'Similar Brands to Explore',
      subtitle: 'Other open stores with market-ready products',
      enabled: true,
      displayOrder: 20,
      sourceType: 'BRAND',
      fallbackSourceType: 'BRAND',
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
    {
      blockKey: 'search-empty-hot-right-now',
      context: MarketSuggestionContext.SEARCH_EMPTY,
      targetType: MarketSuggestionTargetType.QUERY,
      title: 'Hot Right Now',
      subtitle: 'Popular market pieces while you keep looking',
      enabled: true,
      displayOrder: 20,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'search-empty-fresh-drops',
      context: MarketSuggestionContext.SEARCH_EMPTY,
      targetType: MarketSuggestionTargetType.QUERY,
      title: 'Fresh Drops',
      subtitle: 'New arrivals from open WEAZ stores',
      enabled: true,
      displayOrder: 30,
      sourceType: 'PRODUCT',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'market-section-detail-related',
      context: MarketSuggestionContext.MARKET_SECTION_DETAIL,
      targetType: MarketSuggestionTargetType.SECTION,
      title: 'Keep Exploring',
      subtitle: 'Related market rails and fallbacks',
      enabled: true,
      displayOrder: 10,
      sourceType: 'MIXED',
      fallbackSourceType: 'PRODUCT',
      itemLimit: 8,
      metadata: null,
      source: 'code-default',
    },
    {
      blockKey: 'wishlist-more-like-this',
      context: MarketSuggestionContext.WISHLIST,
      targetType: MarketSuggestionTargetType.QUERY,
      title: 'More Like This',
      subtitle: 'Popular pieces to compare with saved items',
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
    return MARKET_SECTION_CODE_DEFAULTS.map((config) => ({ ...config })).sort(
      (left, right) => {
        if (left.displayOrder !== right.displayOrder) {
          return left.displayOrder - right.displayOrder;
        }
        return left.sectionKey.localeCompare(right.sectionKey);
      },
    );
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
      const defaultKeys = new Set(
        MARKET_SECTION_CODE_DEFAULTS.map((config) => config.sectionKey),
      );
      const merged = this.getCodeDefaultSectionConfigs().map(
        (defaultConfig) => {
          const row = rowByKey.get(defaultConfig.sectionKey);
          if (!row) return defaultConfig;
          return {
            sectionKey: defaultConfig.sectionKey,
            title: row.title,
            subtitle: row.subtitle,
            enabled: row.enabled,
            status: (row as any).status ?? defaultConfig.status,
            sourceType: (row as any).sourceType ?? defaultConfig.sourceType,
            rankingProfileKey:
              (row as any).rankingProfileKey ?? defaultConfig.rankingProfileKey,
            displayOrder: row.displayOrder,
            previewItemLimit: row.previewItemLimit,
            detailPageLimit: row.detailPageLimit,
            minimumItems: row.minimumItems,
            viewAllEnabled: row.viewAllEnabled,
            viewAllLabel:
              (row as any).viewAllLabel ?? defaultConfig.viewAllLabel,
            fallbackMode: row.fallbackMode,
            fallbackSectionKey:
              (row as any).fallbackSectionKey ??
              defaultConfig.fallbackSectionKey,
            guestEnabled:
              (row as any).guestEnabled ?? defaultConfig.guestEnabled,
            requiresAuth:
              (row as any).requiresAuth ?? defaultConfig.requiresAuth,
            newBrandReservedRatio:
              (row as any).newBrandReservedRatio ??
              defaultConfig.newBrandReservedRatio,
            metadata: this.asRecord(row.metadata),
            source: 'db' as const,
          };
        },
      );
      for (const row of rows) {
        if (defaultKeys.has(row.sectionKey as SupportedMarketSectionKey)) {
          continue;
        }
        merged.push({
          sectionKey: row.sectionKey,
          title: row.title,
          subtitle: row.subtitle,
          enabled: row.enabled,
          status: (row as any).status ?? 'ACTIVE',
          sourceType: (row as any).sourceType ?? 'PRODUCT',
          rankingProfileKey: (row as any).rankingProfileKey ?? null,
          displayOrder: row.displayOrder,
          previewItemLimit: row.previewItemLimit,
          detailPageLimit: row.detailPageLimit,
          minimumItems: row.minimumItems,
          viewAllEnabled: row.viewAllEnabled,
          viewAllLabel: (row as any).viewAllLabel ?? null,
          fallbackMode: row.fallbackMode,
          fallbackSectionKey: (row as any).fallbackSectionKey ?? null,
          guestEnabled: (row as any).guestEnabled ?? true,
          requiresAuth: (row as any).requiresAuth ?? false,
          newBrandReservedRatio: (row as any).newBrandReservedRatio ?? 0,
          metadata: this.asRecord(row.metadata),
          source: 'db' as const,
        });
      }

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
