import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AdminFeaturedService } from './admin-featured.service';

@Injectable()
export class FeaturedExpiryCronService {
  private readonly logger = new Logger(FeaturedExpiryCronService.name);

  constructor(private readonly featuredService: AdminFeaturedService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async handleExpiredFeaturedItems() {
    try {
      const count = await this.featuredService.processExpiredItems();
      if (count > 0) {
        this.logger.log(`Cron: expired ${count} featured item(s)`);
      }
    } catch (err: any) {
      this.logger.warn(`Featured expiry cron failed: ${err?.message ?? err}`);
    }
  }
}
