import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { CategoriesService } from './categories.service';

@Injectable()
export class CategoriesBootstrapService implements OnModuleInit {
  private readonly logger = new Logger(CategoriesBootstrapService.name);

  constructor(private readonly categoriesService: CategoriesService) {}

  async onModuleInit() {
    const autoSeed =
      String(process.env.AUTO_SEED_CATEGORY_TAXONOMY ?? 'true')
        .trim()
        .toLowerCase() !== 'false';

    if (!autoSeed) {
      this.logger.log('AUTO_SEED_CATEGORY_TAXONOMY is disabled.');
      return;
    }

    // Taxonomy seeding is idempotent, but it should not block the server from
    // becoming reachable during local development or normal restarts.
    void this.categoriesService.ensureDefaultTaxonomy().catch((error: any) => {
      this.logger.warn(
        `Default taxonomy seeding failed in background: ${error?.message || error}`,
      );
    });
  }
}
