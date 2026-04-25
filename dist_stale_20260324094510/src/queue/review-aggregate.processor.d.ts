import { WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { ReviewsService } from '../reviews/reviews.service';
export declare class ReviewAggregateProcessor extends WorkerHost {
    private readonly reviewsService;
    private readonly logger;
    constructor(reviewsService: ReviewsService);
    process(job: Job): Promise<void>;
}
