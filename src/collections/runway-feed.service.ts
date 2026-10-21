import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  RUNWAY_CASUAL_TERMS,
  RUNWAY_AFRICAN_TERMS,
  emptyRunwayAffinity,
  matchesRunwayLane,
  rankRunwayCandidates,
  runwayKey,
  type RunwayAffinity,
  type RunwayKey,
} from './runway-ranking.util';

const isUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const WINDOW_MS = 90 * 86400000;
const SESSION_MS = 30 * 60000;
const AFRICAN_COUNTRIES = new Set([
  'ng',
  'nigeria',
  'gh',
  'ghana',
  'ke',
  'kenya',
  'za',
  'south-africa',
  'sn',
  'senegal',
  'ci',
  'côte-d’ivoire',
  'cote-divoire',
  'ivory-coast',
  'rw',
  'rwanda',
  'tz',
  'tanzania',
  'ug',
  'uganda',
  'cm',
  'cameroon',
  'et',
  'ethiopia',
  'ma',
  'morocco',
  'eg',
  'egypt',
  'tn',
  'tunisia',
  'dz',
  'algeria',
  'bj',
  'benin',
  'tg',
  'togo',
  'bf',
  'burkina-faso',
  'ml',
  'mali',
  'ne',
  'niger',
  'ao',
  'angola',
  'zm',
  'zambia',
  'zw',
  'zimbabwe',
  'bw',
  'botswana',
  'mw',
  'malawi',
  'mz',
  'mozambique',
  'na',
  'namibia',
  'mu',
  'mauritius',
  'ga',
  'gabon',
  'gm',
  'gambia',
  'gn',
  'guinea',
  'sl',
  'sierra-leone',
  'lr',
  'liberia',
  'ls',
  'lesotho',
  'sz',
  'eswatini',
  'sd',
  'sudan',
  'ss',
  'south-sudan',
  'so',
  'somalia',
  'dj',
  'djibouti',
  'er',
  'eritrea',
  'cd',
  'democratic-republic-of-the-congo',
  'cg',
  'congo',
  'cf',
  'central-african-republic',
  'td',
  'chad',
  'gq',
  'equatorial-guinea',
  'mg',
  'madagascar',
  'sc',
  'seychelles',
  'km',
  'comoros',
  'st',
  'sao-tome-and-principe',
  'cv',
  'cabo-verde',
  'gw',
  'guinea-bissau',
  'bi',
  'burundi',
  'mr',
  'mauritania',
  'ly',
  'libya',
]);
const normalized = (value: string) =>
  value
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-');

@Injectable()
export class RunwayFeedService {
  private readonly logger = new Logger(RunwayFeedService.name);
  private readonly candidateCache = new Map<
    string,
    { expiresAt: number; promise: Promise<unknown> }
  >();
  private readonly sourceCache = new Map<
    string,
    { expiresAt: number; promise: Promise<unknown> }
  >();
  constructor(private readonly prisma: PrismaService) {}

  private async candidateIds(
    where: Prisma.CollectionWhereInput,
    take: number,
    popular = false,
    related?: {
      owners?: string[];
      tags?: string[];
      categories?: string[];
      ids?: string[];
      lane?: RunwayKey;
    },
  ) {
    const tag =
      typeof where.tags === 'object' &&
      where.tags &&
      'has' in where.tags &&
      typeof where.tags.has === 'string'
        ? where.tags.has
        : null;
    const category =
      typeof where.category === 'object' &&
      where.category &&
      'slug' in where.category &&
      typeof where.category.slug === 'string'
        ? where.category.slug
        : null;
    const clauses: Prisma.Sql[] = [];
    if (related?.owners?.length)
      clauses.push(
        Prisma.sql`c."ownerId" IN (${Prisma.join(related.owners.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (related?.tags?.length)
      clauses.push(
        Prisma.sql`c.tags && ARRAY[${Prisma.join(related.tags)}]::text[]`,
      );
    if (related?.categories?.length)
      clauses.push(
        Prisma.sql`c."categoryId" IN (${Prisma.join(related.categories.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (related?.ids?.length)
      clauses.push(
        Prisma.sql`c."_id" IN (${Prisma.join(related.ids.map((id) => Prisma.sql`${id}::uuid`))})`,
      );
    if (related?.lane)
      clauses.push(
        Prisma.sql`EXISTS (SELECT 1 FROM "EntityFilter" ef JOIN "FilterValue" fv ON fv."_id" = ef."filterValueId" JOIN "FilterDimension" fd ON fd."_id" = fv."dimensionId" WHERE ef."entityId" = c."_id" AND ef."entityType" IN ('DESIGN','COLLECTION') AND fv."isActive" AND fd."isActive" AND fv.slug IN (${Prisma.join(RUNWAY_CASUAL_TERMS)}))`,
      );
    return this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c."_id" AS id FROM "Collection" c
      WHERE c.domain = 'DESIGN' AND c.status = 'PUBLISHED' AND c.visibility = 'PUBLIC' AND c."deletedAt" IS NULL
        AND EXISTS (SELECT 1 FROM "User" u WHERE u."_id" = c."ownerId" AND u.status = 'ACTIVE')
        ${tag ? Prisma.sql`AND c.tags @> ARRAY[${tag}]::text[]` : Prisma.empty}
        ${category ? Prisma.sql`AND EXISTS (SELECT 1 FROM "CollectionCategory" cat WHERE cat."_id" = c."categoryId" AND cat.slug = ${category})` : Prisma.empty}
        ${related ? Prisma.sql`AND (${clauses.length ? Prisma.join(clauses, ' OR ') : Prisma.sql`FALSE`})` : Prisma.empty}
        ${
          related?.lane === 'african-casual'
            ? Prisma.sql`AND (
          c.tags && ARRAY[${Prisma.join(RUNWAY_AFRICAN_TERMS)}]::text[]
          OR EXISTS (SELECT 1 FROM "Brand" b WHERE b."ownerId" = c."ownerId" AND regexp_replace(lower(trim(b.country)), '[[:space:]_]+', '-', 'g') IN (${Prisma.join([...AFRICAN_COUNTRIES])}))
          OR EXISTS (SELECT 1 FROM "EntityFilter" ef JOIN "FilterValue" fv ON fv."_id" = ef."filterValueId" JOIN "FilterDimension" fd ON fd."_id" = fv."dimensionId" WHERE ef."entityId" = c."_id" AND ef."entityType" IN ('DESIGN','COLLECTION') AND fv."isActive" AND fd."isActive" AND fv.slug IN (${Prisma.join(RUNWAY_AFRICAN_TERMS)}))
        )`
            : Prisma.empty
        }
        AND (SELECT 1 FROM "CollectionMedia" m JOIN "FileUpload" f ON f."_id" = m."fileUploadId"
             WHERE m."collectionId" = c."_id" AND f."processingStatus" = 'READY'
               AND f."originalDeletedAt" IS NULL AND f."s3Url" <> '' LIMIT 1) IS NOT NULL
      ORDER BY ${popular ? Prisma.sql`c."likesCount" DESC` : Prisma.sql`c."createdAt" DESC`}, c."_id" ASC LIMIT ${take}
    `);
  }

  private publicCandidates<T>(
    key: string,
    load: () => Promise<T>,
    cache = this.candidateCache,
  ): Promise<T> {
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now)
      return existing.promise as Promise<T>;
    for (const [cacheKey, entry] of cache)
      if (entry.expiresAt <= now) cache.delete(cacheKey);
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    const promise = load();
    cache.set(key, { expiresAt: now + 10000, promise });
    void promise.catch(() => {
      if (cache.get(key)?.promise === promise) cache.delete(key);
    });
    return promise;
  }

  @Cron(CronExpression.EVERY_HOUR)
  async expireSessions() {
    await Promise.all([
      this.prisma.runwayFeedSession.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }),
      this.prisma.runwayAffinityCache.deleteMany({
        where: { expiresAt: { lt: new Date() } },
      }),
    ]);
  }

  private async affinity(
    userId: string | undefined,
    key: RunwayKey,
    now: Date,
  ): Promise<RunwayAffinity> {
    const result = emptyRunwayAffinity();
    if (!userId) return result;
    const [reset, cached] = await Promise.all([
      this.prisma.personalizationReset.findFirst({
        where: { userId, resetType: { in: ['FEED', 'ALL'] } },
        orderBy: { resetAt: 'desc' },
      }),
      this.prisma.runwayAffinityCache.findUnique({ where: { userId } }),
    ]);
    if (
      cached &&
      (cached.payload as Record<string, unknown>)?.version === 'runway-v2' &&
      cached.expiresAt > now &&
      (!reset || cached.builtAt >= reset.resetAt)
    ) {
      const payload = cached.payload as Record<string, unknown>;
      for (const name of ['brands', 'tags', 'categories', 'fashion'] as const)
        result[name] = new Map(payload[name] as Array<[string, number]>);
      result.seen = new Set(payload.seen as string[]);
      result.negative = new Set(payload.negative as string[]);
      return result;
    }
    const since = new Date(
      Math.max(now.getTime() - WINDOW_MS, reset?.resetAt.getTime() ?? 0),
    );
    const [
      reactions,
      comments,
      saved,
      signals,
      purchases,
      patches,
      designReactions,
      standardPurchases,
    ] = await Promise.all([
      this.prisma.collectionMediaReaction.findMany({
        where: { userId, type: 'THREAD', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { createdAt: true, media: { select: { collectionId: true } } },
      }),
      this.prisma.commentV2.findMany({
        where: {
          userId,
          deletedAt: null,
          targetType: { in: ['DESIGN', 'COLLECTION', 'COLLECTION_MEDIA'] },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { targetId: true, targetType: true, createdAt: true },
      }),
      this.prisma.savedItem.findMany({
        where: {
          userId,
          targetType: { in: ['DESIGN', 'COLLECTION', 'COLLECTION_MEDIA'] },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { targetId: true, targetType: true, createdAt: true },
      }),
      this.prisma.userFeedSignal.findMany({
        where: {
          userId,
          targetType: 'DESIGN',
          createdAt: { gte: since },
          signalType: {
            in: [
              'DWELL_MEDIUM',
              'DWELL_LONG',
              'SHARE',
              'PROFILE_TAP',
              'SCROLL_SKIP',
              'NOT_INTERESTED',
              'IMPRESSION',
              'ITEM_IMPRESSION',
            ],
          },
        },
        orderBy: { createdAt: 'desc' },
        take: 400,
        select: { targetId: true, signalType: true, createdAt: true },
      }),
      this.prisma.customOrder.findMany({
        where: {
          buyerId: userId,
          paymentStatus: 'PAID',
          cancelledAt: null,
          status: {
            notIn: ['REJECTED_BY_BRAND', 'CANCELLED_BY_BUYER_PRE_ACCEPTANCE'],
          },
          sourceType: 'DESIGN',
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { sourceId: true, createdAt: true },
      }),
      this.prisma.patchConnection.findMany({
        where: {
          requesterId: userId,
          status: 'ACCEPTED',
          createdAt: { gte: since },
        },
        take: 100,
        orderBy: { createdAt: 'desc' },
        select: { targetId: true },
      }),
      this.prisma.collectionReaction.findMany({
        where: { userId, type: 'THREAD', createdAt: { gte: since } },
        orderBy: { createdAt: 'desc' },
        take: 150,
        select: { collectionId: true, createdAt: true },
      }),
      this.prisma.order.findMany({
        where: {
          buyerId: userId,
          paymentStatus: 'PAID',
          status: { not: 'CANCELLED' },
          createdAt: { gte: since },
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: { createdAt: true, brand: { select: { ownerId: true } } },
      }),
    ]);
    const mediaTargets = [...comments, ...saved]
      .filter(
        (row) => row.targetType === 'COLLECTION_MEDIA' && isUuid(row.targetId),
      )
      .map((row) => row.targetId);
    const medias = mediaTargets.length
      ? await this.prisma.collectionMedia.findMany({
          where: { id: { in: mediaTargets } },
          select: { id: true, collectionId: true },
        })
      : [];
    const mediaMap = new Map(medias.map((row) => [row.id, row.collectionId]));
    const votes = new Map<string, number>();
    const voted = new Set<string>();
    const add = (
      id: string | undefined,
      kind: string,
      weight: number,
      at: Date,
    ) => {
      if (!id || !isUuid(id) || voted.has(`${kind}:${id}`)) return;
      voted.add(`${kind}:${id}`);
      votes.set(
        id,
        (votes.get(id) ?? 0) +
          weight *
            (0.65 * Math.exp(-(now.getTime() - at.getTime()) / (7 * 86400000)) +
              0.35 *
                Math.exp(-(now.getTime() - at.getTime()) / (45 * 86400000))),
      );
    };
    reactions.forEach((row) =>
      add(row.media.collectionId, 'thread', 2, row.createdAt),
    );
    designReactions.forEach((row) =>
      add(row.collectionId, 'thread', 2, row.createdAt),
    );
    comments.forEach((row) =>
      add(
        row.targetType === 'COLLECTION_MEDIA'
          ? mediaMap.get(row.targetId)
          : row.targetId,
        'comment',
        3,
        row.createdAt,
      ),
    );
    saved.forEach((row) =>
      add(
        row.targetType === 'COLLECTION_MEDIA'
          ? mediaMap.get(row.targetId)
          : row.targetId,
        'save',
        4,
        row.createdAt,
      ),
    );
    purchases.forEach((row) => add(row.sourceId, 'purchase', 5, row.createdAt));
    for (const row of signals) {
      if (!isUuid(row.targetId)) continue;
      if (['IMPRESSION', 'ITEM_IMPRESSION'].includes(row.signalType))
        result.seen.add(row.targetId);
      else if (['SCROLL_SKIP', 'NOT_INTERESTED'].includes(row.signalType)) {
        if (row.signalType === 'NOT_INTERESTED')
          result.negative.add(row.targetId);
        add(
          row.targetId,
          row.signalType,
          row.signalType === 'NOT_INTERESTED' ? -4 : -0.5,
          row.createdAt,
        );
      } else
        add(
          row.targetId,
          row.signalType,
          row.signalType === 'SHARE' ? 3 : 1,
          row.createdAt,
        );
    }
    const designs = votes.size
      ? await this.prisma.collection.findMany({
          where: {
            id: { in: [...votes.keys()] },
            domain: 'DESIGN',
            deletedAt: null,
          },
          select: { id: true, ownerId: true, tags: true, categoryId: true },
        })
      : [];
    const fashionRows = designs.length
      ? await this.prisma.entityFilter.findMany({
          where: {
            entityType: { in: ['DESIGN', 'COLLECTION'] },
            entityId: { in: designs.map((row) => row.id) },
            filterValue: { isActive: true, dimension: { isActive: true } },
          },
          select: { entityId: true, filterValue: { select: { id: true } } },
        })
      : [];
    const bump = (map: Map<string, number>, id: string, weight: number) =>
      map.set(id, (map.get(id) ?? 0) + weight);
    for (const design of designs) {
      const weight = Math.min(12, votes.get(design.id) ?? 0);
      if (design.ownerId === userId) continue;
      bump(result.brands, design.ownerId, weight);
      if (design.categoryId) bump(result.categories, design.categoryId, weight);
      design.tags.forEach((tag) => bump(result.tags, normalized(tag), weight));
    }
    patches.forEach((row) => bump(result.brands, row.targetId, 8));
    standardPurchases.forEach((row) => {
      if (row.brand.ownerId !== userId)
        bump(
          result.brands,
          row.brand.ownerId,
          5 *
            Math.exp(
              -(now.getTime() - row.createdAt.getTime()) / (45 * 86400000),
            ),
        );
    });
    for (const row of fashionRows)
      bump(
        result.fashion,
        row.filterValue.id,
        Math.min(12, votes.get(row.entityId) ?? 0),
      );
    const trim = (map: Map<string, number>) =>
      [...map].sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 64);
    for (const name of ['brands', 'tags', 'categories', 'fashion'] as const)
      result[name] = new Map(trim(result[name]));
    const payload = {
      version: 'runway-v2',
      brands: [...result.brands],
      tags: [...result.tags],
      categories: [...result.categories],
      fashion: [...result.fashion],
      seen: [...result.seen],
      negative: [...result.negative],
    };
    const snapshot = {
      payload,
      builtAt: now,
      expiresAt: new Date(now.getTime() + 30000),
    };
    await this.prisma.runwayAffinityCache.upsert({
      where: { userId },
      create: { userId, ...snapshot },
      update: snapshot,
    });
    return result;
  }

  async page(
    where: Prisma.CollectionWhereInput,
    userId: string | undefined,
    category: string | undefined,
    cursor: string | undefined,
    take: number,
  ) {
    const startedAt = performance.now();
    const key = runwayKey(category);
    const now = new Date();
    const scope =
      key +
      ':' +
      createHash('sha256')
        .update(JSON.stringify(where))
        .digest('hex')
        .slice(0, 32);
    let ids: string[];
    let sessionId: string;
    let offset = 0;
    if (cursor?.startsWith('rw_')) {
      const match =
        /^rw_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_(\d+)$/.exec(
          cursor,
        );
      if (!match || !Number.isSafeInteger(Number(match[2])))
        throw new BadRequestException('Invalid Runway cursor');
      sessionId = match[1];
      offset = Number(match[2]);
      const session = await this.prisma.runwayFeedSession.findFirst({
        where: {
          id: sessionId,
          userId: userId ?? null,
          categoryKey: scope,
          expiresAt: { gt: now },
        },
      });
      if (!session) return { ids: [], hasNextPage: false, nextCursor: null };
      if (userId) {
        const reset = await this.prisma.personalizationReset.findFirst({
          where: {
            userId,
            resetType: { in: ['FEED', 'ALL'] },
            resetAt: { gt: session.createdAt },
          },
          select: { id: true },
        });
        if (reset) return { ids: [], hasNextPage: false, nextCursor: null };
      }
      ids = session.designIds;
    } else {
      const select = {
        id: true,
        ownerId: true,
        tags: true,
        categoryId: true,
        createdAt: true,
        updatedAt: true,
        threadsCount: true,
        commentsCount: true,
        viewsCount: true,
        collectionCollabsCount: true,
        owner: { select: { brand: { select: { id: true, country: true } } } },
      } as const;
      const read = async (
        take: number,
        popular = false,
        related?: Parameters<RunwayFeedService['candidateIds']>[3],
      ) => {
        const load = async () => {
          const ids = await this.candidateIds(where, take, popular, related);
          return ids.length
            ? this.prisma.collection.findMany({
                where: {
                  AND: [where, { id: { in: ids.map((row) => row.id) } }],
                },
                select,
              })
            : [];
        };
        return related
          ? this.publicCandidates(
              'source:' + JSON.stringify([where, take, popular, related]),
              load,
              this.sourceCache,
            )
          : load();
      };
      const [[fresh, popular], affinity] = await Promise.all([
        this.publicCandidates(JSON.stringify(where), () =>
          Promise.all([read(160), read(80, true)]),
        ),
        this.affinity(userId, key, now),
      ]);
      const top = (map: Map<string, number>) =>
        [...map]
          .filter(([, weight]) => weight > 0)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map((entry) => entry[0]);
      const fashionIds = top(affinity.fashion);
      // Cap every feature lookup before merging: a common facet must not scan
      // or sort its full history, or crowd out a shopper's favourite brands.
      const fashionMatches = fashionIds.length
        ? await this.prisma.$queryRaw<Array<{ entityId: string }>>(Prisma.sql`
        SELECT matches."entityId" FROM unnest(ARRAY[${Prisma.join(fashionIds.map((id) => Prisma.sql`${id}::uuid`))}]::uuid[]) feature(id)
        CROSS JOIN LATERAL (
          SELECT ef."entityId" FROM "EntityFilter" ef
          WHERE ef."filterValueId" = feature.id AND ef."entityType" IN ('DESIGN','COLLECTION')
          ORDER BY ef."createdAt" DESC, ef."entityId" ASC LIMIT ${Math.ceil(160 / fashionIds.length)}
        ) matches LIMIT 160
      `)
        : [];
      const owners = top(affinity.brands).sort();
      const tags = top(affinity.tags).sort();
      const categories = top(affinity.categories).sort();
      const fashionDesignIds = [
        ...new Set(fashionMatches.map((row) => row.entityId)),
      ].sort();
      const [brandRows, tagRows, categoryRows, fashionRows, laneRows] =
        await Promise.all([
          owners.length ? read(40, false, { owners }) : [],
          tags.length ? read(32, false, { tags }) : [],
          categories.length ? read(24, false, { categories }) : [],
          fashionDesignIds.length
            ? read(24, false, { ids: fashionDesignIds })
            : [],
          ['african-casual', 'casual-style'].includes(key)
            ? read(120, false, { tags: RUNWAY_CASUAL_TERMS, lane: key })
            : [],
        ]);
      const personal = [
        ...brandRows,
        ...tagRows,
        ...categoryRows,
        ...fashionRows,
      ];
      const pool = [
        ...new Map(
          [...laneRows, ...personal, ...fresh, ...popular].map((row) => [
            row.id,
            row,
          ]),
        ).values(),
      ];
      const metadataKey =
        'metadata:' +
        createHash('sha256')
          .update(
            pool
              .map((row) => row.id)
              .sort()
              .join(','),
          )
          .digest('hex');
      const [mediaCounts, filters] = pool.length
        ? await this.publicCandidates(
            metadataKey,
            () =>
              Promise.all([
                this.prisma.collectionMedia.groupBy({
                  by: ['collectionId'],
                  where: {
                    collectionId: { in: pool.map((row) => row.id) },
                    file: {
                      processingStatus: 'READY',
                      originalDeletedAt: null,
                      s3Url: { not: '' },
                    },
                  },
                  _count: { _all: true },
                }),
                this.prisma.entityFilter.findMany({
                  where: {
                    entityType: { in: ['DESIGN', 'COLLECTION'] },
                    entityId: { in: pool.map((row) => row.id) },
                    filterValue: {
                      isActive: true,
                      dimension: { isActive: true },
                    },
                  },
                  select: {
                    entityId: true,
                    filterValue: { select: { id: true, slug: true } },
                  },
                }),
              ]),
            this.sourceCache,
          )
        : [[], []];
      const countById = new Map(
        mediaCounts.map((row) => [row.collectionId, row._count._all]),
      );
      const features = new Map<string, string[]>();
      for (const filter of filters)
        features.set(filter.entityId, [
          ...(features.get(filter.entityId) ?? []),
          filter.filterValue.id,
        ]);
      const classifications = new Map<string, string[]>();
      for (const filter of filters)
        classifications.set(filter.entityId, [
          ...(classifications.get(filter.entityId) ?? []),
          filter.filterValue.slug,
        ]);
      const candidates = pool
        .filter((row) => {
          const terms = [...row.tags, ...(classifications.get(row.id) ?? [])];
          if (AFRICAN_COUNTRIES.has(normalized(row.owner.brand?.country ?? '')))
            terms.push('african');
          return matchesRunwayLane(key, terms);
        })
        .map((row) => ({
          ...row,
          mediaCount: countById.get(row.id) ?? 0,
          fashionFeatures: features.get(row.id) ?? [],
        }));
      sessionId = randomUUID();
      ids = rankRunwayCandidates(
        candidates,
        key,
        sessionId,
        affinity,
        now.getTime(),
      ).map((row) => row.id);
      await this.prisma.runwayFeedSession.create({
        data: {
          id: sessionId,
          userId: userId ?? null,
          categoryKey: scope,
          designIds: ids,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SESSION_MS),
        },
      });
    }
    const hidden =
      userId && ids.length
        ? await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT c."_id" AS id FROM "Collection" c
      LEFT JOIN "Brand" b ON b."ownerId" = c."ownerId"
      WHERE c."_id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
      AND EXISTS (
        SELECT 1 FROM user_content_suppressions s
        WHERE s."userId" = ${userId}::uuid AND (s."expiresAt" IS NULL OR s."expiresAt" > ${now})
          AND s."suppressionType" IN ('HIDE_ITEM', 'HIDE_BRAND', 'HIDE_CATEGORY', 'NOT_INTERESTED')
          AND ((s."targetType" IN ('DESIGN', 'COLLECTION') AND s."targetId" = c."_id"::text)
            OR (s."suppressionType" = 'HIDE_BRAND' AND (s."brandId" = b."_id" OR s."targetId" IN (b."_id"::text, c."ownerId"::text)))
            OR (s."suppressionType" = 'HIDE_CATEGORY' AND (s."categoryId" = c."categoryId" OR s."targetId" = c."categoryId"::text)))
      )
    `)
        : [];
    const hiddenIds = new Set(hidden.map((row) => row.id));
    const page: string[] = [];
    while (offset < ids.length && page.length < take) {
      const id = ids[offset++];
      if (!hiddenIds.has(id)) page.push(id);
    }
    this.logger.log(
      JSON.stringify({
        event: 'runway.page',
        version: 'runway-v2',
        lane: key,
        sessionPage: Boolean(cursor),
        candidates: ids.length,
        served: page.length,
        durationMs: Math.round(performance.now() - startedAt),
      }),
    );
    return {
      ids: page,
      hasNextPage: offset < ids.length,
      nextCursor: offset < ids.length ? `rw_${sessionId}_${offset}` : null,
    };
  }
}
