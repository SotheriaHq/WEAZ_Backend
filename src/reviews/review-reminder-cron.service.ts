import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { FeatureFlagsService } from '../admin/feature-flags/feature-flags.service';
import { ReviewReminderQueueService } from '../queue/review-reminder.queue.service';
import { REVIEW_FEATURE_FLAGS } from './review.constants';

@Injectable()
export class ReviewReminderCronService {
  private readonly logger = new Logger(ReviewReminderCronService.name);

  constructor(
    private readonly featureFlags: FeatureFlagsService,
    private readonly reminderQueue: ReviewReminderQueueService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async enqueueDueReviewReminders(): Promise<void> {
    const enabled = await this.featureFlags.isEnabled(
      REVIEW_FEATURE_FLAGS.REMINDERS,
    );
    if (!enabled) {
      return;
    }

    try {
      await this.reminderQueue.enqueueReminderProcessing();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Failed to enqueue review reminder job: ${message}`);
    }
  }
}
