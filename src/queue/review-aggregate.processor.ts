import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  REVIEW_AGGREGATE_QUEUE,
  REVIEW_AGGREGATE_PRODUCT_JOB,
  REVIEW_AGGREGATE_BRAND_JOB,
} from './queue.constants';
import { ReviewsService } from '../reviews/reviews.service';

@Processor(REVIEW_AGGREGATE_QUEUE)
export class ReviewAggregateProcessor extends WorkerHost {
  private readonly logger = new Logger(ReviewAggregateProcessor.name);

  constructor(private readonly reviewsService: ReviewsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    this.logger.log(
      `Processing review aggregate job: ${job.name} id=${job.id}`,
    );

    try {
      switch (job.name) {
        case REVIEW_AGGREGATE_PRODUCT_JOB: {
          const { productId } = job.data;
          await this.reviewsService.recalculateProductAggregate(productId);
          break;
        }

        case REVIEW_AGGREGATE_BRAND_JOB: {
          const { brandId } = job.data;
          await this.reviewsService.recalculateBrandAggregate(brandId);
          break;
        }

        default:
          this.logger.warn(`Unknown review aggregate job name: ${job.name}`);
      }
    } catch (error) {
      this.logger.error(
        `Review aggregate job failed: ${job.name} id=${job.id} error=${error.message}`,
        error.stack,
      );
      throw error; // Let BullMQ handle retries
    }
  }
}
