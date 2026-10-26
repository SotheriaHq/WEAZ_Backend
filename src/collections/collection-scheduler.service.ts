import type { NotificationEvent } from '../notifications/notification-batch-query';
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NotificationType, Prisma } from '@prisma/client';
import { UploadService } from 'src/upload/upload.service';
import { ClockService } from 'src/common/clock/clock.service';
import {
  DRAFT_EXPIRY_CONFIG,
  getDraftExpiryDate,
  getDaysUntilExpiry,
} from './config/draft-expiry.config';
import { ClockEffectiveState } from 'src/common/clock/clock.types';

export interface DraftCleanupSummary {
  clockState: ClockEffectiveState;
  skipped: boolean;
  reason?: string;
  firstWarningsSent?: number;
  finalWarningsSent?: number;
  draftsDeleted?: number;
  softDeletedCollectionsDeleted?: number;
}

/**
 * Scheduled jobs for collection management:
 * - Draft expiry warnings (configurable days before expiry)
 * - Draft auto-deletion (configurable TTL)
 * - Orphaned S3 object cleanup
 *
 * Configuration via environment variables:
 * - DRAFT_TTL_DAYS: Days before draft expires (default: 30)
 * - DRAFT_WARNING_DAYS_FIRST: Days before expiry for first warning (default: 7)
 * - DRAFT_WARNING_DAYS_FINAL: Days before expiry for final warning (default: 1)
 * - PRESIGN_TTL_HOURS: Hours before orphaned presigns are cleaned (default: 24)
 * - DRAFT_CLEANUP_ENABLED: Enable/disable cleanup job (default: true)
 * - DRAFT_WARNINGS_ENABLED: Enable/disable warning notifications (default: true)
 */
@Injectable()
export class CollectionSchedulerService {
  private readonly logger = new Logger(CollectionSchedulerService.name);
  private readonly config = DRAFT_EXPIRY_CONFIG;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly uploadService: UploadService,
    private readonly clock: ClockService,
  ) {}

  /**
   * Run daily at midnight to clean up expired drafts and send warnings
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDraftCleanup(): Promise<void> {
    await this.runDraftCleanup();
  }

  /**
   * Core draft cleanup logic shared by the scheduled cron and the non-production
   * manual trigger. Returns a summary of what was processed.
   */
  async runDraftCleanup(): Promise<DraftCleanupSummary> {
    const clockState = this.clock.getEffectiveState();

    if (!this.config.CLEANUP_ENABLED) {
      this.logger.log('Draft cleanup job is disabled');
      return { clockState, skipped: true, reason: 'CLEANUP_ENABLED=false' };
    }

    this.logger.log('Starting draft cleanup job...');
    this.logger.log(
      `Config: TTL=${this.config.DRAFT_TTL_DAYS}d, FirstWarning=${this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY}d, FinalWarning=${this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY}d`,
    );
    this.logger.log(
      `Clock: mode=${clockState.mode}, effectiveNow=${clockState.effectiveNow}`,
    );

    const now = this.clock.now();
    const msPerDay = 24 * 60 * 60 * 1000;

    // Calculate dates based on config
    const expiryThreshold = new Date(
      now.getTime() - this.config.DRAFT_TTL_DAYS * msPerDay,
    );
    const firstWarningDate = new Date(
      now.getTime() -
        (this.config.DRAFT_TTL_DAYS -
          this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY) *
          msPerDay,
    );
    const finalWarningDate = new Date(
      now.getTime() -
        (this.config.DRAFT_TTL_DAYS -
          this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY) *
          msPerDay,
    );

    const summary: DraftCleanupSummary = {
      clockState,
      skipped: false,
      firstWarningsSent: 0,
      finalWarningsSent: 0,
      draftsDeleted: 0,
      softDeletedCollectionsDeleted: 0,
    };

    try {
      if (this.config.WARNINGS_ENABLED) {
        // 1. Send first warning for drafts approaching expiry
        summary.firstWarningsSent = await this.sendExpiryWarnings(
          firstWarningDate,
          this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY,
        );

        // 2. Send final warning for drafts about to expire
        summary.finalWarningsSent = await this.sendExpiryWarnings(
          finalWarningDate,
          this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY,
        );
      }

      // 3. Delete drafts older than TTL
      summary.draftsDeleted = await this.deleteExpiredDrafts(expiryThreshold);

      // 4. Clean up orphaned presigned uploads (always real time — security boundary)
      await this.cleanupOrphanedPresigns();

      // 5. Permanently delete collections past soft-delete window
      summary.softDeletedCollectionsDeleted =
        await this.deleteExpiredSoftDeletedCollections(now);

      this.logger.log('Draft cleanup job completed successfully');
    } catch (error) {
      this.logger.error('Draft cleanup job failed:', error);
      throw error;
    }

    return summary;
  }

  /**
   * Send expiry warning notifications for drafts approaching expiry
   */
  private async sendExpiryWarnings(
    activityBefore: Date,
    daysRemaining: number,
  ): Promise<number> {
    const activityAfter = new Date(
      activityBefore.getTime() - 24 * 60 * 60 * 1000,
    );

    const drafts = await (this.prisma as any).collection.findMany({
      where: {
        status: 'DRAFT',
        deletedAt: null,
        OR: [
          {
            lastActivityAt: {
              gte: activityAfter,
              lte: activityBefore,
            },
          },
          {
            lastActivityAt: null,
            createdAt: {
              gte: activityAfter,
              lte: activityBefore,
            },
          },
        ],
      },
      include: { _count: { select: { medias: true, products: true } } },
      take: this.config.CLEANUP_BATCH_SIZE,
    });

    const events: NotificationEvent[] = drafts.map((draft) => ({
      recipientId: draft.ownerId,
      type: NotificationType.COLLECTION_DELETED,
      opts: {
        payload: {
          type: 'DRAFT_EXPIRY_WARNING',
          collectionId: draft.id,
          collectionTitle: draft.title || 'Untitled Draft',
          daysRemaining,
          expiryDate: getDraftExpiryDate(
            draft.lastActivityAt ?? draft.createdAt,
          ).toISOString(),
          mediaCount: draft._count.medias,
          productCount: draft._count.products,
          targetUrl: `/studio/drafts/${draft.id}`,
        },
      },
    }));
    if (events.length) {
      const results = await this.notifications.createEvents(events);
      results.forEach((result, index) => {
        if (result.status === 'rejected')
          this.logger.error(
            `Failed to send expiry warning for draft ${drafts[index].id}:`,
            result.reason,
          );
      });
    }

    this.logger.log(
      `Sent ${drafts.length} expiry warnings (${daysRemaining} days remaining)`,
    );
    return drafts.length;
  }

  /**
   * Delete drafts older than TTL and notify owners
   */
  private async deleteExpiredDrafts(activityBefore: Date): Promise<number> {
    const expiredDrafts = await (this.prisma as any).collection.findMany({
      where: {
        status: 'DRAFT',
        deletedAt: null,
        OR: [
          { lastActivityAt: { lte: activityBefore } },
          { lastActivityAt: null, createdAt: { lte: activityBefore } },
        ],
      },
      include: { _count: { select: { medias: true, products: true } } },
      take: this.config.CLEANUP_BATCH_SIZE,
    });

    let deleted = 0;
    const events: NotificationEvent[] = [];
    for (const draft of expiredDrafts) {
      try {
        if (
          !(await this.deleteExpiredCollection(
            draft.id,
            'DRAFT',
            activityBefore,
          ))
        )
          continue;
        deleted++;
        events.push({
          recipientId: draft.ownerId,
          type: NotificationType.COLLECTION_DELETED,
          opts: {
            payload: {
              type: 'DRAFT_AUTO_DELETED',
              collectionId: draft.id,
              collectionTitle: draft.title || 'Untitled Draft',
              mediaCount: draft._count.medias,
              productCount: draft._count.products,
              reason: `Automatically deleted after ${this.config.DRAFT_TTL_DAYS} days of inactivity`,
            },
          },
        });
      } catch (error) {
        this.logger.error(
          `Failed to clean up expired draft ${draft.id}:`,
          error,
        );
      }
    }
    if (events.length) {
      const results = await this.notifications.createEvents(events);
      for (const result of results)
        if (result.status === 'rejected')
          this.logger.error(
            'Failed to send draft deletion notice:',
            result.reason,
          );
    }
    this.logger.log(`Deleted ${deleted} expired drafts`);
    return deleted;
  }

  /**
   * Clean up orphaned presigned uploads (expired but never finalized).
   * Intentionally uses real wall-clock time — this is a security/provider boundary.
   */
  private async cleanupOrphanedPresigns() {
    const ttlMs = this.config.PRESIGN_TTL_HOURS * 60 * 60 * 1000;
    const expiryThreshold = new Date(Date.now() - ttlMs);

    const deleted = await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        Array<{ id: string; s3Key: string; finalizeTargetKey: string | null }>
      >`
        SELECT "_id" AS id, "s3Key", "finalizeTargetKey" FROM "PresignedUpload"
        WHERE status IN ('PENDING', 'READY', 'EXPIRED') AND "expiresAt" <= ${expiryThreshold}
          AND ("finalizeLeaseUntil" IS NULL OR "finalizeLeaseUntil" <= (clock_timestamp() AT TIME ZONE 'UTC'))
        ORDER BY "expiresAt", "_id" LIMIT 100 FOR UPDATE SKIP LOCKED
      `;
      if (!rows.length) return 0;
      const keys = [
        ...new Set(
          rows
            .flatMap((row) => [row.s3Key, row.finalizeTargetKey])
            .filter((key): key is string => Boolean(key)),
        ),
      ];
      await tx.storageObjectDeletion.createMany({
        data: keys.map((s3Key) => ({ s3Key })),
        skipDuplicates: true,
      });
      return (
        await tx.presignedUpload.deleteMany({
          where: { id: { in: rows.map((row) => row.id) } },
        })
      ).count;
    });
    this.logger.log(`Cleaned up ${deleted} orphaned presigned uploads`);
  }

  /**
   * Permanently delete collections past soft-delete recovery window.
   * Uses effective clock time so fake clock tests can advance past the window.
   */
  private async deleteExpiredSoftDeletedCollections(
    now: Date,
  ): Promise<number> {
    const candidates = await (this.prisma as any).collection.findMany({
      where: {
        deletedAt: { not: null },
        deleteExpiresAt: { lte: now },
      },
      select: { id: true },
      take: this.config.CLEANUP_BATCH_SIZE,
    });

    let deleted = 0;
    for (const entry of candidates) {
      try {
        if (await this.deleteExpiredCollection(entry.id, 'SOFT', now))
          deleted++;
      } catch (error) {
        this.logger.error(
          `Failed to hard-delete collection ${entry.id}:`,
          error,
        );
      }
    }
    return deleted;
  }

  private async deleteExpiredCollection(
    id: string,
    mode: 'DRAFT' | 'SOFT',
    cutoff: Date,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const eligibility =
        mode === 'DRAFT'
          ? Prisma.sql`status = 'DRAFT' AND "deletedAt" IS NULL AND
            ("lastActivityAt" <= ${cutoff} OR ("lastActivityAt" IS NULL AND "createdAt" <= ${cutoff}))`
          : Prisma.sql`"deletedAt" IS NOT NULL AND "deleteExpiresAt" <= ${cutoff}`;
      // Lock and recheck the aggregate, then join all of its immutable storage keys.
      const rows = await tx.$queryRaw<
        Array<{
          id: string;
          fileId: string | null;
          s3Key: string | null;
          variantKey: string | null;
        }>
      >(Prisma.sql`
        WITH claimed AS (
          SELECT "_id" FROM "Collection" WHERE "_id" = ${id}::uuid AND ${eligibility}
          FOR UPDATE SKIP LOCKED
        )
        SELECT claimed."_id" AS id, file."_id" AS "fileId", file."s3Key", variant."s3Key" AS "variantKey"
        FROM claimed
        LEFT JOIN "CollectionMedia" media ON media."collectionId" = claimed."_id"
        LEFT JOIN "FileUpload" file ON file."_id" = media."fileUploadId"
        LEFT JOIN "FileVariant" variant ON variant."fileUploadId" = file."_id"
      `);
      if (!rows.length) return false;
      const fileIds = [
        ...new Set(rows.flatMap((row) => (row.fileId ? [row.fileId] : []))),
      ];
      const keys = [
        ...new Set(
          rows
            .flatMap((row) => [row.s3Key, row.variantKey])
            .filter((key): key is string => Boolean(key)),
        ),
      ];
      await tx.collectionMedia.deleteMany({ where: { collectionId: id } });
      if (fileIds.length)
        await tx.fileUpload.deleteMany({ where: { id: { in: fileIds } } });
      await tx.collection.delete({ where: { id } });
      if (keys.length)
        await tx.storageObjectDeletion.createMany({
          data: keys.map((s3Key) => ({ s3Key })),
          skipDuplicates: true,
        });
      return true;
    });
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async dispatchStorageDeletions(): Promise<void> {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + 5 * 60_000);
    const claimed = await this.prisma.$queryRaw<
      Array<{ s3Key: string; attempts: number }>
    >`
      WITH pending AS (
        SELECT "s3Key" FROM "StorageObjectDeletion" job
        WHERE "nextAttemptAt" <= ${now} AND ("leaseUntil" IS NULL OR "leaseUntil" <= ${now})
          AND NOT EXISTS (SELECT 1 FROM "PresignedUpload" intent
            WHERE intent."finalizeTargetKey" = job."s3Key" AND intent."finalizeLeaseUntil" > (clock_timestamp() AT TIME ZONE 'UTC'))
          AND NOT EXISTS (SELECT 1 FROM "FileUpload" processing_file
            WHERE processing_file."_id" = job."processingFileId"
              AND processing_file."processingLeaseToken" = job."processingLeaseToken"
              AND processing_file."processingLeaseUntil" > (clock_timestamp() AT TIME ZONE 'UTC'))
        ORDER BY "nextAttemptAt", "s3Key" LIMIT 100 FOR UPDATE SKIP LOCKED
      )
      UPDATE "StorageObjectDeletion" job SET "leaseUntil" = ${leaseUntil}
      FROM pending WHERE job."s3Key" = pending."s3Key" RETURNING job."s3Key", job.attempts
    `;
    if (!claimed.length) return;
    const keys = claimed.map((job) => job.s3Key);
    try {
      const [files, variants] = await Promise.all([
        this.prisma.fileUpload.findMany({
          where: { s3Key: { in: keys } },
          select: { s3Key: true },
        }),
        this.prisma.fileVariant.findMany({
          where: { s3Key: { in: keys } },
          select: { s3Key: true },
        }),
      ]);
      const referenced = new Set(
        [...files, ...variants].map((file) => file.s3Key),
      );
      const deletable = keys.filter((key) => !referenced.has(key));
      if (deletable.length)
        await this.uploadService.deleteS3ObjectsByKeys(deletable);
      await this.prisma.storageObjectDeletion.deleteMany({
        where: { s3Key: { in: keys }, leaseUntil },
      });
    } catch (error) {
      // One bounded batch, including partial S3 failures, can safely repeat: DELETE is idempotent.
      const attempts = Math.max(...claimed.map((job) => job.attempts));
      const nextAttemptAt = new Date(
        Date.now() +
          Math.min(6 * 60 * 60_000, 30_000 * 2 ** Math.min(attempts, 10)),
      );
      await this.prisma.storageObjectDeletion.updateMany({
        where: { s3Key: { in: keys }, leaseUntil },
        data: { attempts: { increment: 1 }, nextAttemptAt, leaseUntil: null },
      });
      this.logger.error(
        'Storage cleanup batch failed; retained for retry',
        error,
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async recoverPresignedImageProcessing(): Promise<void> {
    const rows = await this.prisma.$queryRaw<
      Array<{ id: string; completed: boolean }>
    >`
      SELECT intent."_id" AS id, (file."lastProcessedAt" IS NOT NULL) AS completed FROM "PresignedUpload" intent
      JOIN "FileUpload" file ON file."_id" = intent."_id"
      WHERE intent.status = 'USED' AND intent."processingEnqueuedAt" IS NULL
        AND intent."processingRequestedAt" IS NOT NULL
      ORDER BY intent."createdAt", intent."_id" LIMIT 100
    `;
    const completedIds = rows
      .filter((row) => row.completed)
      .map((row) => row.id);
    if (completedIds.length)
      await this.prisma.presignedUpload.updateMany({
        where: { id: { in: completedIds }, processingEnqueuedAt: null },
        data: { processingEnqueuedAt: new Date() },
      });
    // Queue deduplication coalesces replicas and crash-after-enqueue retries.
    const pending = rows.filter((row) => !row.completed);
    for (let offset = 0; offset < pending.length; offset += 4) {
      await Promise.all(
        pending
          .slice(offset, offset + 4)
          .map((row) =>
            this.uploadService.dispatchPresignedImageProcessing(row.id),
          ),
      );
    }
  }

  /**
   * Get draft statistics for a user (used by frontend)
   */
  /**
   * Draft expiry stats for one owner.
   *
   * `domain` matters. `Collection` backs BOTH designs (`domain: 'DESIGN'`) and
   * store collections (`domain: 'STORE'`) — see the design/collection
   * decoupling note in CODEMAP — so an unfiltered count mixes two things the
   * product treats as unrelated. The Studio dashboard's Draft Status card reads
   * this and its "View All" opens the STORE collections list, so an unfiltered
   * count meant a brand with two design drafts and no store collections saw
   * "2 Total Drafts", tapped through to an empty list, and reasonably concluded
   * it was looking at someone else's data. It never was: the query has always
   * been `ownerId`-scoped from the JWT subject, with no client-supplied id
   * anywhere in the path.
   *
   * The expiry buckets are new. The web client's `DraftExpiryStats` type has
   * always declared `expiringIn7Days` / `expiringIn3Days` / `expiringToday` /
   * `oldestDraftAge` / `warningThresholdDays`, and this method has never
   * returned any of them — which is why the card rendered blank under
   * "Expiring Soon" and "Expire Today" instead of a number.
   */
  async getDraftStats(userId: string, domain?: 'DESIGN' | 'STORE') {
    const now = this.clock.now();
    const drafts = await (this.prisma as any).collection.findMany({
      where: {
        ownerId: userId,
        status: 'DRAFT',
        deletedAt: null,
        ...(domain ? { domain } : {}),
      },
      include: { _count: { select: { medias: true, products: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    const msPerDay = 24 * 60 * 60 * 1000;
    const daysRemainingByDraft: number[] = drafts.map((d) =>
      getDaysUntilExpiry(d.lastActivityAt ?? d.createdAt, now),
    );
    const oldestDraftAge = drafts.reduce((oldest: number, d) => {
      const anchor: Date = d.createdAt;
      const ageDays = Math.max(
        0,
        Math.floor((now.getTime() - anchor.getTime()) / msPerDay),
      );
      return Math.max(oldest, ageDays);
    }, 0);

    return {
      totalDrafts: drafts.length,
      expiringIn7Days: daysRemainingByDraft.filter((days) => days <= 7).length,
      expiringIn3Days: daysRemainingByDraft.filter((days) => days <= 3).length,
      expiringToday: daysRemainingByDraft.filter((days) => days <= 1).length,
      oldestDraftAge,
      maxDraftsAllowed: 4,
      draftTtlDays: this.config.DRAFT_TTL_DAYS,
      warningThresholdDays: this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY,
      drafts: drafts.map((d) => {
        const anchor = d.lastActivityAt ?? d.createdAt;
        const expiryDate = getDraftExpiryDate(anchor);
        const daysRemaining = getDaysUntilExpiry(anchor, now);

        return {
          id: d.id,
          title: d.title || 'Untitled Draft',
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          expiryDate,
          daysRemaining,
          isExpiringSoon:
            daysRemaining <= this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY,
          isCritical:
            daysRemaining <= this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY,
          mediaCount: d._count.medias,
          productCount: d._count.products,
        };
      }),
    };
  }
}
