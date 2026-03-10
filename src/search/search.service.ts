import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
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
const SEARCH_SUGGEST_SCAN_CAP = 120;
const SEARCH_SIMILARITY_THRESHOLD = 0.3;

const SEARCH_SUGGEST_KEYS = {
  products: 'search:suggest:products',
  brands: 'search:suggest:brands',
  designs: 'search:suggest:designs',
  collections: 'search:suggest:store-collections',
  tags: 'search:suggest:tags',
} as const;

@Injectable()
export class SearchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchService.name);
  private redis: RedisClientType | null = null;
  private redisCircuitOpenUntil = 0;
  private redisFailureCount = 0;
  private isRebuildingSuggestions = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly tagsService: TagsService,
  ) {}

  async onModuleInit() {
    const redisUrl = String(process.env.REDIS_URL || '').trim();
    if (!redisUrl) {
      return;
    }

    try {
      this.redis = createClient({
        url: redisUrl,
        socket: {
          connectTimeout: SEARCH_REDIS_TIMEOUT_MS,
        },
      });
      this.redis.on('error', (error) => {
        this.logger.warn(`Search Redis error: ${error?.message || error}`);
      });
      await this.redis.connect();
      await this.ensureSuggestionIndexes();
    } catch (error: any) {
      this.logger.warn(
        `Search Redis unavailable, continuing without recent/trending persistence: ${error?.message || error}`,
      );
      this.redis = null;
    }
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
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase();
  }

  private tokenize(query: string): string[] {
    return query
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean);
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
  }) {
    return [
      'search:results:v2',
      params.query,
      params.types.join(','),
      params.page,
      params.limit,
      params.brandId || 'all',
    ].join(':');
  }

  private suggestionWords(value: string) {
    return Array.from(new Set(this.tokenize(this.normalizeQuery(value))));
  }

  private encodeSuggestionMember(word: string, payload: SuggestionPayload) {
    return `${word}\u0000${JSON.stringify(payload)}`;
  }

  private decodeSuggestionMember(member: string): SuggestionPayload | null {
    const separatorIndex = member.indexOf('\u0000');
    if (separatorIndex < 0) {
      return null;
    }

    try {
      return JSON.parse(member.slice(separatorIndex + 1)) as SuggestionPayload;
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
      matchText: this.normalizeQuery(`${row.name} ${row.brand?.name || ''} ${row.description || ''}`),
    };
  }

  private createBrandSuggestionPayload(row: {
    id: string;
    ownerId: string;
    name: string;
    description: string | null;
    tagline: string | null;
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
      matchText: this.normalizeQuery(`${row.name} ${row.tagline || ''} ${row.description || ''}`),
    };
  }

  private createDesignSuggestionPayload(row: {
    id: string;
    ownerId: string;
    title: string | null;
    description: string | null;
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
      matchText: this.normalizeQuery(`${title} ${row.description || ''}`),
    };
  }

  private createCollectionSuggestionPayload(row: {
    id: string;
    ownerId: string;
    title: string | null;
    description: string | null;
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
      matchText: this.normalizeQuery(`${title} ${row.description || ''}`),
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

  private async fetchSuggestionItems(
    key: string,
    normalizedQuery: string,
    limit: number,
  ) {
    const tokens = this.tokenize(normalizedQuery);
    const prefix = tokens[tokens.length - 1];
    const requiredTokens = tokens.slice(0, -1);
    const items: SearchItem[] = [];
    const seen = new Set<string>();
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

      for (const member of batch) {
        const payload = this.decodeSuggestionMember(member);
        if (!payload || seen.has(payload.id)) {
          continue;
        }
        if (!requiredTokens.every((token) => payload.matchText.includes(token))) {
          continue;
        }

        seen.add(payload.id);
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
      )
      SELECT id, name, description, thumbnail, images, price, "salePrice", currency, slug, "brandId", "brandName", "brandOwnerId", score
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
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
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
      )
      SELECT COUNT(*)::bigint AS total
      FROM (
        SELECT id FROM fts
        UNION ALL
        SELECT id FROM trgm
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

  @Cron(CronExpression.EVERY_10_MINUTES)
  async rebuildSuggestionIndexesCron() {
    await this.rebuildSuggestionIndexes('scheduled');
  }

  private async rebuildSuggestionIndexes(reason: string) {
    if (!this.redis || this.isRebuildingSuggestions) {
      return;
    }

    this.isRebuildingSuggestions = true;
    try {
      await this.withRedisBudget(
        `DEL suggestion indexes (${reason})`,
        () =>
          this.redis!.del([
            SEARCH_SUGGEST_KEYS.products,
            SEARCH_SUGGEST_KEYS.brands,
            SEARCH_SUGGEST_KEYS.designs,
            SEARCH_SUGGEST_KEYS.collections,
            SEARCH_SUGGEST_KEYS.tags,
          ]),
        0,
      );

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
        return this.suggestionWords(payload.title).map((word) => ({
          score: 0,
          value: this.encodeSuggestionMember(word, payload),
        }));
      });

      if (members.length > 0) {
        await this.withRedisBudget(
          'ZADD product suggestions',
          () => this.redis!.zAdd(SEARCH_SUGGEST_KEYS.products, members),
          0,
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
        return this.suggestionWords(payload.title).map((word) => ({
          score: 0,
          value: this.encodeSuggestionMember(word, payload),
        }));
      });

      if (members.length > 0) {
        await this.withRedisBudget(
          'ZADD brand suggestions',
          () => this.redis!.zAdd(SEARCH_SUGGEST_KEYS.brands, members),
          0,
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
        return this.suggestionWords(payload.title).map((word) => ({
          score: 0,
          value: this.encodeSuggestionMember(word, payload),
        }));
      });

      if (members.length > 0) {
        await this.withRedisBudget(
          'ZADD design suggestions',
          () => this.redis!.zAdd(SEARCH_SUGGEST_KEYS.designs, members),
          0,
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
        return this.suggestionWords(payload.title).map((word) => ({
          score: 0,
          value: this.encodeSuggestionMember(word, payload),
        }));
      });

      if (members.length > 0) {
        await this.withRedisBudget(
          'ZADD store collection suggestions',
          () => this.redis!.zAdd(SEARCH_SUGGEST_KEYS.collections, members),
          0,
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
          return [] as Array<{ score: number; value: string }>;
        }
        return [
          {
            score: 0,
            value: this.encodeSuggestionMember(normalized, {
              id: row.id,
              type: 'tag',
              title: row.normalizedName,
              href: `/search?q=${encodeURIComponent(row.normalizedName)}&type=tag`,
              matchText: normalized,
            }),
          },
        ];
      });

      if (members.length > 0) {
        await this.withRedisBudget(
          'ZADD tag suggestions',
          () => this.redis!.zAdd(SEARCH_SUGGEST_KEYS.tags, members),
          0,
        );
      }

      cursor = rows[rows.length - 1].id;
    }
  }

  async suggest(queryInput?: string, userId?: string, brandId?: string): Promise<SearchSuggestionResponse> {
    const normalizedQuery = this.normalizeQuery(queryInput);
    const recent = await this.getRecentSearches(userId, normalizedQuery || undefined);
    const trending = normalizedQuery ? [] : await this.getTrendingSearches();
    const brandOwnerId = await this.resolveBrandOwnerId(brandId);

    if (!normalizedQuery) {
      return {
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
    }

    if (normalizedQuery.length < 2) {
      return {
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
    }

    const [products, brands, designs, storeCollections, tagItems] = await Promise.all([
      this.fetchSuggestionItems(
        SEARCH_SUGGEST_KEYS.products,
        normalizedQuery,
        PRODUCT_SUGGEST_LIMIT,
      ),
      this.fetchSuggestionItems(
        SEARCH_SUGGEST_KEYS.brands,
        normalizedQuery,
        BRAND_SUGGEST_LIMIT,
      ),
      this.fetchSuggestionItems(
        SEARCH_SUGGEST_KEYS.designs,
        normalizedQuery,
        DESIGN_SUGGEST_LIMIT,
      ),
      this.fetchSuggestionItems(
        SEARCH_SUGGEST_KEYS.collections,
        brandOwnerId ? this.normalizeQuery(`${normalizedQuery}`) : normalizedQuery,
        COLLECTION_SUGGEST_LIMIT,
      ),
      this.fetchSuggestionItems(
        SEARCH_SUGGEST_KEYS.tags,
        normalizedQuery,
        TAG_SUGGEST_LIMIT,
      ),
    ]);

    const scopedCollections =
      brandOwnerId == null
        ? storeCollections
        : storeCollections.filter(
            (item) => item.metadata?.ownerId === brandOwnerId,
          );

    return {
      query: queryInput || '',
      normalizedQuery,
      recent,
      trending: [],
      products: { items: products, total: products.length },
      brands: { items: brands, total: brands.length },
      designs: { items: designs, total: designs.length },
      storeCollections: { items: scopedCollections, total: scopedCollections.length },
      tags: tagItems.map((item) => ({
        id: item.id,
        type: 'tag',
        title: item.title,
        href: item.href,
        score: item.score,
      })),
    };
  }

  async search(params: SearchParams): Promise<SearchResponse> {
    const normalizedQuery = this.normalizeQuery(params.query);
    if (!normalizedQuery) {
      throw new BadRequestException('Search query is required');
    }

    const page = this.clampPage(params.page);
    const limit = this.clampLimit(params.limit, 20, 50);
    const tokens = this.tokenize(normalizedQuery);
    const types = this.resolveTypes(params.types);
    if (types.length > 1 && page > 1) {
      throw new BadRequestException(
        'Mixed-result pagination is not supported beyond the first page',
      );
    }

    const cacheKey = this.buildSearchCacheKey({
      query: normalizedQuery,
      types,
      page,
      limit,
      brandId: params.brandId,
    });

    const cached = await this.getCachedSearchResult(cacheKey);
    if (cached) {
      await this.recordSearch(params.userId, normalizedQuery);
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
      const [products, brands, designs, collections, tags] = await Promise.all([
        types.includes('product')
          ? this.searchProductsPage(normalizedQuery, tokens, limit, 0, params.brandId)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('brand')
          ? this.searchBrandsPage(normalizedQuery, tokens, limit, 0)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('design')
          ? this.searchDesignsPage(normalizedQuery, tokens, limit, 0)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('collection')
          ? this.searchCollectionsPage(normalizedQuery, tokens, limit, 0, brandOwnerId)
          : Promise.resolve({ items: [], total: 0 }),
        types.includes('tag')
          ? this.searchTagsPage(normalizedQuery, tokens, limit, 0)
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