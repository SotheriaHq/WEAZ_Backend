import {
  BadRequestException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { MarketPublicMediaService } from './market-public-media.service';
import { eligibleProductWhere } from '../eligibility/market-eligibility';
import {
  MarketCatalogAdmissionException,
  MarketCatalogReadService,
} from './market-catalog-read.service';
import {
  MarketCursorCodec,
  MarketCursorState,
  MarketCursorKey,
  MARKET_CURSOR_TTL_MS,
} from './market-cursor';
import {
  MarketCatalogRequest,
  parseMarketCatalogRequest,
} from './market-catalog-request';
import { CanonicalMarketFilters, marketFilterHash } from './market-filters';
import {
  MarketCatalogScope,
  MarketCatalogViewer,
  createMarketCatalogScope,
  marketCatalogSourceContext,
  marketCatalogViewerContext,
} from './market-catalog-scope';
import { captureMarketReadContext } from './market-read-context';
import {
  readMarketOrderedPage,
  MarketOrderedRow,
} from './market-ordered-reader';
import {
  marketSortAvailability,
  selectMarketSort,
  CatalogSort,
} from './market-sort-availability';
import { marketSnapshotPageSql } from './market-snapshot-order.sql';
import {
  captureMarketCatalogCards,
  hydrateMarketCatalogCards,
} from './market-catalog-cards';
import { readMarketFacets } from './market-facets';
import { validateMarketDimensionLayers } from './market-filter-dictionary';
import { MARKET_FEATURE_MAX_SOURCE_AGE_MS } from '../intelligence/market-intelligence.contracts';
import { rememberReadResource } from '../../auth/access/read-resource-context';
import { marketCatalogProductFiltersSql } from './market-filter.sql';

interface CatalogRow extends MarketOrderedRow {
  score?: number;
  trendEligible?: boolean;
  trendScore?: number | null;
}
export interface MarketLegacySellingOptions {
  readonly sizes: readonly string[];
  readonly colors: readonly string[];
  readonly sizeStock: unknown;
  readonly slug?: string | null;
  readonly isFeatured?: boolean;
  readonly gender?: string;
  readonly saleStartAt?: string | null;
  readonly saleEndAt?: string | null;
  readonly categoryType?: {
    id: string;
    categoryId: string;
    slug: string;
    name: string;
  } | null;
  readonly filters?: readonly {
    dimensionId: string;
    dimensionSlug: string;
    dimensionName: string;
    valueId: string;
    valueSlug: string;
    valueName: string;
  }[];
  readonly gallery?: readonly {
    url: string;
    fileId: string;
    width: number | null;
    height: number | null;
    aspectRatio: number | null;
  }[];
  readonly variants: readonly {
    id: string;
    size: string | null;
    color: string | null;
    stock: number;
    price: string | null;
    sku: string | null;
    colorHex: string | null;
  }[];
}
export type MarketCatalogNotStartedReason =
  | 'ADMISSION'
  | 'CURSOR_CONFIGURATION';
/** The canonical read was refused before any database work began. The public
 * response is unchanged; only a compatibility caller may act on the reason. */
export class MarketCatalogNotStartedException extends ServiceUnavailableException {
  constructor(
    readonly reason: MarketCatalogNotStartedReason,
    response: { readonly code: string; readonly message: string },
  ) {
    super(response);
  }
}
const isOrdered = (
  sort: CatalogSort,
): sort is 'newest' | 'price_asc' | 'price_desc' =>
  ['newest', 'price_asc', 'price_desc'].includes(sort);

@Injectable()
export class MarketCatalogService {
  constructor(
    private readonly reads: MarketCatalogReadService,
    private readonly media: MarketPublicMediaService,
    private readonly config: ConfigService,
  ) {}

  private codec(): MarketCursorCodec {
    try {
      return new MarketCursorCodec(
        this.config.get<string>('MARKET_CURSOR_SECRET') ?? '',
        this.config.get<string>('MARKET_CATALOG_NAMESPACE') ?? '',
        this.config.get<string>('MARKET_CURSOR_SECRET_PREVIOUS') || undefined,
      );
    } catch {
      throw new MarketCatalogNotStartedException('CURSOR_CONFIGURATION', {
        code: 'CATALOGUE_CURSOR_UNAVAILABLE',
        message: 'The catalogue is updating. Please try again shortly.',
      });
    }
  }

  async getPage(
    query: URLSearchParams,
    viewer: MarketCatalogViewer = {},
    trusted?: {
      readonly scope: MarketCatalogScope;
      readonly fixedFilters: CanonicalMarketFilters;
      readonly includeTotal?: boolean;
      readonly includeLegacyOptions?: boolean;
    },
  ) {
    const request = parseMarketCatalogRequest(query);
    const codec = this.codec();
    if (request.cursor) codec.authenticate(request.cursor);
    const scope =
      trusted?.scope ??
      createMarketCatalogScope({ key: 'catalog', version: '1', viewer });
    const fixedFilters = trusted?.fixedFilters ?? {};
    const captured = await this.reads
      .run((tx) =>
        this.capturePage(tx, request, codec, scope, fixedFilters, trusted),
      )
      .catch((error: unknown) => {
        // Only the first admission precedes all database work. A refusal of
        // the later media authorization read is a failure of a query that ran.
        if (error instanceof MarketCatalogAdmissionException)
          throw new MarketCatalogNotStartedException('ADMISSION', {
            code: 'CATALOGUE_BUSY',
            message: 'The catalogue is busy. Please try again shortly.',
          });
        throw error;
      });
    const authorizedGallery = new Map<string, ReadonlySet<string>>();
    const delivery = await this.media.resolve(async (tx) => {
      const { asOf: now } = await captureMarketReadContext(tx, false);
      const expectedMedia = captured.cards.flatMap((card) =>
        (trusted?.includeLegacyOptions
          ? card.product.media.map((media) => media.file)
          : [card.file]
        ).map((file) => ({
          productId: card.product.id,
          file,
          isCover: file.id === card.file.id,
        })),
      );
      const current = captured.cards.length
        ? await tx.$queryRaw<Array<{ id: string; fileIds: string[] }>>(
            Prisma.sql`SELECT p."_id"::text AS id,array_agg(DISTINCT expected."fileId"::text) AS "fileIds"
              FROM (VALUES ${Prisma.join(expectedMedia.map((media) => Prisma.sql`(${media.productId}::uuid,${media.file.id}::uuid,${media.file.assetVersion}::int,${media.isCover}::boolean)`))}) expected("productId","fileId","assetVersion","isCover")
              JOIN "Product" p ON p."_id"=expected."productId"
              JOIN "ProductMedia" media ON media."productId"=p."_id" AND media."fileUploadId"=expected."fileId" AND media."reviewStatus"='APPROVED'
              JOIN "FileUpload" file ON file."_id"=expected."fileId" AND file."assetVersion"=expected."assetVersion"
                AND file."processingStatus"='READY' AND file."originalDeletedAt" IS NULL AND file."mimeType" IN ('image/jpeg','image/png','image/webp','image/avif','image/gif')
              WHERE ${marketCatalogProductFiltersSql([request.filters, fixedFilters], now, 'p', captured.scope)}
              GROUP BY p."_id" HAVING bool_or(expected."isCover") LIMIT 61`,
          )
        : [];
      authorizedGallery.clear();
      for (const product of current)
        authorizedGallery.set(product.id, new Set(product.fileIds));
      const currentIds = current.map((product) => product.id);
      for (const id of currentIds)
        rememberReadResource({ type: 'PRODUCT', id });
      const cards = captured.cards.filter((card) =>
        currentIds.includes(card.product.id),
      );
      const mediaFiles = cards
        .flatMap((card) =>
          trusted?.includeLegacyOptions
            ? card.product.media.map((media) => ({
                file: media.file,
                productId: card.product.id,
              }))
            : [{ file: card.file, productId: card.product.id }],
        )
        .filter((media) =>
          authorizedGallery.get(media.productId)?.has(media.file.id),
        );
      const coverIds = mediaFiles.map((media) => media.file.id);
      const logos = cards
        .filter((card) => !!card.logoFileId)
        .map((card) => ({
          id: card.logoFileId!,
          userId: card.product.brand.owner.id,
          fileType: 'PROFILE_IMAGE' as const,
          userProfileImages: {
            some: {
              userId: card.product.brand.owner.id,
              user: { status: 'ACTIVE' as const },
            },
          },
        }));
      return {
        fileIds: [...coverIds, ...logos.map((logo) => logo.id)],
        value: new Set(currentIds),
        sources: mediaFiles.map((media) => ({
          fileId: media.file.id,
          source: { type: 'PRODUCT' as const, id: media.productId },
        })),
        fileWhere: {
          OR: [
            ...mediaFiles.map((media) => ({
              id: media.file.id,
              assetVersion: media.file.assetVersion,
              productMedias: {
                some: {
                  productId: media.productId,
                  reviewStatus: 'APPROVED' as const,
                  product: eligibleProductWhere(now),
                },
              },
            })),
            ...logos,
          ],
        },
      };
    });
    const signed = await hydrateMarketCatalogCards(captured.cards, {
      getBatchPublicSignedUrls: async (ids) =>
        new Map(
          ids.flatMap((id) =>
            delivery.originals.has(id)
              ? [[id, delivery.originals.get(id)!] as const]
              : [],
          ),
        ),
      getBatchVariantDisplayUrls: async (ids, kind) => {
        const variants =
          delivery.variants.get(kind) ?? new Map<string, string>();
        return new Map(
          ids.flatMap((id) =>
            variants.has(id) ? [[id, variants.get(id)!] as const] : [],
          ),
        );
      },
    });
    const renderable = signed.filter((item) => delivery.value.has(item.id));
    const items = renderable.slice(0, request.limit);
    const hasNextPage = renderable.length > request.limit || captured.lookAhead;
    const lastId =
      renderable.length > request.limit
        ? items[items.length - 1]?.id
        : captured.rows[captured.rows.length - 1]?.id;
    const row = captured.rows.find((value) => value.id === lastId);
    const nextCursor =
      hasNextPage && row
        ? codec.encode({
            v: 1,
            namespace: this.config.get<string>('MARKET_CATALOG_NAMESPACE')!,
            requestedSort: request.sort ?? 'popular',
            sort: captured.sort,
            filterHash: marketFilterHash(request.filters),
            scopeHash: codec.contextHash('scope', captured.scopeContext),
            viewerHash: codec.contextHash('viewer', captured.viewerContext),
            asOf: captured.asOf.getTime(),
            expiresAt: Math.min(
              captured.asOf.getTime() + MARKET_CURSOR_TTL_MS,
              captured.epoch?.acceptUntil.getTime() ?? Infinity,
              (!isOrdered(captured.sort) || captured.scope.trendEvidence) &&
                captured.epoch
                ? captured.epoch.sourceAsOf.getTime() +
                    MARKET_FEATURE_MAX_SOURCE_AGE_MS
                : Infinity,
            ),
            key: this.key(captured.sort, row),
            epoch:
              (!isOrdered(captured.sort) || captured.scope.trendEvidence) &&
              captured.epoch
                ? {
                    id: captured.epoch.id,
                    generation: captured.epoch.generation.toString(),
                    featureVersion: captured.epoch.featureSchemaVersion,
                    policyVersion: captured.epoch.policyVersion,
                  }
                : null,
            price:
              captured.sort === 'price_asc' || captured.sort === 'price_desc'
                ? {
                    snapshot: captured.snapshot,
                    nextChangeAt: captured.nextPriceChangeAt?.getTime() ?? null,
                  }
                : null,
          })
        : null;
    return {
      items,
      pagination: {
        limit: request.limit,
        hasNextPage: !!nextCursor,
        nextCursor,
        reanchored: captured.reanchored,
      },
      availableSorts: captured.availableSorts,
      appliedFilters: request.filters,
      sort: { requested: request.sort ?? 'popular', effective: captured.sort },
      meta: {
        asOf: captured.asOf.toISOString(),
        notice: captured.notice,
        fallbackReason:
          captured.sort !== (request.sort ?? 'popular')
            ? 'INSUFFICIENT_EVIDENCE'
            : null,
      },
      ...(captured.facets ? { facets: captured.facets } : {}),
      ...(captured.total === undefined ? {} : { total: captured.total }),
      ...(captured.legacyOptions === undefined
        ? {}
        : {
            legacyOptions: new Map(
              captured.cards
                .filter((card) =>
                  items.some((item) => item.id === card.product.id),
                )
                .map((card) => [
                  card.product.id,
                  {
                    ...captured.legacyOptions!.get(card.product.id)!,
                    slug: card.product.slug,
                    saleStartAt:
                      card.product.saleStartAt?.toISOString() ?? null,
                    saleEndAt: card.product.saleEndAt?.toISOString() ?? null,
                    gallery: card.product.media.flatMap((media) => {
                      const url = authorizedGallery
                        .get(card.product.id)
                        ?.has(media.file.id)
                        ? delivery.originals.get(media.file.id)
                        : undefined;
                      if (!url) return [];
                      const width =
                          media.file.width && media.file.width > 0
                            ? media.file.width
                            : null,
                        height =
                          media.file.height && media.file.height > 0
                            ? media.file.height
                            : null;
                      return [
                        {
                          url,
                          fileId: media.file.id,
                          width,
                          height,
                          aspectRatio: width && height ? width / height : null,
                        },
                      ];
                    }),
                  },
                ]),
            ),
          }),
    };
  }

  async facets(
    query: URLSearchParams,
    viewer: MarketCatalogViewer = {},
    trusted?: {
      readonly scope: MarketCatalogScope;
      readonly fixedFilters: CanonicalMarketFilters;
    },
  ) {
    const clean = new URLSearchParams(query);
    const surface = clean.get('surface');
    if (
      clean.getAll('surface').length > 1 ||
      (surface && surface !== 'CATALOG')
    )
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Choose a supported facet surface.',
      });
    clean.delete('surface');
    if (
      ['cursor', 'sort', 'limit', 'includeFacets'].some((key) => clean.has(key))
    )
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Facet counts do not accept page controls.',
      });
    const request = parseMarketCatalogRequest(clean);
    if (request.cursor || request.sort)
      throw new BadRequestException({
        code: 'INVALID_FILTER',
        message: 'Facet counts do not accept pagination or sort controls.',
      });
    return this.reads.run(async (tx) => {
      const context = await captureMarketReadContext(tx, false);
      await validateMarketDimensionLayers(tx, [
        request.filters,
        trusted?.fixedFilters ?? {},
        ...(trusted?.scope.filterLayers ?? []),
      ]);
      return readMarketFacets(tx, {
        filters: request.filters,
        fixedFilters: trusted?.fixedFilters,
        now: context.asOf,
        scope:
          trusted?.scope ??
          createMarketCatalogScope({
            key: 'catalog',
            version: '1',
            viewer,
          }),
      });
    });
  }

  private async capturePage(
    tx: Prisma.TransactionClient,
    request: MarketCatalogRequest,
    codec: MarketCursorCodec,
    scope: MarketCatalogScope,
    fixedFilters: CanonicalMarketFilters,
    legacy?: {
      readonly includeTotal?: boolean;
      readonly includeLegacyOptions?: boolean;
    },
  ) {
    const context = await captureMarketReadContext(tx);
    const { asOf } = context;
    await validateMarketDimensionLayers(tx, [
      request.filters,
      fixedFilters,
      ...(scope.filterLayers ?? []),
    ]);
    const viewerContext = await marketCatalogViewerContext(
      tx,
      scope.viewer,
      asOf,
    );
    const scopeContext = createHash('sha256')
      .update(
        JSON.stringify({
          source: marketCatalogSourceContext(scope),
          fixedFilters,
        }),
      )
      .digest('hex');
    const decoded = request.cursor
      ? codec.decode(
          request.cursor,
          {
            requestedSort: request.sort ?? 'popular',
            filterHash: marketFilterHash(request.filters),
            scopeContext,
            viewerContext,
          },
          asOf.getTime(),
        )
      : null;
    let cursor = decoded?.kind === 'valid' ? decoded.cursor : null;
    let reanchored = decoded?.kind === 'reanchor';
    let notice: 'Updated' | 'Prices updated' | null =
      decoded?.kind === 'reanchor' ? decoded.notice : null;
    // A verified ordered continuation keeps its sort; repeating the
    // whole-catalogue evidence probes on every page would not change it.
    let availability = await marketSortAvailability(tx, asOf, cursor, {
      probe: !(cursor && isOrdered(cursor.sort as CatalogSort)),
    });
    if (cursor?.epoch && availability.currentMissing) {
      availability = await marketSortAvailability(tx, asOf, null);
      cursor = null;
      reanchored = true;
      notice = 'Updated';
    }
    if (scope.trendEvidence) {
      if (!availability.epoch)
        throw new ServiceUnavailableException({
          code: 'CATALOGUE_EVIDENCE_UNAVAILABLE',
          message: 'This section is updating. Refresh it shortly.',
        });
      scope = createMarketCatalogScope({
        ...scope,
        trendEvidence: {
          ...scope.trendEvidence,
          epochId: availability.epoch.id,
        },
      });
    }
    const requested = request.sort ?? 'popular';
    const sort =
      cursor && isOrdered(cursor.sort as CatalogSort)
        ? (cursor.sort as CatalogSort)
        : decoded && !availability.available.includes(requested as CatalogSort)
          ? 'newest'
          : selectMarketSort(requested, availability.available);
    if (cursor && cursor.sort !== sort) {
      cursor = null;
      reanchored = true;
      notice = 'Updated';
    }
    const scanLimit = Math.min(61, request.limit * 2 + 1);
    let rows: CatalogRow[],
      snapshot = context.snapshot,
      nextPriceChangeAt: Date | null = null;
    if (isOrdered(sort)) {
      const ordered = await readMarketOrderedPage(tx, {
        filters: request.filters,
        fixedFilters,
        scope,
        sort,
        limit: scanLimit,
        cursor,
        context,
      });
      rows = ordered.rows;
      snapshot = ordered.snapshot;
      nextPriceChangeAt = ordered.nextPriceChangeAt;
      reanchored ||= ordered.reanchored;
      notice = ordered.notice ?? notice;
    } else {
      rows = await tx.$queryRaw<CatalogRow[]>(
        marketSnapshotPageSql({
          epochId: availability.epoch!.id,
          sort,
          filters: request.filters,
          fixedFilters,
          scope,
          now: asOf,
          limit: scanLimit,
          after: cursor?.key,
        }),
      );
    }
    // The final row of a full scan is look-ahead only: it proves that a row
    // exists after the anchor without another query, so a cursor never leads
    // to a page with no candidates. It is never hydrated or used as the anchor.
    const lookAhead = rows.length === scanLimit;
    if (lookAhead) rows = rows.slice(0, -1);
    const cards = await captureMarketCatalogCards(tx, { rows, asOf });
    let total: number | undefined;
    if (legacy?.includeTotal) {
      const counts = await tx.$queryRaw<Array<{ count: string }>>(
        isOrdered(sort)
          ? Prisma.sql`SELECT count(*)::text AS count FROM "Product" p WHERE ${marketCatalogProductFiltersSql([request.filters, fixedFilters], asOf, 'p', scope)}${sort === 'newest' ? Prisma.sql` AND p."firstPublishedAt" IS NOT NULL AND p."firstPublishedAt"<=${asOf.toISOString()}::timestamptz` : Prisma.empty}`
          : marketSnapshotPageSql({
              epochId: availability.epoch!.id,
              sort,
              filters: request.filters,
              fixedFilters,
              scope,
              now: asOf,
              limit: 1,
              countOnly: true,
            }),
      );
      total = Number(counts[0]?.count);
      if (!Number.isSafeInteger(total) || total < 0)
        throw new ServiceUnavailableException({
          code: 'CATALOGUE_COUNT_UNAVAILABLE',
          message: 'The catalogue is updating. Please try again shortly.',
        });
    }
    let legacyOptions:
      | ReadonlyMap<string, MarketLegacySellingOptions>
      | undefined;
    if (legacy?.includeLegacyOptions) {
      const options = cards.length
        ? await tx.$queryRaw<
            Array<{
              id: string;
              options: MarketLegacySellingOptions;
              variantCount: bigint;
              filterCount: bigint;
            }>
          >(Prisma.sql`SELECT p."_id" AS id,
        jsonb_build_object('sizes',p.sizes,'colors',p.colors,'sizeStock',p."sizeStock",'gender',p.gender::text,'isFeatured',p."isFeatured",
          'categoryType',CASE WHEN type."isActive" AND category."isActive" AND type."categoryId"=p."categoryId" THEN jsonb_build_object('id',type."_id",'categoryId',type."categoryId",'slug',type.slug,'name',type.name) ELSE NULL END,
          'filters',COALESCE(filters.rows,'[]'::jsonb),'variants',COALESCE(variants.rows,'[]'::jsonb)) AS options,variants.count AS "variantCount",filters.count AS "filterCount"
        FROM "Product" p
        LEFT JOIN "CollectionCategoryType" type ON type."_id"=p."categoryTypeId"
        LEFT JOIN "CollectionCategory" category ON category."_id"=p."categoryId"
        LEFT JOIN LATERAL (
          SELECT jsonb_agg(jsonb_build_object('id',v."_id",'size',v.size,'color',v.color,'stock',v.stock,'price',v.price::text,'sku',v.sku,'colorHex',v."colorHex") ORDER BY v."_id") AS rows,count(*) AS count
          FROM (SELECT * FROM "ProductVariant" option_variant WHERE option_variant."productId"=p."_id" ORDER BY option_variant."_id" LIMIT 513) v
        ) variants ON true LEFT JOIN LATERAL (
          SELECT jsonb_agg(option_filter.payload ORDER BY option_filter.dimension,option_filter.value) AS rows,count(*) AS count FROM (
            SELECT jsonb_build_object('dimensionId',d."_id",'dimensionSlug',d.slug,'dimensionName',d.name,'valueId',v."_id",'valueSlug',v.slug,'valueName',v.name) AS payload,d.slug AS dimension,v.slug AS value
            FROM "EntityFilter" binding JOIN "FilterValue" v ON v."_id"=binding."filterValueId" AND v."isActive"
            JOIN "FilterDimension" d ON d."_id"=v."dimensionId" AND d."isActive" AND 'PRODUCT'=ANY(d."appliesTo")
            WHERE binding."entityType"='PRODUCT' AND binding."entityId"=p."_id" ORDER BY d.slug,v.slug LIMIT 257
          ) option_filter
        ) filters ON true WHERE p."_id" IN (${Prisma.join(cards.map((card) => Prisma.sql`${card.product.id}::uuid`))})`)
        : [];
      if (
        options.some((row) => row.variantCount > 512n || row.filterCount > 256n)
      )
        throw new ServiceUnavailableException({
          code: 'CATALOGUE_OPTIONS_LIMIT',
          message:
            'The catalogue options are updating. Please try again shortly.',
        });
      legacyOptions = new Map(options.map((row) => [row.id, row.options]));
    }
    const facets = request.includeFacets
      ? await readMarketFacets(tx, {
          filters: request.filters,
          fixedFilters,
          scope,
          now: asOf,
        })
      : undefined;
    return {
      rows,
      cards,
      total,
      legacyOptions,
      lookAhead,
      sort,
      asOf,
      snapshot,
      nextPriceChangeAt,
      reanchored,
      notice,
      facets,
      availableSorts: availability.available,
      epoch: availability.epoch,
      scopeContext,
      viewerContext,
      scope,
    };
  }

  private key(sort: CatalogSort, row: CatalogRow): MarketCursorKey {
    if (sort === 'newest') return [row.firstPublishedAt!.toISOString(), row.id];
    if (sort === 'price_asc' || sort === 'price_desc')
      return [row.amount!.toFixed(2), row.id];
    if (sort === 'trending')
      return [
        row.trendEligible ? 1 : 0,
        row.trendEligible ? row.trendScore! : null,
        row.score!,
        row.id,
      ];
    return [row.score!, row.id];
  }
}
