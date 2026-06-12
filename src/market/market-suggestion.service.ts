import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { CollectionStatus, CollectionVisibility, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MarketSectionItemDto,
  MarketSectionSourceType,
} from './dto/market-section.dto';
import {
  MARKET_SUGGESTION_DEFAULT_LIMIT,
  MARKET_SUGGESTION_MAX_LIMIT,
  MarketSuggestionBlockDto,
  MarketSuggestionContext,
  MarketSuggestionQueryDto,
  MarketSuggestionResponseDto,
  MarketSuggestionTargetType,
} from './dto/market-suggestion.dto';
import { MarketSignalIdentity } from './market-signal.service';
import {
  MarketSuppressionScope,
  MarketSuppressionService,
} from './market-suppression.service';

type SuggestionBlockInput = {
  blockKey: string;
  title: string;
  subtitle?: string | null;
  reason?: string | null;
  sourceType: MarketSectionSourceType;
  items: MarketSectionItemDto[];
  strategy: string;
  limit: number;
  fallbackReason?: string | null;
};

type TargetSnapshot = {
  id: string;
  brandId?: string | null;
  ownerId?: string | null;
  collectionId?: string | null;
  categoryId?: string | null;
  tags: string[];
};

@Injectable()
export class MarketSuggestionService {
  private readonly defaultLimit = MARKET_SUGGESTION_DEFAULT_LIMIT;
  private readonly maxLimit = MARKET_SUGGESTION_MAX_LIMIT;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly marketSuppressionService?: MarketSuppressionService,
  ) {}

  async getSuggestions(
    query: MarketSuggestionQueryDto,
    identity: MarketSignalIdentity,
  ): Promise<MarketSuggestionResponseDto> {
    const limit = this.normalizeLimit(query.limit);
    const context = query.context;
    const targetType =
      query.targetType ?? this.defaultTargetTypeForContext(context);
    const targetId = this.clean(query.targetId);
    const searchQuery = this.clean(query.query);
    const sectionKey = this.clean(query.sectionKey);
    const excludedIds = this.parseExcludedIds(query.excludeIds);
    const suppressionScope = await this.getSuppressionScope(identity);
    const usedItemKeys = new Set<string>();

    let blocks: MarketSuggestionBlockDto[] = [];
    let fallbackReason: string | null = null;

    switch (context) {
      case MarketSuggestionContext.PRODUCT_DETAIL:
        this.assertTarget(
          targetType,
          targetId,
          MarketSuggestionTargetType.PRODUCT,
          'Product detail suggestions require a product target',
        );
        ({ blocks, fallbackReason } = await this.getProductDetailSuggestions(
          targetId,
          limit,
          suppressionScope,
          usedItemKeys,
        ));
        break;
      case MarketSuggestionContext.COLLECTION_DETAIL:
        this.assertTarget(
          targetType,
          targetId,
          MarketSuggestionTargetType.COLLECTION,
          'Collection detail suggestions require a collection target',
        );
        ({ blocks, fallbackReason } = await this.getCollectionDetailSuggestions(
          targetId,
          limit,
          suppressionScope,
          usedItemKeys,
        ));
        break;
      case MarketSuggestionContext.BRAND_DETAIL:
      case MarketSuggestionContext.BRAND_STORE:
        this.assertTarget(
          targetType,
          targetId,
          MarketSuggestionTargetType.BRAND,
          'Brand suggestions require a brand target',
        );
        ({ blocks, fallbackReason } = await this.getBrandDetailSuggestions(
          targetId,
          limit,
          suppressionScope,
          usedItemKeys,
        ));
        break;
      case MarketSuggestionContext.SEARCH_EMPTY:
        if (!searchQuery) {
          throw new BadRequestException(
            'Search-empty suggestions require a non-empty query',
          );
        }
        ({ blocks, fallbackReason } = await this.getSearchEmptySuggestions(
          searchQuery,
          limit,
          suppressionScope,
          usedItemKeys,
        ));
        break;
      case MarketSuggestionContext.MARKET_SECTION_DETAIL:
        if (!sectionKey) {
          throw new BadRequestException(
            'Market section suggestions require a sectionKey',
          );
        }
        ({ blocks, fallbackReason } =
          await this.getMarketSectionDetailSuggestions(
            sectionKey,
            limit,
            suppressionScope,
            usedItemKeys,
          ));
        break;
      case MarketSuggestionContext.WISHLIST:
        ({ blocks, fallbackReason } = await this.getWishlistSuggestions(
          limit,
          suppressionScope,
          usedItemKeys,
        ));
        break;
      default:
        throw new BadRequestException('Unsupported suggestion context');
    }

    const safeBlocks = blocks
      .map((block) => ({
        ...block,
        items: block.items.filter(
          (item) => !this.isExcludedItem(item, excludedIds),
        ),
      }))
      .filter((block) => block.items.length > 0);
    const noCandidatesReason =
      safeBlocks.length === 0 && !fallbackReason
        ? 'no-eligible-candidates'
        : fallbackReason;

    return {
      generatedAt: new Date().toISOString(),
      context,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      sectionKey,
      query: searchQuery,
      blocks: safeBlocks,
      metadata: {
        version: 'phase3.foundation.v1',
        personalization: 'disabled',
        cachePolicy: 'private-no-store',
        fallbackUsed: Boolean(noCandidatesReason),
        fallbackReason: noCandidatesReason,
        contextsDeferred: [],
      },
    };
  }

  private async getProductDetailSuggestions(
    productId: string,
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const target = await this.prisma.product.findFirst({
      where: this.buildMarketableProductWhere([{ id: productId }]),
      select: {
        id: true,
        brandId: true,
        collectionId: true,
        categoryId: true,
        tags: true,
      },
    });

    if (!target) {
      return { blocks: [], fallbackReason: 'target-not-found' };
    }

    const blocks = [
      this.buildBlock(
        {
          blockKey: 'product-detail-more-like-this',
          title: 'More Like This',
          subtitle: 'Similar market-ready pieces',
          reason: 'same-category-or-style',
          sourceType: 'PRODUCT',
          strategy: 'product.same-category-tags',
          limit,
          items: await this.getProductCandidates({
            limit,
            excludeIds: [productId],
            categoryId: target.categoryId,
            tags: target.tags,
            orderBy: [
              { viewsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'product-detail-complete-the-look',
          title: 'Complete the Look',
          subtitle: 'Pieces from the same edit or store',
          reason: target.collectionId
            ? 'same-collection-products'
            : 'same-brand-fallback',
          sourceType: 'PRODUCT',
          strategy: target.collectionId
            ? 'product.same-collection'
            : 'product.same-brand-fallback',
          limit,
          items: target.collectionId
            ? await this.getCollectionProductCandidates(
                target.collectionId,
                limit,
                [productId],
              )
            : await this.getProductCandidates({
                limit,
                excludeIds: [productId],
                brandId: target.brandId,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'product-detail-new-designers-to-watch',
          title: 'New Designers to Watch',
          subtitle: 'Fresh stores with market-ready pieces',
          reason: 'new-brand-fallback',
          sourceType: 'BRAND',
          strategy: 'product.new-designers',
          limit,
          items: await this.getBrandCandidates({
            limit,
            excludeIds: target.brandId ? [target.brandId] : undefined,
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private async getCollectionDetailSuggestions(
    collectionId: string,
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const target = await this.prisma.storeCollection.findFirst({
      where: {
        id: collectionId,
        status: CollectionStatus.PUBLISHED,
        visibility: CollectionVisibility.PUBLIC,
        deletedAt: null,
      },
      select: {
        id: true,
        ownerId: true,
        categoryId: true,
        tags: true,
        owner: {
          select: {
            brand: {
              select: {
                id: true,
                isStoreOpen: true,
              },
            },
          },
        },
      },
    });

    if (!target || target.owner?.brand?.isStoreOpen === false) {
      return { blocks: [], fallbackReason: 'target-not-found' };
    }

    const targetSnapshot: TargetSnapshot = {
      id: target.id,
      ownerId: target.ownerId,
      brandId: target.owner?.brand?.id ?? null,
      categoryId: target.categoryId,
      tags: target.tags,
    };

    const blocks = [
      this.buildBlock(
        {
          blockKey: 'collection-detail-pieces-that-match-this-edit',
          title: 'Pieces That Match This Edit',
          subtitle: 'Market-ready products in this collection',
          reason: 'same-collection-products',
          sourceType: 'PRODUCT',
          strategy: 'collection.products',
          limit,
          items: await this.getCollectionProductCandidates(collectionId, limit),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'collection-detail-more-from-this-style',
          title: 'More From This Style',
          subtitle: 'Related pieces with similar category or tags',
          reason: 'same-category-or-style',
          sourceType: 'PRODUCT',
          strategy: 'collection.same-style-products',
          limit,
          items: await this.getProductCandidates({
            limit,
            categoryId: targetSnapshot.categoryId,
            tags: targetSnapshot.tags,
            orderBy: [
              { viewsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'collection-detail-similar-collections',
          title: 'Similar Collections',
          subtitle: 'Related store edits and capsules',
          reason: 'same-category-or-style',
          sourceType: 'COLLECTION',
          strategy: 'collection.similar-collections',
          limit,
          items: await this.getCollectionCandidates({
            limit,
            excludeIds: [collectionId],
            categoryId: targetSnapshot.categoryId,
            tags: targetSnapshot.tags,
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private async getBrandDetailSuggestions(
    brandId: string,
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const target = await this.prisma.brand.findFirst({
      where: {
        id: brandId,
        isStoreOpen: true,
      },
      select: {
        id: true,
        ownerId: true,
      },
    });

    if (!target) {
      return { blocks: [], fallbackReason: 'target-not-found' };
    }

    const blocks = [
      this.buildBlock(
        {
          blockKey: 'brand-store-more-from-this-brand',
          title: 'More From This Brand',
          subtitle: 'Available products from this store',
          reason: 'same-brand-products',
          sourceType: 'PRODUCT',
          strategy: 'brand.more-from-this-brand',
          limit,
          items: await this.getProductCandidates({
            limit,
            brandId: target.id,
            orderBy: [
              { viewsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'brand-detail-latest-collections',
          title: 'Latest Collections',
          subtitle: 'Recent edits from this brand',
          reason: 'same-brand-collections',
          sourceType: 'COLLECTION',
          strategy: 'brand.latest-collections',
          limit,
          items: await this.getCollectionCandidates({
            limit,
            ownerId: target.ownerId,
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'brand-store-similar-brands-to-explore',
          title: 'Similar Brands to Explore',
          subtitle: 'Other open stores with market-ready products',
          reason: 'fallback-brands',
          sourceType: 'BRAND',
          strategy: 'brand.similar-brands',
          limit,
          items: await this.getBrandCandidates({
            limit,
            excludeIds: [target.id],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private async getSearchEmptySuggestions(
    query: string,
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const blocks = [
      this.buildBlock(
        {
          blockKey: 'search-empty-relaxed-products',
          title: 'Try These Instead',
          subtitle: 'Relaxed matches from the market',
          reason: 'query-relaxed-products',
          sourceType: 'PRODUCT',
          strategy: 'search.relaxed-products',
          limit,
          items: await this.getProductCandidates({
            limit,
            query,
            orderBy: [
              { viewsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'search-empty-hot-right-now',
          title: 'Hot Right Now',
          subtitle: 'Popular market pieces while you keep looking',
          reason: 'hot-right-now-fallback',
          sourceType: 'PRODUCT',
          strategy: 'search.hot-right-now',
          limit,
          items: await this.getProductCandidates({
            limit,
            orderBy: [
              { viewsCount: 'desc' },
              { threadsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'search-empty-fresh-drops',
          title: 'Fresh Drops',
          subtitle: 'New arrivals from open WEAZ stores',
          reason: 'fresh-fallback',
          sourceType: 'PRODUCT',
          strategy: 'search.fresh-drops',
          limit,
          items: await this.getProductCandidates({
            limit,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private async getMarketSectionDetailSuggestions(
    sectionKey: string,
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const normalizedSection = sectionKey.trim().toLowerCase();
    const isBrandSection = normalizedSection === 'new-designers-to-watch';
    const isCollectionSection = normalizedSection === 'shop-the-look';
    const isHotSection =
      normalizedSection === 'hot-right-now' ||
      normalizedSection === 'loved-near-you' ||
      normalizedSection === 'still-thinking-about-these';

    const blocks = [
      this.buildBlock(
        {
          blockKey: `${normalizedSection}-section-fresh-drops`,
          title: isHotSection ? 'Fresh Drops' : 'Hot Right Now',
          subtitle: isHotSection
            ? 'New arrivals related to this section'
            : 'Popular market pieces related to this section',
          reason: isHotSection ? 'fresh-fallback' : 'hot-right-now-fallback',
          sourceType: 'PRODUCT',
          strategy: isHotSection
            ? 'section-detail.fresh-drops'
            : 'section-detail.hot-right-now',
          limit,
          items: await this.getProductCandidates({
            limit,
            orderBy: isHotSection
              ? [{ createdAt: 'desc' }, { id: 'desc' }]
              : [
                  { viewsCount: 'desc' },
                  { threadsCount: 'desc' },
                  { createdAt: 'desc' },
                  { id: 'desc' },
                ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: `${normalizedSection}-section-${
            isBrandSection ? 'fresh-designers' : 'new-designers-to-watch'
          }`,
          title: 'New Designers to Watch',
          subtitle: 'Open stores with market-ready pieces',
          reason: 'new-brand-fallback',
          sourceType: 'BRAND',
          strategy: 'section-detail.new-designers',
          limit,
          items: await this.getBrandCandidates({ limit }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: `${normalizedSection}-section-${
            isCollectionSection ? 'fresh-products' : 'shop-the-look'
          }`,
          title: isCollectionSection ? 'Fresh Drops' : 'Shop the Look',
          subtitle: isCollectionSection
            ? 'New products from open WEAZ stores'
            : 'Recent store edits and capsules',
          reason: isCollectionSection
            ? 'fresh-products-fallback'
            : 'collection-fallback',
          sourceType: isCollectionSection ? 'PRODUCT' : 'COLLECTION',
          strategy: isCollectionSection
            ? 'section-detail.fresh-products'
            : 'section-detail.collections',
          limit,
          items: isCollectionSection
            ? await this.getProductCandidates({
                limit,
                orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              })
            : await this.getCollectionCandidates({ limit }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private async getWishlistSuggestions(
    limit: number,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ) {
    const blocks = [
      this.buildBlock(
        {
          blockKey: 'wishlist-more-like-this',
          title: 'More Like This',
          subtitle: 'Popular pieces to compare with your saved items',
          reason: 'wishlist-generic-fallback',
          sourceType: 'PRODUCT',
          strategy: 'wishlist.hot-right-now',
          limit,
          items: await this.getProductCandidates({
            limit,
            orderBy: [
              { viewsCount: 'desc' },
              { threadsCount: 'desc' },
              { createdAt: 'desc' },
              { id: 'desc' },
            ],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'wishlist-fresh-drops',
          title: 'Fresh Drops',
          subtitle: 'New arrivals from open WEAZ stores',
          reason: 'fresh-fallback',
          sourceType: 'PRODUCT',
          strategy: 'wishlist.fresh-drops',
          limit,
          items: await this.getProductCandidates({
            limit,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          }),
        },
        suppressionScope,
        usedItemKeys,
      ),
      this.buildBlock(
        {
          blockKey: 'wishlist-new-designers-to-watch',
          title: 'New Designers to Watch',
          subtitle: 'Fresh stores with market-ready pieces',
          reason: 'new-brand-fallback',
          sourceType: 'BRAND',
          strategy: 'wishlist.new-designers',
          limit,
          items: await this.getBrandCandidates({ limit }),
        },
        suppressionScope,
        usedItemKeys,
      ),
    ].filter((block): block is MarketSuggestionBlockDto => Boolean(block));

    return {
      blocks,
      fallbackReason: blocks.length ? null : 'no-eligible-candidates',
    };
  }

  private buildBlock(
    input: SuggestionBlockInput,
    suppressionScope: MarketSuppressionScope,
    usedItemKeys: Set<string>,
  ): MarketSuggestionBlockDto | null {
    if (suppressionScope.suggestionBlockKeys.has(input.blockKey)) {
      return null;
    }

    const items = this.dedupeItems(input.items)
      .filter((item) => !this.isSuppressedItem(item, suppressionScope))
      .filter((item) => {
        const key = this.itemKey(item);
        if (usedItemKeys.has(key)) return false;
        usedItemKeys.add(key);
        return true;
      })
      .slice(0, input.limit);

    if (!items.length) return null;

    return {
      blockKey: input.blockKey,
      title: input.title,
      subtitle: input.subtitle ?? null,
      reason: input.reason ?? null,
      layout:
        input.sourceType === 'COLLECTION'
          ? 'COLLECTION_RAIL'
          : input.sourceType === 'BRAND'
            ? 'BRAND_RAIL'
            : 'HORIZONTAL_RAIL',
      sourceType: input.sourceType,
      items,
      pagination: {
        limit: input.limit,
        hasNextPage: false,
        nextCursor: null,
      },
      metadata: {
        strategy: input.strategy,
        fallbackUsed: Boolean(input.fallbackReason),
        fallbackReason: input.fallbackReason ?? null,
        personalization: 'disabled',
        ranking: 'deterministic-v1',
      },
    };
  }

  private async getProductCandidates(options: {
    limit: number;
    excludeIds?: string[];
    categoryId?: string | null;
    brandId?: string | null;
    tags?: string[] | null;
    query?: string | null;
    orderBy: Prisma.ProductOrderByWithRelationInput[];
  }) {
    if (options.brandId === null || options.categoryId === null) {
      return [];
    }

    const extraAnd: Prisma.ProductWhereInput[] = [];
    if (options.excludeIds?.length) {
      extraAnd.push({ id: { notIn: options.excludeIds } });
    }
    if (options.brandId) {
      extraAnd.push({ brandId: options.brandId });
    }
    if (options.categoryId) {
      extraAnd.push({ categoryId: options.categoryId });
    }

    const normalizedTags = this.normalizeTags(options.tags);
    const queryFilter = this.buildProductQueryFilter(options.query);
    if (queryFilter) {
      extraAnd.push(queryFilter);
    } else if (normalizedTags.length) {
      extraAnd.push({ tags: { hasSome: normalizedTags } });
    }

    const products = await this.prisma.product.findMany({
      where: this.buildMarketableProductWhere(extraAnd),
      orderBy: options.orderBy,
      take: this.queryTake(options.limit),
      select: this.productSelect(),
    });

    return products
      .map((product) => this.mapProductItem(product))
      .filter((item): item is MarketSectionItemDto => Boolean(item));
  }

  private async getCollectionProductCandidates(
    collectionId: string,
    limit: number,
    excludeIds: string[] = [],
  ) {
    const productWhere = this.buildMarketableProductWhere([], {
      includeBrandOpen: false,
    });
    const links = await this.prisma.storeCollectionProduct.findMany({
      where: {
        collectionId,
        product: {
          ...productWhere,
          ...(excludeIds.length ? { id: { notIn: excludeIds } } : {}),
        },
      },
      orderBy: [{ orderIndex: 'asc' }, { productId: 'asc' }],
      take: this.queryTake(limit),
      select: {
        product: {
          select: this.productSelect(),
        },
      },
    });

    return links
      .map((link) => this.mapProductItem(link.product))
      .filter((item): item is MarketSectionItemDto => Boolean(item));
  }

  private async getCollectionCandidates(options: {
    limit: number;
    excludeIds?: string[];
    ownerId?: string | null;
    categoryId?: string | null;
    tags?: string[] | null;
  }) {
    if (options.ownerId === null || options.categoryId === null) return [];

    const andFilters: Prisma.StoreCollectionWhereInput[] = [];
    if (options.excludeIds?.length) {
      andFilters.push({ id: { notIn: options.excludeIds } });
    }
    if (options.ownerId) {
      andFilters.push({ ownerId: options.ownerId });
    }
    if (options.categoryId) {
      andFilters.push({ categoryId: options.categoryId });
    }
    const tags = this.normalizeTags(options.tags);
    if (tags.length) {
      andFilters.push({ tags: { hasSome: tags } });
    }

    const collections = await this.prisma.storeCollection.findMany({
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
        ...(andFilters.length ? { AND: andFilters } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.queryTake(options.limit),
      select: this.storeCollectionSelect(),
    });

    return collections
      .map((collection) => this.mapStoreCollectionItem(collection))
      .filter((item): item is MarketSectionItemDto => Boolean(item));
  }

  private async getBrandCandidates(options: {
    limit: number;
    excludeIds?: string[];
  }) {
    const productWhere = this.buildMarketableProductWhere([], {
      includeBrandOpen: false,
    });
    const brands = await this.prisma.brand.findMany({
      where: {
        isStoreOpen: true,
        ...(options.excludeIds?.length
          ? { id: { notIn: options.excludeIds } }
          : {}),
        products: {
          some: productWhere,
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: this.queryTake(options.limit),
      select: {
        id: true,
        ownerId: true,
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
    });

    return brands
      .map((brand) => this.mapBrandItem(brand))
      .filter((item): item is MarketSectionItemDto => Boolean(item));
  }

  private productSelect() {
    return {
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
        },
      },
      category: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    } satisfies Prisma.ProductSelect;
  }

  private storeCollectionSelect() {
    return {
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
              saleStartAt: true,
              saleEndAt: true,
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
    } satisfies Prisma.StoreCollectionSelect;
  }

  private buildProductQueryFilter(
    query?: string | null,
  ): Prisma.ProductWhereInput | null {
    const tokens = this.searchTokens(query);
    if (!tokens.length) return null;
    const containsFilters = tokens.slice(0, 4).flatMap((token) => [
      { name: { contains: token, mode: 'insensitive' as const } },
      { description: { contains: token, mode: 'insensitive' as const } },
      { brand: { name: { contains: token, mode: 'insensitive' as const } } },
      {
        category: { name: { contains: token, mode: 'insensitive' as const } },
      },
    ]);

    return {
      OR: [...containsFilters, { tags: { hasSome: tokens.slice(0, 8) } }],
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
      deletedAt: null,
      archivedAt: null,
      ...(options?.includeBrandOpen === false
        ? {}
        : { brand: { isStoreOpen: true } }),
      AND: andFilters,
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
        route: brand.ownerId
          ? `/profile/${encodeURIComponent(brand.ownerId)}?tab=Store`
          : `/store/${encodeURIComponent(brand.id)}`,
      },
      createdAt: brand.createdAt?.toISOString?.() ?? null,
      updatedAt: brand.updatedAt?.toISOString?.() ?? null,
    };
  }

  private dedupeItems(items: MarketSectionItemDto[]) {
    const seen = new Set<string>();
    return items.filter((item) => {
      const key = this.itemKey(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private itemKey(item: MarketSectionItemDto) {
    return `${item.entityType}:${item.sourceId}`;
  }

  private isSuppressedItem(
    item: MarketSectionItemDto,
    scope: MarketSuppressionScope,
  ) {
    const targetKeys = [
      this.targetKey(item.entityType, item.sourceId),
      item.target?.id ? this.targetKey(item.target.type, item.target.id) : null,
    ].filter((key): key is string => Boolean(key));

    if (targetKeys.some((key) => scope.targetKeys.has(key))) return true;
    if (item.brand?.id && scope.brandIds.has(item.brand.id)) return true;
    if (item.category?.id && scope.categoryIds.has(item.category.id))
      return true;
    return false;
  }

  private targetKey(targetType: string, targetId: string) {
    return (
      this.marketSuppressionService?.targetKey(targetType, targetId) ??
      `${targetType}:${targetId}`
    );
  }

  private async getSuppressionScope(identity: MarketSignalIdentity) {
    if (!this.marketSuppressionService) {
      return this.emptySuppressionScope();
    }

    return this.marketSuppressionService.getSuppressionScope({
      userId: identity.userId,
      anonymousSessionId: identity.anonymousSessionId,
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

  private assertTarget(
    actualType: MarketSuggestionTargetType | undefined,
    targetId: string | null,
    expectedType: MarketSuggestionTargetType,
    message: string,
  ) {
    if (actualType !== expectedType || !targetId) {
      throw new BadRequestException(message);
    }
  }

  private defaultTargetTypeForContext(context: MarketSuggestionContext) {
    switch (context) {
      case MarketSuggestionContext.PRODUCT_DETAIL:
        return MarketSuggestionTargetType.PRODUCT;
      case MarketSuggestionContext.COLLECTION_DETAIL:
        return MarketSuggestionTargetType.COLLECTION;
      case MarketSuggestionContext.BRAND_DETAIL:
      case MarketSuggestionContext.BRAND_STORE:
        return MarketSuggestionTargetType.BRAND;
      case MarketSuggestionContext.SEARCH_EMPTY:
        return MarketSuggestionTargetType.QUERY;
      case MarketSuggestionContext.MARKET_SECTION_DETAIL:
        return MarketSuggestionTargetType.SECTION;
      case MarketSuggestionContext.WISHLIST:
        return MarketSuggestionTargetType.QUERY;
    }
  }

  private normalizeLimit(limit?: number) {
    if (typeof limit !== 'number' || !Number.isFinite(limit)) {
      return this.defaultLimit;
    }
    return Math.min(this.maxLimit, Math.max(1, Math.floor(limit)));
  }

  private queryTake(limit: number) {
    return Math.min(this.maxLimit * 2, Math.max(limit + 6, limit));
  }

  private normalizeTags(tags?: string[] | null) {
    if (!Array.isArray(tags)) return [];
    return Array.from(
      new Set(
        tags
          .map((tag) => this.clean(tag))
          .filter((tag): tag is string => Boolean(tag))
          .slice(0, 8),
      ),
    );
  }

  private searchTokens(query?: string | null) {
    const cleaned = this.clean(query);
    if (!cleaned) return [];
    return Array.from(
      new Set(
        cleaned
          .toLowerCase()
          .split(/[\s,]+/)
          .map((token) => token.trim())
          .filter((token) => token.length >= 2)
          .slice(0, 8),
      ),
    );
  }

  private parseExcludedIds(value?: string | null) {
    const cleaned = this.clean(value);
    if (!cleaned) return new Set<string>();
    return new Set(
      cleaned
        .split(',')
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry.length <= 128)
        .slice(0, 100),
    );
  }

  private isExcludedItem(
    item: MarketSectionItemDto,
    excludedIds: Set<string>,
  ) {
    if (excludedIds.size === 0) return false;
    const candidates = [
      item.id,
      item.sourceId,
      item.target?.id,
      item.target?.key,
    ].filter((entry): entry is string => Boolean(entry));
    return candidates.some((entry) => excludedIds.has(entry));
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

  private clean(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private cleanString(value: unknown): string | null {
    return this.clean(value);
  }
}
