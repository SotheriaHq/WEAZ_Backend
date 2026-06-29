import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NotificationType } from '@prisma/client';
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
    this.logger.log(`Clock: mode=${clockState.mode}, effectiveNow=${clockState.effectiveNow}`);

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

    for (const draft of drafts) {
      const anchor = draft.lastActivityAt ?? draft.createdAt;
      const expiryDate = getDraftExpiryDate(anchor);

      try {
        await this.notifications.create(
          draft.ownerId,
          NotificationType.COLLECTION_DELETED, // Re-use or create new type
          {
            payload: {
              type: 'DRAFT_EXPIRY_WARNING',
              collectionId: draft.id,
              collectionTitle: draft.title || 'Untitled Draft',
              daysRemaining,
              expiryDate: expiryDate.toISOString(),
              mediaCount: draft._count.medias,
              productCount: draft._count.products,
              targetUrl: `/studio/drafts/${draft.id}`,
            },
          },
        );

        this.logger.log(
          `Sent ${daysRemaining}-day expiry warning for draft ${draft.id} to user ${draft.ownerId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to send expiry warning for draft ${draft.id}:`,
          error,
        );
      }
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

    for (const draft of expiredDrafts) {
      try {
        // Notify owner before deletion
        await this.notifications.create(
          draft.ownerId,
          NotificationType.COLLECTION_DELETED,
          {
            payload: {
              type: 'DRAFT_AUTO_DELETED',
              collectionId: draft.id,
              collectionTitle: draft.title || 'Untitled Draft',
              mediaCount: draft._count.medias,
              productCount: draft._count.products,
              reason: `Automatically deleted after ${this.config.DRAFT_TTL_DAYS} days of inactivity`,
            },
          },
        );

        const medias = await this.prisma.collectionMedia.findMany({
          where: { collectionId: draft.id },
          include: { file: true },
        });
        const keys = medias
          .map((m) => m.file?.s3Key)
          .filter((k): k is string => !!k);

        if (keys.length > 0) {
          try {
            await this.uploadService.deleteS3ObjectsByKeys(keys);
          } catch (error) {
            this.logger.error(
              `Failed to delete S3 objects for draft ${draft.id}:`,
              error,
            );
          }
        }

        const fileIds = medias
          .map((m) => m.file?.id)
          .filter((id): id is string => !!id);

        await this.prisma.$transaction(async (tx) => {
          await tx.collectionMedia.deleteMany({
            where: { collectionId: draft.id } as any,
          });
          if (fileIds.length) {
            await tx.fileUpload.deleteMany({
              where: { id: { in: fileIds } } as any,
            });
          }
          await tx.collection.delete({ where: { id: draft.id } });
        });

        this.logger.log(`Deleted expired draft ${draft.id}`);
      } catch (error) {
        this.logger.error(`Failed to delete expired draft ${draft.id}:`, error);
      }
    }

    this.logger.log(`Deleted ${expiredDrafts.length} expired drafts`);
    return expiredDrafts.length;
  }

  /**
   * Clean up orphaned presigned uploads (expired but never finalized).
   * Intentionally uses real wall-clock time — this is a security/provider boundary.
   */
  private async cleanupOrphanedPresigns() {
    const ttlMs = this.config.PRESIGN_TTL_HOURS * 60 * 60 * 1000;
    const expiryThreshold = new Date(Date.now() - ttlMs);

    const deleted = await this.prisma.presignedUpload.deleteMany({
      where: {
        status: 'PENDING',
        expiresAt: { lte: expiryThreshold },
      },
    });

    this.logger.log(`Cleaned up ${deleted.count} orphaned presigned uploads`);
  }

  /**
   * Permanently delete collections past soft-delete recovery window.
   * Uses effective clock time so fake clock tests can advance past the window.
   */
  private async deleteExpiredSoftDeletedCollections(now: Date): Promise<number> {
    const candidates = await (this.prisma as any).collection.findMany({
      where: {
        deletedAt: { not: null },
        deleteExpiresAt: { lte: now },
      },
      select: { id: true },
      take: this.config.CLEANUP_BATCH_SIZE,
    });

    for (const entry of candidates) {
      try {
        const medias = await this.prisma.collectionMedia.findMany({
          where: { collectionId: entry.id },
          include: { file: true },
        });
        const keys = medias
          .map((m) => m.file?.s3Key)
          .filter((k): k is string => !!k);
        if (keys.length) {
          try {
            await this.uploadService.deleteS3ObjectsByKeys(keys);
          } catch (error) {
            this.logger.error(
              `Failed to delete S3 objects for collection ${entry.id}:`,
              error,
            );
          }
        }

        const fileIds = medias
          .map((m) => m.file?.id)
          .filter((id): id is string => !!id);

        await this.prisma.$transaction(async (tx) => {
          await tx.collectionMedia.deleteMany({
            where: { collectionId: entry.id } as any,
          });
          if (fileIds.length) {
            await tx.fileUpload.deleteMany({
              where: { id: { in: fileIds } } as any,
            });
          }
          await tx.collection.delete({ where: { id: entry.id } });
        });

        this.logger.log(
          `Hard-deleted collection ${entry.id} after recovery window`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to hard-delete collection ${entry.id}:`,
          error,
        );
      }
    }
    return candidates.length;
  }

  /**
   * Get draft statistics for a user (used by frontend)
   */
  async getDraftStats(userId: string) {
    const now = this.clock.now();
    const drafts = await (this.prisma as any).collection.findMany({
      where: { ownerId: userId, status: 'DRAFT', deletedAt: null },
      include: { _count: { select: { medias: true, products: true } } },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      totalDrafts: drafts.length,
      maxDraftsAllowed: 4,
      draftTtlDays: this.config.DRAFT_TTL_DAYS,
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
