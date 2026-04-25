import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CollectionsService } from 'src/collections/collections.service';
export interface BulkUploadProcessJob {
    jobId: string;
}
export interface BulkUploadRetryJob {
    jobId: string;
    ownerId: string;
    rowIndices?: number[];
}
export declare class BulkUploadProcessor extends WorkerHost {
    private readonly collections;
    private readonly logger;
    constructor(collections: CollectionsService);
    process(job: Job<BulkUploadProcessJob | BulkUploadRetryJob>): Promise<void>;
}
