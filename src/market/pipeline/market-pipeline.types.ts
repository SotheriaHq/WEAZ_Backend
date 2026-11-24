import type { CanonicalMarketFilters } from '../catalog/market-filters';
import type { MarketSectionItemDto } from '../dto/market-section.dto';
import type { ProductEligibilityRow } from '../eligibility/market-eligibility';

export type PipelineTemplate =
  | 'NEW_RELEASES'
  | 'TREND'
  | 'CATALOG_POPULAR'
  | 'STARTER_PICKS'
  | 'NEW_DESIGNERS'
  | 'CATEGORY_TILES'
  | 'LOOKS'
  | 'LOW_STOCK'
  | 'CURATED_LIST'
  | 'CATALOG_FILTER'
  | 'SIMILAR_ITEMS'
  | 'COMPLEMENTS'
  | 'FROM_RUNWAY'
  | 'AFFINITY'
  | 'RECENTLY_VIEWED'
  | 'FOLLOWED_BRANDS'
  | 'REGIONAL_POPULAR';
export type PipelinePolicy =
  | 'recency'
  | 'decayed_popularity'
  | 'trend'
  | 'quality_diverse'
  | 'exposure_balanced'
  | 'admin_order'
  | 'curator_order'
  | 'stock_scarcity'
  | 'similarity';
export type PipelineSort =
  | 'newest'
  | 'popular'
  | 'trending'
  | 'price_asc'
  | 'price_desc';
export type PipelineSurface =
  | 'HOME'
  | 'PRODUCT'
  | 'STORE'
  | 'SEARCH_EMPTY'
  | 'WISHLIST'
  | 'COLLECTION';

export interface PipelineSpec {
  readonly key: string;
  readonly version: number;
  readonly title: string;
  readonly subtitle: string | null;
  readonly status: 'DRAFT' | 'ACTIVE' | 'PAUSED' | 'ARCHIVED';
  readonly template: PipelineTemplate;
  readonly rankingPolicy: PipelinePolicy;
  readonly placement: {
    readonly surface: PipelineSurface;
    readonly order: number;
  };
  readonly audience: { readonly guests: boolean; readonly signedIn: boolean };
  readonly schedule: {
    readonly startsAt: string | null;
    readonly endsAt: string | null;
  };
  readonly filters: CanonicalMarketFilters;
  readonly curated: { readonly placementKey: string } | null;
  readonly capacity: {
    readonly preview: number;
    readonly page: number;
    readonly minItems: number;
  };
  readonly params: {
    readonly candidateLimit: number;
    readonly eligibilityWindowDays: number;
    readonly evidenceFloorActors: number;
    readonly maxPerBrand: number;
    readonly maxPerCategory: number;
    readonly newDesignerSlots: number;
    readonly explorationShare: number;
    readonly maxTenureEpochs: number;
    readonly reentryCooldownEpochs: number;
    readonly lowStockThreshold: number;
  };
  readonly sorts: readonly PipelineSort[];
  readonly fallback: readonly string[];
  readonly diversity: {
    readonly pageDedupe: boolean;
    readonly allowRepeat: boolean;
  };
  readonly cache: { readonly sharedTtlSeconds: number };
}

/** All feature values belong to this immutable READY generation, never mutable rows. */
export interface PipelineEpoch {
  readonly id: string;
  readonly epochStart: string;
  readonly epochEnd: string;
  readonly sourceAsOf: string;
  readonly acceptUntil: string;
  readonly featureSchemaVersion: 1;
  readonly policyVersion: 1;
  readonly stateKey: 'market.features.v1.r1';
  readonly status: 'READY';
  readonly complete: Readonly<{
    popularity: boolean;
    trend: boolean;
    quality: boolean;
  }>;
  readonly intentProductCount: number;
}
export interface PipelineCandidate {
  readonly exposureProductId?: string | null;
  readonly categoryTypeId?: string | null;
  readonly effectivePriceAmount?: number | null;
  readonly id: string;
  readonly entityType:
    | 'PRODUCT'
    | 'BRAND'
    | 'CATEGORY'
    | 'COLLECTION'
    | 'DESIGN';
  readonly brandId: string | null;
  readonly categoryId: string | null;
  readonly firstPublishedAt: string | null;
  readonly brandCreatedAt: string | null;
  readonly tags: readonly string[];
  readonly dimensions: readonly string[];
  readonly features: Readonly<{
    popularity: number | null;
    quality: number | null;
    trend: number | null;
    trendRatio: number | null;
    actors7d: number | null;
    trendEligible: boolean;
    intent7d: number | null;
    minStock: number | null;
    sourceOrder: number;
    similarity: number | null;
  }>;
}
export interface PipelineScoredCandidate {
  readonly candidate: PipelineCandidate;
  readonly score: number;
  readonly explore: boolean;
  readonly samplingProbability: number | null;
  readonly repeatOf: string | null;
}
export type PipelineSource =
  | {
      readonly kind: 'catalog';
      readonly sort: 'newest' | 'popular' | 'trending';
      readonly firstPublishedAfter: string | null;
    }
  | { readonly kind: 'low_stock'; readonly threshold: number }
  | { readonly kind: 'curated'; readonly placementKey: string }
  | { readonly kind: 'similar' | 'complements'; readonly productId: string }
  | { readonly kind: 'from_runway' }
  | {
      readonly kind: 'looks';
      readonly minEligibleProducts: 2;
      readonly minEligibleRatio: 0.7;
      readonly placementKey?: string;
    }
  | {
      readonly kind: 'new_designers';
      readonly maxAgeDays: 180;
      readonly minEligibleProducts: 3;
    }
  | { readonly kind: 'category_tiles'; readonly minEligibleProducts: 2 };

export interface PipelineSuppression {
  readonly targetKeys: ReadonlySet<string>;
  readonly brandIds: ReadonlySet<string>;
  readonly categoryIds: ReadonlySet<string>;
  readonly sectionKeys: ReadonlySet<string>;
}
export interface PipelineContext {
  /** Monotonic request deadline; shared by capture, media and composition. */
  readonly deadline?: number;
  /** Captured database time from the same read context as the epoch/suppressions. */
  readonly asOf: Date;
  readonly epoch: PipelineEpoch | null;
  readonly surface: PipelineSurface;
  readonly signedIn: boolean;
  /** Server-resolved public context; never accepts arbitrary SQL or actor history. */
  readonly productId?: string;
  readonly filters: CanonicalMarketFilters;
  readonly suppression: PipelineSuppression;
  readonly retentionHours: number;
  readonly personalEnabled: boolean;
  readonly regionalEnabled: boolean;
  readonly tenure: ReadonlyMap<
    string,
    {
      readonly consecutive: number;
      readonly lastEpochStart: string;
      readonly entryTrendRatio: number | null;
    }
  >;
  readonly signal?: AbortSignal;
}
export interface PipelineSourceRequest {
  readonly suppressionMode?: 'public_pool' | 'viewer';
  readonly sectionKey: string;
  readonly source: PipelineSource;
  readonly fixedFilterLayers: readonly CanonicalMarketFilters[];
  readonly filters: CanonicalMarketFilters;
  readonly asOf: Date;
  readonly epoch: PipelineEpoch | null;
  readonly limit: number;
  readonly signal: AbortSignal;
  /** Anonymous IDs only; adapter rechecks original membership and live eligibility. */
  readonly cachedIds?: readonly string[];
  /** Server-captured exact cover associations for the final authorization read. */
  readonly capturedCovers?: readonly {
    readonly productId: string;
    readonly fileId: string;
    readonly assetVersion: number;
  }[];
}
export interface PipelineHydrated {
  readonly item: MarketSectionItemDto;
  readonly product?: ProductEligibilityRow;
  /** Live SKU proof; required for LOW_STOCK, never inferred from aggregate totalStock. */
  readonly scarcity?: {
    readonly trackInventory: boolean;
    readonly standardCheckoutEnabled: boolean;
    readonly minPositiveStock: number | null;
  };
}
export interface PipelinePorts {
  /** Bounded, cancellable, read-only. Apply canonical eligibility and source restriction BEFORE limiting. */
  retrieve(input: PipelineSourceRequest): Promise<readonly PipelineCandidate[]>;
  /** Uses WP03 captured-time capture + public batch signing. Missing/unauthorized media is omitted. */
  hydrate(
    candidates: readonly PipelineCandidate[],
    asOf: Date,
    signal: AbortSignal,
    request?: PipelineSourceRequest,
  ): Promise<readonly PipelineHydrated[]>;
}
export interface PipelineSection {
  readonly exposures?: readonly {
    readonly productId: string;
    readonly position: number;
  }[];
  readonly key: string;
  readonly template: PipelineTemplate;
  readonly title: string;
  readonly subtitle: string | null;
  readonly policy: PipelinePolicy;
  readonly policyVersion: 1;
  readonly personalization: 'none';
  readonly items: readonly (MarketSectionItemDto & {
    position: number;
    explore: boolean;
    samplingProbability: number | null;
    repeatOf: string | null;
  })[];
  readonly viewAll: {
    readonly enabled: boolean;
    readonly sectionKey: string;
    readonly specVersion: number;
    readonly effectiveTemplate: PipelineTemplate;
    readonly availableSorts: readonly PipelineSort[];
  };
  /** Internal trusted scope for the facade; omit this object from public JSON. */
  readonly scope: {
    readonly source: PipelineSource;
    readonly fixedFilterLayers: readonly CanonicalMarketFilters[];
  };
  readonly metadata: {
    readonly fallbackUsed: boolean;
    readonly fallbackReason: string | null;
    readonly candidateCount: number;
    readonly minItems: number;
  };
}
