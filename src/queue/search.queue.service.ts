import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { SEARCH_QUEUE, SEARCH_SYNC_JOB } from './queue.constants';

export type SearchSyncTarget = 'product' | 'brand' | 'design' | 'collection' | 'tag';

export interface SearchSyncJob {
  target: SearchSyncTarget;
  mode: 'entity' | 'rebuild';
  id?: string;
  reason?: string;
}

@Injectable()
export class SearchQueueService {
  constructor(@InjectQueue(SEARCH_QUEUE) private readonly queue: Queue) {}

  async enqueueSync(job: SearchSyncJob): Promise<void> {
    const dedupeKey =
      job.mode === 'entity' && job.id
        ? `${job.target}:${job.mode}:${job.id}`
        : `${job.target}:${job.mode}`;

    await this.queue.add(SEARCH_SYNC_JOB, job, {
      jobId: dedupeKey,
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }
}