import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { SizeFitService } from './size-fit.service';

@Injectable()
export class SizeFitReminderService {
  private readonly logger = new Logger(SizeFitReminderService.name);

  constructor(private readonly sizeFitService: SizeFitService) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async processDueSizeFitReminders() {
    try {
      const sent = await this.sizeFitService.sendDueUpdateReminders();
      if (sent > 0) {
        this.logger.log(`Sent ${sent} size fitting reminder notification(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to process size fitting reminders: ${
          error instanceof Error ? error.message : 'unknown error'
        }`,
      );
    }
  }
}
