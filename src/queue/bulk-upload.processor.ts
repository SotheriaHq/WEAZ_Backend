import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { CollectionsService } from 'src/collections/collections.service';
import {
  BULK_UPLOAD_QUEUE,
  BULK_UPLOAD_PROCESS_JOB,
  BULK_UPLOAD_RETRY_JOB,
} from './queue.constants';

export interface BulkUploadProcessJob {
  jobId: string;
}

export interface BulkUploadRetryJob {
  jobId: string;
  ownerId: string;
  rowIndices?: number[];
}

@Processor(BULK_UPLOAD_QUEUE)
export class BulkUploadProcessor extends WorkerHost {
  private readonly logger = new Logger(BulkUploadProcessor.name);

  constructor(private readonly collections: CollectionsService) {
    super();
  }

  async process(job: Job<BulkUploadProcessJob | BulkUploadRetryJob>): Promise<void> {
    try {
      if (job.name === BULK_UPLOAD_PROCESS_JOB) {
        const data = job.data as BulkUploadProcessJob;
        await this.collections.processBulkUploadJob(data.jobId);
        return;
      }
      if (job.name === BULK_UPLOAD_RETRY_JOB) {
        const data = job.data as BulkUploadRetryJob;
        await this.collections.processBulkUploadRetry(
          data.jobId,
          data.ownerId,
          data.rowIndices ?? [],
        );
        return;
      }
    } catch (error) {
      this.logger.error(
        `Bulk upload job failed (${job.name}): ${String(error)}`,
      );
      throw error;
    }
  }
}
