import { lockTagRows, refreshTagUsageCounts } from './tag-usage-query';
import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType, TagStatus, Prisma } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeTags, normalizeTag } from 'src/common/utils/tag-validator';
import { TAG_ENTITY_TYPE, TagEntityTypeValue } from './tag-entity-type';
import {
  canonicalBrandProfileSelect,
  resolveRequiredBrandField,
} from 'src/common/brand-profile-source.helper';

const NT_TAG_MENTION = 'TAG_MENTION' as NotificationType;

type SyncEntityTagsOptions = {
  maxCount?: number;
  actorId?: string | null;
  entityTitle?: string;
  notifyMentions?: boolean;
};

@Injectable()
export class TagIndexService {
  private readonly logger = new Logger(TagIndexService.name);
  private warnedMissingTagDelegates = false;
  private warnedMissingTagTables = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  normalizeTagName(input: string): string {
    const withoutHash = (input || '').trim().replace(/^#+/, '');
    return normalizeTag(withoutHash);
  }

  normalizeTagList(
    tags: Array<string | null | undefined>,
    maxCount = 30,
  ): string[] {
    const safe = tags
      .map((tag) => (typeof tag === 'string' ? tag : ''))
      .filter(Boolean);
    return sanitizeTags(safe, maxCount);
  }

  async registerPendingCreatorTags(
    tags: Array<string | null | undefined>,
    actorId: string,
    maxCount = 10,
  ): Promise<string[]> {
    const normalizedTags = this.normalizeTagList(tags, maxCount);
    if (normalizedTags.length === 0) return [];

    const prismaClient = this.prisma as any;
    if (
      !this.ensureTagDelegatesAvailable(prismaClient, 'pending registration')
    ) {
      return normalizedTags;
    }

    try {
      const existing = await prismaClient.tag.findMany({
        where: { normalizedName: { in: normalizedTags } },
        select: {
          normalizedName: true,
          status: true,
          isBanned: true,
          createdById: true,
        },
      });
      const blocked = existing.filter(
        (tag: any) => tag.isBanned || tag.status === TagStatus.REJECTED,
      );
      if (blocked.length > 0) {
        throw new BadRequestException(
          `One or more tags are blocked: ${blocked.map((tag: any) => `#${tag.normalizedName}`).join(', ')}`,
        );
      }

      const existingNames = new Set(
        existing.map((tag: any) => String(tag.normalizedName)),
      );
      const missingNames = normalizedTags.filter(
        (name) => !existingNames.has(name),
      );
      const needsAttribution = existing.some(
        (tag: any) =>
          tag.status === TagStatus.PENDING && tag.createdById == null,
      );

      if (missingNames.length === 0 && !needsAttribution) {
        return normalizedTags;
      }

      await this.prisma.$transaction(async (tx) => {
        for (const name of missingNames) {
          await (tx as any).tag.upsert({
            where: { normalizedName: name },
            create: {
              id: uuidv4(),
              normalizedName: name,
              displayName: name,
              status: TagStatus.PENDING,
              createdById: actorId,
              usageCount: 0,
              isBanned: false,
            },
            update: { displayName: name },
          });
        }

        await (tx as any).tag.updateMany({
          where: {
            normalizedName: { in: normalizedTags },
            status: TagStatus.PENDING,
            createdById: null,
          },
          data: { createdById: actorId },
        });
      });

      return normalizedTags;
    } catch (error: any) {
      if (this.isMissingTagTableError(error)) {
        this.warnMissingTagTables('pending registration');
        return normalizedTags;
      }
      throw error;
    }
  }

  private ensureTagDelegatesAvailable(client: any, context: string): boolean {
    if (client?.tag && client?.tagBinding) return true;
    if (!this.warnedMissingTagDelegates) {
      this.warnedMissingTagDelegates = true;
      this.logger.warn(
        `Skipping tag index ${context}: Prisma client is missing Tag/TagBinding delegates. Run "npm run prisma:generate".`,
      );
    }
    return false;
  }

  private isMissingTagTableError(error: any): boolean {
    if (!error || typeof error !== 'object') return false;
    if (error.code !== 'P2021') return false;
    const message = String(error.message ?? '');
    return (
      message.includes('public.Tag') || message.includes('public.TagBinding')
    );
  }

  private warnMissingTagTables(context: string): void {
    if (this.warnedMissingTagTables) return;
    this.warnedMissingTagTables = true;
    this.logger.warn(
      `Skipping tag index ${context}: Tag/TagBinding tables are missing. Run pending Prisma migrations.`,
    );
  }

  async syncEntityTags(
    entityType: TagEntityTypeValue,
    entityId: string,
    previousTags: Array<string | null | undefined>,
    nextTags: Array<string | null | undefined>,
    options?: SyncEntityTagsOptions,
  ): Promise<void> {
    await this.syncEntitiesTags([{ entityType, entityId, previousTags, nextTags, options }]);
  }

  async syncEntitiesTags(entries: Array<{
    entityType: TagEntityTypeValue; entityId: string;
    previousTags: Array<string | null | undefined>; nextTags: Array<string | null | undefined>;
    options?: SyncEntityTagsOptions;
  }>): Promise<void> {
    const keys = new Set<string>();
    const changes = entries.map((entry) => {
      const key = entry.entityType + ':' + entry.entityId;
      if (keys.has(key)) throw new BadRequestException('Duplicate entity in tag synchronization batch');
      keys.add(key);
      const prev = new Set(this.normalizeTagList(entry.previousTags, entry.options?.maxCount ?? 30));
      const next = new Set(this.normalizeTagList(entry.nextTags, entry.options?.maxCount ?? 30));
      return { ...entry, added: [...next].filter((name) => !prev.has(name)), removed: [...prev].filter((name) => !next.has(name)) };
    }).filter((entry) => entry.added.length || entry.removed.length);
    for (let offset = 0; offset < changes.length; offset += 500) {
      const batch = changes.slice(offset, offset + 500);
      const now = new Date();
      const addedNames = [...new Set(batch.flatMap((entry) => entry.added))].sort();
      const affected = [...new Set(batch.flatMap((entry) => [...entry.added, ...entry.removed]))].sort();
      const creatorByTag = new Map<string, string | null>();
      for (const entry of batch) for (const name of entry.added) {
        if (!creatorByTag.has(name)) creatorByTag.set(name, entry.options?.actorId ?? null);
      }
      await this.prisma.$transaction(async (tx) => {
        for (let start = 0; start < addedNames.length; start += 500) {
          await tx.tag.createMany({
            data: addedNames.slice(start, start + 500).map((name) => ({
              id: uuidv4(), normalizedName: name, displayName: name, status: TagStatus.PENDING,
              createdById: creatorByTag.get(name) ?? null,
              usageCount: 0, lastUsedAt: now, isBanned: false,
            })), skipDuplicates: true,
          });
        }
        const existing: Array<{ id: string; normalizedName: string }> = [];
        for (let start = 0; start < affected.length; start += 500) {
          existing.push(...await tx.tag.findMany({
            where: { normalizedName: { in: affected.slice(start, start + 500) } }, select: { id: true, normalizedName: true },
          }));
        }
        const locked = await lockTagRows(tx, existing.map((row) => row.id));
        const addedSet = new Set(addedNames);
        const blocked = locked.filter((row) => addedSet.has(row.normalizedName) && (row.isBanned || row.status === TagStatus.REJECTED));
        if (blocked.length) throw new BadRequestException(`One or more tags are blocked: ${blocked.map((row) => '#' + row.normalizedName).join(', ')}`);
        const byName = new Map(locked.map((row) => [row.normalizedName, row.id]));
        const added = batch.flatMap((entry) => entry.added.flatMap((name) => {
          const tagId = byName.get(name);
          return tagId ? [{ id: uuidv4(), tagId, entityType: entry.entityType, entityId: entry.entityId }] : [];
        }));
        const removed = batch.flatMap((entry) => entry.removed.flatMap((name) => {
          const tagId = byName.get(name);
          return tagId ? [{ tagId, entityType: entry.entityType, entityId: entry.entityId }] : [];
        }));
        for (let start = 0; start < added.length; start += 500) {
          await tx.tagBinding.createMany({ data: added.slice(start, start + 500), skipDuplicates: true });
        }
        for (let start = 0; start < removed.length; start += 500) {
          const removals = removed.slice(start, start + 500);
          await tx.$executeRaw(Prisma.sql`
            DELETE FROM "TagBinding" binding USING unnest(
              ${removals.map((row) => row.tagId)}::uuid[],
              ${removals.map((row) => row.entityType)}::"TagEntityType"[],
              ${removals.map((row) => row.entityId)}::uuid[]
            ) removed("tagId", type, "entityId")
            WHERE binding."tagId" = removed."tagId" AND binding."entityType" = removed.type AND binding."entityId" = removed."entityId"
          `);
        }
        await refreshTagUsageCounts(tx, locked.map((row) => row.id), now);
      });
    }
  }

  private async resolveMentionContext(
    entityType: TagEntityTypeValue,
    entityId: string,
  ): Promise<{
    actorId: string | null;
    entityTitle: string;
    target:
      | { type: 'COLLECTION'; id: string; preview?: string }
      | { type: 'PRODUCT'; id: string; preview?: string }
      | { type: 'USER'; id: string; preview?: string }
      | { type: 'SYSTEM'; id: string; preview?: string };
    targetUrl?: string;
  } | null> {
    if (entityType === TAG_ENTITY_TYPE.COLLECTION) {
      const collection = await this.prisma.collection.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          title: true,
          ownerId: true,
          status: true,
          visibility: true,
          deletedAt: true,
        },
      });
      if (
        !collection ||
        collection.deletedAt ||
        collection.status !== 'PUBLISHED' ||
        collection.visibility !== 'PUBLIC'
      ) {
        return null;
      }
      const title = collection.title || 'Collection';
      return {
        actorId: collection.ownerId,
        entityTitle: title,
        target: { type: 'COLLECTION', id: collection.id, preview: title },
        targetUrl: `/collections/${collection.id}`,
      };
    }

    if (entityType === TAG_ENTITY_TYPE.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          name: true,
          isActive: true,
          deletedAt: true,
          archivedAt: true,
          publishAt: true,
          brand: {
            select: {
              ownerId: true,
              isStoreOpen: true,
            },
          },
        },
      });
      if (
        !product ||
        product.deletedAt ||
        product.archivedAt ||
        !product.isActive ||
        !product.brand?.isStoreOpen ||
        (product.publishAt && product.publishAt > new Date())
      ) {
        return null;
      }
      const title = product.name || 'Product';
      return {
        actorId: product.brand.ownerId,
        entityTitle: title,
        target: { type: 'PRODUCT', id: product.id, preview: title },
        targetUrl: `/products/${product.id}`,
      };
    }

    if (entityType === TAG_ENTITY_TYPE.BRAND) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          name: true,
          ownerId: true,
          isStoreOpen: true,
        },
      });
      if (!brand || !brand.isStoreOpen) return null;
      const title = brand.name || 'Brand';
      return {
        actorId: brand.ownerId,
        entityTitle: title,
        target: { type: 'USER', id: brand.ownerId, preview: title },
        targetUrl: `/profile/${brand.ownerId}`,
      };
    }

    if (entityType === TAG_ENTITY_TYPE.USER_BRAND) {
      const user = await this.prisma.user.findUnique({
        where: { id: entityId },
        select: {
          id: true,
          type: true,
          username: true,
          brand: { select: canonicalBrandProfileSelect },
        },
      });
      if (!user || user.type !== 'BRAND') return null;
      const title =
        resolveRequiredBrandField(user, 'brandFullName') ||
        user.username ||
        'Brand profile';
      return {
        actorId: user.id,
        entityTitle: title,
        target: { type: 'USER', id: user.id, preview: title },
        targetUrl: `/profile/${user.id}`,
      };
    }

    return null;
  }

  private async notifyTagMentions(
    entityType: TagEntityTypeValue,
    entityId: string,
    addedTags: string[],
    actorIdOverride?: string | null,
    entityTitleOverride?: string,
  ): Promise<void> {
    if (!this.notifications || addedTags.length === 0) return;

    const normalizedAdded = this.normalizeTagList(addedTags, 30);
    if (normalizedAdded.length === 0) return;
    const addedSet = new Set(normalizedAdded);

    const context = await this.resolveMentionContext(entityType, entityId);
    if (!context) return;

    const actorId = actorIdOverride ?? context.actorId ?? null;
    const entityTitle =
      entityTitleOverride?.trim() || context.entityTitle || 'Tagged content';

    const brands = await this.prisma.brand.findMany({
      where: {
        isStoreOpen: true,
        tags: { hasSome: normalizedAdded },
      },
      select: {
        id: true,
        ownerId: true,
        tags: true,
      },
    });

    const recipientTags = new Map<string, Set<string>>();
    const addRecipientTag = (recipientId: string, tag: string) => {
      if (!recipientId || !tag) return;
      if (actorId && recipientId === actorId) return;
      if (!recipientTags.has(recipientId)) {
        recipientTags.set(recipientId, new Set());
      }
      recipientTags.get(recipientId)!.add(tag);
    };

    for (const brand of brands) {
      if (entityType === TAG_ENTITY_TYPE.BRAND && brand.id === entityId) {
        continue;
      }

      const matched = (brand.tags ?? [])
        .map((tag) => this.normalizeTagName(tag))
        .filter((tag) => tag && addedSet.has(tag));

      for (const tag of matched) addRecipientTag(brand.ownerId, tag);
    }

    if (recipientTags.size === 0) return;

    const notificationPromises = Array.from(recipientTags.entries()).map(
      async ([recipientId, tagsSet]) => {
        const tags = Array.from(tagsSet);
        const previewTags = tags
          .slice(0, 3)
          .map((tag) => `#${tag}`)
          .join(', ');
        const remainder = tags.length > 3 ? ` +${tags.length - 3} more` : '';
        const message = `${entityTitle} matched your tags (${previewTags}${remainder})`;

        await this.notifications!.create(recipientId, NT_TAG_MENTION, {
          actorId,
          target: context.target,
          dedupeMs: 6 * 60 * 60 * 1000,
          payload: {
            entityType,
            entityId,
            entityTitle,
            tag: tags[0] || null,
            tags,
            targetUrl: context.targetUrl,
            message,
          },
        });
      },
    );

    await Promise.allSettled(notificationPromises);
  }

  async reindexAll(): Promise<{
    tagsIndexed: number;
    bindingsCreated: number;
  }> {
    const prismaClient = this.prisma as any;
    if (!this.ensureTagDelegatesAvailable(prismaClient, 'reindex')) {
      return { tagsIndexed: 0, bindingsCreated: 0 };
    }

    const now = new Date();
    const pageSize = 500;
    const sources: Array<{
      entityType: TagEntityTypeValue;
      maxCount: number;
      load: (
        afterId: string | null,
      ) => Promise<Array<{ id: string; entityId: string; tags: string[] }>>;
    }> = [
      {
        entityType: TAG_ENTITY_TYPE.COLLECTION,
        maxCount: 30,
        load: async (afterId) =>
          (
            await this.prisma.collection.findMany({
              where: {
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              select: { id: true, tags: true },
              orderBy: { id: 'asc' },
              take: pageSize,
            })
          ).map((row) => ({ ...row, entityId: row.id })),
      },
      {
        entityType: TAG_ENTITY_TYPE.STORE_COLLECTION,
        maxCount: 30,
        load: async (afterId) =>
          (
            await this.prisma.storeCollection.findMany({
              where: {
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              select: { id: true, tags: true },
              orderBy: { id: 'asc' },
              take: pageSize,
            })
          ).map((row) => ({ ...row, entityId: row.id })),
      },
      {
        entityType: TAG_ENTITY_TYPE.PRODUCT,
        maxCount: 30,
        load: async (afterId) =>
          (
            await this.prisma.product.findMany({
              where: {
                isActive: true,
                deletedAt: null,
                archivedAt: null,
                OR: [{ publishAt: null }, { publishAt: { lte: now } }],
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              select: { id: true, tags: true },
              orderBy: { id: 'asc' },
              take: pageSize,
            })
          ).map((row) => ({ ...row, entityId: row.id })),
      },
      {
        entityType: TAG_ENTITY_TYPE.BRAND,
        maxCount: 30,
        load: async (afterId) =>
          (
            await this.prisma.brand.findMany({
              where: {
                isStoreOpen: true,
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              select: { id: true, tags: true },
              orderBy: { id: 'asc' },
              take: pageSize,
            })
          ).map((row) => ({ ...row, entityId: row.id })),
      },
      {
        entityType: TAG_ENTITY_TYPE.USER_BRAND,
        maxCount: 10,
        load: async (afterId) =>
          (
            await this.prisma.brand.findMany({
              where: {
                owner: { type: 'BRAND' },
                ...(afterId ? { id: { gt: afterId } } : {}),
              },
              select: { id: true, ownerId: true, tags: true },
              orderBy: { id: 'asc' },
              take: pageSize,
            })
          ).map((row) => ({
            id: row.id,
            entityId: row.ownerId,
            tags: row.tags,
          })),
      },
    ];

    // No global delete: the index stays searchable while it is rebuilt, and each
    // entity converges from its current bindings to its current source tags.
    let bindingsCreated = 0;
    for (const source of sources) {
      let afterId: string | null = null;
      while (true) {
        const rows = await source.load(afterId);
        if (!rows.length) break;
        const normalized = rows.map((row) => ({
          ...row,
          tags: this.normalizeTagList(row.tags ?? [], source.maxCount),
        }));
        const bound = new Map<string, string[]>();
        const current = await this.prisma.tagBinding.findMany({
          where: {
            entityType: source.entityType,
            entityId: { in: normalized.map((row) => row.entityId) },
          },
          select: { entityId: true, tag: { select: { normalizedName: true } } },
        });
        for (const binding of current) {
          const list = bound.get(binding.entityId) ?? [];
          list.push(binding.tag.normalizedName);
          bound.set(binding.entityId, list);
        }
        const names = [...new Set(normalized.flatMap((row) => row.tags))];
        const blocked = new Set<string>();
        for (let offset = 0; offset < names.length; offset += pageSize) {
          const tags = await this.prisma.tag.findMany({
            where: {
              normalizedName: { in: names.slice(offset, offset + pageSize) },
              OR: [{ isBanned: true }, { status: TagStatus.REJECTED }],
            },
            select: { normalizedName: true },
          });
          for (const tag of tags) blocked.add(tag.normalizedName);
        }
        const entries = normalized.map((row) => ({
          entityType: source.entityType,
          entityId: row.entityId,
          previousTags: bound.get(row.entityId) ?? [],
          nextTags: row.tags.filter((tag) => !blocked.has(tag)),
          options: { maxCount: 1000, notifyMentions: false },
        }));
        await this.syncEntitiesTags(entries);
        bindingsCreated += entries.reduce(
          (sum, entry) => sum + entry.nextTags.length,
          0,
        );
        afterId = rows[rows.length - 1].id;
      }
    }

    await this.removeIneligibleBindings();
    const tagsIndexed = await prismaClient.tag.count();
    return { tagsIndexed, bindingsCreated };
  }

  /**
   * Remove bindings whose target is no longer indexable (unpublished, private,
   * archived, deleted or closed). Tags are locked before their bindings change,
   * as every binding writer does, and usage counts are recomputed after.
   */
  private async removeIneligibleBindings(batchSize = 500) {
    for (;;) {
      const stale = await this.prisma.$queryRaw<Array<{ id: string; tagId: string }>>(Prisma.sql`
        SELECT b."_id" AS id, b."tagId" FROM "TagBinding" b
        WHERE ${this.ineligibleBindingCondition()}
        ORDER BY b."_id" LIMIT ${batchSize}
      `);
      if (!stale.length) return;
      await this.prisma.$transaction(async (tx) => {
        const locked = await lockTagRows(tx, stale.map((row) => row.tagId));
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM "TagBinding" b
          WHERE b."_id" = ANY(${stale.map((row) => row.id)}::uuid[])
            AND ${this.ineligibleBindingCondition()}
        `);
        await refreshTagUsageCounts(tx, locked.map((row) => row.id), new Date());
      });
      if (stale.length < batchSize) return;
    }
  }

  private ineligibleBindingCondition() {
    return Prisma.sql`(
      (b."entityType" = 'PRODUCT' AND NOT EXISTS (SELECT 1 FROM "Product" p
        WHERE p."_id" = b."entityId" AND p."isActive" AND p."deletedAt" IS NULL AND p."archivedAt" IS NULL
          AND (p."publishAt" IS NULL OR p."publishAt" <= (CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))
      OR (b."entityType" = 'COLLECTION' AND NOT EXISTS (SELECT 1 FROM "Collection" c
        WHERE c."_id" = b."entityId" AND c.status = 'PUBLISHED' AND c.visibility = 'PUBLIC' AND c."deletedAt" IS NULL))
      OR (b."entityType" = 'STORE_COLLECTION' AND NOT EXISTS (SELECT 1 FROM "StoreCollection" s
        WHERE s."_id" = b."entityId" AND s.status = 'PUBLISHED' AND s.visibility = 'PUBLIC' AND s."deletedAt" IS NULL))
      OR (b."entityType" = 'BRAND' AND NOT EXISTS (SELECT 1 FROM "Brand" br
        WHERE br."_id" = b."entityId" AND br."isStoreOpen"))
      OR (b."entityType" = 'USER_BRAND' AND NOT EXISTS (SELECT 1 FROM "User" u
        WHERE u."_id" = b."entityId" AND u.type = 'BRAND'))
    )`;
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async reconcileTagIndexSnapshot(): Promise<void> {
    if ((process.env.TAG_REINDEX_CRON_ENABLED ?? 'false') !== 'true') return;
    try {
      const result = await this.reindexAll();
      this.logger.log(
        `Tag index reconciled: ${result.tagsIndexed} tags, ${result.bindingsCreated} bindings`,
      );
    } catch (error) {
      this.logger.error('Failed to reconcile tag index snapshot', error as any);
    }
  }
}
