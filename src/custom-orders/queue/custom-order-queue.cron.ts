import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';

@Injectable()
export class CustomOrderQueueCronService {
  private readonly logger = new Logger(CustomOrderQueueCronService.name);
  private running = false;
  constructor(private readonly queue: CustomOrderQueueService, private readonly refunds: CustomOrderQueueRefundsService) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const results = await Promise.allSettled([this.queue.sweep(), this.refunds.processPending()]);
      for (const result of results) if (result.status === 'rejected') this.logger.error(result.reason instanceof Error ? result.reason.message : 'Queue maintenance failed');
    } finally { this.running = false; }
  }
}
