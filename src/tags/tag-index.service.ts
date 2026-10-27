import { loadCurrentTagSources } from './tag-source-query';
import {
  acknowledgeTagProjections,
  claimTagJobs,
  failTagJob,
  readTagProjectionJobs,
  reapTagJobs,
  tagProjectionErrorCode,
  TagProjectionJob,
  TagUsageJob,
} from './tag-projection-query';
import { retryDatabaseTransaction } from '../common/transaction-retry.util';
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
  skipModerated?: boolean;
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
    await this.syncEntitiesTags([
      { entityType, entityId, previousTags, nextTags, options },
    ]);
  }

  async syncEntitiesTags(
    entries: Array<{
      entityType: TagEntityTypeValue;
      entityId: string;
      previousTags: Array<string | null | undefined>;
      nextTags: Array<string | null | undefined>;
      options?: SyncEntityTagsOptions;
    }>,
    claims?: readonly TagProjectionJob[],
  ): Promise<number> {
    const keys = new Set<string>();
    const requests = entries.map((entry) => {
      const normalized = { ...entry, entityId: entry.entityId.toLowerCase() };
      const key = normalized.entityType + ':' + normalized.entityId;
      if (keys.has(key))
        throw new BadRequestException(
          'Duplicate entity in tag synchronization batch',
        );
      keys.add(key);
      return normalized;
    });
    let bindingCount = 0;
    for (let offset = 0; offset < requests.length; offset += 500) {
      const requestedBatch = requests.slice(offset, offset + 500);
      bindingCount += await retryDatabaseTransaction(() =>
        this.prisma.$transaction(
          async (tx) => {
            const sources = await loadCurrentTagSources(
              tx,
              requestedBatch,
              !!claims,
            );
            const jobs = await readTagProjectionJobs(tx, requestedBatch);
            const captured = new Map(
              jobs.map((job) => [job.entityType + ':' + job.entityId, job]),
            );
            const expectedClaims = new Map(
              claims?.map((job) => [job.entityType + ':' + job.entityId, job]),
            );
            const batch = requestedBatch.filter((entry) => {
              if (!claims) return true;
              const key = entry.entityType + ':' + entry.entityId;
              const expected = expectedClaims.get(key),
                current = captured.get(key);
              return (
                expected &&
                current &&
                current.status === 'PROCESSING' &&
                current.leaseValid &&
                current.generation === expected.generation &&
                current.lockOwner === expected.lockOwner
              );
            });
            if (!batch.length) return 0;
            const sourceMap = new Map(
              sources.map((source) => [
                source.entityType + ':' + source.entityId,
                source,
              ]),
            );
            const scope = {
              OR: batch.map(({ entityType, entityId }) => ({
                entityType,
                entityId,
              })),
            };
            const bindingSelect = {
              id: true,
              tagId: true,
              entityType: true,
              entityId: true,
            } as const;
            const before = await tx.tagBinding.findMany({
              where: scope,
              select: bindingSelect,
            });
            const desired = batch.map((entry) => {
              const source = sourceMap.get(
                entry.entityType + ':' + entry.entityId,
              );
              const sourceLimit =
                entry.entityType === TAG_ENTITY_TYPE.USER_BRAND ? 10 : 30;
              return {
                ...entry,
                names: source?.indexable
                  ? this.normalizeTagList(
                      source.tags,
                      Math.min(
                        entry.options?.maxCount ?? sourceLimit,
                        sourceLimit,
                      ),
                    )
                  : [],
              };
            });
            const names = [
              ...new Set(desired.flatMap((entry) => entry.names)),
            ].sort();
            const creatorByName = new Map<string, string | null>();
            for (const entry of desired)
              for (const name of entry.names) {
                if (!creatorByName.has(name))
                  creatorByName.set(name, entry.options?.actorId ?? null);
              }
            const now = new Date();
            for (let start = 0; start < names.length; start += 500) {
              await tx.tag.createMany({
                data: names.slice(start, start + 500).map((name) => ({
                  id: uuidv4(),
                  normalizedName: name,
                  displayName: name,
                  status: TagStatus.PENDING,
                  createdById: creatorByName.get(name) ?? null,
                  usageCount: 0,
                  lastUsedAt: now,
                  isBanned: false,
                })),
                skipDuplicates: true,
              });
            }
            type TagRow = {
              id: string;
              normalizedName: string;
              aliasOfTagId: string | null;
            };
            const known = new Map<string, TagRow>();
            const remember = (rows: TagRow[]) =>
              rows.forEach((row) => known.set(row.id, row));
            for (let start = 0; start < names.length; start += 500)
              remember(
                await tx.tag.findMany({
                  where: {
                    normalizedName: { in: names.slice(start, start + 500) },
                  },
                  select: {
                    id: true,
                    normalizedName: true,
                    aliasOfTagId: true,
                  },
                }),
              );
            let pending = [...new Set(before.map((row) => row.tagId))].filter(
              (id) => !known.has(id),
            );
            for (let depth = 0; ; depth++) {
              pending = [
                ...new Set([
                  ...pending,
                  ...[...known.values()].flatMap((row) =>
                    row.aliasOfTagId && !known.has(row.aliasOfTagId)
                      ? [row.aliasOfTagId]
                      : [],
                  ),
                ]),
              ];
              if (!pending.length) break;
              if (depth >= 16)
                throw new Error('Tag alias graph exceeds the supported depth');
              for (let start = 0; start < pending.length; start += 500)
                remember(
                  await tx.tag.findMany({
                    where: { id: { in: pending.slice(start, start + 500) } },
                    select: {
                      id: true,
                      normalizedName: true,
                      aliasOfTagId: true,
                    },
                  }),
                );
              if (pending.some((id) => !known.has(id)))
                throw Object.assign(
                  new Error('Tag source changed during reconciliation'),
                  { code: 'P2034' },
                );
              pending = [];
            }
            const locked = await lockTagRows(tx, [...known.keys()]);
            const byId = new Map(locked.map((tag) => [tag.id, tag]));
            const byName = new Map(
              locked.map((tag) => [tag.normalizedName, tag.id]),
            );
            const current = await tx.tagBinding.findMany({
              where: scope,
              select: bindingSelect,
            });
            if (current.some((binding) => !byId.has(binding.tagId)))
              throw Object.assign(
                new Error('Tag bindings changed during reconciliation'),
                { code: 'P2034' },
              );
            const expected = new Set<string>();
            const additions: Prisma.TagBindingCreateManyInput[] = [];
            for (const entry of desired)
              for (const name of entry.names) {
                let tag = byId.get(byName.get(name) ?? '');
                const visited = new Set<string>();
                while (tag) {
                  if (visited.has(tag.id))
                    throw new Error('Tag alias cycle detected');
                  visited.add(tag.id);
                  if (tag.isBanned || tag.status === TagStatus.REJECTED) {
                    if (!entry.options?.skipModerated)
                      throw new BadRequestException(
                        `One or more tags are blocked: #${name}`,
                      );
                    tag = undefined;
                    break;
                  }
                  if (!tag.aliasOfTagId) break;
                  if (!byId.has(tag.aliasOfTagId))
                    throw Object.assign(
                      new Error('Tag alias changed during reconciliation'),
                      { code: 'P2034' },
                    );
                  tag = byId.get(tag.aliasOfTagId);
                }
                if (!tag) continue;
                const key =
                  entry.entityType + ':' + entry.entityId + ':' + tag.id;
                if (expected.has(key)) continue;
                expected.add(key);
                additions.push({
                  id: uuidv4(),
                  tagId: tag.id,
                  entityType: entry.entityType,
                  entityId: entry.entityId,
                });
              }
            const removals = current.filter(
              (row) =>
                !expected.has(
                  row.entityType + ':' + row.entityId + ':' + row.tagId,
                ),
            );
            for (let start = 0; start < removals.length; start += 500)
              await tx.tagBinding.deleteMany({
                where: {
                  id: {
                    in: removals.slice(start, start + 500).map((row) => row.id),
                  },
                },
              });
            for (let start = 0; start < additions.length; start += 500)
              await tx.tagBinding.createMany({
                data: additions.slice(start, start + 500),
                skipDuplicates: true,
              });
            await refreshTagUsageCounts(
              tx,
              locked.map((tag) => tag.id),
              now,
            );
            await acknowledgeTagProjections(
              tx,
              batch.flatMap((entry) => {
                const key = entry.entityType + ':' + entry.entityId;
                const job = captured.get(key);
                return job
                  ? [
                      {
                        ...job,
                        nextRefreshAt: sourceMap.get(key)?.nextRefreshAt,
                      },
                    ]
                  : [];
              }),
              !!claims,
            );
            return expected.size;
          },
          {
            isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
            timeout: 15000,
          },
        ),
      );
    }
    return bindingCount;
  }

  /** Durable retries are bounded; requests still take the immediate path. */
  @Cron(CronExpression.EVERY_10_SECONDS, { waitForCompletion: true })
  async recoverTagProjections(): Promise<void> {
    for (const kind of ['source', 'usage'] as const) {
      const exhausted = await reapTagJobs(this.prisma, kind);
      if (exhausted)
        this.logger.error({
          event: 'tag_projection_exhausted',
          kind,
          count: exhausted,
        });
    }
    const sources = await claimTagJobs(this.prisma, 'source', 25);
    const project = (jobs: TagProjectionJob[]) =>
      this.syncEntitiesTags(
        jobs.map((job) => ({
          ...job,
          previousTags: [],
          nextTags: [],
          options: { skipModerated: true, notifyMentions: false },
        })),
        jobs,
      );
    if (sources.length) {
      try {
        await project(sources);
      } catch {
        // A malformed source cannot keep healthy neighbours behind it.
        for (const job of sources) {
          try {
            await project([job]);
          } catch (error) {
            await this.recordProjectionFailure('source', job, error);
          }
        }
      }
    }
    const usages = await claimTagJobs(this.prisma, 'usage', 100);
    if (usages.length) {
      try {
        await this.projectUsageJobs(usages);
      } catch {
        for (const job of usages) {
          try {
            await this.projectUsageJobs([job]);
          } catch (error) {
            await this.recordProjectionFailure('usage', job, error);
          }
        }
      }
    }
  }

  private async projectUsageJobs(jobs: TagUsageJob[]) {
    await this.prisma.$transaction(
      async (tx) => {
        await lockTagRows(
          tx,
          jobs.map((job) => job.tagId),
        );
        // Read ownership after tag-lock waits. The count/ack statement has its own
        // generation fence so a concurrent FK cascade cannot lose its repair job.
        const current = await tx.$queryRaw<Array<{ tagId: string }>>(Prisma.sql`
        SELECT q."tagId" FROM "TagUsageOutbox" q JOIN (VALUES ${Prisma.join(jobs.map((job) => Prisma.sql`(${job.tagId}::uuid,${job.generation}::uuid,${job.lockOwner}::uuid)`))}) claimed(id,generation,owner)
        ON q."tagId"=claimed.id AND q.generation=claimed.generation AND q."lockOwner"=claimed.owner
        WHERE q.status='PROCESSING' AND q."lockExpiresAt">clock_timestamp() AT TIME ZONE 'UTC'
      `);
        if (current.length)
          await refreshTagUsageCounts(
            tx,
            current.map((row) => row.tagId),
            new Date(),
            jobs,
          );
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        timeout: 15000,
      },
    );
  }

  private async recordProjectionFailure(
    kind: 'source' | 'usage',
    job: TagProjectionJob | TagUsageJob,
    error: unknown,
  ) {
    const updated = await failTagJob(this.prisma, kind, job, error);
    if (updated)
      this.logger.warn({
        event: 'tag_projection_retry',
        kind,
        code: tagProjectionErrorCode(error),
        attempt: job.attempts,
        exhausted: job.attempts >= 8 && tagProjectionErrorCode(error) !== '55P03',
      });
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
        const entries = normalized.map((row) => ({
          entityType: source.entityType,
          entityId: row.entityId,
          previousTags: [] as string[],
          nextTags: row.tags,
          options: {
            maxCount: source.maxCount,
            notifyMentions: false,
            skipModerated: true,
          },
        }));
        bindingsCreated += await this.syncEntitiesTags(entries);
        afterId = rows[rows.length - 1].id;
      }
    }

    await this.removeIneligibleBindings();
    // Repair pre-outbox counters too, including tags with no remaining binding.
    let afterTag: string | undefined;
    for (;;) {
      const page = await this.prisma.tag.findMany({
        where: afterTag ? { id: { gt: afterTag } } : {},
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
      });
      if (!page.length) break;
      await this.prisma.$transaction(
        async (tx) => {
          await lockTagRows(
            tx,
            page.map((tag) => tag.id),
          );
          await refreshTagUsageCounts(
            tx,
            page.map((tag) => tag.id),
            new Date(),
          );
        },
        { timeout: 15000 },
      );
      afterTag = page[page.length - 1].id;
    }
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
      const stale = await this.prisma.$queryRaw<
        Array<{ id: string; tagId: string }>
      >(Prisma.sql`
        SELECT b."_id" AS id, b."tagId" FROM "TagBinding" b
        WHERE ${this.ineligibleBindingCondition()}
        ORDER BY b."_id" LIMIT ${batchSize}
      `);
      if (!stale.length) return;
      await this.prisma.$transaction(async (tx) => {
        const locked = await lockTagRows(
          tx,
          stale.map((row) => row.tagId),
        );
        await tx.$executeRaw(Prisma.sql`
          DELETE FROM "TagBinding" b
          WHERE b."_id" = ANY(${stale.map((row) => row.id)}::uuid[])
            AND ${this.ineligibleBindingCondition()}
        `);
        await refreshTagUsageCounts(
          tx,
          locked.map((row) => row.id),
          new Date(),
        );
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
