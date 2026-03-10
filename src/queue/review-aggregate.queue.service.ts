import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
    REVIEW_AGGREGATE_QUEUE,
    REVIEW_AGGREGATE_PRODUCT_JOB,
    REVIEW_AGGREGATE_BRAND_JOB,
} from './queue.constants';

@Injectable()
export class ReviewAggregateQueueService {
    private readonly logger = new Logger(ReviewAggregateQueueService.name);

    constructor(
        @InjectQueue(REVIEW_AGGREGATE_QUEUE)
        private readonly reviewAggregateQueue: Queue,
    ) { }

    async enqueueProductAggregate(productId: string): Promise<void> {
        await this.reviewAggregateQueue.add(
            REVIEW_AGGREGATE_PRODUCT_JOB,
            { productId },
            {
                // Deduplicate: if the same product aggregate is already queued, skip
                jobId: `product-aggregate-${productId}`,
                removeOnComplete: true,
                removeOnFail: 500,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            },
        );

        this.logger.debug(
            `Enqueued product aggregate recalculation: productId=${productId}`,
        );
    }

    async enqueueBrandAggregate(brandId: string): Promise<void> {
        await this.reviewAggregateQueue.add(
            REVIEW_AGGREGATE_BRAND_JOB,
            { brandId },
            {
                jobId: `brand-aggregate-${brandId}`,
                removeOnComplete: true,
                removeOnFail: 500,
                attempts: 3,
                backoff: { type: 'exponential', delay: 2000 },
            },
        );

        this.logger.debug(
            `Enqueued brand aggregate recalculation: brandId=${brandId}`,
        );
    }
}
