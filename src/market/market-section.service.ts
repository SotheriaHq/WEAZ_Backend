import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { CollectionStatus, CollectionVisibility, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MarketSectionDto,
  MarketSectionItemDto,
  MarketSectionKey,
  MarketSectionLayout,
  MarketSectionMetadataDto,
  MarketSectionSourceType,
} from './dto/market-section.dto';
import {
  MARKET_SECTION_CODE_DEFAULTS,
  MarketGovernanceConfigService,
  MarketSectionConfigView,
} from './market-governance-config.service';
import {
  MarketSuppressionScope,
  MarketSuppressionService,
} from './market-suppression.service';
import {
  MarketRankingConfig,
  MarketRankingConfigService,
} from './market-ranking-config.service';
import { MarketRankingAggregateReaderService } from './market-ranking-aggregate-reader.service';
import { MarketRankingScorerService } from './market-ranking-scorer.service';

type MarketSectionIdentityOptions = {
  userId?: string | null;
  anonymousSessionId?: string | null;
};

type SectionConfig = {
  key: string;
  title: string;
  subtitle: string | null;
  emotionalLabel: string;
  layout: MarketSectionLayout;
  sourceType: MarketSectionSourceType;
  previewItemLimit: number;
  detailPageLimit: number;
  minimumItems: number;
  viewAllEnabled: boolean;
  viewAllLabel: string | null;
  newBrandReservedRatio: number;
};

const SECTION_PRESENTATION: Partial<Record<
  string,
  {
    emotionalLabel: string;
    layout: MarketSectionLayout;
    fallbackSourceType: MarketSectionSourceType;
  }
>> = {
  'hot-right-now': {
    emotionalLabel: 'People are checking these out',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'fresh-drops': {
    emotionalLabel: 'New this week',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'picked-for-you': {
    emotionalLabel: 'Starter picks',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'new-designers-to-watch': {
    emotionalLabel: 'Fresh brand energy',
    layout: 'BRAND_RAIL',
    fallbackSourceType: 'BRAND',
  },
  'shop-by-style': {
    emotionalLabel: 'Choose a lane',
    layout: 'CATEGORY_GRID',
    fallbackSourceType: 'MIXED',
  },
  'loved-near-you': {
    emotionalLabel: 'Popular right now',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'shop-the-look': {
    emotionalLabel: 'Capsules and edits',
    layout: 'COLLECTION_RAIL',
    fallbackSourceType: 'COLLECTION',
  },
  'almost-gone': {
    emotionalLabel: 'Low stock',
    layout: 'PRODUCT_GRID',
    fallbackSourceType: 'PRODUCT',
  },
  'still-thinking-about-these': {
    emotionalLabel: 'Worth another look',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'more-from-brands-you-like': {
    emotionalLabel: 'Brand-led picks',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
  'style-picks-of-the-week': {
    emotionalLabel: 'Weekly edit',
    layout: 'HORIZONTAL_RAIL',
    fallbackSourceType: 'PRODUCT',
  },
};

@Injectable()
export class MarketSectionService {
  private readonly logger = new Logger(MarketSectionService.name);
  private readonly maxPreviewLimit = 12;
  private readonly defaultDetailLimit = 24;
  private readonly maxDetailLimit = 60;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly marketSuppressionService?: MarketSuppressionService,
    @Optional()
    private readonly marketRankingConfigService?: MarketRankingConfigService,
    @Optional()
    private readonly marketRankingAggregateReader?: MarketRankingAggregateReaderService,
    @Optional()
    private readonly marketRankingScorer?: MarketRankingScorerService,
    @Optional()
    private readonly marketGovernanceConfigService?: MarketGovernanceConfigService,
  ) {}

  async getSections(
    options?: { limit?: number } & MarketSectionIdentityOptions,
  ) {
    const limitOverride =
      typeof options?.limit === 'number' && Number.isFinite(options.limit)
        ? Math.min(this.maxPreviewLimit, Math.max(1, Math.floor(options.limit)))
        : undefined;
    const suppressionScope = await this.getSuppressionScope(options);
    const rankingConfig = this.marketRankingConfigService?.getConfig();
    const sectionConfigs = await this.getServedSectionConfigs({
      userId: options?.userId,
    });

    const sections = await Promise.all(
      sectionConfigs
        .filter((config) => !suppressionScope.sectionKeys.has(config.key))
        .map((config) =>
          this.buildSection(config, {
            limit: limitOverride ?? config.previewItemLimit,
            suppressionScope,
            rankingConfig,
          }),
        ),
    );

    return {
      generatedAt: new Date().toISOString(),
      sections: sections.filter(
        (section) => section.items.length >= section.metadata.minimumItems,
      ),
      metadata: {
        version: 'phase1.v1' as const,
        personalization: 'disabled' as const,
        cachePolicy: 'private-no-store' as const,
      },
    };
  }

  async getSectionDetail(
    key: string,
    options?: {
      cursor?: string;
      limit?: number;
    } & MarketSectionIdentityOptions,
  ) {
    const sectionConfig = await this.resolveServedSectionConfig(key, {
      userId: options?.userId,
    });
    const safeLimit = this.normalizeLimit(
      options?.limit,
      sectionConfig.detailPageLimit,
    );
    const safeCursor = this.normalizeCursor(options?.cursor);
    const suppressionScope = await this.getSuppressionScope(options);
    const rankingConfig = this.marketRankingConfigService?.getConfig();
    const section = await this.buildSection(sectionConfig, {
      cursor: safeCursor,
      limit: safeLimit,
      suppressionScope,
      rankingConfig,
    });

    return {
      generatedAt: new Date().toISOString(),
      section,
    };
  }

  private normalizeSectionKey(key: string): string {
    const normalized = String(key ?? '')
      .trim()
      .toLowerCase();
    if (!normalized) throw new NotFoundException('Unsupported market section');
    return normalized;
  }

  private async getServedSectionConfigs(options?: {
    userId?: string | null;
  }): Promise<SectionConfig[]> {
    const configs = await this.getConfiguredSectionViews();
    return configs
      .filter((config) => this.canServeConfig(config, options))
      .map((config) => this.toSectionConfig(config));
  }

  private async resolveServedSectionConfig(
    key: string,
    options?: { userId?: string | null },
  ): Promise<SectionConfig> {
    const normalized = this.normalizeSectionKey(key);
    const config = (await this.getServedSectionConfigs(options)).find(
      (item) => item.key === normalized,
    );
    if (!config) {
      throw new NotFoundException(`Unsupported market section: ${key}`);
    }
    return config;
  }

  private async getConfiguredSectionViews(): Promise<
    MarketSectionConfigView[]
  > {
    if (!this.marketGovernanceConfigService) {
      return MARKET_SECTION_CODE_DEFAULTS.map((config) => ({
        ...config,
      })).sort((left, right) => {
        if (left.displayOrder !== right.displayOrder) {
          return left.displayOrder - right.displayOrder;
        }
        return left.sectionKey.localeCompare(right.sectionKey);
      });
    }
    const result =
      await this.marketGovernanceConfigService.getSectionConfigsWithFallback();
    return result.items;
  }

  private canServeConfig(
    config: MarketSectionConfigView,
    options?: { userId?: string | null },
  ) {
    if (!config.enabled || config.status !== 'ACTIVE') return false;
    if (config.requiresAuth && !options?.userId) return false;
    if (!options?.userId && config.guestEnabled === false) return false;
    return true;
  }

  private toSectionConfig(config: MarketSectionConfigView): SectionConfig {
    const key = String(config.sectionKey);
    const presentation =
      SECTION_PRESENTATION[key] ??
      this.presentationForSourceType(config.sourceType);
    return {
      key,
      title: config.title,
      subtitle: config.subtitle,
      emotionalLabel: presentation.emotionalLabel,
      layout: presentation.layout,
      sourceType: config.sourceType ?? presentation.fallbackSourceType,
      previewItemLimit: config.previewItemLimit,
      detailPageLimit: config.detailPageLimit,
      minimumItems: config.minimumItems,
      viewAllEnabled: config.viewAllEnabled,
      viewAllLabel: config.viewAllLabel,
      newBrandReservedRatio: config.newBrandReservedRatio,
    };
  }

  private presentationForSourceType(
    sourceType: MarketSectionSourceType,
  ): {
    emotionalLabel: string;
    layout: MarketSectionLayout;
    fallbackSourceType: MarketSectionSourceType;
  } {
    if (sourceType === 'BRAND') {
      return {
        emotionalLabel: 'Fresh brand energy',
        layout: 'BRAND_RAIL',
        fallbackSourceType: 'BRAND',
      };
    }
    if (sourceType === 'COLLECTION') {
      return {
        emotionalLabel: 'Capsules and edits',
        layout: 'COLLECTION_RAIL',
        fallbackSourceType: 'COLLECTION',
      };
    }
    if (sourceType === 'MIXED') {
      return {
        emotionalLabel: 'Choose a lane',
        layout: 'CATEGORY_GRID',
        fallbackSourceType: 'MIXED',
      };
    }
    return {
      emotionalLabel: 'Market picks',
      layout: sourceType === 'PRODUCT' ? 'HORIZONTAL_RAIL' : 'PRODUCT_GRID',
      fallbackSourceType: sourceType,
    };
  }

  private normalizeLimit(limit: number | undefined, fallback: number) {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return fallback;
    }
    return Math.min(this.maxDetailLimit, Math.max(1, Math.floor(limit)));
  }

  private normalizeCursor(cursor: string | undefined) {
    if (typeof cursor !== 'string') return undefined;
    const trimmed = cursor.trim();
    if (!trimmed) return undefined;
    if (trimmed.length > 160 || /[\u0000-\u001F\u007F]/.test(trimmed)) {
      throw new BadRequestException('Invalid market section cursor');
    }
    return trimmed;
  }

  private async runCursorQuery<T>(operation: () => Promise<T>) {
    try {
      return await operation();
    } catch (error) {
      if (this.isInvalidCursorError(error)) {
        throw new BadRequestException('Invalid market section cursor');
      }
      throw error;
    }
  }

  private isInvalidCursorError(error: unknown) {
    return (
      (error instanceof Prisma.PrismaClientKnownRequestError ||
        typeof error === 'object') &&
      (error as { code?: string } | null)?.code === 'P2025'
    );
  }

  private async buildSection(
    config: SectionConfig,
    options: {
      cursor?: string;
      limit: number;
      suppressionScope?: MarketSuppressionScope;
      rankingConfig?: MarketRankingConfig;
    },
  ): Promise<MarketSectionDto> {
    const key = config.key;

    if (options.suppressionScope?.sectionKeys.has(key)) {
      return this.buildEmptySection(
        config,
        options.limit,
        options.rankingConfig,
      );
    }

    let items: MarketSectionItemDto[] = [];
    let hasNextPage = false;
    let nextCursor: string | null = null;

    switch (key) {
      case 'fresh-drops': {
        const page = await this.getProductItems({
          cursor: options.cursor,
          limit: options.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'hot-right-now': {
        const page = await this.getProductItems({
          cursor: options.cursor,
          limit: options.limit,
          orderBy: [
            { viewsCount: 'desc' },
            { threadsCount: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        });
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'picked-for-you':
      case 'more-from-brands-you-like':
      case 'style-picks-of-the-week': {
        const page = await this.getProductItems({
          cursor: options.cursor,
          limit: options.limit,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        });
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'loved-near-you':
      case 'still-thinking-about-these': {
        const page = await this.getProductItems({
          cursor: options.cursor,
          limit: options.limit,
          orderBy: [
            { viewsCount: 'desc' },
            { threadsCount: 'desc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        });
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'almost-gone': {
        const page = await this.getProductItems({
          cursor: options.cursor,
          limit: options.limit,
          extraAnd: [{ totalStock: { gt: 0, lte: 5 } }],
          orderBy: [
            { totalStock: 'asc' },
            { createdAt: 'desc' },
            { id: 'desc' },
          ],
        });
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'shop-the-look': {
        const page = await this.getStoreCollectionItems(options);
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'shop-by-style': {
        const page = await this.getCategoryItems(options);
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      case 'new-designers-to-watch': {
        const page = await this.getBrandItems(options);
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
      default: {
        const page = await this.getTemplateItems(config, options);
        items = page.items;
        hasNextPage = page.hasNextPage;
        nextCursor = page.nextCursor;
        break;
      }
    }

    const unslicedItems = this.filterSuppressedItems(
      this.dedupeItems(items),
      options.suppressionScope,
    );
    const deterministicItems = this.applyNewBrandFairness(
      unslicedItems,
      config,
      options.limit,
    ).slice(0, options.limit);
    const rankingResult = await this.resolveRankedItems(
      key,
      config,
      deterministicItems,
      options.rankingConfig,
    );

    return {
      key,
      title: config.title,
      subtitle: config.subtitle,
      emotionalLabel: config.emotionalLabel,
      layout: config.layout,
      sourceType: config.sourceType,
      items: rankingResult.items,
      supportsViewAll: config.viewAllEnabled,
      viewAllLabel: config.viewAllLabel,
      viewAll: {
        enabled: config.viewAllEnabled,
        key,
        route: `/market/sections/${key}`,
        label: config.viewAllLabel ?? 'View All',
      },
      pagination: {
        limit: options.limit,
        hasNextPage,
        nextCursor,
      },
      metadata: {
        ...rankingResult.metadata,
        minimumItems: config.minimumItems,
        previewItemLimit: config.previewItemLimit,
        newBrandReservedRatio: config.newBrandReservedRatio,
        newBrandFairnessApplied:
          config.newBrandReservedRatio > 0 &&
          deterministicItems.some((item, index) => unslicedItems[index] !== item),
      },
    };
  }

  private buildEmptySection(
    config: SectionConfig,
    limit: number,
    rankingConfig?: MarketRankingConfig,
  ): MarketSectionDto {
    return {
      key: config.key,
      title: config.title,
      subtitle: config.subtitle,
      emotionalLabel: config.emotionalLabel,
      layout: config.layout,
      sourceType: config.sourceType,
      items: [],
      supportsViewAll: config.viewAllEnabled,
      viewAllLabel: config.viewAllLabel,
      viewAll: {
        enabled: config.viewAllEnabled,
        key: config.key,
        route: `/market/sections/${config.key}`,
        label: config.viewAllLabel ?? 'View All',
      },
      pagination: {
        limit,
        hasNextPage: false,
        nextCursor: null,
      },
      metadata: {
        ...this.resolveDeterministicMetadata(rankingConfig),
        minimumItems: config.minimumItems,
        previewItemLimit: config.previewItemLimit,
        newBrandReservedRatio: config.newBrandReservedRatio,
        newBrandFairnessApplied: false,
      },
    };
  }

  private async getTemplateItems(
    config: SectionConfig,
    options: { cursor?: string; limit: number },
  ) {
    if (config.sourceType === 'BRAND') {
      return this.getBrandItems(options);
    }
    if (config.sourceType === 'COLLECTION') {
      return this.getStoreCollectionItems(options);
    }
    if (config.sourceType === 'MIXED') {
      return this.getCategoryItems(options);
    }
    if (config.sourceType === 'DESIGN') {
      return this.getDesignItems(options);
    }
    return this.getProductItems({
      cursor: options.cursor,
      limit: options.limit,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  private applyNewBrandFairness(
    items: MarketSectionItemDto[],
    config: SectionConfig,
    limit: number,
  ) {
    const ratio = this.clampNumber(config.newBrandReservedRatio, 0, 50);
    if (ratio <= 0 || items.length <= 1 || limit <= 1) return items;

    const reservedTarget = Math.max(1, Math.floor((limit * ratio) / 100));
    const reserved: MarketSectionItemDto[] = [];
    const reservedKeys = new Set<string>();
    const reservedBrands = new Set<string>();

    for (const item of items) {
      if (!this.isNewBrandCandidate(item)) continue;
      const brandKey = this.brandKeyForFairness(item);
      if (!brandKey || reservedBrands.has(brandKey)) continue;
      reserved.push(item);
      reservedKeys.add(this.itemKey(item));
      reservedBrands.add(brandKey);
      if (reserved.length >= reservedTarget) break;
    }

    if (reserved.length === 0) return items;
    const remaining = items.filter((item) => !reservedKeys.has(this.itemKey(item)));
    return [...reserved, ...remaining];
  }

  private isNewBrandCandidate(item: MarketSectionItemDto) {
    if (item.entityType === 'BRAND') {
      return this.isNewBrandCreatedAt(item.createdAt);
    }
    return item.brand?.isNew === true || this.isNewBrandCreatedAt(item.brand?.createdAt);
  }

  private isNewBrandCreatedAt(value: unknown) {
    const iso = this.toIsoString(value);
    if (!iso) return false;
    const created = Date.parse(iso);
    if (!Number.isFinite(created)) return false;
    const ageDays = Math.max(0, (Date.now() - created) / 86_400_000);
    return ageDays <= 180;
  }

  private brandKeyForFairness(item: MarketSectionItemDto) {
    if (item.entityType === 'BRAND') return item.sourceId;
    return item.brand?.id ?? null;
  }

  private itemKey(item: MarketSectionItemDto) {
    return `${item.entityType}:${item.sourceId}`;
  }

  private clampNumber(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  private resolveDeterministicMetadata(
    rankingConfig?: MarketRankingConfig,
    fallbackReason: string | null = null,
  ): Omit<MarketSectionMetadataDto, 'minimumItems' | 'previewItemLimit'> {
    return {
      ranking: 'deterministic-v1',
      personalization: 'disabled',
      fallbackUsed: Boolean(fallbackReason),
      fallbackReason,
      rankingVersion: null,
      shadowMode: Boolean(rankingConfig?.enabled && rankingConfig.shadowMode),
      rankingEnabled: Boolean(rankingConfig?.enabled),
    };
  }

  private async resolveRankedItems(
    key: string,
    config: SectionConfig,
    deterministicItems: MarketSectionItemDto[],
    rankingConfig?: MarketRankingConfig,
  ): Promise<{
    items: MarketSectionItemDto[];
    metadata: Omit<
      MarketSectionMetadataDto,
      'minimumItems' | 'previewItemLimit'
    >;
  }> {
    if (!rankingConfig?.enabled) {
      this.logRankingEvent('ranking-skipped-disabled', {
        sectionKey: key,
        candidateCount: deterministicItems.length,
        servedItemCount: deterministicItems.length,
      });
      return {
        items: deterministicItems,
        metadata: this.resolveDeterministicMetadata(rankingConfig),
      };
    }

    if (!this.canRankSection(key, rankingConfig)) {
      this.logRankingEvent('ranking-skipped-section-not-allowlisted', {
        sectionKey: key,
        rankingEnabled: true,
        shadowMode: rankingConfig.shadowMode,
        candidateCount: deterministicItems.length,
        servedItemCount: deterministicItems.length,
      });
      return {
        items: deterministicItems,
        metadata: this.resolveDeterministicMetadata(rankingConfig),
      };
    }

    if (!rankingConfig.fallbackDeterministic) {
      return this.resolveRankingFallback(
        key,
        rankingConfig,
        deterministicItems,
        'deterministic-fallback-disabled',
      );
    }

    if (
      deterministicItems.length === 0 ||
      !this.marketRankingAggregateReader ||
      !this.marketRankingScorer
    ) {
      return this.resolveRankingFallback(
        key,
        rankingConfig,
        deterministicItems,
        deterministicItems.length === 0
          ? 'no-candidates'
          : 'ranking-services-unavailable',
      );
    }

    const aggregateTargets = deterministicItems.map((item) => ({
      targetType: this.marketRankingScorer!.targetTypeForItem(item),
      targetId: item.sourceId,
    }));
    const aggregateResult =
      await this.marketRankingAggregateReader.readItemAggregates({
        sectionKey: key,
        targets: aggregateTargets,
        timeoutMs: rankingConfig.aggregateTimeoutMs,
      });

    if (!aggregateResult.ok) {
      return this.resolveRankingFallback(
        key,
        rankingConfig,
        deterministicItems,
        aggregateResult.fallbackReason ?? 'aggregate-read-failed',
      );
    }

    if (aggregateResult.aggregates.size === 0) {
      return this.resolveRankingFallback(
        key,
        rankingConfig,
        deterministicItems,
        'aggregate-empty',
      );
    }

    const scored = this.marketRankingScorer.rankItems({
      sectionKey: key,
      items: deterministicItems,
      aggregates: aggregateResult.aggregates,
      config: rankingConfig,
    });

    if (scored.items.length === 0) {
      return this.resolveRankingFallback(
        key,
        rankingConfig,
        deterministicItems,
        'ranked-empty',
      );
    }

    if (rankingConfig.shadowMode) {
      this.logRankingEvent('shadow-mode-computed-not-served', {
        sectionKey: key,
        rankingEnabled: true,
        shadowMode: true,
        candidateCount: deterministicItems.length,
        servedItemCount: deterministicItems.length,
        rankedItemCount: scored.items.length,
        aggregateCount: aggregateResult.aggregates.size,
        durationMs: aggregateResult.durationMs,
      });
      return {
        items: deterministicItems,
        metadata: this.resolveDeterministicMetadata(rankingConfig),
      };
    }

    this.logRankingEvent('aggregate-ranking-served', {
      sectionKey: key,
      rankingEnabled: true,
      shadowMode: false,
      candidateCount: deterministicItems.length,
      servedItemCount: scored.items.length,
      aggregateCount: aggregateResult.aggregates.size,
      durationMs: aggregateResult.durationMs,
      layout: config.layout,
    });

    return {
      items: scored.items,
      metadata: {
        ranking: 'aggregate-v1',
        personalization: 'aggregate-contextual',
        fallbackUsed: false,
        fallbackReason: null,
        rankingVersion: 'aggregate-v1',
        shadowMode: false,
        rankingEnabled: true,
      },
    };
  }

  private resolveRankingFallback(
    key: string,
    rankingConfig: MarketRankingConfig,
    deterministicItems: MarketSectionItemDto[],
    fallbackReason: string,
  ) {
    this.logRankingEvent('deterministic-fallback-used', {
      sectionKey: key,
      rankingEnabled: rankingConfig.enabled,
      shadowMode: rankingConfig.shadowMode,
      fallbackReason,
      candidateCount: deterministicItems.length,
      servedItemCount: deterministicItems.length,
    });
    return {
      items: deterministicItems,
      metadata: this.resolveDeterministicMetadata(
        rankingConfig,
        fallbackReason,
      ),
    };
  }

  private canRankSection(
    key: string,
    rankingConfig: MarketRankingConfig,
  ) {
    return this.getRankingEnabledSectionKeys(rankingConfig).has(key);
  }

  private getRankingEnabledSectionKeys(rankingConfig: MarketRankingConfig) {
    const configured = new Set(rankingConfig.sectionKeys);
    const ordered = MARKET_SECTION_CODE_DEFAULTS.map(
      (config) => config.sectionKey,
    ).filter((sectionKey) => configured.has(sectionKey));
    return new Set(ordered.slice(0, rankingConfig.maxPersonalizedSections));
  }

  private logRankingEvent(event: string, payload: Record<string, unknown>) {
    this.logger.debug(JSON.stringify({ event, ...payload }));
  }

  private dedupeItems(items: MarketSectionItemDto[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = `${item.sourceType}:${item.sourceId}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private filterSuppressedItems(
    items: MarketSectionItemDto[],
    scope?: MarketSuppressionScope,
  ) {
    if (!scope) return items;
    return items.filter((item) => !this.isSuppressedItem(item, scope));
  }

  private isSuppressedItem(
    item: MarketSectionItemDto,
    scope: MarketSuppressionScope,
  ) {
    if (
      scope.targetKeys.has(
        this.marketSuppressionService?.targetKey(
          item.entityType,
          item.sourceId,
        ) ?? `${item.entityType}:${item.sourceId}`,
      )
    ) {
      return true;
    }

    if (
      item.target?.id &&
      scope.targetKeys.has(
        this.marketSuppressionService?.targetKey(
          item.target.type,
          item.target.id,
        ) ?? `${item.target.type}:${item.target.id}`,
      )
    ) {
      return true;
    }

    if (item.brand?.id && scope.brandIds.has(item.brand.id)) {
      return true;
    }

    if (item.category?.id && scope.categoryIds.has(item.category.id)) {
      return true;
    }

    return false;
  }

  private async getSuppressionScope(options?: MarketSectionIdentityOptions) {
    if (!this.marketSuppressionService) {
      return this.emptySuppressionScope();
    }

    return this.marketSuppressionService.getSuppressionScope({
      userId: options?.userId,
      anonymousSessionId: options?.anonymousSessionId,
    });
  }

  private emptySuppressionScope(): MarketSuppressionScope {
    return {
      targetKeys: new Set(),
      brandIds: new Set(),
      categoryIds: new Set(),
      sectionKeys: new Set(),
      suggestionBlockKeys: new Set(),
    };
  }

  private buildMarketableProductWhere(
    extraAnd: Prisma.ProductWhereInput[] = [],
    options?: { includeBrandOpen?: boolean },
  ): Prisma.ProductWhereInput {
    const now = new Date();
    const andFilters: Prisma.ProductWhereInput[] = [
      {
        OR: [{ totalStock: { gt: 0 } }, { customOrderEnabled: true }],
      },
      {
        OR: [{ publishAt: null }, { publishAt: { lte: now } }],
      },
      {
        OR: [{ thumbnail: { not: null } }, { images: { isEmpty: false } }],
      },
      ...extraAnd,
    ];

    return {
      isActive: true,
      publicationStatus: CollectionStatus.PUBLISHED,
      deletedAt: null,
      archivedAt: null,
      ...(options?.includeBrandOpen === false
        ? {}
        : { brand: { isStoreOpen: true } }),
      AND: andFilters,
    };
  }

  private async getProductItems(options: {
    cursor?: string;
    limit: number;
    extraAnd?: Prisma.ProductWhereInput[];
    orderBy: Prisma.ProductOrderByWithRelationInput[];
  }) {
    const take = this.normalizeLimit(options.limit, this.defaultDetailLimit);
    const products = await this.runCursorQuery(() =>
      this.prisma.product.findMany({
        where: this.buildMarketableProductWhere(options.extraAnd),
        orderBy: options.orderBy,
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        take: take + 1,
        select: {
          id: true,
          name: true,
          description: true,
          slug: true,
          price: true,
          salePrice: true,
          saleStartAt: true,
          saleEndAt: true,
          currency: true,
          thumbnail: true,
          images: true,
          totalStock: true,
          customOrderEnabled: true,
          standardCheckoutEnabled: true,
          tags: true,
          gender: true,
          viewsCount: true,
          threadsCount: true,
          createdAt: true,
          updatedAt: true,
          brandId: true,
          brand: {
            select: {
              id: true,
              name: true,
              logo: true,
              currency: true,
              createdAt: true,
            },
          },
          category: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
        },
      }),
    );

    const hasNextPage = products.length > take;
    const page = hasNextPage ? products.slice(0, take) : products;
    return {
      items: page
        .map((product) => this.mapProductItem(product))
        .filter((item): item is MarketSectionItemDto => Boolean(item)),
      hasNextPage,
      nextCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  private async getStoreCollectionItems(options: {
    cursor?: string;
    limit: number;
  }) {
    const take = this.normalizeLimit(options.limit, this.defaultDetailLimit);
    const collections = await this.runCursorQuery(() =>
      this.prisma.storeCollection.findMany({
        where: {
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          isAvailableInStore: true,
          deletedAt: null,
          owner: { brand: { isStoreOpen: true } },
          products: {
            some: {
              product: this.buildMarketableProductWhere([], {
                includeBrandOpen: false,
              }),
            },
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        take: take + 1,
        select: {
          id: true,
          title: true,
          description: true,
          minPrice: true,
          maxPrice: true,
          saleMinPrice: true,
          saleMaxPrice: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
          category: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
          owner: {
            select: {
              id: true,
              username: true,
              brand: {
                select: {
                  id: true,
                  name: true,
                  logo: true,
                  currency: true,
                  createdAt: true,
                },
              },
            },
          },
          products: {
            orderBy: [{ orderIndex: 'asc' }],
            take: 5,
            select: {
              product: {
                select: {
                  id: true,
                  name: true,
                  price: true,
                  salePrice: true,
                  currency: true,
                  thumbnail: true,
                  images: true,
                  totalStock: true,
                  customOrderEnabled: true,
                  isActive: true,
                  deletedAt: true,
                  archivedAt: true,
                  publishAt: true,
                },
              },
            },
          },
          _count: {
            select: {
              products: true,
            },
          },
        },
      }),
    );

    const hasNextPage = collections.length > take;
    const page = hasNextPage ? collections.slice(0, take) : collections;
    return {
      items: page
        .map((collection) => this.mapStoreCollectionItem(collection))
        .filter((item): item is MarketSectionItemDto => Boolean(item)),
      hasNextPage,
      nextCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  private async getCategoryItems(options: { cursor?: string; limit: number }) {
    const take = this.normalizeLimit(options.limit, this.defaultDetailLimit);
    const categories = await this.runCursorQuery(() =>
      this.prisma.collectionCategory.findMany({
        where: {
          isActive: true,
        },
        orderBy: [{ order: 'asc' }, { slug: 'asc' }],
        ...(options.cursor
          ? { cursor: { slug: options.cursor }, skip: 1 }
          : {}),
        take: take + 1,
        select: {
          id: true,
          slug: true,
          name: true,
          description: true,
          updatedAt: true,
        },
      }),
    );

    const hasNextPage = categories.length > take;
    const page = hasNextPage ? categories.slice(0, take) : categories;
    return {
      items: page.map((category) => ({
        id: category.slug,
        sourceId: category.slug,
        sourceType: 'MIXED',
        entityType: 'CATEGORY',
        title: category.name,
        subtitle: category.description ?? null,
        description: category.description ?? null,
        brand: null,
        media: null,
        price: null,
        priceRange: null,
        availability: null,
        category: {
          id: category.id,
          slug: category.slug,
          name: category.name,
        },
        tags: [category.slug],
        stats: {
          views: null,
          threads: null,
          products: null,
        },
        target: {
          type: 'CATEGORY',
          id: category.id,
          key: category.slug,
          route: `/market-place?category=${encodeURIComponent(category.slug)}`,
        },
        createdAt: null,
        updatedAt: category.updatedAt.toISOString(),
      })) as MarketSectionItemDto[],
      hasNextPage,
      nextCursor: hasNextPage ? (page[page.length - 1]?.slug ?? null) : null,
    };
  }

  private async getBrandItems(options: { cursor?: string; limit: number }) {
    const take = this.normalizeLimit(options.limit, this.defaultDetailLimit);
    const productWhere = this.buildMarketableProductWhere([], {
      includeBrandOpen: false,
    });
    const brands = await this.runCursorQuery(() =>
      this.prisma.brand.findMany({
        where: {
          isStoreOpen: true,
          products: {
            some: productWhere,
          },
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        take: take + 1,
        select: {
          id: true,
          name: true,
          description: true,
          logo: true,
          tags: true,
          createdAt: true,
          updatedAt: true,
          products: {
            where: productWhere,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take: 1,
            select: {
              id: true,
              name: true,
              thumbnail: true,
              images: true,
            },
          },
          _count: {
            select: {
              products: true,
            },
          },
        },
      }),
    );

    const hasNextPage = brands.length > take;
    const page = hasNextPage ? brands.slice(0, take) : brands;
    return {
      items: page
        .map((brand) => this.mapBrandItem(brand))
        .filter((item): item is MarketSectionItemDto => Boolean(item)),
      hasNextPage,
      nextCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  private async getDesignItems(options: { cursor?: string; limit: number }) {
    const take = this.normalizeLimit(options.limit, this.defaultDetailLimit);
    const designs = await this.runCursorQuery(() =>
      this.prisma.design.findMany({
        where: {
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
          brand: { isStoreOpen: true },
          OR: [
            { coverMedia: { file: { s3Url: { not: '' } } } },
            { medias: { some: { file: { s3Url: { not: '' } } } } },
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        ...(options.cursor ? { cursor: { id: options.cursor }, skip: 1 } : {}),
        take: take + 1,
        select: {
          id: true,
          legacyCollectionId: true,
          title: true,
          description: true,
          minPrice: true,
          maxPrice: true,
          saleMinPrice: true,
          saleMaxPrice: true,
          saleStartAt: true,
          saleEndAt: true,
          customOrderEnabled: true,
          tags: true,
          viewsCount: true,
          threadsCount: true,
          createdAt: true,
          updatedAt: true,
          brand: {
            select: {
              id: true,
              name: true,
              logo: true,
              currency: true,
              createdAt: true,
            },
          },
          category: {
            select: {
              id: true,
              slug: true,
              name: true,
            },
          },
          coverMedia: {
            select: {
              file: {
                select: {
                  s3Url: true,
                  fileType: true,
                },
              },
            },
          },
          medias: {
            orderBy: [{ orderIndex: 'asc' }, { id: 'asc' }],
            take: 1,
            select: {
              file: {
                select: {
                  s3Url: true,
                  fileType: true,
                },
              },
            },
          },
        },
      }),
    );

    const hasNextPage = designs.length > take;
    const page = hasNextPage ? designs.slice(0, take) : designs;
    return {
      items: page
        .map((design) => this.mapDesignItem(design))
        .filter((item): item is MarketSectionItemDto => Boolean(item)),
      hasNextPage,
      nextCursor: hasNextPage ? (page[page.length - 1]?.id ?? null) : null,
    };
  }

  private mapDesignItem(design: any): MarketSectionItemDto | null {
    const media =
      this.cleanString(design.coverMedia?.file?.s3Url) ??
      this.cleanString(design.medias?.[0]?.file?.s3Url);
    if (!media) return null;
    const min =
      this.isSaleActive(design) && typeof design.saleMinPrice === 'number'
        ? design.saleMinPrice
        : design.minPrice;
    const max =
      this.isSaleActive(design) && typeof design.saleMaxPrice === 'number'
        ? design.saleMaxPrice
        : design.maxPrice;
    const targetId = design.legacyCollectionId ?? design.id;

    return {
      id: design.id,
      sourceId: design.id,
      sourceType: 'DESIGN',
      entityType: 'DESIGN',
      title: design.title ?? 'Untitled design',
      subtitle: design.brand?.name ?? null,
      description: design.description ?? null,
      brand: {
        id: design.brand?.id ?? null,
        name: design.brand?.name ?? null,
        logoUrl: this.cleanString(design.brand?.logo),
        createdAt: this.toIsoString(design.brand?.createdAt),
        isNew: this.isNewBrandCreatedAt(design.brand?.createdAt),
      },
      media: {
        url: media,
        thumbnailUrl: media,
        type: String(
          design.coverMedia?.file?.fileType ?? design.medias?.[0]?.file?.fileType ?? '',
        )
          .toUpperCase()
          .includes('VIDEO')
          ? 'VIDEO'
          : 'IMAGE',
        alt: design.title ?? 'Design',
      },
      price: null,
      priceRange: {
        min: typeof min === 'number' ? min : null,
        max: typeof max === 'number' ? max : null,
        currency: design.brand?.currency ?? 'NGN',
      },
      availability: {
        totalStock: null,
        customOrderEnabled: design.customOrderEnabled === true,
        standardCheckoutEnabled: false,
        isOnSale: this.isSaleActive(design),
      },
      category: design.category
        ? {
            id: design.category.id,
            slug: design.category.slug,
            name: design.category.name,
          }
        : null,
      tags: Array.isArray(design.tags) ? design.tags : [],
      stats: {
        views: Number(design.viewsCount ?? 0),
        threads: Number(design.threadsCount ?? 0),
        products: null,
      },
      target: {
        type: 'DESIGN',
        id: targetId,
        key: targetId,
        route: `/designs/${targetId}`,
      },
      createdAt: design.createdAt?.toISOString?.() ?? null,
      updatedAt: design.updatedAt?.toISOString?.() ?? null,
    };
  }

  private mapProductItem(product: any): MarketSectionItemDto | null {
    const image = this.firstProductImage(product);
    if (!image) return null;
    const price = Number(product.price ?? 0);
    const saleAmount = this.isSaleActive(product)
      ? Number(product.salePrice)
      : null;
    const effectiveAmount = saleAmount ?? price;

    return {
      id: product.id,
      sourceId: product.id,
      sourceType: 'PRODUCT',
      entityType: 'PRODUCT',
      title: product.name,
      subtitle: product.brand?.name ?? null,
      description: product.description ?? null,
      brand: {
        id: product.brand?.id ?? product.brandId ?? null,
        name: product.brand?.name ?? null,
        logoUrl: this.cleanString(product.brand?.logo),
        createdAt: this.toIsoString(product.brand?.createdAt),
        isNew: this.isNewBrandCreatedAt(product.brand?.createdAt),
      },
      media: {
        url: image,
        thumbnailUrl: this.cleanString(product.thumbnail) ?? image,
        type: 'IMAGE',
        alt: product.name,
      },
      price: {
        amount: price,
        saleAmount,
        effectiveAmount,
        currency: product.currency ?? product.brand?.currency ?? 'NGN',
      },
      priceRange: null,
      availability: {
        totalStock: Number(product.totalStock ?? 0),
        customOrderEnabled: product.customOrderEnabled === true,
        standardCheckoutEnabled: product.standardCheckoutEnabled !== false,
        isOnSale: saleAmount !== null,
      },
      category: product.category
        ? {
            id: product.category.id,
            slug: product.category.slug,
            name: product.category.name,
          }
        : null,
      tags: Array.isArray(product.tags) ? product.tags : [],
      stats: {
        views: Number(product.viewsCount ?? 0),
        threads: Number(product.threadsCount ?? 0),
        products: null,
      },
      target: {
        type: 'PRODUCT',
        id: product.id,
        key: product.slug ?? product.id,
        route: product.slug
          ? `/market-place/products/${product.slug}`
          : `/market-place?productId=${product.id}`,
      },
      createdAt: product.createdAt?.toISOString?.() ?? null,
      updatedAt: product.updatedAt?.toISOString?.() ?? null,
    };
  }

  private mapStoreCollectionItem(collection: any): MarketSectionItemDto | null {
    const visibleProducts = (collection.products ?? [])
      .map((link: any) => link?.product)
      .filter((product: any) => product && this.isProductVisible(product));
    const coverProduct = visibleProducts.find((product: any) =>
      this.firstProductImage(product),
    );
    const coverImage = coverProduct
      ? this.firstProductImage(coverProduct)
      : null;
    if (!coverImage) return null;

    const prices = visibleProducts
      .map((product: any) =>
        Number(
          this.isSaleActive(product) && product.salePrice
            ? product.salePrice
            : product.price,
        ),
      )
      .filter((price: number) => Number.isFinite(price) && price > 0);
    const currency =
      coverProduct?.currency ?? collection.owner?.brand?.currency ?? 'NGN';

    return {
      id: collection.id,
      sourceId: collection.id,
      sourceType: 'COLLECTION',
      entityType: 'COLLECTION',
      title: collection.title ?? 'Untitled collection',
      subtitle:
        collection.owner?.brand?.name ?? collection.owner?.username ?? null,
      description: collection.description ?? null,
      brand: {
        id: collection.owner?.brand?.id ?? collection.owner?.id ?? null,
        name:
          collection.owner?.brand?.name ?? collection.owner?.username ?? null,
        logoUrl: this.cleanString(collection.owner?.brand?.logo),
        createdAt: this.toIsoString(collection.owner?.brand?.createdAt),
        isNew: this.isNewBrandCreatedAt(collection.owner?.brand?.createdAt),
      },
      media: {
        url: coverImage,
        thumbnailUrl: coverImage,
        type: 'IMAGE',
        alt: collection.title ?? 'Store collection',
      },
      price: null,
      priceRange: {
        min: prices.length
          ? Math.min(...prices)
          : (collection.minPrice ?? null),
        max: prices.length
          ? Math.max(...prices)
          : (collection.maxPrice ?? null),
        currency,
      },
      availability: null,
      category: collection.category
        ? {
            id: collection.category.id,
            slug: collection.category.slug,
            name: collection.category.name,
          }
        : null,
      tags: Array.isArray(collection.tags) ? collection.tags : [],
      stats: {
        views: null,
        threads: null,
        products: Number(collection._count?.products ?? visibleProducts.length),
      },
      target: {
        type: 'COLLECTION',
        id: collection.id,
        key: collection.id,
        route: `/store-collections/${collection.id}`,
      },
      createdAt: collection.createdAt?.toISOString?.() ?? null,
      updatedAt: collection.updatedAt?.toISOString?.() ?? null,
    };
  }

  private mapBrandItem(brand: any): MarketSectionItemDto | null {
    const representativeProduct = brand.products?.[0] ?? null;
    const productImage = representativeProduct
      ? this.firstProductImage(representativeProduct)
      : null;
    const logo = this.cleanString(brand.logo);
    const mediaUrl = productImage ?? logo;
    if (!mediaUrl) return null;

    return {
      id: brand.id,
      sourceId: brand.id,
      sourceType: 'BRAND',
      entityType: 'BRAND',
      title: brand.name,
      subtitle: representativeProduct?.name ?? null,
      description: brand.description ?? null,
      brand: {
        id: brand.id,
        name: brand.name,
        logoUrl: logo,
        createdAt: this.toIsoString(brand.createdAt),
        isNew: this.isNewBrandCreatedAt(brand.createdAt),
      },
      media: {
        url: mediaUrl,
        thumbnailUrl: mediaUrl,
        type: 'IMAGE',
        alt: brand.name,
      },
      price: null,
      priceRange: null,
      availability: null,
      category: null,
      tags: Array.isArray(brand.tags) ? brand.tags : [],
      stats: {
        views: null,
        threads: null,
        products: Number(brand._count?.products ?? 0),
      },
      target: {
        type: 'BRAND',
        id: brand.id,
        key: brand.id,
        route: `/brand/${brand.id}`,
      },
      createdAt: brand.createdAt?.toISOString?.() ?? null,
      updatedAt: brand.updatedAt?.toISOString?.() ?? null,
    };
  }

  private firstProductImage(product: any): string | null {
    const thumbnail = this.cleanString(product?.thumbnail);
    if (thumbnail) return thumbnail;
    const images = Array.isArray(product?.images) ? product.images : [];
    return (
      images
        .map((image: unknown) => this.cleanString(image))
        .find((image: string | null): image is string => Boolean(image)) ?? null
    );
  }

  private isProductVisible(product: any) {
    if (!product) return false;
    if (product.deletedAt || product.archivedAt || product.isActive === false) {
      return false;
    }
    if (product.publishAt && product.publishAt > new Date()) {
      return false;
    }
    return (
      Number(product.totalStock ?? 0) > 0 || product.customOrderEnabled === true
    );
  }

  private isSaleActive(product: any) {
    const price = Number(product?.price ?? 0);
    const salePrice = Number(product?.salePrice ?? 0);
    if (!Number.isFinite(price) || !Number.isFinite(salePrice)) return false;
    if (salePrice <= 0 || salePrice >= price) return false;
    const now = Date.now();
    const start = product.saleStartAt
      ? new Date(product.saleStartAt).getTime()
      : null;
    const end = product.saleEndAt
      ? new Date(product.saleEndAt).getTime()
      : null;
    return (!start || start <= now) && (!end || end >= now);
  }

  private cleanString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private toIsoString(value: unknown): string | null {
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    return null;
  }
}
