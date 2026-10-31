import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BrandVerificationStatus, NotificationType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';

@Injectable()
export class BrandVerificationCronService {
  private readonly logger = new Logger(BrandVerificationCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async autoReleaseStaleReviews() {
    const threshold = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const stale = await this.prisma.brand.findMany({
      where: {
        verificationStatus: BrandVerificationStatus.IN_REVIEW,
        verificationReviewStartedAt: { lt: threshold },
        updatedAt: { lt: threshold },
      },
      select: {
        id: true,
        verificationAttemptNumber: true,
      },
    });

    for (const brand of stale) {
      await this.prisma.$transaction(async (tx) => {
        const released = await tx.brand.updateMany({
          where: {
            id: brand.id,
            verificationStatus: BrandVerificationStatus.IN_REVIEW,
            verificationReviewStartedAt: { lt: threshold },
          },
          data: {
            verificationStatus: BrandVerificationStatus.PENDING,
            verificationReviewedById: null,
            verificationReviewStartedAt: null,
          },
        });
        if (released.count === 0) return;
        await tx.brandVerificationAttempt.updateMany({
          where: {
            brandId: brand.id,
            attemptNumber: brand.verificationAttemptNumber,
          },
          data: {
            status: BrandVerificationStatus.PENDING,
            reviewedById: null,
            reviewStartedAt: null,
          },
        });
      });
    }

    if (stale.length > 0) {
      this.logger.log(
        `Auto-released ${stale.length} stale verification review(s)`,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async cleanupExpiredVerificationState() {
    const now = new Date();
    const expiredCooldownBrands = await this.prisma.brand.findMany({
      where: {
        verificationCooldownExpiresAt: { lt: now },
      },
      select: {
        id: true,
        name: true,
        ownerId: true,
        owner: {
          select: {
            email: true,
          },
        },
      },
      take: 100,
    });

    const [cooldowns, drafts] = await Promise.all([
      this.prisma.brand.updateMany({
        where: {
          id: { in: expiredCooldownBrands.map((brand) => brand.id) },
        },
        data: {
          verificationCooldownExpiresAt: null,
        },
      }),
      this.prisma.brand.updateMany({
        where: {
          verificationDraftUpdatedAt: {
            lt: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
          },
          verificationDraftData: { not: null },
        },
        data: {
          verificationDraftData: null,
          verificationDraftUpdatedAt: null,
        },
      }),
    ]);

    if (expiredCooldownBrands.length > 0) {
      const appName = this.emailService.getAppName();
      const results = await this.notifications.createEvents(
        expiredCooldownBrands.map((brand) => ({
          recipientId: brand.ownerId,
          type: NotificationType.VERIFICATION_COOLDOWN_EXPIRED,
          opts: {
            payload: { brandId: brand.id, targetUrl: '/studio/verification' },
          },
        })),
      );
      for (let index = 0; index < expiredCooldownBrands.length; index += 1) {
        const brand = expiredCooldownBrands[index];
        const notification = results[index];
        if (notification.status === 'rejected') throw notification.reason;
        if (brand.owner.email) {
          const mail = emailTemplates.verificationCooldownExpiredEmail(
            brand.name,
            appName,
          );
          void this.emailService
            .send(brand.owner.email, mail.subject, mail.html, mail.text)
            .catch(() => undefined);
        }
      }
    }

    if (cooldowns.count > 0 || drafts.count > 0) {
      this.logger.log(
        `Verification cleanup complete: ${cooldowns.count} cooldown reset(s), ${drafts.count} draft cleanup(s)`,
      );
    }
  }

  @Cron(CronExpression.EVERY_WEEK)
  async sendVerificationNudges() {
    const now = new Date();
    const threshold = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const brands = await this.prisma.brand.findMany({
      where: {
        verificationStatus: BrandVerificationStatus.NOT_SUBMITTED,
        isStoreOpen: true,
        verificationNudgeOptOut: false,
        verificationNudgeCount: { lt: 3 },
        OR: [
          { verificationLastNudgedAt: null },
          { verificationLastNudgedAt: { lt: threshold } },
        ],
      },
      select: {
        id: true,
        name: true,
        ownerId: true,
        owner: {
          select: {
            email: true,
          },
        },
      },
      take: 100,
    });

    const appName = this.emailService.getAppName();
    const results = await this.notifications.createEvents(
      brands.map((brand) => ({
        recipientId: brand.ownerId,
        type: NotificationType.VERIFICATION_NUDGE,
        opts: {
          payload: { brandId: brand.id, targetUrl: '/studio/verification' },
        },
      })),
    );
    const delivered = brands.filter(
      (_, index) => results[index]?.status === 'fulfilled',
    );
    for (const brand of delivered) {
      if (brand.owner.email) {
        const mail = emailTemplates.verificationNudgeEmail(brand.name, appName);
        void this.emailService
          .send(brand.owner.email, mail.subject, mail.html, mail.text)
          .catch(() => undefined);
      }
    }

    if (delivered.length > 0) {
      await this.prisma.brand.updateMany({
        where: { id: { in: delivered.map((brand) => brand.id) } },
        data: {
          verificationNudgeCount: { increment: 1 },
          verificationLastNudgedAt: now,
        },
      });
      this.logger.log(`Sent ${delivered.length} verification nudge(s)`);
    }

    const failure = results.find((result) => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
  }
}
