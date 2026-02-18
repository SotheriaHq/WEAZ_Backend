import {
  BadRequestException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { NotificationType } from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import { sanitizeTags, normalizeTag } from 'src/common/utils/tag-validator';
import { TAG_ENTITY_TYPE, TagEntityTypeValue } from './tag-entity-type';

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

  async syncEntityTags(
    entityType: TagEntityTypeValue,
    entityId: string,
    previousTags: Array<string | null | undefined>,
    nextTags: Array<string | null | undefined>,
    options?: SyncEntityTagsOptions,
  ): Promise<void> {
    const maxCount = options?.maxCount ?? 30;
    const prev = new Set(this.normalizeTagList(previousTags, maxCount));
    const next = new Set(this.normalizeTagList(nextTags, maxCount));

    const added = Array.from(next).filter((tag) => !prev.has(tag));
    const removed = Array.from(prev).filter((tag) => !next.has(tag));
    const affected = Array.from(new Set([...added, ...removed]));

    if (affected.length === 0) return;

    const banned = await (this.prisma as any).tag.findMany({
      where: { normalizedName: { in: added }, isBanned: true },
      select: { normalizedName: true },
    });

    if (banned.length > 0) {
      throw new BadRequestException(
        `One or more tags are blocked: ${banned.map((t) => `#${t.normalizedName}`).join(', ')}`,
      );
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const tagIdByName = new Map<string, string>();

      if (affected.length > 0) {
        const existing = await (tx as any).tag.findMany({
          where: { normalizedName: { in: affected } },
          select: { id: true, normalizedName: true },
        });
        for (const row of existing) tagIdByName.set(row.normalizedName, row.id);
      }

      for (const name of added) {
        if (tagIdByName.has(name)) continue;
        const row = await (tx as any).tag.upsert({
          where: { normalizedName: name },
          create: {
            id: uuidv4(),
            normalizedName: name,
            displayName: name,
            usageCount: 0,
            lastUsedAt: now,
          },
          update: { displayName: name },
          select: { id: true, normalizedName: true },
        });
        tagIdByName.set(row.normalizedName, row.id);
      }

      const addedBindings = added
        .map((name) => {
          const tagId = tagIdByName.get(name);
          if (!tagId) return null;
          return {
            id: uuidv4(),
            tagId,
            entityType,
            entityId,
          };
        })
        .filter(Boolean) as Array<{
        id: string;
        tagId: string;
        entityType: TagEntityTypeValue;
        entityId: string;
      }>;

      if (addedBindings.length > 0) {
        await (tx as any).tagBinding.createMany({
          data: addedBindings,
          skipDuplicates: true,
        });
      }

      const removedTagIds = removed
        .map((name) => tagIdByName.get(name))
        .filter(Boolean) as string[];

      if (removedTagIds.length > 0) {
        await (tx as any).tagBinding.deleteMany({
          where: {
            entityType,
            entityId,
            tagId: { in: removedTagIds },
          },
        });
      }

      const affectedRows = await (tx as any).tag.findMany({
        where: { normalizedName: { in: affected } },
        select: { id: true, normalizedName: true },
      });

      const zeroUsageNames: string[] = [];
      for (const row of affectedRows) {
        const count = await (tx as any).tagBinding.count({
          where: { tagId: row.id },
        });
        await (tx as any).tag.update({
          where: { id: row.id },
          data: {
            usageCount: count,
            lastUsedAt: count > 0 ? now : null,
          },
        });
        if (count === 0) {
          zeroUsageNames.push(row.normalizedName);
        }
      }

      const allNext = Array.from(next);
      if (allNext.length > 0) {
        await tx.systemTag.createMany({
          data: allNext.map((tag) => ({ id: uuidv4(), tag })),
          skipDuplicates: true,
        });
      }

      if (zeroUsageNames.length > 0) {
        await tx.systemTag.deleteMany({
          where: { tag: { in: zeroUsageNames } },
        });
      }
    });

    if (added.length > 0 && options?.notifyMentions !== false) {
      try {
        await this.notifyTagMentions(
          entityType,
          entityId,
          added,
          options?.actorId ?? null,
          options?.entityTitle,
        );
      } catch (error) {
        this.logger.warn(
          `Failed TAG_MENTION notification fanout for ${entityType}:${entityId} - ${String(
            error,
          )}`,
        );
      }
    }
  }

  private async resolveMentionContext(
    entityType: TagEntityTypeValue,
    entityId: string,
  ): Promise<
    | {
        actorId: string | null;
        entityTitle: string;
        target:
          | { type: 'COLLECTION'; id: string; preview?: string }
          | { type: 'PRODUCT'; id: string; preview?: string }
          | { type: 'USER'; id: string; preview?: string }
          | { type: 'SYSTEM'; id: string; preview?: string };
        targetUrl?: string;
      }
    | null
  > {
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
          brandFullName: true,
        },
      });
      if (!user || user.type !== 'BRAND') return null;
      const title = user.brandFullName || user.username || 'Brand profile';
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

    const [brands, users] = await Promise.all([
      this.prisma.brand.findMany({
        where: {
          isStoreOpen: true,
          tags: { hasSome: normalizedAdded },
        },
        select: {
          id: true,
          ownerId: true,
          tags: true,
        },
      }),
      this.prisma.user.findMany({
        where: {
          type: 'BRAND',
          brandTags: { hasSome: normalizedAdded },
        },
        select: {
          id: true,
          brandTags: true,
        },
      }),
    ]);

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
      if (
        entityType === TAG_ENTITY_TYPE.BRAND &&
        brand.id === entityId
      ) {
        continue;
      }

      const matched = (brand.tags ?? [])
        .map((tag) => this.normalizeTagName(tag))
        .filter((tag) => tag && addedSet.has(tag));

      for (const tag of matched) addRecipientTag(brand.ownerId, tag);
    }

    for (const user of users) {
      if (
        entityType === TAG_ENTITY_TYPE.USER_BRAND &&
        user.id === entityId
      ) {
        continue;
      }

      const matched = (user.brandTags ?? [])
        .map((tag) => this.normalizeTagName(tag))
        .filter((tag) => tag && addedSet.has(tag));

      for (const tag of matched) addRecipientTag(user.id, tag);
    }

    if (recipientTags.size === 0) return;

    const notificationPromises = Array.from(recipientTags.entries()).map(
      async ([recipientId, tagsSet]) => {
        const tags = Array.from(tagsSet);
        const previewTags = tags.slice(0, 3).map((tag) => `#${tag}`).join(', ');
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
    const now = new Date();
    const [collections, products, brands, users, bannedRows] = await Promise.all([
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
      this.prisma.user.findMany({
        where: { type: 'BRAND' },
        select: { id: true, brandTags: true },
      }),
      (this.prisma as any).tag.findMany({
        where: { isBanned: true },
        select: { normalizedName: true },
      }),
    ]);
    const banned = new Set<string>(
      (bannedRows as Array<{ normalizedName: string }>).map((row) => row.normalizedName),
    );

    await this.prisma.$transaction(async (tx) => {
      await (tx as any).tagBinding.deleteMany({});
      await (tx as any).tag.updateMany({
        data: { usageCount: 0, lastUsedAt: null },
      });
      await tx.systemTag.deleteMany({});
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
    for (const u of users) {
      const tags = this.normalizeTagList(u.brandTags ?? [], 10).filter(
        (tag) => !banned.has(tag),
      );
      if (tags.length === 0) continue;
      bindingsCreated += tags.length;
      await this.syncEntityTags(TAG_ENTITY_TYPE.USER_BRAND, u.id, [], tags, {
        maxCount: 10,
        notifyMentions: false,
      });
    }

    const tagsIndexed = await (this.prisma as any).tag.count();
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
