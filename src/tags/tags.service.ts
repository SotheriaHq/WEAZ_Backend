import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  AdminAuditAction,
  CollectionStatus,
  CollectionVisibility,
  TagStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TagIndexService } from './tag-index.service';
import * as crypto from 'crypto';
import { TAG_ENTITY_TYPE } from './tag-entity-type';
import { AdminAuditService } from 'src/admin/services/admin-audit.service';
import {
  canonicalUserProfileSelect,
  resolveProfileImage,
} from 'src/common/user-profile-source.helper';
import {
  canonicalBrandProfileSelect,
  resolveRequiredBrandField,
  resolveBrandTags,
} from 'src/common/brand-profile-source.helper';

type TagFeedItem =
  | {
      id: string;
      entityType: 'COLLECTION';
      taggedAt: string;
      data: {
        id: string;
        title: string | null;
        description: string | null;
        tags: string[];
        createdAt: string;
        owner: {
          id: string;
          username: string;
          brandFullName: string | null;
          profileImage: string | null;
        };
      };
    }
  | {
      id: string;
      entityType: 'PRODUCT';
      taggedAt: string;
      data: {
        id: string;
        name: string;
        description: string | null;
        tags: string[];
        thumbnail: string | null;
        price: number;
        salePrice: number | null;
        currency: string;
        createdAt: string;
        brand: {
          id: string;
          name: string;
          logo: string | null;
        };
      };
    }
  | {
      id: string;
      entityType: 'BRAND' | 'USER_BRAND';
      taggedAt: string;
      data: {
        id: string;
        displayName: string;
        username: string | null;
        profileImage: string | null;
        tags: string[];
      };
    };

type TagAdminRow = {
  name: string;
  displayName: string;
  usageCount: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  isBanned: boolean;
  aliasOfTagName: string | null;
  createdById: string | null;
  createdBy: {
    id: string;
    username: string | null;
    brandFullName: string | null;
    profileImage: string | null;
  } | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type TagLifecycleStage = 'all' | 'pending' | 'approved' | 'rejected';

type TagStatusValue = 'PENDING' | 'APPROVED' | 'REJECTED';

type TagVisibilityOptions = {
  viewerId?: string | null;
  isSuperAdmin?: boolean;
};

type TagAdminSortMode = 'recent' | 'popular' | 'last-used' | 'name-asc';

type TagLifecycleEvent = {
  id: string;
  type:
    | 'TAG_CREATED'
    | 'FIRST_USAGE'
    | 'LAST_USAGE'
    | 'STATUS_PENDING'
    | 'STATUS_APPROVED'
    | 'STATUS_REJECTED'
    | 'ALIASED_TO'
    | 'TAG_UPDATED';
  at: string;
  summary: string;
};

type TagLifecycleActor = {
  userId: string;
  username: string | null;
  brandFullName: string | null;
  profileImage: string | null;
  usageCount: number;
  latestTaggedAt: string | null;
};

type TagGroupedBindingRow = {
  entityType: string;
  entityId: string;
  _count?: {
    _all?: number | bigint | null;
  } | null;
  _max?: {
    createdAt?: Date | null;
  } | null;
};

@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagIndex: TagIndexService,
    @Optional() private readonly adminAudit?: AdminAuditService,
  ) {}

  private async recordTagAudit(params: {
    actorUserId?: string | null;
    operation: string;
    targetId: string;
    previousState?: Record<string, unknown>;
    newState?: Record<string, unknown>;
  }) {
    if (!params.actorUserId || !this.adminAudit) return;
    await this.adminAudit.safeLog({
      actorUserId: params.actorUserId,
      action: AdminAuditAction.ADMIN_TAG_MODERATE,
      targetType: 'Tag',
      targetId: params.targetId,
      metadata: { operation: params.operation },
      previousState: params.previousState,
      newState: params.newState,
    });
  }

  private mapOwnerDisplay(user: any) {
    return {
      id: user.id,
      username: user.username,
      brandFullName: resolveRequiredBrandField(user, 'brandFullName') || null,
      profileImage: resolveProfileImage(user).url,
    };
  }

  private mapBrandUserDisplay(user: any) {
    const displayName =
      resolveRequiredBrandField(user, 'brandFullName') || user.username;
    return {
      id: user.id,
      displayName,
      username: user.username,
      profileImage: user.brand?.logo ?? resolveProfileImage(user).url,
      tags: resolveBrandTags(user),
    };
  }

  private clampLimit(input: number | undefined, min = 1, max = 100): number {
    const parsed = Number.isFinite(input) ? Number(input) : min;
    return Math.min(max, Math.max(min, parsed || min));
  }

  private normalizeLookup(input: string): string {
    return this.tagIndex.normalizeTagName(input);
  }

  private normalizeDisplayName(input: string): string {
    return String(input ?? '')
      .trim()
      .replace(/^#+/, '')
      .replace(/\s+/g, ' ')
      .slice(0, 64);
  }

  private parseTrendingWindow(window?: string): number {
    const normalized = (window || '24h').trim().toLowerCase();
    if (normalized === '1h') return 1 * 60 * 60 * 1000;
    if (normalized === '24h') return 24 * 60 * 60 * 1000;
    if (normalized === '7d') return 7 * 24 * 60 * 60 * 1000;
    throw new BadRequestException(
      'Invalid window. Supported values: 1h, 24h, 7d',
    );
  }

  private parseLifecycleStage(state?: string): TagLifecycleStage {
    const normalized = String(state ?? 'all')
      .trim()
      .toLowerCase();
    if (normalized === 'pending') return 'pending';
    if (normalized === 'approved') return 'approved';
    if (normalized === 'rejected') return 'rejected';
    return 'all';
  }

  private parseTagStatus(input?: string | TagStatus | null): TagStatusValue {
    const normalized = String(input ?? '')
      .trim()
      .toUpperCase();
    if (normalized === 'PENDING') return 'PENDING';
    if (normalized === 'REJECTED') return 'REJECTED';
    return 'APPROVED';
  }

  private parseModerationStatus(input?: string): TagStatusValue {
    const normalized = String(input ?? '')
      .trim()
      .toUpperCase();
    if (normalized === 'PENDING') return 'PENDING';
    if (normalized === 'REJECTED') return 'REJECTED';
    return 'APPROVED';
  }

  private mapLegacyLifecycleStage(row: {
    status?: TagStatus | string | null;
    isBanned?: boolean;
    aliasOfTagId?: string | null;
    usageCount: number;
  }): 'LIVE' | 'REJECTED' | 'ALIAS' | 'DORMANT' {
    if (row.aliasOfTagId) return 'ALIAS';
    const status = this.parseTagStatus(row.status as any);
    if (row.isBanned || status === 'REJECTED') return 'REJECTED';
    if (status === 'PENDING') return 'DORMANT';
    if ((row.usageCount ?? 0) <= 0) return 'DORMANT';
    return 'LIVE';
  }

  private parseAdminSort(sort?: string): TagAdminSortMode {
    const normalized = String(sort ?? 'recent')
      .trim()
      .toLowerCase();
    if (normalized === 'popular') return 'popular';
    if (normalized === 'last-used') return 'last-used';
    if (normalized === 'name-asc') return 'name-asc';
    return 'recent';
  }

  private isTagVisibleToViewer(
    tag: {
      status?: TagStatus | null;
      isBanned?: boolean;
      createdById?: string | null;
    },
    viewerId?: string | null,
    isSuperAdmin = false,
  ): boolean {
    if (isSuperAdmin) return true;

    const status = (tag.status ??
      (tag.isBanned ? TagStatus.REJECTED : TagStatus.APPROVED)) as TagStatus;
    if (status === TagStatus.APPROVED && !tag.isBanned) return true;
    if (
      status === TagStatus.PENDING &&
      viewerId &&
      tag.createdById === viewerId
    )
      return true;
    return false;
  }

  private async queryAdminTagRows(params: {
    query?: string;
    cursor?: string;
    limit?: number;
    includeBanned?: boolean;
    sort?: TagAdminSortMode;
    state?: TagLifecycleStage;
  }): Promise<{ items: TagAdminRow[]; nextCursor: string | null }> {
    const take = this.clampLimit(params.limit, 1, 100);
    const normalizedQuery = this.normalizeLookup(params.query ?? '');

    const where: Record<string, any> = {};
    if (normalizedQuery) {
      where.normalizedName = { startsWith: normalizedQuery };
    }

    const state = this.parseLifecycleStage(params.state);
    if (state === 'pending') {
      where.status = TagStatus.PENDING;
      where.isBanned = false;
    } else if (state === 'approved') {
      where.status = TagStatus.APPROVED;
      where.isBanned = false;
    } else if (state === 'rejected') {
      where.OR = [{ status: TagStatus.REJECTED }, { isBanned: true }];
    } else if (!params.includeBanned) {
      where.status = { not: TagStatus.REJECTED };
      where.isBanned = false;
    }

    const sort = this.parseAdminSort(params.sort);
    const orderBy =
      sort === 'popular'
        ? [
            { usageCount: 'desc' },
            { lastUsedAt: 'desc' },
            { normalizedName: 'asc' },
          ]
        : sort === 'last-used'
          ? [
              { lastUsedAt: 'desc' },
              { usageCount: 'desc' },
              { normalizedName: 'asc' },
            ]
          : sort === 'name-asc'
            ? [{ normalizedName: 'asc' }]
            : [{ createdAt: 'desc' }, { normalizedName: 'asc' }];

    const rows = await (this.prisma as any).tag.findMany({
      where,
      orderBy,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      take: take + 1,
      select: {
        id: true,
        normalizedName: true,
        displayName: true,
        usageCount: true,
        status: true,
        isBanned: true,
        aliasOfTagId: true,
        aliasOfTag: {
          select: {
            normalizedName: true,
          },
        },
        createdById: true,
        createdBy: {
          select: {
            id: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: canonicalBrandProfileSelect },
          },
        },
        createdAt: true,
        lastUsedAt: true,
      },
    });

    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;

    return {
      items: pageRows.map((row: any) => ({
        name: row.normalizedName,
        displayName: row.displayName,
        usageCount: row.usageCount,
        status: this.parseTagStatus(row.status),
        isBanned: row.isBanned,
        aliasOfTagName: row.aliasOfTag?.normalizedName ?? null,
        createdById: row.createdById ?? null,
        createdBy: row.createdBy ? this.mapOwnerDisplay(row.createdBy) : null,
        createdAt: row.createdAt.toISOString(),
        lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
      })),
      nextCursor: hasMore ? (pageRows[pageRows.length - 1]?.id ?? null) : null,
    };
  }

  async getAdminTagQueue(params: {
    cursor?: string;
    limit?: number;
    includeBanned?: boolean;
    sort?: TagAdminSortMode;
    state?: TagLifecycleStage;
  }) {
    return this.queryAdminTagRows({
      cursor: params.cursor,
      limit: params.limit,
      includeBanned: params.includeBanned,
      sort: params.sort ?? 'recent',
      state: params.state,
    });
  }

  async searchAdminTags(
    query: string,
    limit = 50,
    includeBanned = false,
    sort: TagAdminSortMode = 'popular',
    state?: TagLifecycleStage,
  ) {
    const rows = await this.queryAdminTagRows({
      query,
      limit,
      includeBanned,
      sort,
      state,
    });

    return rows.items;
  }

  async updateTagMetadata(
    inputName: string,
    payload: { displayName?: string },
    actorUserId?: string | null,
  ) {
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new BadRequestException('Invalid tag');

    const nextDisplayName = payload.displayName
      ? this.normalizeDisplayName(payload.displayName)
      : '';
    if (!nextDisplayName) {
      throw new BadRequestException('Display name is required');
    }

    const previous = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        normalizedName: true,
        displayName: true,
        status: true,
        isBanned: true,
      },
    });

    const updated = await (this.prisma as any).tag.upsert({
      where: { normalizedName },
      create: {
        id: crypto.randomUUID(),
        normalizedName,
        displayName: nextDisplayName,
      },
      update: {
        displayName: nextDisplayName,
      },
      select: {
        normalizedName: true,
        displayName: true,
        updatedAt: true,
      },
    });
    await this.recordTagAudit({
      actorUserId,
      operation: 'tag_metadata_updated',
      targetId: updated.normalizedName,
      previousState: previous ?? undefined,
      newState: {
        normalizedName: updated.normalizedName,
        displayName: updated.displayName,
      },
    });

    return {
      name: updated.normalizedName,
      displayName: updated.displayName,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  /**
   * Returns popular tags from the unified tag index.
   * Falls back to legacy aggregation if index is empty.
   */
  async getPopularTags(
    limit = 50,
    options?: TagVisibilityOptions,
  ): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 200);
    const viewerId = options?.viewerId ?? null;
    const isSuperAdmin = Boolean(options?.isSuperAdmin);

    const visibilityWhere = !isSuperAdmin
      ? {
          OR: [
            { status: TagStatus.APPROVED, isBanned: false },
            ...(viewerId
              ? [
                  {
                    status: TagStatus.PENDING,
                    createdById: viewerId,
                    isBanned: false,
                  },
                ]
              : []),
          ],
        }
      : {};

    const indexed = await (this.prisma as any).tag.findMany({
      where: {
        aliasOfTagId: null,
        OR: [
          { usageCount: { gt: 0 } },
          { status: TagStatus.APPROVED, isBanned: false },
        ],
        ...visibilityWhere,
      },
      orderBy: [
        { usageCount: 'desc' },
        { lastUsedAt: 'desc' },
        { normalizedName: 'asc' },
      ],
      take,
      select: { normalizedName: true, usageCount: true },
    });

    if (indexed.length > 0) {
      return indexed.map((row: any) => ({
        tag: row.normalizedName,
        count: row.usageCount,
      }));
    }

    const now = new Date();
    const [collections, products, brands] = await Promise.all([
      this.prisma.collection.findMany({
        where: {
          status: 'PUBLISHED',
          visibility: CollectionVisibility.PUBLIC,
          deletedAt: null,
        },
        select: { tags: true },
        take: 5000,
      }),
      this.prisma.product.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          archivedAt: null,
          OR: [{ publishAt: null }, { publishAt: { lte: now } }],
        },
        select: { tags: true },
        take: 5000,
      }),
      this.prisma.brand.findMany({
        where: { isStoreOpen: true },
        select: { tags: true },
        take: 5000,
      }),
    ]);

    const counts = new Map<string, number>();
    const bump = (tag: string | null | undefined) => {
      const normalized = this.normalizeLookup(tag || '');
      if (!normalized) return;
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    };
    for (const c of collections) for (const t of c.tags ?? []) bump(t);
    for (const p of products) for (const t of p.tags ?? []) bump(t);
    for (const b of brands) for (const t of b.tags ?? []) bump(t);

    const ranked = Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count);

    if (ranked.length === 0) return [];

    const tagRows = await (this.prisma as any).tag.findMany({
      where: {
        normalizedName: { in: ranked.map((entry) => entry.tag) },
      },
      select: {
        normalizedName: true,
        status: true,
        isBanned: true,
        createdById: true,
      },
    });
    const tagMetaByName = new Map(
      tagRows.map((row: any) => [row.normalizedName, row] as const),
    );

    return ranked
      .filter((entry) => {
        const meta = tagMetaByName.get(entry.tag);
        if (!meta) return isSuperAdmin;
        return this.isTagVisibleToViewer(meta, viewerId, isSuperAdmin);
      })
      .slice(0, take);
  }

  async searchTags(
    query: string,
    limit = 10,
    options?: TagVisibilityOptions,
  ): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 100);
    const normalized = this.normalizeLookup(query);
    const viewerId = options?.viewerId ?? null;
    const isSuperAdmin = Boolean(options?.isSuperAdmin);
    if (!normalized) {
      return this.getPopularTags(take, options);
    }

    const visibilityWhere = !isSuperAdmin
      ? {
          OR: [
            { status: TagStatus.APPROVED, isBanned: false },
            ...(viewerId
              ? [
                  {
                    status: TagStatus.PENDING,
                    createdById: viewerId,
                    isBanned: false,
                  },
                ]
              : []),
          ],
        }
      : {};

    const rows = await (this.prisma as any).tag.findMany({
      where: {
        normalizedName: { startsWith: normalized },
        aliasOfTagId: null,
        OR: [
          { usageCount: { gt: 0 } },
          { status: TagStatus.APPROVED, isBanned: false },
        ],
        ...visibilityWhere,
      },
      orderBy: [
        { usageCount: 'desc' },
        { lastUsedAt: 'desc' },
        { normalizedName: 'asc' },
      ],
      take,
      select: {
        normalizedName: true,
        usageCount: true,
        status: true,
        isBanned: true,
        createdById: true,
      },
    });

    return rows
      .filter((row: any) =>
        this.isTagVisibleToViewer(row, viewerId, isSuperAdmin),
      )
      .map((row: any) => ({
        tag: row.normalizedName,
        count: row.usageCount,
      }));
  }

  async getTrendingTags(
    window: string,
    limit = 20,
    options?: TagVisibilityOptions,
  ): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 100);
    const windowMs = this.parseTrendingWindow(window);
    const from = new Date(Date.now() - windowMs);
    const viewerId = options?.viewerId ?? null;
    const isSuperAdmin = Boolean(options?.isSuperAdmin);

    const rows = await this.prisma.$queryRaw<
      Array<{
        tag: string;
        usageCount: bigint;
        status: TagStatus | null;
        isBanned: boolean;
        createdById: string | null;
      }>
    >`
      SELECT
        t."normalizedName" AS "tag",
        COUNT(tb."_id") AS "usageCount",
        t."status" AS "status",
        t."isBanned" AS "isBanned",
        t."createdById" AS "createdById"
      FROM "TagBinding" tb
      INNER JOIN "Tag" t ON t."_id" = tb."tagId"
      WHERE tb."createdAt" >= ${from}
        AND t."aliasOfTagId" IS NULL
      GROUP BY t."_id", t."normalizedName", t."status", t."isBanned", t."createdById"
      ORDER BY COUNT(tb."_id") DESC, t."normalizedName" ASC
      LIMIT ${take * 3}
    `;

    return rows
      .filter((row) => this.isTagVisibleToViewer(row, viewerId, isSuperAdmin))
      .slice(0, take)
      .map((row) => ({
        tag: row.tag,
        count: Number(row.usageCount ?? 0),
      }));
  }

  async getTagDetails(inputName: string, options?: TagVisibilityOptions) {
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new NotFoundException('Tag not found');

    const viewerId = options?.viewerId ?? null;
    const isSuperAdmin = Boolean(options?.isSuperAdmin);

    const tag = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        id: true,
        normalizedName: true,
        displayName: true,
        usageCount: true,
        status: true,
        createdById: true,
        createdBy: {
          select: {
            id: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: canonicalBrandProfileSelect },
          },
        },
        isBanned: true,
        lastUsedAt: true,
        aliasOfTagId: true,
        aliasOfTag: {
          select: {
            id: true,
            normalizedName: true,
            displayName: true,
          },
        },
        aliases: {
          select: {
            id: true,
            normalizedName: true,
            displayName: true,
            createdAt: true,
            updatedAt: true,
          },
          orderBy: [{ updatedAt: 'desc' }],
          take: 25,
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!tag) throw new NotFoundException('Tag not found');
    if (!this.isTagVisibleToViewer(tag, viewerId, isSuperAdmin)) {
      throw new NotFoundException('Tag not found');
    }

    const resolvedTagId = tag.aliasOfTagId ?? tag.id;
    const resolvedTag =
      tag.aliasOfTagId && tag.aliasOfTag
        ? tag.aliasOfTag
        : {
            id: tag.id,
            normalizedName: tag.normalizedName,
            displayName: tag.displayName,
          };

    const [bindingStats, groupedBindings] = await Promise.all([
      (this.prisma as any).tagBinding.aggregate({
        where: { tagId: resolvedTagId },
        _count: { _all: true },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
      (this.prisma as any).tagBinding.groupBy({
        by: ['entityType', 'entityId'],
        where: { tagId: resolvedTagId },
        _count: { _all: true },
        _max: { createdAt: true },
      }),
    ]);

    const typedGroupedBindings = groupedBindings as TagGroupedBindingRow[];

    const countRows = typedGroupedBindings.reduce(
      (acc: Record<string, number>, row) => {
        const key = row.entityType;
        acc[key] = (acc[key] ?? 0) + Number(row._count?._all ?? 0);
        return acc;
      },
      {},
    );

    const collectionIds = typedGroupedBindings
      .filter((row) => row.entityType === TAG_ENTITY_TYPE.COLLECTION)
      .map((row) => row.entityId);
    const productIds = typedGroupedBindings
      .filter((row) => row.entityType === TAG_ENTITY_TYPE.PRODUCT)
      .map((row) => row.entityId);
    const brandIds = typedGroupedBindings
      .filter((row) => row.entityType === TAG_ENTITY_TYPE.BRAND)
      .map((row) => row.entityId);
    const userBrandIds = typedGroupedBindings
      .filter((row) => row.entityType === TAG_ENTITY_TYPE.USER_BRAND)
      .map((row) => row.entityId);

    const [collections, products, brands, userBrands] = await Promise.all([
      collectionIds.length
        ? this.prisma.collection.findMany({
            where: { id: { in: collectionIds } },
            select: { id: true, title: true, ownerId: true },
          })
        : Promise.resolve([]),
      productIds.length
        ? this.prisma.product.findMany({
            where: { id: { in: productIds } },
            select: {
              id: true,
              name: true,
              brand: {
                select: {
                  ownerId: true,
                  name: true,
                },
              },
            },
          })
        : Promise.resolve([]),
      brandIds.length
        ? this.prisma.brand.findMany({
            where: { id: { in: brandIds } },
            select: {
              id: true,
              name: true,
              ownerId: true,
            },
          })
        : Promise.resolve([]),
      userBrandIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userBrandIds } },
            select: {
              id: true,
              username: true,
              brand: { select: canonicalBrandProfileSelect },
            },
          })
        : Promise.resolve([]),
    ]);

    const ownerByEntity = new Map<string, string>();
    const labelByEntity = new Map<string, string>();

    collections.forEach((row) => {
      ownerByEntity.set(`${TAG_ENTITY_TYPE.COLLECTION}:${row.id}`, row.ownerId);
      labelByEntity.set(
        `${TAG_ENTITY_TYPE.COLLECTION}:${row.id}`,
        row.title?.trim() || 'Collection',
      );
    });

    products.forEach((row) => {
      if (row.brand?.ownerId) {
        ownerByEntity.set(
          `${TAG_ENTITY_TYPE.PRODUCT}:${row.id}`,
          row.brand.ownerId,
        );
      }
      labelByEntity.set(
        `${TAG_ENTITY_TYPE.PRODUCT}:${row.id}`,
        row.name?.trim() || row.brand?.name || 'Product',
      );
    });

    brands.forEach((row) => {
      ownerByEntity.set(`${TAG_ENTITY_TYPE.BRAND}:${row.id}`, row.ownerId);
      labelByEntity.set(
        `${TAG_ENTITY_TYPE.BRAND}:${row.id}`,
        row.name?.trim() || 'Brand',
      );
    });

    userBrands.forEach((row) => {
      ownerByEntity.set(`${TAG_ENTITY_TYPE.USER_BRAND}:${row.id}`, row.id);
      labelByEntity.set(
        `${TAG_ENTITY_TYPE.USER_BRAND}:${row.id}`,
        resolveRequiredBrandField(row, 'brandFullName') ||
          row.username?.trim() ||
          'Brand profile',
      );
    });

    const usageByUser = new Map<
      string,
      {
        usageCount: number;
        latestTaggedAt: Date | null;
      }
    >();
    for (const row of typedGroupedBindings) {
      const entityKey = `${row.entityType}:${row.entityId}`;
      const ownerId = ownerByEntity.get(entityKey);
      if (!ownerId) continue;

      const previous = usageByUser.get(ownerId) ?? {
        usageCount: 0,
        latestTaggedAt: null,
      };
      const rowCount = Number(row._count?._all ?? 0);
      const rowLatest: Date | null = row._max?.createdAt ?? null;
      const latestTaggedAt =
        previous.latestTaggedAt && rowLatest
          ? previous.latestTaggedAt > rowLatest
            ? previous.latestTaggedAt
            : rowLatest
          : (previous.latestTaggedAt ?? rowLatest);

      usageByUser.set(ownerId, {
        usageCount: previous.usageCount + rowCount,
        latestTaggedAt,
      });
    }

    const usageUserIds = Array.from(usageByUser.keys());
    const usageUsers = usageUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: usageUserIds } },
          select: {
            id: true,
            username: true,
            userProfile: { select: canonicalUserProfileSelect },
            brand: { select: canonicalBrandProfileSelect },
          },
        })
      : [];
    const usageUserMap = new Map(usageUsers.map((row) => [row.id, row]));

    const usageByUsers: TagLifecycleActor[] = usageUserIds
      .map((userId) => {
        const stats = usageByUser.get(userId);
        const user = usageUserMap.get(userId);
        if (!stats || !user) return null;
        return {
          userId,
          username: user.username,
          brandFullName:
            resolveRequiredBrandField(user, 'brandFullName') || null,
          profileImage: user.brand?.logo ?? resolveProfileImage(user).url,
          usageCount: stats.usageCount,
          latestTaggedAt: stats.latestTaggedAt
            ? stats.latestTaggedAt.toISOString()
            : null,
        };
      })
      .filter((entry): entry is TagLifecycleActor => Boolean(entry))
      .sort((a, b) => {
        if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
        const aDate = a.latestTaggedAt
          ? new Date(a.latestTaggedAt).getTime()
          : 0;
        const bDate = b.latestTaggedAt
          ? new Date(b.latestTaggedAt).getTime()
          : 0;
        return bDate - aDate;
      })
      .slice(0, 50);

    const timeline: TagLifecycleEvent[] = [];
    timeline.push({
      id: `created:${tag.id}`,
      type: 'TAG_CREATED',
      at: tag.createdAt.toISOString(),
      summary: `Tag #${tag.normalizedName} was created.`,
    });

    if (bindingStats?._min?.createdAt) {
      timeline.push({
        id: `first-usage:${tag.id}`,
        type: 'FIRST_USAGE',
        at: bindingStats._min.createdAt.toISOString(),
        summary: 'First recorded usage in published content.',
      });
    }

    if (bindingStats?._max?.createdAt) {
      timeline.push({
        id: `last-usage:${tag.id}`,
        type: 'LAST_USAGE',
        at: bindingStats._max.createdAt.toISOString(),
        summary: 'Most recent recorded usage.',
      });
    }

    if (tag.aliasOfTag) {
      timeline.push({
        id: `alias:${tag.id}`,
        type: 'ALIASED_TO',
        at: tag.updatedAt.toISOString(),
        summary: `Merged under #${tag.aliasOfTag.normalizedName}.`,
      });
    }

    const normalizedStatus = this.parseTagStatus(tag.status);
    if (normalizedStatus === 'REJECTED' || tag.isBanned) {
      timeline.push({
        id: `rejected:${tag.id}`,
        type: 'STATUS_REJECTED',
        at: tag.updatedAt.toISOString(),
        summary: 'Tag is currently rejected from global use.',
      });
    } else if (normalizedStatus === 'PENDING') {
      timeline.push({
        id: `pending:${tag.id}`,
        type: 'STATUS_PENDING',
        at: tag.updatedAt.toISOString(),
        summary: 'Tag is currently pending moderation.',
      });
    } else if (tag.updatedAt.getTime() >= tag.createdAt.getTime()) {
      timeline.push({
        id: `approved:${tag.id}`,
        type: 'STATUS_APPROVED',
        at: tag.updatedAt.toISOString(),
        summary: 'Tag is currently approved for global use.',
      });
    }

    timeline.push({
      id: `updated:${tag.id}`,
      type: 'TAG_UPDATED',
      at: tag.updatedAt.toISOString(),
      summary: 'Tag metadata was updated.',
    });

    timeline.sort(
      (a, b) => new Date(b.at).getTime() - new Date(a.at).getTime(),
    );

    const usageSamples = typedGroupedBindings
      .map((row) => {
        const entityKey = `${row.entityType}:${row.entityId}`;
        const label = labelByEntity.get(entityKey) ?? row.entityId;
        return {
          entityType: row.entityType,
          entityId: row.entityId,
          usageCount: Number(row._count?._all ?? 0),
          latestTaggedAt: row._max?.createdAt
            ? row._max.createdAt.toISOString()
            : null,
          label,
        };
      })
      .sort((a, b) => {
        if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
        const aDate = a.latestTaggedAt
          ? new Date(a.latestTaggedAt).getTime()
          : 0;
        const bDate = b.latestTaggedAt
          ? new Date(b.latestTaggedAt).getTime()
          : 0;
        return bDate - aDate;
      })
      .slice(0, 100);

    const resolvedUsageCount = Number(
      bindingStats?._count?._all ?? tag.usageCount ?? 0,
    );

    const entityCounts = countRows;

    return {
      name: tag.normalizedName,
      displayName: tag.displayName,
      usageCount: resolvedUsageCount,
      status: normalizedStatus,
      isBanned: tag.isBanned,
      lifecycleStage: this.mapLegacyLifecycleStage({
        status: tag.status,
        isBanned: tag.isBanned,
        aliasOfTagId: tag.aliasOfTagId,
        usageCount: resolvedUsageCount,
      }),
      createdById: tag.createdById ?? null,
      createdBy: tag.createdBy ? this.mapOwnerDisplay(tag.createdBy) : null,
      lastUsedAt: tag.lastUsedAt ? tag.lastUsedAt.toISOString() : null,
      aliasOf: tag.aliasOfTag
        ? {
            name: tag.aliasOfTag.normalizedName,
            displayName: tag.aliasOfTag.displayName,
          }
        : null,
      aliases: (tag.aliases ?? []).map((alias: any) => ({
        name: alias.normalizedName,
        displayName: alias.displayName,
        createdAt: alias.createdAt.toISOString(),
        updatedAt: alias.updatedAt.toISOString(),
      })),
      resolvedTag: {
        id: resolvedTag.id,
        name: resolvedTag.normalizedName,
        displayName: resolvedTag.displayName,
      },
      entityCounts,
      usage: {
        distinctUsersCount: usageByUsers.length,
        users: usageByUsers,
        entities: usageSamples,
      },
      timeline,
      createdAt: tag.createdAt.toISOString(),
      updatedAt: tag.updatedAt.toISOString(),
    };
  }

  async getTagFeed(
    inputName: string,
    cursor?: string,
    limit = 20,
    options?: TagVisibilityOptions,
  ): Promise<{ tag: string; items: TagFeedItem[]; nextCursor: string | null }> {
    const take = this.clampLimit(limit, 1, 40);
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new NotFoundException('Tag not found');

    const viewerId = options?.viewerId ?? null;
    const isSuperAdmin = Boolean(options?.isSuperAdmin);

    const requested = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        id: true,
        normalizedName: true,
        aliasOfTagId: true,
        status: true,
        isBanned: true,
        createdById: true,
      },
    });

    if (!requested) throw new NotFoundException('Tag not found');
    if (!this.isTagVisibleToViewer(requested, viewerId, isSuperAdmin)) {
      throw new NotFoundException('Tag not found');
    }

    const resolvedTagId = requested.aliasOfTagId ?? requested.id;
    const resolvedTag = requested.aliasOfTagId
      ? await (this.prisma as any).tag.findUnique({
          where: { id: requested.aliasOfTagId },
          select: { normalizedName: true },
        })
      : requested;

    const bindings = await (this.prisma as any).tagBinding.findMany({
      where: { tagId: resolvedTagId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      take: take + 1,
      select: {
        id: true,
        entityType: true,
        entityId: true,
        createdAt: true,
      },
    });

    const hasMore = bindings.length > take;
    const pageItems = hasMore ? bindings.slice(0, take) : bindings;
    const nextCursor = hasMore ? pageItems[pageItems.length - 1].id : null;

    const collectionIds = pageItems
      .filter((row: any) => row.entityType === TAG_ENTITY_TYPE.COLLECTION)
      .map((row: any) => row.entityId);
    const productIds = pageItems
      .filter((row: any) => row.entityType === TAG_ENTITY_TYPE.PRODUCT)
      .map((row: any) => row.entityId);
    const brandIds = pageItems
      .filter((row: any) => row.entityType === TAG_ENTITY_TYPE.BRAND)
      .map((row: any) => row.entityId);
    const userBrandIds = pageItems
      .filter((row: any) => row.entityType === TAG_ENTITY_TYPE.USER_BRAND)
      .map((row: any) => row.entityId);

    const [collections, products, brands, users] = await Promise.all([
      collectionIds.length > 0
        ? this.prisma.collection.findMany({
            where: {
              id: { in: collectionIds },
              status: 'PUBLISHED',
              visibility: CollectionVisibility.PUBLIC,
              deletedAt: null,
            },
            select: {
              id: true,
              title: true,
              description: true,
              tags: true,
              createdAt: true,
              owner: {
                select: {
                  id: true,
                  username: true,
                  userProfile: { select: canonicalUserProfileSelect },
                  brand: { select: canonicalBrandProfileSelect },
                },
              },
            },
          })
        : Promise.resolve([]),
      productIds.length > 0
        ? this.prisma.product.findMany({
            where: {
              id: { in: productIds },
              deletedAt: null,
              archivedAt: null,
              isActive: true,
              publicationStatus: CollectionStatus.PUBLISHED,
              OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }],
              brand: { isStoreOpen: true },
            },
            select: {
              id: true,
              name: true,
              description: true,
              tags: true,
              thumbnail: true,
              price: true,
              salePrice: true,
              currency: true,
              createdAt: true,
              brand: {
                select: { id: true, name: true, logo: true },
              },
            },
          })
        : Promise.resolve([]),
      brandIds.length > 0
        ? this.prisma.brand.findMany({
            where: { id: { in: brandIds }, isStoreOpen: true },
            select: {
              id: true,
              name: true,
              tags: true,
              owner: {
                select: {
                  username: true,
                  userProfile: { select: canonicalUserProfileSelect },
                },
              },
            },
          })
        : Promise.resolve([]),
      userBrandIds.length > 0
        ? this.prisma.user.findMany({
            where: { id: { in: userBrandIds }, type: 'BRAND' },
            select: {
              id: true,
              username: true,
              userProfile: { select: canonicalUserProfileSelect },
              brand: { select: canonicalBrandProfileSelect },
            },
          })
        : Promise.resolve([]),
    ]);

    const collectionMap = new Map(collections.map((c) => [c.id, c]));
    const productMap = new Map(products.map((p) => [p.id, p]));
    const brandMap = new Map(brands.map((b) => [b.id, b]));
    const userMap = new Map(users.map((u) => [u.id, u]));

    const items: TagFeedItem[] = [];
    for (const binding of pageItems) {
      if (binding.entityType === TAG_ENTITY_TYPE.COLLECTION) {
        const c = collectionMap.get(binding.entityId);
        if (!c) continue;
        items.push({
          id: binding.id,
          entityType: 'COLLECTION',
          taggedAt: binding.createdAt.toISOString(),
          data: {
            id: c.id,
            title: c.title,
            description: c.description,
            tags: c.tags ?? [],
            createdAt: c.createdAt.toISOString(),
            owner: {
              ...this.mapOwnerDisplay(c.owner),
            },
          },
        });
        continue;
      }

      if (binding.entityType === TAG_ENTITY_TYPE.PRODUCT) {
        const p = productMap.get(binding.entityId);
        if (!p) continue;
        items.push({
          id: binding.id,
          entityType: 'PRODUCT',
          taggedAt: binding.createdAt.toISOString(),
          data: {
            id: p.id,
            name: p.name,
            description: p.description,
            tags: p.tags ?? [],
            thumbnail: p.thumbnail,
            price: Number(p.price),
            salePrice:
              p.salePrice !== null && p.salePrice !== undefined
                ? Number(p.salePrice)
                : null,
            currency: p.currency,
            createdAt: p.createdAt.toISOString(),
            brand: {
              id: p.brand.id,
              name: p.brand.name,
              logo: p.brand.logo,
            },
          },
        });
        continue;
      }

      if (binding.entityType === TAG_ENTITY_TYPE.BRAND) {
        const b = brandMap.get(binding.entityId);
        if (!b) continue;
        items.push({
          id: binding.id,
          entityType: 'BRAND',
          taggedAt: binding.createdAt.toISOString(),
          data: {
            id: b.id,
            displayName: b.name,
            username: b.owner.username,
            profileImage: resolveProfileImage(b.owner).url,
            tags: b.tags ?? [],
          },
        });
        continue;
      }

      if (binding.entityType === TAG_ENTITY_TYPE.USER_BRAND) {
        const u = userMap.get(binding.entityId);
        if (!u) continue;
        items.push({
          id: binding.id,
          entityType: 'USER_BRAND',
          taggedAt: binding.createdAt.toISOString(),
          data: {
            id: u.id,
            ...this.mapBrandUserDisplay(u),
          },
        });
      }
    }

    return {
      tag: resolvedTag?.normalizedName || normalizedName,
      items,
      nextCursor,
    };
  }

  async setTagStatus(
    inputName: string,
    statusInput: 'PENDING' | 'APPROVED' | 'REJECTED',
    actorUserId?: string | null,
  ) {
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new BadRequestException('Invalid tag');

    const nextStatus = this.parseModerationStatus(statusInput);
    const shouldBan = nextStatus === 'REJECTED';

    const previous = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        normalizedName: true,
        displayName: true,
        status: true,
        isBanned: true,
        aliasOfTagId: true,
      },
    });

    const updated = await (this.prisma as any).tag.upsert({
      where: { normalizedName },
      create: {
        id: crypto.randomUUID(),
        normalizedName,
        displayName: normalizedName,
        status: nextStatus,
        isBanned: shouldBan,
      },
      update: {
        status: nextStatus,
        isBanned: shouldBan,
        updatedAt: new Date(),
      },
      select: {
        normalizedName: true,
        displayName: true,
        status: true,
        isBanned: true,
        aliasOfTagId: true,
        updatedAt: true,
      },
    });
    await this.recordTagAudit({
      actorUserId,
      operation: shouldBan
        ? 'hashtag_rejected_or_banned'
        : 'hashtag_status_updated',
      targetId: updated.normalizedName,
      previousState: previous ?? undefined,
      newState: {
        normalizedName: updated.normalizedName,
        displayName: updated.displayName,
        status: this.parseTagStatus(updated.status),
        isBanned: updated.isBanned,
        aliasOfTagId: updated.aliasOfTagId,
      },
    });

    // Note: systemTag table not in schema, skipping systemTag operations

    return {
      name: updated.normalizedName,
      displayName: updated.displayName,
      status: this.parseTagStatus(updated.status),
      isBanned: updated.isBanned,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  async banTag(inputName: string, banned = true): Promise<void> {
    await this.setTagStatus(inputName, banned ? 'REJECTED' : 'APPROVED');
  }

  async mergeTags(
    sourceInput: string,
    targetInput: string,
    actorUserId?: string | null,
  ): Promise<void> {
    const source = this.normalizeLookup(sourceInput);
    const target = this.normalizeLookup(targetInput);
    if (!source || !target)
      throw new BadRequestException('Invalid tag merge input');
    if (source === target)
      throw new BadRequestException('Source and target tags must differ');

    await this.prisma.$transaction(async (tx) => {
      const sourceTag = await (tx as any).tag.upsert({
        where: { normalizedName: source },
        create: {
          id: crypto.randomUUID(),
          normalizedName: source,
          displayName: source,
        },
        update: {},
        select: { id: true, normalizedName: true },
      });

      const targetTag = await (tx as any).tag.upsert({
        where: { normalizedName: target },
        create: {
          id: crypto.randomUUID(),
          normalizedName: target,
          displayName: target,
        },
        update: {},
        select: { id: true, normalizedName: true },
      });

      const sourceBindings = await (tx as any).tagBinding.findMany({
        where: { tagId: sourceTag.id },
        select: { entityType: true, entityId: true },
      });

      if (sourceBindings.length > 0) {
        await (tx as any).tagBinding.createMany({
          data: sourceBindings.map((b: any) => ({
            id: crypto.randomUUID(),
            tagId: targetTag.id,
            entityType: b.entityType,
            entityId: b.entityId,
          })),
          skipDuplicates: true,
        });
      }

      await (tx as any).tagBinding.deleteMany({
        where: { tagId: sourceTag.id },
      });

      const [targetCount, sourceCount] = await Promise.all([
        (tx as any).tagBinding.count({ where: { tagId: targetTag.id } }),
        (tx as any).tagBinding.count({ where: { tagId: sourceTag.id } }),
      ]);

      await Promise.all([
        (tx as any).tag.update({
          where: { id: targetTag.id },
          data: {
            usageCount: targetCount,
            lastUsedAt: targetCount > 0 ? new Date() : null,
            isBanned: false,
          },
        }),
        (tx as any).tag.update({
          where: { id: sourceTag.id },
          data: {
            usageCount: sourceCount,
            lastUsedAt: null,
            aliasOfTagId: targetTag.id,
          },
        }),
      ]);

      // Note: systemTag table not in schema, skipping systemTag operations
    });
    await this.recordTagAudit({
      actorUserId,
      operation: 'hashtag_merged',
      targetId: source,
      newState: {
        sourceTag: source,
        targetTag: target,
      },
    });
  }

  async reindexAllTags() {
    return this.tagIndex.reindexAll();
  }
}
