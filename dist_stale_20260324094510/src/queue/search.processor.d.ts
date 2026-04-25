import { WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { SearchService } from 'src/search/search.service';
import type { SearchSyncJob } from './search.queue.service';
export declare class SearchProcessor extends WorkerHost {
    private readonly searchService;
    private readonly logger;
    constructor(searchService: SearchService);
    process(job: Job<SearchSyncJob>): Promise<void>;
}
