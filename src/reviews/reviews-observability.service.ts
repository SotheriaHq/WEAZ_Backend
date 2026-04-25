import { Injectable, Logger } from '@nestjs/common';

@Injectable()
export class ReviewsObservabilityService {
    private readonly logger = new Logger(ReviewsObservabilityService.name);

    recordRead(event: {
        surface: 'product' | 'brand' | 'admin-reviews' | 'admin-reports';
        resultCount: number;
        durationMs: number;
        hasNextPage?: boolean;
        sort?: string;
        filter?: string;
    }) {
        this.logger.log(`metrics.review_read ${JSON.stringify(event)}`);
    }

    recordWrite(event: {
        action:
            | 'create'
            | 'update'
            | 'delete'
            | 'helpful-add'
            | 'helpful-remove'
            | 'report'
            | 'brand-reply'
            | 'moderation';
        durationMs: number;
        outcome: 'success' | 'failure';
        detail?: string;
    }) {
        this.logger.log(`metrics.review_write ${JSON.stringify(event)}`);
    }

    recordReminderRun(event: {
        durationMs: number;
        processed: number;
        sent: number;
        skipped: number;
        failed: number;
    }) {
        this.logger.log(`metrics.review_reminder ${JSON.stringify(event)}`);
    }

    recordAggregate(event: {
        target: 'product' | 'brand';
        durationMs: number;
        reviewCount: number;
    }) {
        this.logger.log(`metrics.review_aggregate ${JSON.stringify(event)}`);
    }
}