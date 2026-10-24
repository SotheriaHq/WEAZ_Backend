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
    const [collections, products, brands, userBrandOwners, bannedRows] =
      await Promise.all([
        this.prisma.collection.findMany({
          where: {
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            deletedAt: null,
          },
          select: { id: true, tags: true },
        }),
        this.prisma.product.findMany({
          where: {
            isActive: true,
            deletedAt: null,
            archivedAt: null,
            OR: [{ publishAt: null }, { publishAt: { lte: now } }],
          },
          select: { id: true, tags: true },
        }),
        this.prisma.brand.findMany({
          where: { isStoreOpen: true },
          select: { id: true, tags: true },
        }),
        this.prisma.brand.findMany({
          where: { owner: { type: 'BRAND' } },
          select: { ownerId: true, tags: true },
        }),
        prismaClient.tag.findMany({
          where: { isBanned: true },
          select: { normalizedName: true },
        }),
      ]);
    const banned = new Set<string>(
      (bannedRows as Array<{ normalizedName: string }>).map(
        (row) => row.normalizedName,
      ),
    );

    await this.prisma.$transaction(async (tx) => {
      await (tx as any).tagBinding.deleteMany({});
      await (tx as any).tag.updateMany({
        data: { usageCount: 0, lastUsedAt: null },
      });
      // Note: systemTag table not in schema, skipping systemTag operations
    });

    let bindingsCreated = 0;
    for (const c of collections) {
      const tags = this.normalizeTagList(c.tags ?? [], 30).filter(
        (tag) => !banned.has(tag),
      );
      if (tags.length === 0) continue;
      bindingsCreated += tags.length;
      await this.syncEntityTags(TAG_ENTITY_TYPE.COLLECTION, c.id, [], tags, {
        maxCount: 30,
        notifyMentions: false,
      });
    }
    for (const p of products) {
      const tags = this.normalizeTagList(p.tags ?? [], 30).filter(
        (tag) => !banned.has(tag),
      );
      if (tags.length === 0) continue;
      bindingsCreated += tags.length;
      await this.syncEntityTags(TAG_ENTITY_TYPE.PRODUCT, p.id, [], tags, {
        maxCount: 30,
        notifyMentions: false,
      });
    }
    for (const b of brands) {
      const tags = this.normalizeTagList(b.tags ?? [], 30).filter(
        (tag) => !banned.has(tag),
      );
      if (tags.length === 0) continue;
      bindingsCreated += tags.length;
      await this.syncEntityTags(TAG_ENTITY_TYPE.BRAND, b.id, [], tags, {
        maxCount: 30,
        notifyMentions: false,
      });
    }
    for (const u of userBrandOwners) {
      const tags = this.normalizeTagList(u.tags ?? [], 10).filter(
        (tag) => !banned.has(tag),
      );
      if (tags.length === 0) continue;
      bindingsCreated += tags.length;
      await this.syncEntityTags(
        TAG_ENTITY_TYPE.USER_BRAND,
        u.ownerId,
        [],
        tags,
        {
          maxCount: 10,
          notifyMentions: false,
        },
      );
    }

    const tagsIndexed = await prismaClient.tag.count();
    return { tagsIndexed, bindingsCreated };
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
