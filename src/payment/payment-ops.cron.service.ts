import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentService } from './payment.service';

@Injectable()
export class PaymentOpsCronService {
  private readonly logger = new Logger(PaymentOpsCronService.name);

  constructor(private readonly paymentService: PaymentService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async reconcileStalePaymentAttempts(): Promise<void> {
    try {
      const result = await this.paymentService.reconcileStalePaymentAttempts(
        {
          olderThanMinutes: 30,
          limit: 120,
        },
        'system-cron',
      );

      if (result.scanned > 0 || result.failed.length > 0) {
        this.logger.log(
          `Stale payment reconcile scanned=${result.scanned} updated=${result.updated} failed=${result.failed.length}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Stale payment reconcile cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reprocessPendingWebhookReceipts(): Promise<void> {
    try {
      const result = await this.paymentService.reprocessPendingWebhookReceipts(80);
      if (result.scanned > 0 || result.failed > 0) {
        this.logger.log(
          `Webhook receipt reprocess scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} failed=${result.failed}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Webhook receipt reprocess cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
