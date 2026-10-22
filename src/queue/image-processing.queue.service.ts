import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  IMAGE_PROCESSING_QUEUE,
  IMAGE_PROCESS_SINGLE_JOB,
  IMAGE_REPROCESS_JOB,
} from './queue.constants';

export interface ImageProcessSingleJob {
  fileId: string;
  force?: boolean;
  /** Re-encode into the next asset version — see `processOne`. */
  newVersion?: boolean;
}

export interface ImageProcessBatchJob {
  fileIds: string[];
  force?: boolean;
  /** Re-encode into the next asset version — see `processOne`. */
  newVersion?: boolean;
}

@Injectable()
export class ImageProcessingQueueService {
  constructor(
    @InjectQueue(IMAGE_PROCESSING_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueSingle(fileId: string, force = false): Promise<void> {
    if (!fileId) return;
    await this.queue.add(
      IMAGE_PROCESS_SINGLE_JOB,
      { fileId, force } as ImageProcessSingleJob,
      {
        attempts: 4,
        deduplication: { id: `image-${fileId}-${force ? 'forced' : 'normal'}` },
        backoff: { type: 'exponential', delay: 1500 },
      },
    );
  }

  async enqueueBatch(fileIds: string[], force = false): Promise<void> {
    const unique = Array.from(new Set((fileIds || []).filter(Boolean)));
    if (unique.length === 0) return;
    for (let offset = 0; offset < unique.length; offset += 500) {
      await this.queue.addBulk(unique.slice(offset, offset + 500).map((fileId) => ({
        name: IMAGE_PROCESS_SINGLE_JOB,
        data: { fileId, force } as ImageProcessSingleJob,
        opts: {
          attempts: 4,
          backoff: { type: 'exponential' as const, delay: 1500 },
          deduplication: { id: `image-${fileId}-${force ? 'forced' : 'normal'}` },
        },
      })));
    }
  }

  async enqueueReprocess(fileId: string): Promise<void> {
    if (!fileId) return;
    await this.queue.add(
      IMAGE_REPROCESS_JOB,
      { fileId, force: true } as ImageProcessSingleJob,
      {
        attempts: 4,
        deduplication: { id: `image-${fileId}-forced` },
        backoff: { type: 'exponential', delay: 1500 },
      },
    );
  }
}
