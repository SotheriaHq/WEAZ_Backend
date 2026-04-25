import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { REVIEW_REMINDER_JOB, REVIEW_REMINDER_QUEUE } from './queue.constants';

@Injectable()
export class ReviewReminderQueueService {
    private readonly logger = new Logger(ReviewReminderQueueService.name);

    constructor(
        @InjectQueue(REVIEW_REMINDER_QUEUE)
        private readonly reminderQueue: Queue,
    ) {}

    async enqueueReminderProcessing(): Promise<void> {
        await this.reminderQueue.add(
            REVIEW_REMINDER_JOB,
            {},
            {
                jobId: 'review-reminder-daily',
                removeOnComplete: true,
                removeOnFail: 500,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            },
        );

        this.logger.debug('Enqueued review reminder processing job');
    }
}
