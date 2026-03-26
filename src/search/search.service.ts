import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  CollectionDomain,
  CollectionStatus,
  CollectionVisibility,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { TagsService } from 'src/tags/tags.service';
import { createClient, type RedisClientType } from 'redis';
import type { SearchSyncJob } from 'src/queue/search.queue.service';
import { SearchQueueService } from 'src/queue/search.queue.service';
import {
  SEARCH_ENTITY_TYPES,
  type SearchEntityType,
  type SearchHealthResponse,
  type SearchItem,
  type SearchResponse,
  type SearchSuggestionResponse,
} from './search.types';

interface SearchParams {
  query?: string;
  types?: SearchEntityType[];
  page?: number;
  limit?: number;
  brandId?: string;
  userId?: string;
}

type SearchQueryMode = 'default' | 'brand' | 'tag';

interface ParsedSearchQuery {
  rawQuery: string;
  mode: SearchQueryMode;
  normalizedQuery: string;
  tokens: string[];
  forcedTypes?: SearchEntityType[];
}

interface SuggestionPayload {
  id: string;
  type: SearchEntityType | 'recent' | 'trending';
  title: string;
  subtitle?: string | null;
  description?: string | null;
  imageUrl?: string | null;
  href: string;
  price?: number | null;
  salePrice?: number | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
  matchText: string;
}

interface ProductSearchRow {
  id: string;
  name: string;
  description: string | null;
  thumbnail: string | null;
  images: string[] | null;
  price: Prisma.Decimal | number | string | null;
  salePrice: Prisma.Decimal | number | string | null;
  currency: string | null;
  slug: string | null;
  brandId: string;
  brandName: string | null;
  brandOwnerId: string | null;
  score: number;
}

interface BrandSearchRow {
  id: string;
  ownerId: string;
  name: string;
  description: string | null;
  tagline: string | null;
  logo: string | null;
  isStoreOpen: boolean;
  score: number;
}

interface CollectionSearchRow {
  id: string;
  ownerId: string;
  title: string | null;
  description: string | null;
  viewsCount: number;
  score: number;
}

interface SearchPageResult {
  items: SearchItem[];
  total: number;
}

const RECENT_LIMIT = 10;
const TRENDING_LIMIT = 6;
const PRODUCT_SUGGEST_LIMIT = 3;
const BRAND_SUGGEST_LIMIT = 2;
const DESIGN_SUGGEST_LIMIT = 2;
const COLLECTION_SUGGEST_LIMIT = 2;
const TAG_SUGGEST_LIMIT = 3;
const SEARCH_CACHE_TTL_SECONDS = 60;
const SEARCH_REDIS_TIMEOUT_MS = 100;
const SEARCH_REDIS_CIRCUIT_FAILURE_THRESHOLD = 5;
const SEARCH_REDIS_CIRCUIT_OPEN_MS = 10000;
const SEARCH_REBUILD_BATCH_SIZE = 250;
const SEARCH_SUGGEST_SCAN_BATCH = 24;
const SEARCH_SUGGEST_SCAN_CAP = 240;
const SEARCH_SIMILARITY_THRESHOLD = 0.3;
const SEARCH_MIXED_PREVIEW_LIMIT = 5;

const SEARCH_RESULT_CACHE_ALL_VERSION_KEY = 'search:results:version:all';
const SEARCH_RESULT_CACHE_VERSION_KEYS: Record<SearchEntityType, string> = {
  product: 'search:results:version:product',
  brand: 'search:results:version:brand',
  design: 'search:results:version:design',
  collection: 'search:results:version:collection',
  tag: 'search:results:version:tag',
};

const SEARCH_SUGGEST_KEYS = {
  products: 'search:suggest:index:products',
  brands: 'search:suggest:index:brands',
  designs: 'search:suggest:index:designs',
  collections: 'search:suggest:index:store-collections',
  tags: 'search:suggest:index:tags',
} as const;

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private redis: RedisClientType | null = null;
  private redisCircuitOpenUntil = 0;
  private redisFailureCount = 0;
  private isRebuildingSuggestions = false;
  private prismaSearchHooksRegistered = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
    @Optional() private readonly searchQueue?: SearchQueueService,
  ) {}

  async onModuleInit() {
    const redisUrl = String(process.env.REDIS_URL || '').trim();
    if (!redisUrl) {
      return;
    }

    const client = createClient({
      url: redisUrl,
      socket: {
        connectTimeout: SEARCH_REDIS_TIMEOUT_MS,
      },
    });

    client.on('error', (error) => {
      this.logger.warn(`Search Redis error: ${error?.message || error}`);
    });

    void client
      .connect()
      .then(() => {
        this.redis = client as RedisClientType;
        this.registerPrismaSearchHooks();
        void this.ensureSuggestionIndexes().catch((indexError: any) => {
          this.logger.warn(
            `Suggestion index bootstrap deferred failure: ${indexError?.message || indexError}`,
          );
        });
      })
      .catch((error: any) => {
        this.logger.warn(
          `Search Redis unavailable, continuing without recent/trending persistence: ${error?.message || error}`,
        );
        this.redis = null;
        try {
          client.disconnect();
        } catch {
          // Ignore best-effort cleanup failures.
        }
      });
  }

  async onModuleDestroy() {
    if (!this.redis) {
      return;
    }
    try {
      await this.redis.quit();
    } catch {
      // Ignore best-effort shutdown failures.
    } finally {
      this.redis = null;
    }
  }

  normalizeQuery(raw?: string | null): string {
    return String(raw || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/\u0000/g, '')
      .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private tokenize(query: string): string[] {
    return query
      .split(/[^\p{L}\p{N}]+/u)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  private parseSearchQuery(queryInput?: string | null): ParsedSearchQuery {
    const rawQuery = String(queryInput || '').trim();
    if (!rawQuery) {
      return {
        rawQuery,
        mode: 'default',
        normalizedQuery: '',
        tokens: [],
      };
    }

    let mode: SearchQueryMode = 'default';
    let workingQuery = rawQuery;

    if (workingQuery.startsWith('@')) {
      mode = 'brand';
      workingQuery = workingQuery.slice(1).trim();
    } else if (workingQuery.startsWith('/') || workingQuery.startsWith('#')) {
      mode = 'tag';
      workingQuery = workingQuery.slice(1).trim();
    }

    const normalizedQuery = this.normalizeQuery(workingQuery);
    const forcedTypes =
      mode === 'brand'
        ? (['brand'] as SearchEntityType[])
        : mode === 'tag'
          ? (['tag'] as SearchEntityType[])
          : undefined;

    return {
      rawQuery,
      mode,
      normalizedQuery,
      tokens: this.tokenize(normalizedQuery),
      forcedTypes,
    };
  }

  private clampLimit(input?: number, fallback = 20, max = 50): number {
    const parsed = Number(input || fallback);
    if (!Number.isFinite(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(1, Math.floor(parsed)));
  }

  private clampPage(input?: number): number {
    const parsed = Number(input || 1);
    if (!Number.isFinite(parsed)) {
      return 1;
    }
    return Math.max(1, Math.floor(parsed));
  }

  private resolveTypes(rawTypes?: SearchEntityType[]): SearchEntityType[] {
    if (!rawTypes || rawTypes.length === 0) {
      return ['product', 'brand', 'design', 'collection', 'tag'];
    }
    const unique = Array.from(new Set(rawTypes));
    const invalid = unique.filter((item) => !SEARCH_ENTITY_TYPES.includes(item));
    if (invalid.length > 0) {
      throw new BadRequestException(
        `Unsupported search type(s): ${invalid.join(', ')}`,
      );
    }
    return unique;
  }

  private decimalToNumber(value: Prisma.Decimal | number | string | null | undefined) {
    if (value == null) {
      return null;
    }

    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : null;
    }

    if (typeof value === 'string') {
      const parsed = Number(value);
      return Number.isFinite(parsed) ? parsed : null;
    }

    try {
      return Number(value);
    } catch {
      return null;
    }
  }

  private isRedisCircuitOpen() {
    return this.redisCircuitOpenUntil > Date.now();
  }

  private markRedisSuccess() {
    this.redisFailureCount = 0;
    this.redisCircuitOpenUntil = 0;
  }

  private markRedisFailure(error: unknown) {
    this.redisFailureCount += 1;
    if (this.redisFailureCount >= SEARCH_REDIS_CIRCUIT_FAILURE_THRESHOLD) {
      this.redisCircuitOpenUntil = Date.now() + SEARCH_REDIS_CIRCUIT_OPEN_MS;
    }
    this.logger.warn(`Search Redis degraded: ${String((error as any)?.message || error)}`);
  }

  private async withRedisBudget<T>(
    label: string,
    operation: () => Promise<T>,
    fallback: T,
  ): Promise<T> {
    if (!this.redis || this.isRedisCircuitOpen()) {
      return fallback;
    }

    let timeoutHandle: NodeJS.Timeout | null = null;
    try {
      const result = await Promise.race([
        operation(),
        new Promise<T>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            reject(new Error(`${label} timed out after ${SEARCH_REDIS_TIMEOUT_MS}ms`));
          }, SEARCH_REDIS_TIMEOUT_MS);
        }),
      ]);
      this.markRedisSuccess();
      return result;
    } catch (error) {
      this.markRedisFailure(error);
      return fallback;
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  private buildSearchCacheKey(params: {
    query: string;
    types: SearchEntityType[];
    page: number;
    limit: number;
    brandId?: string;
    versionToken: string;
  }) {
    return [
      'search:results:v3',
      params.query,
      params.types.join(','),
      params.page,
      params.limit,
      params.brandId || 'all',
      params.versionToken,
    ].join(':');
  }

  private suggestionWords(...values: Array<string | string[] | null | undefined>) {
    const tokens: string[] = [];

    for (const value of values) {
      if (Array.isArray(value)) {
        tokens.push(...this.suggestionWords(...value));
        continue;
      }

      const normalized = this.normalizeQuery(value);
      if (!normalized) {
        continue;
      }

      tokens.push(...this.tokenize(normalized));
    }

    return Array.from(new Set(tokens));
  }

  private buildDescriptionTerms(value: string | null | undefined) {
    return this.tokenize(this.normalizeQuery(value))
      .filter((token) => token.length > 2)
      .slice(0, 12);
  }

  private suggestionDocumentKey(type: SearchEntityType, id: string) {
    return `search:suggest:doc:${type}:${id}`;
  }

  private suggestionReverseKey(type: SearchEntityType, id: string) {
    return `search:suggest:entity:${type}:${id}`;
  }

  private suggestionRef(type: SearchEntityType, id: string) {
    return `${type}:${id}`;
  }

  private encodeSuggestionMember(word: string, ref: string) {
    return `${word}\u0000${ref}`;
  }

  private decodeSuggestionMember(member: string): { word: string; ref: string } | null {
    const separatorIndex = member.indexOf('\u0000');
    if (separatorIndex < 0) {
      return null;
    }

    return {
      word: member.slice(0, separatorIndex),
      ref: member.slice(separatorIndex + 1),
    };
  }

  private parseSuggestionDocument(document: string | null | undefined) {
    if (!document) {
      return null;
    }

    try {
      return JSON.parse(document) as SuggestionPayload;
    } catch {
      return null;
    }
  }

  private itemFromSuggestionPayload(payload: SuggestionPayload, query: string, tokens: string[]): SearchItem {
    return {
      id: payload.id,
      type: payload.type as SearchEntityType,
      title: payload.title,
      subtitle: payload.subtitle ?? null,
      description: payload.description ?? null,
      imageUrl: payload.imageUrl ?? null,
      href: payload.href,
      score:
        this.scoreField(payload.title, query, tokens, 10) +
        this.scoreField(payload.subtitle, query, tokens, 4) +
        this.scoreField(payload.description, query, tokens, 3),
      price: payload.price ?? null,
      salePrice: payload.salePrice ?? null,
      currency: payload.currency ?? null,
      metadata: payload.metadata,
      highlights: {
        title: this.buildHighlightOffsets(payload.title, tokens),
        description: this.buildHighlightOffsets(payload.description, tokens),
      },
    };
  }

  private createProductSuggestionPayload(row: {
    id: string;
    name: string;
    description: string | null;
    tags?: string[] | null;
    thumbnail: string | null;
    images: string[];
    price: Prisma.Decimal | number | string;
    salePrice: Prisma.Decimal | number | string | null;
    currency: string;
    slug: string | null;
    brandId: string;
    brand: { ownerId: string; name: string | null };
  }): SuggestionPayload {
    return {
      id: row.id,
      type: 'product',
      title: row.name,
      subtitle: row.brand?.name || null,
      description: row.description || null,
      imageUrl: row.thumbnail || row.images?.[0] || null,
      href: row.slug ? `/p/${row.slug}` : `/products/${row.id}`,
      price: this.decimalToNumber(row.price),
      salePrice: this.decimalToNumber(row.salePrice),
      currency: row.currency || 'NGN',
      metadata: {
        brandId: row.brandId,
        brandOwnerId: row.brand?.ownerId || null,
      },
      matchText: this.normalizeQuery(
        `${row.name} ${row.brand?.name || ''} ${(row.tags || []).join(' ')} ${row.description || ''}`,
      ),
    };
  }

  private createBrandSuggestionPayload(row: {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    tagline: string | null;
    tags?: string[] | null;
    logo: string | null;
    isStoreOpen: boolean;
  }): SuggestionPayload {
    return {
      id: row.id,
      type: 'brand',
      title: row.name,
      subtitle: row.tagline || null,
      description: row.description || null,
      imageUrl: row.logo || null,
      href: `/profile/${row.ownerId}`,
      metadata: {
        ownerId: row.ownerId,
        isStoreOpen: row.isStoreOpen,
      },
      matchText: this.normalizeQuery(
        `${row.name} ${row.tagline || ''} ${(row.tags || []).join(' ')} ${row.description || ''}`,
      ),
    };
  }

  private createDesignSuggestionPayload(row: {
    id: string;
    ownerId: string;
    title: string | null;
    description: string | null;
    tags?: string[] | null;
  }): SuggestionPayload {
    const title = row.title || 'Untitled design';
    return {
      id: row.id,
      type: 'design',
      title,
      subtitle: 'Design',
      description: row.description || null,
      href: `/collections/${row.id}`,
      metadata: {
        ownerId: row.ownerId,
      },
      matchText: this.normalizeQuery(`${title} ${(row.tags || []).join(' ')} ${row.description || ''}`),
    };
  }

  private createCollectionSuggestionPayload(row: {
    id: string;
    ownerId: string;
    title: string | null;
    description: string | null;
    tags?: string[] | null;
  }): SuggestionPayload {
    const title = row.title || 'Untitled collection';
    return {
      id: row.id,
      type: 'collection',
      title,
      subtitle: 'Store Collection',
      description: row.description || null,
      href: `/collections/${row.id}`,
      metadata: {
        ownerId: row.ownerId,
      },
      matchText: this.normalizeQuery(`${title} ${(row.tags || []).join(' ')} ${row.description || ''}`),
    };
  }

  private createTagSuggestionPayload(tag: { id: string; normalizedName: string; usageCount: number }) {
    return {
      id: tag.id,
      type: 'tag' as const,
      title: tag.normalizedName,
      href: `/search?q=${encodeURIComponent(tag.normalizedName)}&type=tag`,
      score: Math.max(1, tag.usageCount || 0),
    };
  }

  private async resolveBrandOwnerId(brandId?: string) {
    if (!brandId) {
      return undefined;
    }

    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });

    return brand?.ownerId;
  }

  private buildHighlightOffsets(value: string | null | undefined, tokens: string[]) {
    if (!value) {
      return undefined;
    }

    const lowerValue = value.toLowerCase();
    const offsets: Array<{ start: number; end: number }> = [];

    for (const token of tokens) {
      const index = lowerValue.indexOf(token.toLowerCase());
      if (index >= 0) {
        offsets.push({ start: index, end: index + token.length });
      }
      if (offsets.length >= 3) {
        break;
      }
    }

    return offsets.length > 0 ? offsets : undefined;
  }

  private scoreField(
    value: string | null | undefined,
    query: string,
    tokens: string[],
    weight: number,
  ): number {
    if (!value) {
      return 0;
    }

    const normalizedValue = this.normalizeQuery(value);
    if (!normalizedValue) {
      return 0;
    }

    let score = 0;
    if (normalizedValue === query) {
      score += weight * 9;
    } else if (normalizedValue.startsWith(query)) {
      score += weight * 6;
    } else if (normalizedValue.includes(query)) {
      score += weight * 3;
    }

    for (const token of tokens) {
      if (normalizedValue === token) {
        score += weight * 5;
      } else if (normalizedValue.startsWith(token)) {
        score += weight * 2;
      } else if (normalizedValue.includes(token)) {
        score += weight;
      }
    }

    return score;
  }

  private scoreTagArray(tags: string[] | null | undefined, tokens: string[], weight: number): number {
    if (!Array.isArray(tags) || tags.length === 0) {
      return 0;
    }

    let score = 0;
    const normalizedTags = tags.map((tag) => this.normalizeQuery(tag));
    for (const token of tokens) {
      if (normalizedTags.some((tag) => tag === token)) {
        score += weight * 3;
      } else if (normalizedTags.some((tag) => tag.includes(token))) {
        score += weight;
      }
    }
    return score;
  }

  private productWhere(query: string, tokens: string[], brandId?: string): Prisma.ProductWhereInput {
    const orClauses: Prisma.ProductWhereInput[] = [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { brand: { name: { contains: query, mode: 'insensitive' } } },
    ];

    if (tokens.length > 0) {
      orClauses.push({ tags: { hasSome: tokens } });
    }

    return {
      brandId,
      isActive: true,
      deletedAt: null,
      archivedAt: null,
      brand: { isStoreOpen: true },
      OR: orClauses,
    };
  }

  private brandWhere(query: string, tokens: string[]): Prisma.BrandWhereInput {
    const orClauses: Prisma.BrandWhereInput[] = [
      { name: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
      { tagline: { contains: query, mode: 'insensitive' } },
    ];

    if (tokens.length > 0) {
      orClauses.push({ tags: { hasSome: tokens } });
    }

    return {
      isStoreOpen: true,
      OR: orClauses,
    };
  }

  private designWhere(query: string, tokens: string[]): Prisma.CollectionWhereInput {
    const orClauses: Prisma.CollectionWhereInput[] = [
      { title: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
    ];

    if (tokens.length > 0) {
      orClauses.push({ tags: { hasSome: tokens } });
    }

    return {
      domain: CollectionDomain.DESIGN,
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
      OR: orClauses,
    };
  }

  private collectionWhere(query: string, tokens: string[], ownerId?: string): Prisma.StoreCollectionWhereInput {
    const orClauses: Prisma.StoreCollectionWhereInput[] = [
      { title: { contains: query, mode: 'insensitive' } },
      { description: { contains: query, mode: 'insensitive' } },
    ];

    if (tokens.length > 0) {
      orClauses.push({ tags: { hasSome: tokens } });
    }

    return {
      ownerId,
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
      OR: orClauses,
    };
  }

  private productToItem(product: any, query: string, tokens: string[]): SearchItem {
    const score =
      this.scoreField(product.name, query, tokens, 10) +
      this.scoreField(product.brand?.name, query, tokens, 5) +
      this.scoreField(product.description, query, tokens, 4) +
      this.scoreTagArray(product.tags, tokens, 4) +
      Math.min(10, Math.log10((Number(product.viewsCount) || 0) + 1));

    return {
      id: product.id,
      type: 'product',
      title: product.name,
      subtitle: product.brand?.name || null,
      description: product.description || null,
      imageUrl: product.thumbnail || product.images?.[0] || null,
      href: product.slug ? `/p/${product.slug}` : `/products/${product.id}`,
      score,
      price: product.price != null ? Number(product.price) : null,
      salePrice: product.salePrice != null ? Number(product.salePrice) : null,
      currency: product.currency || 'NGN',
      metadata: {
        brandId: product.brandId,
        brandOwnerId: product.brand?.ownerId || null,
      },
      highlights: {
        title: this.buildHighlightOffsets(product.name, tokens),
        description: this.buildHighlightOffsets(product.description, tokens),
      },
    };
  }

  private brandToItem(brand: any, query: string, tokens: string[]): SearchItem {
    const score =
      this.scoreField(brand.name, query, tokens, 10) +
      this.scoreField(brand.tagline, query, tokens, 4) +
      this.scoreField(brand.description, query, tokens, 3) +
      this.scoreTagArray(brand.tags, tokens, 3);

    return {
      id: brand.id,
      type: 'brand',
      title: brand.name,
      subtitle: brand.tagline || null,
      description: brand.description || null,
      imageUrl: brand.logo || null,
      href: `/profile/${brand.ownerId}`,
      score,
      metadata: {
        ownerId: brand.ownerId,
        isStoreOpen: brand.isStoreOpen,
      },
      highlights: {
        title: this.buildHighlightOffsets(brand.name, tokens),
        description: this.buildHighlightOffsets(brand.description, tokens),
      },
    };
  }

  private designToItem(collection: any, query: string, tokens: string[]): SearchItem {
    const score =
      this.scoreField(collection.title, query, tokens, 10) +
      this.scoreField(collection.description, query, tokens, 4) +
      this.scoreTagArray(collection.tags, tokens, 4) +
      Math.min(8, Math.log10((Number(collection.viewsCount) || 0) + 1));

    return {
      id: collection.id,
      type: 'design',
      title: collection.title || 'Untitled design',
      subtitle: 'Design',
      description: collection.description || null,
      imageUrl: null,
      href: `/collections/${collection.id}`,
      score,
      metadata: {
        ownerId: collection.ownerId,
      },
      highlights: {
        title: this.buildHighlightOffsets(collection.title, tokens),
        description: this.buildHighlightOffsets(collection.description, tokens),
      },
    };
  }

  private collectionToItem(collection: any, query: string, tokens: string[]): SearchItem {
    const score =
      this.scoreField(collection.title, query, tokens, 10) +
      this.scoreField(collection.description, query, tokens, 4) +
      this.scoreTagArray(collection.tags, tokens, 4) +
      Math.min(8, Math.log10((Number(collection.viewsCount) || 0) + 1));

    return {
      id: collection.id,
      type: 'collection',
      title: collection.title || 'Untitled collection',
      subtitle: 'Store Collection',
      description: collection.description || null,
      imageUrl: null,
      href: `/collections/${collection.id}`,
      score,
      metadata: {
        ownerId: collection.ownerId,
      },
      highlights: {
        title: this.buildHighlightOffsets(collection.title, tokens),
        description: this.buildHighlightOffsets(collection.description, tokens),
      },
    };
  }

  private tagToItem(tag: { tag: string; count: number }, query: string, tokens: string[]): SearchItem {
    const score = this.scoreField(tag.tag, query, tokens, 8) + Math.min(6, Math.log10((tag.count || 0) + 1));
    return {
      id: tag.tag,
      type: 'tag',
      title: tag.tag,
      subtitle: `${tag.count} uses`,
      description: null,
      imageUrl: null,
      href: `/search?q=${encodeURIComponent(tag.tag)}&type=tag`,
      score,
      metadata: { usageCount: tag.count },
      highlights: {
        title: this.buildHighlightOffsets(tag.tag, tokens),
      },
    };
  }

  private async getRecentSearches(userId?: string, prefix?: string) {
    if (!userId) {
      return [] as Array<{ query: string; href: string }>;
    }

    const rows = await this.withRedisBudget(
      'LRANGE recent',
      () => this.redis!.lRange(`search:recent:${userId}`, 0, RECENT_LIMIT - 1),
      [] as string[],
    );

    return rows
      .filter((row) => (prefix ? row.startsWith(prefix) : true))
      .slice(0, 5)
      .map((row) => ({
        query: row,
        href: `/search?q=${encodeURIComponent(row)}`,
      }));
  }

  private async getTrendingSearches() {
    if (!this.redis) {
      return [] as Array<{ query: string; score: number; href: string }>;
    }

    const bucketKeys = this.getTrendingBucketKeys();
    const buckets = await Promise.all(
      bucketKeys.map((key) =>
        this.withRedisBudget(
          `HGETALL ${key}`,
          () => this.redis!.hGetAll(key),
          {} as Record<string, string>,
        ),
      ),
    );

    const counts = new Map<string, number>();
    for (const bucket of buckets) {
      for (const [query, rawScore] of Object.entries(bucket)) {
        counts.set(query, (counts.get(query) || 0) + Number(rawScore || 0));
      }
    }

    return Array.from(counts.entries())
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, TRENDING_LIMIT)
      .map(([query, score]) => ({
        query,
        score,
        href: `/search?q=${encodeURIComponent(query)}`,
      }));
  }

  private getTrendingBucketKeys() {
    const keys: string[] = [];
    const now = new Date();

    for (let offset = 0; offset < 24; offset += 1) {
      const bucket = new Date(now.getTime() - offset * 60 * 60 * 1000);
      const year = bucket.getUTCFullYear();
      const month = String(bucket.getUTCMonth() + 1).padStart(2, '0');
      const day = String(bucket.getUTCDate()).padStart(2, '0');
      const hour = String(bucket.getUTCHours()).padStart(2, '0');
      keys.push(`search:trending:bucket:${year}${month}${day}${hour}`);
    }

    return keys;
  }

  private async getCachedSearchResult(key: string) {
    const cached = await this.withRedisBudget(
      `GET ${key}`,
      () => this.redis!.get(key),
      null as string | null,
    );

    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached) as SearchResponse;
    } catch {
      return null;
    }
  }

  private async setCachedSearchResult(key: string, value: SearchResponse) {
    await this.withRedisBudget(
      `SET ${key}`,
      () =>
        this.redis!.set(key, JSON.stringify(value), {
          EX: SEARCH_CACHE_TTL_SECONDS,
        }),
      null,
    );
  }

  private async recordSearch(userId: string | undefined, query: string) {
    const normalizedQuery = this.normalizeQuery(query);
    if (!normalizedQuery) {
      return;
    }

    const bucketKey = this.getTrendingBucketKeys()[0];
    await this.withRedisBudget(
      'MULTI search activity',
      async () => {
        const pipeline = this.redis!.multi();
        if (userId) {
          pipeline.lRem(`search:recent:${userId}`, 0, normalizedQuery);
          pipeline.lPush(`search:recent:${userId}`, normalizedQuery);
          pipeline.lTrim(`search:recent:${userId}`, 0, RECENT_LIMIT - 1);
          pipeline.expire(`search:recent:${userId}`, 60 * 60 * 24 * 90);
        }
        pipeline.hIncrBy(bucketKey, normalizedQuery, 1);
        pipeline.expire(bucketKey, 60 * 60 * 27);
        await pipeline.exec();
        return true;
      },
      false,
    );
  }

  private async getSearchCacheVersionToken(types: SearchEntityType[]) {
    const versionKeys = [
      SEARCH_RESULT_CACHE_ALL_VERSION_KEY,
      ...Array.from(new Set(types)).map((type) => SEARCH_RESULT_CACHE_VERSION_KEYS[type]),
    ];

    const versions = await this.withRedisBudget(
      'MGET search cache versions',
      () => this.redis!.mGet(versionKeys),
      versionKeys.map(() => null as string | null),
    );

    return versions
      .map((value) => {
        const parsed = Number(value || 0);
        return Number.isFinite(parsed) ? parsed : 0;
      })
      .join('.');
  }

  private async invalidateSearchCaches(types: SearchEntityType[]) {
    if (!this.redis) {
      return;
    }

    const versionKeys = Array.from(
      new Set([
        SEARCH_RESULT_CACHE_ALL_VERSION_KEY,
        ...types.map((type) => SEARCH_RESULT_CACHE_VERSION_KEYS[type]),
      ]),
    );

    await this.withRedisBudget(
      'INCR search cache versions',
      async () => {
        const pipeline = this.redis!.multi();
        for (const key of versionKeys) {
          pipeline.incr(key);
        }
        await pipeline.exec();
        return true;
      },
      false,
    );
  }

  private async zRangeByPrefix(key: string, prefix: string, offset: number, count: number) {
    return this.withRedisBudget(
      `ZRANGEBYLEX ${key}`,
      () =>
        this.redis!.sendCommand<string[]>([
          'ZRANGEBYLEX',
          key,
          `[${prefix}`,
          `[${prefix}\xff`,
          'LIMIT',
          String(offset),
          String(count),
        ]),
      [],
    );
  }

  private async getSuggestionDocuments(refs: string[]) {
    if (refs.length === 0) {
      return new Map<string, SuggestionPayload>();
    }

    const documentKeys = refs.map((ref) => {
      const [type, ...idParts] = ref.split(':');
      return this.suggestionDocumentKey(type as SearchEntityType, idParts.join(':'));
    });

    const documents = await this.withRedisBudget(
      'MGET suggestion docs',
      () => this.redis!.mGet(documentKeys),
      refs.map(() => null as string | null),
    );

    const parsed = new Map<string, SuggestionPayload>();
    refs.forEach((ref, index) => {
      const payload = this.parseSuggestionDocument(documents[index]);
      if (payload) {
        parsed.set(ref, payload);
      }
    });

    return parsed;
  }

  private async fetchSuggestionItems(
    key: string,
    normalizedQuery: string,
    limit: number,
    filter?: (payload: SuggestionPayload) => boolean,
  ) {
    const tokens = this.tokenize(normalizedQuery);
    const prefix = tokens[tokens.length - 1];
    const requiredTokens = tokens.slice(0, -1);
    const items: SearchItem[] = [];
    const seenRefs = new Set<string>();
    let offset = 0;

    while (items.length < limit && offset < SEARCH_SUGGEST_SCAN_CAP) {
      const batch = await this.zRangeByPrefix(
        key,
        prefix,
        offset,
        SEARCH_SUGGEST_SCAN_BATCH,
      );

      if (batch.length === 0) {
        break;
      }

      const refs = batch
        .map((member) => this.decodeSuggestionMember(member))
        .filter((entry): entry is { word: string; ref: string } => Boolean(entry))
        .map((entry) => entry.ref)
        .filter((ref) => {
          if (seenRefs.has(ref)) {
            return false;
          }
          seenRefs.add(ref);
          return true;
        });

      const documents = await this.getSuggestionDocuments(refs);

      for (const ref of refs) {
        const payload = documents.get(ref);
        if (!payload) {
          continue;
        }
        if (!requiredTokens.every((token) => payload.matchText.includes(token))) {
          continue;
        }
        if (filter && !filter(payload)) {
          continue;
        }

        items.push(this.itemFromSuggestionPayload(payload, normalizedQuery, tokens));
        if (items.length >= limit) {
          break;
        }
      }

      offset += batch.length;
      if (batch.length < SEARCH_SUGGEST_SCAN_BATCH) {
        break;
      }
    }

    return items;
  }

  private async getSearchResultCount(sql: Prisma.Sql) {
    const rows = await this.prisma.$queryRaw<Array<{ total: bigint | number }>>(sql);
    return Number(rows?.[0]?.total ?? 0);
  }

  private async searchProductsPage(
    query: string,
    tokens: string[],
    limit: number,
    offset: number,
    brandId?: string,
  ): Promise<SearchPageResult> {
    const brandFilter = brandId
      ? Prisma.sql`AND p."brandId" = ${brandId}`
      : Prisma.empty;
    const prodIlikePat = `%${query}%`;

    const rows = await this.prisma.$queryRaw<ProductSearchRow[]>(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT
          p."_id" AS id,
          p.name,
          p.description,
          p.thumbnail,
          p.images,
          p.price,
          p."salePrice" AS "salePrice",
          p.currency,
          p.slug,
          p."brandId" AS "brandId",
          b.name AS "brandName",
          b."ownerId" AS "brandOwnerId",
          ts_rank_cd(COALESCE(p.search_vector, ''::tsvector), sp.tsq) * 100
            + LEAST(10, LN(GREATEST(p."viewsCount", 0) + 1)) AS score,
          0 AS source_rank
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        CROSS JOIN search_params sp
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND COALESCE(p.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT
          p."_id" AS id,
          p.name,
          p.description,
          p.thumbnail,
          p.images,
          p.price,
          p."salePrice" AS "salePrice",
          p.currency,
          p.slug,
          p."brandId" AS "brandId",
          b.name AS "brandName",
          b."ownerId" AS "brandOwnerId",
          GREATEST(
            similarity(immutable_unaccent(COALESCE(p.name, '')), sp.normalized_query),
            similarity(immutable_unaccent(COALESCE(p."brandNameCache", '')), sp.normalized_query)
          ) * 100
            + LEAST(10, LN(GREATEST(p."viewsCount", 0) + 1)) AS score,
          1 AS source_rank
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        CROSS JOIN search_params sp
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = p."_id")
          AND GREATEST(
            similarity(immutable_unaccent(COALESCE(p.name, '')), sp.normalized_query),
            similarity(immutable_unaccent(COALESCE(p."brandNameCache", '')), sp.normalized_query)
          ) >= ${SEARCH_SIMILARITY_THRESHOLD}
      ),
      ilike_fallback AS (
        SELECT
          p."_id" AS id,
          p.name,
          p.description,
          p.thumbnail,
          p.images,
          p.price,
          p."salePrice" AS "salePrice",
          p.currency,
          p.slug,
          p."brandId" AS "brandId",
          b.name AS "brandName",
          b."ownerId" AS "brandOwnerId",
          LEAST(10, LN(GREATEST(p."viewsCount", 0) + 1)) + 1 AS score,
          2 AS source_rank
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = p."_id")
          AND NOT EXISTS (SELECT 1 FROM trgm WHERE trgm.id = p."_id")
          AND (
            immutable_unaccent(COALESCE(p.name, '')) ILIKE immutable_unaccent(${prodIlikePat})
            OR immutable_unaccent(COALESCE(p.description, '')) ILIKE immutable_unaccent(${prodIlikePat})
            OR immutable_unaccent(COALESCE(p."brandNameCache", '')) ILIKE immutable_unaccent(${prodIlikePat})
          )
      )
      SELECT id, name, description, thumbnail, images, price, "salePrice", currency, slug, "brandId", "brandName", "brandOwnerId", score
      FROM (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM trgm
        UNION ALL
        SELECT * FROM ilike_fallback
      ) ranked
      ORDER BY source_rank ASC, score DESC, id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = await this.getSearchResultCount(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT p."_id" AS id
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        CROSS JOIN search_params sp
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND COALESCE(p.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT p."_id" AS id
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        CROSS JOIN search_params sp
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = p."_id")
          AND GREATEST(
            similarity(immutable_unaccent(COALESCE(p.name, '')), sp.normalized_query),
            similarity(immutable_unaccent(COALESCE(p."brandNameCache", '')), sp.normalized_query)
          ) >= ${SEARCH_SIMILARITY_THRESHOLD}
      ),
      ilike_fallback AS (
        SELECT p."_id" AS id
        FROM "Product" p
        INNER JOIN "Brand" b ON b."_id" = p."brandId"
        WHERE p."isActive" = true
          AND p."deletedAt" IS NULL
          AND p."archivedAt" IS NULL
          AND b."isStoreOpen" = true
          ${brandFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = p."_id")
          AND NOT EXISTS (SELECT 1 FROM trgm WHERE trgm.id = p."_id")
          AND (
            immutable_unaccent(COALESCE(p.name, '')) ILIKE immutable_unaccent(${prodIlikePat})
            OR immutable_unaccent(COALESCE(p.description, '')) ILIKE immutable_unaccent(${prodIlikePat})
            OR immutable_unaccent(COALESCE(p."brandNameCache", '')) ILIKE immutable_unaccent(${prodIlikePat})
          )
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
        UNION ALL
        SELECT id FROM ilike_fallback
      ) ranked
    `);

    return {
      items: rows.map((row) =>
        this.productToItem(
          {
            id: row.id,
            name: row.name,
            description: row.description,
            thumbnail: row.thumbnail,
            images: row.images || [],
            price: row.price,
            salePrice: row.salePrice,
            currency: row.currency,
            slug: row.slug,
            brandId: row.brandId,
            brand: {
              name: row.brandName,
              ownerId: row.brandOwnerId,
            },
            viewsCount: 0,
            tags: [],
          },
          query,
          tokens,
        ),
      ),
      total,
    };
  }

  private async searchBrandsPage(query: string, tokens: string[], limit: number, offset: number): Promise<SearchPageResult> {
    const rows = await this.prisma.$queryRaw<BrandSearchRow[]>(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT
          b."_id" AS id,
          b."ownerId" AS "ownerId",
          b.name,
          b.description,
          b.tagline,
          b.logo,
          b."isStoreOpen" AS "isStoreOpen",
          ts_rank_cd(COALESCE(b.search_vector, ''::tsvector), sp.tsq) * 100 AS score,
          0 AS source_rank
        FROM "Brand" b
        CROSS JOIN search_params sp
        WHERE b."isStoreOpen" = true
          AND COALESCE(b.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT
          b."_id" AS id,
          b."ownerId" AS "ownerId",
          b.name,
          b.description,
          b.tagline,
          b.logo,
          b."isStoreOpen" AS "isStoreOpen",
          similarity(immutable_unaccent(COALESCE(b.name, '')), sp.normalized_query) * 100 AS score,
          1 AS source_rank
        FROM "Brand" b
        CROSS JOIN search_params sp
        WHERE b."isStoreOpen" = true
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = b."_id")
          AND similarity(immutable_unaccent(COALESCE(b.name, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      )
      SELECT id, "ownerId", name, description, tagline, logo, "isStoreOpen", score
      FROM (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM trgm
      ) ranked
      ORDER BY source_rank ASC, score DESC, id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = await this.getSearchResultCount(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT b."_id" AS id
        FROM "Brand" b
        CROSS JOIN search_params sp
        WHERE b."isStoreOpen" = true
          AND COALESCE(b.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT b."_id" AS id
        FROM "Brand" b
        CROSS JOIN search_params sp
        WHERE b."isStoreOpen" = true
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = b."_id")
          AND similarity(immutable_unaccent(COALESCE(b.name, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
      ) ranked
    `);

    return {
      items: rows.map((row) => this.brandToItem(row, query, tokens)),
      total,
    };
  }

  private async searchDesignsPage(query: string, tokens: string[], limit: number, offset: number): Promise<SearchPageResult> {
    const ilikePat = `%${query}%`;
    const rows = await this.prisma.$queryRaw<CollectionSearchRow[]>(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT
          c."_id" AS id,
          c."ownerId" AS "ownerId",
          c.title,
          c.description,
          c."viewsCount" AS "viewsCount",
          ts_rank_cd(COALESCE(c.search_vector, ''::tsvector), sp.tsq) * 100
            + LEAST(8, LN(GREATEST(c."viewsCount", 0) + 1)) AS score,
          0 AS source_rank
        FROM "Collection" c
        CROSS JOIN search_params sp
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND COALESCE(c.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT
          c."_id" AS id,
          c."ownerId" AS "ownerId",
          c.title,
          c.description,
          c."viewsCount" AS "viewsCount",
          similarity(immutable_unaccent(COALESCE(c.title, '')), sp.normalized_query) * 100
            + LEAST(8, LN(GREATEST(c."viewsCount", 0) + 1)) AS score,
          1 AS source_rank
        FROM "Collection" c
        CROSS JOIN search_params sp
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = c."_id")
          AND similarity(immutable_unaccent(COALESCE(c.title, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      ),
      ilike_fallback AS (
        SELECT
          c."_id" AS id,
          c."ownerId" AS "ownerId",
          c.title,
          c.description,
          c."viewsCount" AS "viewsCount",
          LEAST(8, LN(GREATEST(c."viewsCount", 0) + 1)) + 1 AS score,
          2 AS source_rank
        FROM "Collection" c
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = c."_id")
          AND NOT EXISTS (SELECT 1 FROM trgm WHERE trgm.id = c."_id")
          AND (
            immutable_unaccent(COALESCE(c.title, '')) ILIKE immutable_unaccent(${ilikePat})
            OR immutable_unaccent(COALESCE(c.description, '')) ILIKE immutable_unaccent(${ilikePat})
          )
      )
      SELECT id, "ownerId", title, description, "viewsCount", score
      FROM (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM trgm
        UNION ALL
        SELECT * FROM ilike_fallback
      ) ranked
      ORDER BY source_rank ASC, score DESC, id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = await this.getSearchResultCount(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT c."_id" AS id
        FROM "Collection" c
        CROSS JOIN search_params sp
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND COALESCE(c.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT c."_id" AS id
        FROM "Collection" c
        CROSS JOIN search_params sp
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = c."_id")
          AND similarity(immutable_unaccent(COALESCE(c.title, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      ),
      ilike_fallback AS (
        SELECT c."_id" AS id
        FROM "Collection" c
        WHERE c.domain = ${CollectionDomain.DESIGN}
          AND c.status = ${CollectionStatus.PUBLISHED}
          AND c.visibility = ${CollectionVisibility.PUBLIC}
          AND c."deletedAt" IS NULL
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = c."_id")
          AND NOT EXISTS (SELECT 1 FROM trgm WHERE trgm.id = c."_id")
          AND (
            immutable_unaccent(COALESCE(c.title, '')) ILIKE immutable_unaccent(${ilikePat})
            OR immutable_unaccent(COALESCE(c.description, '')) ILIKE immutable_unaccent(${ilikePat})
          )
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
        UNION ALL
        SELECT id FROM ilike_fallback
      ) ranked
    `);

    return {
      items: rows.map((row) => this.designToItem(row, query, tokens)),
      total,
    };
  }

  private async searchCollectionsPage(
    query: string,
    tokens: string[],
    limit: number,
    offset: number,
    ownerId?: string,
  ): Promise<SearchPageResult> {
    const ownerFilter = ownerId
      ? Prisma.sql`AND sc."ownerId" = ${ownerId}`
      : Prisma.empty;

    const rows = await this.prisma.$queryRaw<CollectionSearchRow[]>(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT
          sc."_id" AS id,
          sc."ownerId" AS "ownerId",
          sc.title,
          sc.description,
          sc."viewsCount" AS "viewsCount",
          ts_rank_cd(COALESCE(sc.search_vector, ''::tsvector), sp.tsq) * 100
            + LEAST(8, LN(GREATEST(sc."viewsCount", 0) + 1)) AS score,
          0 AS source_rank
        FROM "StoreCollection" sc
        CROSS JOIN search_params sp
        WHERE sc.status = ${CollectionStatus.PUBLISHED}
          AND sc.visibility = ${CollectionVisibility.PUBLIC}
          AND sc."deletedAt" IS NULL
          ${ownerFilter}
          AND COALESCE(sc.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT
          sc."_id" AS id,
          sc."ownerId" AS "ownerId",
          sc.title,
          sc.description,
          sc."viewsCount" AS "viewsCount",
          similarity(immutable_unaccent(COALESCE(sc.title, '')), sp.normalized_query) * 100
            + LEAST(8, LN(GREATEST(sc."viewsCount", 0) + 1)) AS score,
          1 AS source_rank
        FROM "StoreCollection" sc
        CROSS JOIN search_params sp
        WHERE sc.status = ${CollectionStatus.PUBLISHED}
          AND sc.visibility = ${CollectionVisibility.PUBLIC}
          AND sc."deletedAt" IS NULL
          ${ownerFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = sc."_id")
          AND similarity(immutable_unaccent(COALESCE(sc.title, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      )
      SELECT id, "ownerId", title, description, "viewsCount", score
      FROM (
        SELECT * FROM fts
        UNION ALL
        SELECT * FROM trgm
      ) ranked
      ORDER BY source_rank ASC, score DESC, id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    const total = await this.getSearchResultCount(Prisma.sql`
      WITH search_params AS (
        SELECT
          websearch_to_tsquery('english', immutable_unaccent(${query})) AS tsq,
          immutable_unaccent(${query}) AS normalized_query
      ),
      fts AS (
        SELECT sc."_id" AS id
        FROM "StoreCollection" sc
        CROSS JOIN search_params sp
        WHERE sc.status = ${CollectionStatus.PUBLISHED}
          AND sc.visibility = ${CollectionVisibility.PUBLIC}
          AND sc."deletedAt" IS NULL
          ${ownerFilter}
          AND COALESCE(sc.search_vector, ''::tsvector) @@ sp.tsq
      ),
      trgm AS (
        SELECT sc."_id" AS id
        FROM "StoreCollection" sc
        CROSS JOIN search_params sp
        WHERE sc.status = ${CollectionStatus.PUBLISHED}
          AND sc.visibility = ${CollectionVisibility.PUBLIC}
          AND sc."deletedAt" IS NULL
          ${ownerFilter}
          AND NOT EXISTS (SELECT 1 FROM fts WHERE fts.id = sc."_id")
          AND similarity(immutable_unaccent(COALESCE(sc.title, '')), sp.normalized_query) >= ${SEARCH_SIMILARITY_THRESHOLD}
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
      ) ranked
    `);

    return {
      items: rows.map((row) => this.collectionToItem(row, query, tokens)),
      total,
    };
  }

  private async searchTagsPage(query: string, tokens: string[], limit: number, offset: number): Promise<SearchPageResult> {
    const total = await this.prisma.tag.count({
      where: {
        normalizedName: { startsWith: query },
        isBanned: false,
        aliasOfTagId: null,
      },
    });

    const rows = await this.prisma.tag.findMany({
      where: {
        normalizedName: { startsWith: query },
        isBanned: false,
        aliasOfTagId: null,
      },
      orderBy: [
        { usageCount: 'desc' },
        { lastUsedAt: 'desc' },
        { normalizedName: 'asc' },
      ],
      take: limit,
      skip: offset,
      select: {
        normalizedName: true,
        usageCount: true,
      },
    });

    return {
      items: rows.map((row) => this.tagToItem({ tag: row.normalizedName, count: row.usageCount }, query, tokens)),
      total,
    };
  }

  private emptyCounts(): Record<SearchEntityType, number> {
    return {
      product: 0,
      brand: 0,
      design: 0,
      collection: 0,
      tag: 0,
    };
  }

  private scheduleSearchSync(task: () => Promise<void>) {
    void task().catch((error: any) => {
      this.logger.warn(`Search sync failed: ${error?.message || error}`);
    });
  }

  private async dispatchSearchSyncJob(job: SearchSyncJob) {
    if (this.searchQueue) {
      await this.searchQueue.enqueueSync(job);
      return;
    }

    this.scheduleSearchSync(() => this.processSearchSyncJob(job));
  }

  async processSearchSyncJob(job: SearchSyncJob) {
    switch (job.target) {
      case 'product':
        await this.invalidateSearchCaches(['product']);
        if (job.mode === 'entity' && job.id) {
          await this.syncProductSuggestionById(job.id);
        } else {
          await this.rebuildProductSuggestions();
        }
        return;
      case 'brand':
        await this.invalidateSearchCaches(['brand', 'product']);
        if (job.mode === 'entity' && job.id) {
          await Promise.all([
            this.syncBrandSuggestionById(job.id),
            this.syncProductsForBrand(job.id),
          ]);
        } else {
          await Promise.all([
            this.rebuildBrandSuggestions(),
            this.rebuildProductSuggestions(),
          ]);
        }
        return;
      case 'design':
        await this.invalidateSearchCaches(['design']);
        if (job.mode === 'entity' && job.id) {
          await this.syncDesignSuggestionById(job.id);
        } else {
          await this.rebuildDesignSuggestions();
        }
        return;
      case 'collection':
        await this.invalidateSearchCaches(['collection']);
        if (job.mode === 'entity' && job.id) {
          await this.syncStoreCollectionSuggestionById(job.id);
        } else {
          await this.rebuildStoreCollectionSuggestions();
        }
        return;
      case 'tag':
        await this.invalidateSearchCaches(['tag']);
        if (job.mode === 'entity' && job.id) {
          await this.syncTagSuggestionById(job.id);
        } else {
          await this.rebuildTagSuggestions();
        }
        return;
      default:
        return;
    }
  }

  private logSearchEvent(event: 'search' | 'suggest', payload: Record<string, unknown>) {
    this.logger.log(
      JSON.stringify({
        event: `search.${event}`,
        ...payload,
      }),
    );
  }

  private registerPrismaSearchHooks() {
    if (this.prismaSearchHooksRegistered) {
      return;
    }

    const prismaWithMiddleware = this.prisma as PrismaService & {
      $use?: (middleware: (params: any, next: (params: any) => Promise<any>) => Promise<any>) => void;
    };

    if (typeof prismaWithMiddleware.$use !== 'function') {
      this.logger.warn('Prisma middleware is unavailable; search cache invalidation falls back to recovery rebuilds.');
      return;
    }

    prismaWithMiddleware.$use(async (params: any, next: (args: any) => Promise<any>) => {
      const result = await next(params);
      this.handlePrismaMutation(params, result);
      return result;
    });

    this.prismaSearchHooksRegistered = true;
  }

  private extractMutationId(
    params: any,
    result: Record<string, unknown> | null | undefined,
  ) {
    const resultId = typeof result?.id === 'string' ? result.id : undefined;
    if (resultId) {
      return resultId;
    }

    const where = params.args?.where as { id?: string } | undefined;
    return typeof where?.id === 'string' ? where.id : undefined;
  }

  private handlePrismaMutation(params: any, result: unknown) {
    const action = params.action;
    const isSingleMutation = ['create', 'update', 'upsert', 'delete'].includes(action);
    const isBulkMutation = ['createMany', 'updateMany', 'deleteMany'].includes(action);
    if (!isSingleMutation && !isBulkMutation) {
      return;
    }

    const entity = result && typeof result === 'object' ? (result as Record<string, unknown>) : null;
    const id = this.extractMutationId(params, entity);

    switch (params.model) {
      case 'Product':
        void this.dispatchSearchSyncJob({
          target: 'product',
          mode: id ? 'entity' : 'rebuild',
          id,
          reason: `${params.model}.${action}`,
        });
        break;
      case 'Brand':
        void this.dispatchSearchSyncJob({
          target: 'brand',
          mode: id ? 'entity' : 'rebuild',
          id,
          reason: `${params.model}.${action}`,
        });
        break;
      case 'Collection':
        void this.dispatchSearchSyncJob({
          target: 'design',
          mode: id ? 'entity' : 'rebuild',
          id,
          reason: `${params.model}.${action}`,
        });
        break;
      case 'StoreCollection':
        void this.dispatchSearchSyncJob({
          target: 'collection',
          mode: id ? 'entity' : 'rebuild',
          id,
          reason: `${params.model}.${action}`,
        });
        break;
      case 'Tag':
        void this.dispatchSearchSyncJob({
          target: 'tag',
          mode: id ? 'entity' : 'rebuild',
          id,
          reason: `${params.model}.${action}`,
        });
        break;
      default:
        break;
    }
  }

  private async clearSuggestionNamespace() {
    if (!this.redis) {
      return;
    }

    const keys: string[] = [];
    for await (const key of this.redis.scanIterator({ MATCH: 'search:suggest:*', COUNT: 200 })) {
      keys.push(String(key));
    }

    if (keys.length === 0) {
      return;
    }

    await this.withRedisBudget('DEL suggestion namespace', () => this.redis!.del(keys), 0);
  }

  private async upsertSuggestion(
    type: SearchEntityType,
    indexKey: string,
    payload: SuggestionPayload,
    searchTerms: string[],
  ) {
    if (!this.redis) {
      return;
    }

    const ref = this.suggestionRef(type, payload.id);
    const reverseKey = this.suggestionReverseKey(type, payload.id);
    const existingTokens = await this.withRedisBudget(
      `SMEMBERS ${reverseKey}`,
      () => this.redis!.sMembers(reverseKey),
      [] as string[],
    );

    await this.withRedisBudget(
      `MULTI upsert ${ref}`,
      async () => {
        const pipeline = this.redis!.multi();
        if (existingTokens.length > 0) {
          pipeline.zRem(indexKey, existingTokens.map((token) => this.encodeSuggestionMember(token, ref)));
        }
        pipeline.del(reverseKey);
        pipeline.set(this.suggestionDocumentKey(type, payload.id), JSON.stringify(payload));
        if (searchTerms.length > 0) {
          pipeline.sAdd(reverseKey, searchTerms);
          pipeline.zAdd(
            indexKey,
            searchTerms.map((token) => ({
              score: 0,
              value: this.encodeSuggestionMember(token, ref),
            })),
          );
        }
        await pipeline.exec();
        return true;
      },
      false,
    );
  }

  private async removeSuggestion(type: SearchEntityType, indexKey: string, id: string) {
    if (!this.redis) {
      return;
    }

    const ref = this.suggestionRef(type, id);
    const reverseKey = this.suggestionReverseKey(type, id);
    const existingTokens = await this.withRedisBudget(
      `SMEMBERS ${reverseKey}`,
      () => this.redis!.sMembers(reverseKey),
      [] as string[],
    );

    await this.withRedisBudget(
      `MULTI delete ${ref}`,
      async () => {
        const pipeline = this.redis!.multi();
        if (existingTokens.length > 0) {
          pipeline.zRem(indexKey, existingTokens.map((token) => this.encodeSuggestionMember(token, ref)));
        }
        pipeline.del(reverseKey);
        pipeline.del(this.suggestionDocumentKey(type, id));
        await pipeline.exec();
        return true;
      },
      false,
    );
  }

  private async ensureSuggestionIndexes() {
    if (!this.redis) {
      return;
    }

    const [productCount, brandCount] = await Promise.all([
      this.withRedisBudget('ZCARD products', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.products), 0),
      this.withRedisBudget('ZCARD brands', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.brands), 0),
    ]);

    if (productCount === 0 && brandCount === 0) {
      await this.rebuildSuggestionIndexes('startup');
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async rebuildSuggestionIndexesCron() {
    await this.rebuildSuggestionIndexes('daily-recovery');
  }

  private async rebuildSuggestionIndexes(reason: string) {
    if (!this.redis || this.isRebuildingSuggestions) {
      return;
    }

    this.isRebuildingSuggestions = true;
    try {
      await this.clearSuggestionNamespace();

      await Promise.all([
        this.rebuildProductSuggestions(),
        this.rebuildBrandSuggestions(),
        this.rebuildDesignSuggestions(),
        this.rebuildStoreCollectionSuggestions(),
        this.rebuildTagSuggestions(),
      ]);
    } catch (error: any) {
      this.logger.warn(`Suggestion rebuild failed: ${error?.message || error}`);
    } finally {
      this.isRebuildingSuggestions = false;
    }
  }

  private async rebuildProductSuggestions() {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.product.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          archivedAt: null,
          brand: { isStoreOpen: true },
        },
        select: {
          id: true,
          name: true,
          description: true,
          tags: true,
          thumbnail: true,
          images: true,
          price: true,
          salePrice: true,
          currency: true,
          slug: true,
          brandId: true,
          brand: {
            select: {
              ownerId: true,
              name: true,
            },
          },
        },
        take: SEARCH_REBUILD_BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) {
        break;
      }

      const members = rows.flatMap((row) => {
        const payload = this.createProductSuggestionPayload(row);
        const searchTerms = this.suggestionWords(
          payload.title,
          payload.subtitle,
          row.tags,
          this.buildDescriptionTerms(row.description),
        );
        return [{ payload, searchTerms }];
      });

      if (members.length > 0) {
        await Promise.all(
          members.map(({ payload, searchTerms }) =>
            this.upsertSuggestion('product', SEARCH_SUGGEST_KEYS.products, payload, searchTerms),
          ),
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  private async rebuildBrandSuggestions() {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.brand.findMany({
        where: { isStoreOpen: true },
        select: {
          id: true,
          ownerId: true,
          name: true,
          description: true,
          tagline: true,
          tags: true,
          logo: true,
          isStoreOpen: true,
        },
        take: SEARCH_REBUILD_BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) {
        break;
      }

      const members = rows.flatMap((row) => {
        const payload = this.createBrandSuggestionPayload(row);
        const searchTerms = this.suggestionWords(
          payload.title,
          payload.subtitle,
          row.tags,
          this.buildDescriptionTerms(row.description),
        );
        return [{ payload, searchTerms }];
      });

      if (members.length > 0) {
        await Promise.all(
          members.map(({ payload, searchTerms }) =>
            this.upsertSuggestion('brand', SEARCH_SUGGEST_KEYS.brands, payload, searchTerms),
          ),
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  private async rebuildDesignSuggestions() {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.collection.findMany({
        where: {
          domain: CollectionDomain.DESIGN,
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        },
        select: {
          id: true,
          ownerId: true,
          title: true,
          description: true,
          tags: true,
        },
        take: SEARCH_REBUILD_BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) {
        break;
      }

      const members = rows.flatMap((row) => {
        const payload = this.createDesignSuggestionPayload(row);
        const searchTerms = this.suggestionWords(
          payload.title,
          row.tags,
          this.buildDescriptionTerms(row.description),
        );
        return [{ payload, searchTerms }];
      });

      if (members.length > 0) {
        await Promise.all(
          members.map(({ payload, searchTerms }) =>
            this.upsertSuggestion('design', SEARCH_SUGGEST_KEYS.designs, payload, searchTerms),
          ),
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  private async rebuildStoreCollectionSuggestions() {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.storeCollection.findMany({
        where: {
          status: CollectionStatus.PUBLISHED,
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        },
        select: {
          id: true,
          ownerId: true,
          title: true,
          description: true,
          tags: true,
        },
        take: SEARCH_REBUILD_BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) {
        break;
      }

      const members = rows.flatMap((row) => {
        const payload = this.createCollectionSuggestionPayload(row);
        const searchTerms = this.suggestionWords(
          payload.title,
          row.tags,
          this.buildDescriptionTerms(row.description),
        );
        return [{ payload, searchTerms }];
      });

      if (members.length > 0) {
        await Promise.all(
          members.map(({ payload, searchTerms }) =>
            this.upsertSuggestion('collection', SEARCH_SUGGEST_KEYS.collections, payload, searchTerms),
          ),
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  private async rebuildTagSuggestions() {
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.tag.findMany({
        where: {
          isBanned: false,
          aliasOfTagId: null,
          usageCount: { gt: 0 },
        },
        select: {
          id: true,
          normalizedName: true,
          usageCount: true,
        },
        take: SEARCH_REBUILD_BATCH_SIZE,
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });

      if (rows.length === 0) {
        break;
      }

      const members = rows.flatMap((row) => {
        const normalized = this.normalizeQuery(row.normalizedName);
        if (!normalized) {
          return [] as Array<{ payload: SuggestionPayload; searchTerms: string[] }>;
        }
        return [
          {
            payload: {
              id: row.id,
              type: 'tag' as const,
              title: row.normalizedName,
              href: `/search?q=${encodeURIComponent(row.normalizedName)}&type=tag`,
              matchText: normalized,
            },
            searchTerms: [normalized],
          },
        ];
      });

      if (members.length > 0) {
        await Promise.all(
          members.map(({ payload, searchTerms }) =>
            this.upsertSuggestion('tag', SEARCH_SUGGEST_KEYS.tags, payload, searchTerms),
          ),
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  private async syncProductSuggestionById(id: string) {
    const row = await this.prisma.product.findUnique({
      where: { id },
      select: {
        id: true,
        name: true,
        description: true,
        tags: true,
        thumbnail: true,
        images: true,
        price: true,
        salePrice: true,
        currency: true,
        slug: true,
        brandId: true,
        isActive: true,
        deletedAt: true,
        archivedAt: true,
        brand: {
          select: {
            ownerId: true,
            name: true,
            isStoreOpen: true,
          },
        },
      },
    });

    if (!row || !row.isActive || row.deletedAt || row.archivedAt || !row.brand?.isStoreOpen) {
      await this.removeSuggestion('product', SEARCH_SUGGEST_KEYS.products, id);
      return;
    }

    const payload = this.createProductSuggestionPayload(row);
    const searchTerms = this.suggestionWords(
      payload.title,
      payload.subtitle,
      row.tags,
      this.buildDescriptionTerms(row.description),
    );
    await this.upsertSuggestion('product', SEARCH_SUGGEST_KEYS.products, payload, searchTerms);
  }

  private async syncProductsForBrand(brandId: string) {
    const rows = await this.prisma.product.findMany({
      where: { brandId },
      select: { id: true },
    });

    await Promise.all(rows.map((row) => this.syncProductSuggestionById(row.id)));
  }

  private async syncBrandSuggestionById(id: string) {
    const row = await this.prisma.brand.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        name: true,
        description: true,
        tagline: true,
        tags: true,
        logo: true,
        isStoreOpen: true,
      },
    });

    if (!row || !row.isStoreOpen) {
      await this.removeSuggestion('brand', SEARCH_SUGGEST_KEYS.brands, id);
      return;
    }

    const payload = this.createBrandSuggestionPayload(row);
    const searchTerms = this.suggestionWords(
      payload.title,
      payload.subtitle,
      row.tags,
      this.buildDescriptionTerms(row.description),
    );
    await this.upsertSuggestion('brand', SEARCH_SUGGEST_KEYS.brands, payload, searchTerms);
  }

  private async syncDesignSuggestionById(id: string) {
    const row = await this.prisma.collection.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        title: true,
        description: true,
        tags: true,
        domain: true,
        status: true,
        visibility: true,
        deletedAt: true,
      },
    });

    if (
      !row ||
      row.domain !== CollectionDomain.DESIGN ||
      row.status !== CollectionStatus.PUBLISHED ||
      row.visibility !== CollectionVisibility.PUBLIC ||
      row.deletedAt
    ) {
      await this.removeSuggestion('design', SEARCH_SUGGEST_KEYS.designs, id);
      return;
    }

    const payload = this.createDesignSuggestionPayload(row);
    const searchTerms = this.suggestionWords(
      payload.title,
      row.tags,
      this.buildDescriptionTerms(row.description),
    );
    await this.upsertSuggestion('design', SEARCH_SUGGEST_KEYS.designs, payload, searchTerms);
  }

  private async syncStoreCollectionSuggestionById(id: string) {
    const row = await this.prisma.storeCollection.findUnique({
      where: { id },
      select: {
        id: true,
        ownerId: true,
        title: true,
        description: true,
        tags: true,
        status: true,
        visibility: true,
        deletedAt: true,
      },
    });

    if (
      !row ||
      row.status !== CollectionStatus.PUBLISHED ||
      row.visibility !== CollectionVisibility.PUBLIC ||
      row.deletedAt
    ) {
      await this.removeSuggestion('collection', SEARCH_SUGGEST_KEYS.collections, id);
      return;
    }

    const payload = this.createCollectionSuggestionPayload(row);
    const searchTerms = this.suggestionWords(
      payload.title,
      row.tags,
      this.buildDescriptionTerms(row.description),
    );
    await this.upsertSuggestion('collection', SEARCH_SUGGEST_KEYS.collections, payload, searchTerms);
  }

  private async syncTagSuggestionById(id: string) {
    const row = await this.prisma.tag.findUnique({
      where: { id },
      select: {
        id: true,
        normalizedName: true,
        usageCount: true,
        isBanned: true,
        aliasOfTagId: true,
      },
    });

    if (!row || row.isBanned || row.aliasOfTagId || row.usageCount <= 0) {
      await this.removeSuggestion('tag', SEARCH_SUGGEST_KEYS.tags, id);
      return;
    }

    const normalized = this.normalizeQuery(row.normalizedName);
    await this.upsertSuggestion(
      'tag',
      SEARCH_SUGGEST_KEYS.tags,
      {
        id: row.id,
        type: 'tag',
        title: row.normalizedName,
        href: `/search?q=${encodeURIComponent(row.normalizedName)}&type=tag`,
        matchText: normalized,
      },
      [normalized],
    );
  }

  async suggest(queryInput?: string, userId?: string, brandId?: string): Promise<SearchSuggestionResponse> {
    const startedAt = Date.now();
    const parsedQuery = this.parseSearchQuery(queryInput);
    const normalizedQuery = parsedQuery.normalizedQuery;
    const recent = await this.getRecentSearches(userId, normalizedQuery || undefined);
    const trending = normalizedQuery ? [] : await this.getTrendingSearches();
    const brandOwnerId = await this.resolveBrandOwnerId(brandId);

    if (!normalizedQuery) {
      const response = {
        query: queryInput || '',
        normalizedQuery,
        recent,
        trending,
        products: { items: [], total: 0 },
        brands: { items: [], total: 0 },
        designs: { items: [], total: 0 },
        storeCollections: { items: [], total: 0 },
        tags: [],
      };
      this.logSearchEvent('suggest', {
        mode: parsedQuery.mode,
        normalizedQueryLength: normalizedQuery.length,
        durationMs: Date.now() - startedAt,
        resultCount: 0,
      });
      return response;
    }

    if (normalizedQuery.length < 1) {
      const response = {
        query: queryInput || '',
        normalizedQuery,
        recent,
        trending: [],
        products: { items: [], total: 0 },
        brands: { items: [], total: 0 },
        designs: { items: [], total: 0 },
        storeCollections: { items: [], total: 0 },
        tags: [],
      };
      this.logSearchEvent('suggest', {
        mode: parsedQuery.mode,
        normalizedQueryLength: normalizedQuery.length,
        durationMs: Date.now() - startedAt,
        resultCount: 0,
      });
      return response;
    }

    const brandMode = parsedQuery.mode === 'brand';
    const tagMode = parsedQuery.mode === 'tag';

    const [products, brands, designs, storeCollections, tagItems] = await Promise.all([
      brandMode || tagMode
        ? Promise.resolve([])
        : this.fetchSuggestionItems(
            SEARCH_SUGGEST_KEYS.products,
            normalizedQuery,
            PRODUCT_SUGGEST_LIMIT,
          ),
      tagMode
        ? Promise.resolve([])
        : this.fetchSuggestionItems(
            SEARCH_SUGGEST_KEYS.brands,
            normalizedQuery,
            brandMode ? Math.max(BRAND_SUGGEST_LIMIT + 2, 4) : BRAND_SUGGEST_LIMIT,
          ),
      brandMode || tagMode
        ? Promise.resolve([])
        : this.fetchSuggestionItems(
            SEARCH_SUGGEST_KEYS.designs,
            normalizedQuery,
            DESIGN_SUGGEST_LIMIT,
          ),
      brandMode || tagMode
        ? Promise.resolve([])
        : this.fetchSuggestionItems(
            SEARCH_SUGGEST_KEYS.collections,
            normalizedQuery,
            COLLECTION_SUGGEST_LIMIT,
            brandOwnerId
              ? (payload) => payload.metadata?.ownerId === brandOwnerId
              : undefined,
          ),
      brandMode
        ? Promise.resolve([])
        : this.fetchSuggestionItems(
            SEARCH_SUGGEST_KEYS.tags,
            normalizedQuery,
            tagMode ? Math.max(TAG_SUGGEST_LIMIT + 3, 4) : TAG_SUGGEST_LIMIT,
          ),
    ]);

    const response = {
      query: queryInput || '',
      normalizedQuery,
      recent,
      trending: [],
      products: { items: products, total: products.length },
      brands: { items: brands, total: brands.length },
      designs: { items: designs, total: designs.length },
      storeCollections: { items: storeCollections, total: storeCollections.length },
      tags: tagItems.map((item) => ({
        id: item.id,
        type: 'tag' as const,
        title: item.title,
        href: item.href,
        score: item.score,
      })),
    };
    this.logSearchEvent('suggest', {
      mode: parsedQuery.mode,
      normalizedQueryLength: normalizedQuery.length,
      durationMs: Date.now() - startedAt,
      resultCount:
        response.products.total +
        response.brands.total +
        response.designs.total +
        response.storeCollections.total +
        response.tags.length,
    });
    return response;
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const startedAt = Date.now();
    const parsedQuery = this.parseSearchQuery(params.query);
    const normalizedQuery = parsedQuery.normalizedQuery;
    if (!normalizedQuery) {
      throw new BadRequestException('Search query is required');
    }

    const page = this.clampPage(params.page);
    const limit = this.clampLimit(params.limit, 20, 50);
    const tokens = parsedQuery.tokens;
    const types = this.resolveTypes(parsedQuery.forcedTypes ?? params.types);
    if (types.length > 1 && page > 1) {
      throw new BadRequestException(
        'Mixed-result pagination is not supported beyond the first page',
      );
    }

    const versionToken = await this.getSearchCacheVersionToken(types);

    const cacheKey = this.buildSearchCacheKey({
      query: normalizedQuery,
      types,
      page,
      limit,
      brandId: params.brandId,
      versionToken,
    });

    const cached = await this.getCachedSearchResult(cacheKey);
    if (cached) {
      await this.recordSearch(params.userId, normalizedQuery);
      this.logSearchEvent('search', {
        mode: parsedQuery.mode,
        normalizedQueryLength: normalizedQuery.length,
        types,
        page,
        limit,
        cacheHit: true,
        durationMs: Date.now() - startedAt,
        resultCount: cached.items.length,
      });
      return cached;
    }

    const offset = (page - 1) * limit;
    const brandOwnerId = await this.resolveBrandOwnerId(params.brandId);
    const counts = this.emptyCounts();
    let items: SearchItem[] = [];
    let hasNextPage = false;
    let paginationMode: 'single' | 'mixed' = 'mixed';

    if (types.length === 1) {
      paginationMode = 'single';
      const activeType = types[0];
      let result: SearchPageResult;

      switch (activeType) {
        case 'product':
          result = await this.searchProductsPage(
            normalizedQuery,
            tokens,
            limit,
            offset,
            params.brandId,
          );
          break;
        case 'brand':
          result = await this.searchBrandsPage(normalizedQuery, tokens, limit, offset);
          break;
        case 'design':
          result = await this.searchDesignsPage(normalizedQuery, tokens, limit, offset);
          break;
        case 'collection':
          result = await this.searchCollectionsPage(
            normalizedQuery,
            tokens,
            limit,
            offset,
            brandOwnerId,
          );
          break;
        case 'tag':
          result = await this.searchTagsPage(normalizedQuery, tokens, limit, offset);
          break;
        default:
          result = { items: [], total: 0 };
      }

      counts[activeType] = result.total;
      items = result.items;
      hasNextPage = offset + result.items.length < result.total;
    } else {
      const mixedLimit = Math.min(limit, SEARCH_MIXED_PREVIEW_LIMIT);
      const [products, brands, designs, collections, tags] = await Promise.all([
        types.includes('product')
          ? this.searchProductsPage(normalizedQuery, tokens, mixedLimit, 0, params.brandId)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('brand')
          ? this.searchBrandsPage(normalizedQuery, tokens, mixedLimit, 0)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('design')
          ? this.searchDesignsPage(normalizedQuery, tokens, mixedLimit, 0)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('collection')
          ? this.searchCollectionsPage(normalizedQuery, tokens, mixedLimit, 0, brandOwnerId)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('tag')
          ? this.searchTagsPage(normalizedQuery, tokens, mixedLimit, 0)
          : Promise.resolve({ items: [], total: 0 }),
      ]);

      counts.product = products.total;
      counts.brand = brands.total;
      counts.design = designs.total;
      counts.collection = collections.total;
      counts.tag = tags.total;

      items = [
        ...products.items,
        ...brands.items,
        ...designs.items,
        ...collections.items,
        ...tags.items,
      ]
        .sort((left, right) => right.score - left.score || left.title.localeCompare(right.title))
        .slice(0, limit);
      hasNextPage = false;
    }

    const response: SearchResponse = {
      query: params.query || '',
      normalizedQuery,
      types,
      items,
      counts,
      meta: {
        page,
        limit,
        hasNextPage,
        paginationMode,
      },
    };

    await this.setCachedSearchResult(cacheKey, response);
    await this.recordSearch(params.userId, normalizedQuery);
    this.logSearchEvent('search', {
      mode: parsedQuery.mode,
      normalizedQueryLength: normalizedQuery.length,
      types,
      page,
      limit,
      cacheHit: false,
      durationMs: Date.now() - startedAt,
      resultCount: response.items.length,
      hasNextPage: response.meta.hasNextPage,
      paginationMode: response.meta.paginationMode,
    });

    return response;
  }

  async health(): Promise<SearchHealthResponse> {
    let postgresReady = false;
    let redisReady = false;
    const suggestionIndexCounts: Record<string, number> = {};

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      postgresReady = true;
    } catch {
      postgresReady = false;
    }

    if (this.redis) {
      try {
        const pong = await this.withRedisBudget('PING', () => this.redis!.ping(), '');
        redisReady = pong === 'PONG';
        if (redisReady) {
          const [products, brands, designs, collections, tags] = await Promise.all([
            this.withRedisBudget('ZCARD products', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.products), 0),
            this.withRedisBudget('ZCARD brands', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.brands), 0),
            this.withRedisBudget('ZCARD designs', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.designs), 0),
            this.withRedisBudget('ZCARD collections', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.collections), 0),
            this.withRedisBudget('ZCARD tags', () => this.redis!.zCard(SEARCH_SUGGEST_KEYS.tags), 0),
          ]);
          suggestionIndexCounts.products = products;
          suggestionIndexCounts.brands = brands;
          suggestionIndexCounts.designs = designs;
          suggestionIndexCounts.storeCollections = collections;
          suggestionIndexCounts.tags = tags;
        }
      } catch {
        redisReady = false;
      }
    }

    return {
      postgres: { ready: postgresReady },
      redis: {
        ready: redisReady,
        degraded: !redisReady,
        circuitOpen: this.isRedisCircuitOpen(),
        suggestionIndexCounts,
      },
      mode: redisReady ? 'database-and-redis' : 'database-only',
    };
  }
}
