import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  IMAGE_PROCESSING_QUEUE,
  IMAGE_PROCESS_SINGLE_JOB,
  IMAGE_PROCESS_BATCH_JOB,
  IMAGE_REPROCESS_JOB,
} from './queue.constants';

export interface ImageProcessSingleJob {
  fileId: string;
  force?: boolean;
}

export interface ImageProcessBatchJob {
  fileIds: string[];
  force?: boolean;
}

@Injectable()
export class ImageProcessingQueueService {
  constructor(
    @InjectQueue(IMAGE_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueSingle(fileId: string, force = false): Promise<void> {
    if (!fileId) return;
    await this.queue.add(IMAGE_PROCESS_SINGLE_JOB, { fileId, force } as ImageProcessSingleJob, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 1500 },
    });
  }

  async enqueueBatch(fileIds: string[], force = false): Promise<void> {
    const unique = Array.from(new Set((fileIds || []).filter(Boolean)));
    if (unique.length === 0) return;
    await this.queue.add(IMAGE_PROCESS_BATCH_JOB, { fileIds: unique, force } as ImageProcessBatchJob, {
      attempts: 2,
      backoff: { type: 'exponential', delay: 2000 },
    });
  }

  async enqueueReprocess(fileId: string): Promise<void> {
    if (!fileId) return;
    await this.queue.add(IMAGE_REPROCESS_JOB, { fileId, force: true } as ImageProcessSingleJob, {
      attempts: 4,
      backoff: { type: 'exponential', delay: 1500 },
    });
  }
}
