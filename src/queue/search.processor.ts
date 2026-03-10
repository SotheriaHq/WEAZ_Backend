import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SearchService } from 'src/search/search.service';
import { SEARCH_QUEUE, SEARCH_SYNC_JOB } from './queue.constants';
import type { SearchSyncJob } from './search.queue.service';

@Processor(SEARCH_QUEUE)
export class SearchProcessor extends WorkerHost {
  private readonly logger = new Logger(SearchProcessor.name);

  constructor(private readonly searchService: SearchService) {
    super();
  }

  async process(job: Job<SearchSyncJob>): Promise<void> {
    if (job.name !== SEARCH_SYNC_JOB) {
      return;
    }

    try {
      await this.searchService.processSearchSyncJob(job.data);
    } catch (error) {
      this.logger.warn(`Failed search sync job ${job.id}: ${String(error)}`);
      throw error;
    }
  }
}