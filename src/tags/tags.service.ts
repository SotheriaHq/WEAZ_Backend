import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { CollectionVisibility } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TagIndexService } from './tag-index.service';
import * as crypto from 'crypto';
import { TAG_ENTITY_TYPE } from './tag-entity-type';

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

@Injectable()
export class TagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tagIndex: TagIndexService,
  ) {}

  private clampLimit(input: number | undefined, min = 1, max = 100): number {
    const parsed = Number.isFinite(input) ? Number(input) : min;
    return Math.min(max, Math.max(min, parsed || min));
  }

  private normalizeLookup(input: string): string {
    return this.tagIndex.normalizeTagName(input);
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

  /**
   * Returns popular tags from the unified tag index.
   * Falls back to legacy aggregation if index is empty.
   */
  async getPopularTags(limit = 50): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 200);
    const indexed = await (this.prisma as any).tag.findMany({
      where: {
        isBanned: false,
        aliasOfTagId: null,
        usageCount: { gt: 0 },
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
    const [collections, products, brands, users] = await Promise.all([
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
      this.prisma.user.findMany({
        where: { type: 'BRAND' },
        select: { brandTags: true },
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
    for (const u of users) for (const t of u.brandTags ?? []) bump(t);

    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, take);
  }

  async searchTags(query: string, limit = 10): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 100);
    const normalized = this.normalizeLookup(query);
    if (!normalized) {
      return this.getPopularTags(take);
    }

    const rows = await (this.prisma as any).tag.findMany({
      where: {
        normalizedName: { startsWith: normalized },
        isBanned: false,
        aliasOfTagId: null,
      },
      orderBy: [
        { usageCount: 'desc' },
        { lastUsedAt: 'desc' },
        { normalizedName: 'asc' },
      ],
      take,
      select: { normalizedName: true, usageCount: true },
    });

    return rows.map((row: any) => ({
      tag: row.normalizedName,
      count: row.usageCount,
    }));
  }

  async getTrendingTags(window: string, limit = 20): Promise<{ tag: string; count: number }[]> {
    const take = this.clampLimit(limit, 1, 100);
    const windowMs = this.parseTrendingWindow(window);
    const from = new Date(Date.now() - windowMs);

    const rows = await this.prisma.$queryRaw<
      Array<{ tag: string; usageCount: bigint }>
    >`
      SELECT t."normalizedName" AS "tag", COUNT(tb."_id") AS "usageCount"
      FROM "TagBinding" tb
      INNER JOIN "Tag" t ON t."_id" = tb."tagId"
      WHERE tb."createdAt" >= ${from}
        AND t."isBanned" = false
        AND t."aliasOfTagId" IS NULL
      GROUP BY t."_id", t."normalizedName"
      ORDER BY COUNT(tb."_id") DESC, t."normalizedName" ASC
      LIMIT ${take}
    `;

    return rows.map((row) => ({
      tag: row.tag,
      count: Number(row.usageCount ?? 0),
    }));
  }

  async getTagDetails(inputName: string) {
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new NotFoundException('Tag not found');

    const tag = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        id: true,
        normalizedName: true,
        displayName: true,
        usageCount: true,
        isBanned: true,
        aliasOfTagId: true,
        aliasOfTag: {
          select: {
            normalizedName: true,
            displayName: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!tag) throw new NotFoundException('Tag not found');

    const countRows = await (this.prisma as any).tagBinding.groupBy({
      by: ['entityType'],
      where: { tagId: tag.id },
      _count: { _all: true },
    });

    const entityCounts = countRows.reduce(
      (acc: Record<string, number>, row: any) => {
        acc[row.entityType] = row._count?._all ?? 0;
        return acc;
      },
      {},
    );

    return {
      name: tag.normalizedName,
      displayName: tag.displayName,
      usageCount: tag.usageCount,
      isBanned: tag.isBanned,
      aliasOf: tag.aliasOfTag
        ? {
            name: tag.aliasOfTag.normalizedName,
            displayName: tag.aliasOfTag.displayName,
          }
        : null,
      entityCounts,
      createdAt: tag.createdAt,
      updatedAt: tag.updatedAt,
    };
  }

  async getTagFeed(
    inputName: string,
    cursor?: string,
    limit = 20,
  ): Promise<{ tag: string; items: TagFeedItem[]; nextCursor: string | null }> {
    const take = this.clampLimit(limit, 1, 40);
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new NotFoundException('Tag not found');

    const requested = await (this.prisma as any).tag.findUnique({
      where: { normalizedName },
      select: {
        id: true,
        normalizedName: true,
        aliasOfTagId: true,
      },
    });

    if (!requested) throw new NotFoundException('Tag not found');

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
                  brandFullName: true,
                  profileImage: true,
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
              OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }],
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
                select: { username: true, profileImage: true },
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
              brandFullName: true,
              profileImage: true,
              brandTags: true,
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
              id: c.owner.id,
              username: c.owner.username,
              brandFullName: c.owner.brandFullName,
              profileImage: c.owner.profileImage,
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
            salePrice: p.salePrice !== null && p.salePrice !== undefined ? Number(p.salePrice) : null,
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
            profileImage: b.owner.profileImage,
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
            displayName: u.brandFullName || u.username,
            username: u.username,
            profileImage: u.profileImage,
            tags: u.brandTags ?? [],
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

  async banTag(inputName: string, banned = true): Promise<void> {
    const normalizedName = this.normalizeLookup(inputName);
    if (!normalizedName) throw new BadRequestException('Invalid tag');

    await (this.prisma as any).tag.upsert({
      where: { normalizedName },
      create: {
        id: crypto.randomUUID(),
        normalizedName,
        displayName: normalizedName,
        isBanned: banned,
      },
      update: { isBanned: banned },
    });

    if (banned) {
      await this.prisma.systemTag.deleteMany({ where: { tag: normalizedName } });
    }
  }

  async mergeTags(sourceInput: string, targetInput: string): Promise<void> {
    const source = this.normalizeLookup(sourceInput);
    const target = this.normalizeLookup(targetInput);
    if (!source || !target) throw new BadRequestException('Invalid tag merge input');
    if (source === target) throw new BadRequestException('Source and target tags must differ');

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

      await tx.systemTag.deleteMany({
        where: { tag: sourceTag.normalizedName },
      });

      await tx.systemTag.createMany({
        data: [{ id: crypto.randomUUID(), tag: targetTag.normalizedName }],
        skipDuplicates: true,
      });
    });
  }

  async reindexAllTags() {
    return this.tagIndex.reindexAll();
  }
}
