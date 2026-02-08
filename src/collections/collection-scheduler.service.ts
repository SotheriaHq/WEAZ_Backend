import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { NotificationType } from '@prisma/client';
import {
  DRAFT_EXPIRY_CONFIG,
  getDraftExpiryDate,
  getDaysUntilExpiry,
} from './config/draft-expiry.config';

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
  ) {}

  /**
   * Run daily at midnight to clean up expired drafts and send warnings
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async handleDraftCleanup() {
    if (!this.config.CLEANUP_ENABLED) {
      this.logger.log('Draft cleanup job is disabled');
      return;
    }

    this.logger.log('Starting draft cleanup job...');
    this.logger.log(`Config: TTL=${this.config.DRAFT_TTL_DAYS}d, FirstWarning=${this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY}d, FinalWarning=${this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY}d`);

    const now = new Date();
    const msPerDay = 24 * 60 * 60 * 1000;
    
    // Calculate dates based on config
    const expiryThreshold = new Date(now.getTime() - this.config.DRAFT_TTL_DAYS * msPerDay);
    const firstWarningDate = new Date(
      now.getTime() - (this.config.DRAFT_TTL_DAYS - this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY) * msPerDay
    );
    const finalWarningDate = new Date(
      now.getTime() - (this.config.DRAFT_TTL_DAYS - this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY) * msPerDay
    );

    try {
      if (this.config.WARNINGS_ENABLED) {
        // 1. Send first warning for drafts approaching expiry
        await this.sendExpiryWarnings(firstWarningDate, this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY);

        // 2. Send final warning for drafts about to expire
        await this.sendExpiryWarnings(finalWarningDate, this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY);
      }

      // 3. Delete drafts older than TTL
      await this.deleteExpiredDrafts(expiryThreshold);

      // 4. Clean up orphaned presigned uploads
      await this.cleanupOrphanedPresigns();

      this.logger.log('Draft cleanup job completed successfully');
    } catch (error) {
      this.logger.error('Draft cleanup job failed:', error);
    }
  }

  /**
   * Send expiry warning notifications for drafts approaching expiry
   */
  private async sendExpiryWarnings(createdBefore: Date, daysRemaining: number) {
    const createdAfter = new Date(createdBefore.getTime() - 24 * 60 * 60 * 1000);

    const drafts = await this.prisma.collection.findMany({
      where: {
        status: 'DRAFT',
        createdAt: {
          gte: createdAfter,
          lte: createdBefore,
        },
      },
      select: {
        id: true,
        title: true,
        ownerId: true,
        createdAt: true,
        _count: { select: { medias: true, products: true } },
      },
      take: this.config.CLEANUP_BATCH_SIZE,
    });

    for (const draft of drafts) {
      const expiryDate = getDraftExpiryDate(draft.createdAt);

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
        this.logger.error(`Failed to send expiry warning for draft ${draft.id}:`, error);
      }
    }

    this.logger.log(`Sent ${drafts.length} expiry warnings (${daysRemaining} days remaining)`);
  }

  /**
   * Delete drafts older than TTL and notify owners
   */
  private async deleteExpiredDrafts(createdBefore: Date) {
    const expiredDrafts = await this.prisma.collection.findMany({
      where: {
        status: 'DRAFT',
        createdAt: { lte: createdBefore },
      },
      select: {
        id: true,
        title: true,
        ownerId: true,
        _count: { select: { medias: true, products: true } },
      },
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

        // Delete the draft (cascade deletes medias and product links)
        await this.prisma.collection.delete({
          where: { id: draft.id },
        });

        this.logger.log(`Deleted expired draft ${draft.id}`);
      } catch (error) {
        this.logger.error(`Failed to delete expired draft ${draft.id}:`, error);
      }
    }

    this.logger.log(`Deleted ${expiredDrafts.length} expired drafts`);
  }

  /**
   * Clean up orphaned presigned uploads (expired but never finalized)
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
   * Get draft statistics for a user (used by frontend)
   */
  async getDraftStats(userId: string) {
    const now = new Date();

    const drafts = await this.prisma.collection.findMany({
      where: { ownerId: userId, status: 'DRAFT' },
      select: {
        id: true,
        title: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { medias: true, products: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return {
      totalDrafts: drafts.length,
      maxDraftsAllowed: 4,
      draftTtlDays: this.config.DRAFT_TTL_DAYS,
      drafts: drafts.map((d) => {
        const expiryDate = getDraftExpiryDate(d.createdAt);
        const daysRemaining = getDaysUntilExpiry(d.createdAt);

        return {
          id: d.id,
          title: d.title || 'Untitled Draft',
          createdAt: d.createdAt,
          updatedAt: d.updatedAt,
          expiryDate,
          daysRemaining,
          isExpiringSoon: daysRemaining <= this.config.FIRST_WARNING_DAYS_BEFORE_EXPIRY,
          isCritical: daysRemaining <= this.config.FINAL_WARNING_DAYS_BEFORE_EXPIRY,
          mediaCount: d._count.medias,
          productCount: d._count.products,
        };
      }),
    };
  }
}
