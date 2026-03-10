import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { REVIEW_REMINDER_JOB, REVIEW_REMINDER_QUEUE } from './queue.constants';
import { ReviewsService } from '../reviews/reviews.service';

@Processor(REVIEW_REMINDER_QUEUE)
export class ReviewReminderProcessor extends WorkerHost {
    private readonly logger = new Logger(ReviewReminderProcessor.name);

    constructor(private readonly reviewsService: ReviewsService) {
        super();
    }

    async process(job: Job): Promise<void> {
        if (job.name !== REVIEW_REMINDER_JOB) {
            this.logger.warn(`Unknown review reminder job name: ${job.name}`);
            return;
        }

        try {
            const summary = await this.reviewsService.processDueReviewReminders();
            this.logger.log(
                `Review reminder job complete: processed=${summary.processed} sent=${summary.sent} skipped=${summary.skipped} failed=${summary.failed}`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : 'unknown error';
            this.logger.error(
                `Review reminder job failed: id=${job.id} error=${message}`,
                error instanceof Error ? error.stack : undefined,
            );
            throw error;
        }
    }
}
