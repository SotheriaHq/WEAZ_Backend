import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PaymentService } from './payment.service';
import { PaymentRuntimeHealthService } from './payment-runtime-health.service';

@Injectable()
export class PaymentOpsCronService {
  private readonly logger = new Logger(PaymentOpsCronService.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly paymentRuntimeHealthService: PaymentRuntimeHealthService,
  ) {}

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

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'stale-payment-reconcile',
        'ok',
        {
          scanned: result.scanned,
          updated: result.updated,
          failed: result.failed.length,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Stale payment reconcile cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'stale-payment-reconcile',
        'error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reprocessPendingWebhookReceipts(): Promise<void> {
    try {
      const result =
        await this.paymentService.reprocessPendingWebhookReceipts(80);
      if (result.scanned > 0 || result.failed > 0) {
        this.logger.log(
          `Webhook receipt reprocess scanned=${result.scanned} processed=${result.processed} skipped=${result.skipped} failed=${result.failed}`,
        );
      }

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'webhook-reprocess',
        'ok',
        {
          scanned: result.scanned,
          processed: result.processed,
          skipped: result.skipped,
          failed: result.failed,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Webhook receipt reprocess cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'webhook-reprocess',
        'error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcilePaidUnifiedCheckoutFinalization(): Promise<void> {
    try {
      const result =
        await this.paymentService.reconcilePaidUnifiedCheckoutFinalization(120);

      if (result.scanned > 0 || result.failed.length > 0) {
        this.logger.log(
          `Paid unified finalize reconcile scanned=${result.scanned} finalized=${result.finalized} failed=${result.failed.length}`,
        );
      }

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'paid-unified-finalize-reconcile',
        'ok',
        {
          scanned: result.scanned,
          finalized: result.finalized,
          failed: result.failed.length,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Paid unified finalize reconcile cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'paid-unified-finalize-reconcile',
        'error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async purgeOldPaymentTelemetry(): Promise<void> {
    try {
      const result = await this.paymentService.purgeOldPaymentTelemetry();

      if (
        result.paymentEventsDeleted > 0 ||
        result.retryHistoryDeleted > 0 ||
        result.webhookIngressAuditsDeleted > 0
      ) {
        this.logger.log(
          `Payment telemetry retention deleted events=${result.paymentEventsDeleted} retries=${result.retryHistoryDeleted} audits=${result.webhookIngressAuditsDeleted}`,
        );
      }

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'payment-telemetry-retention',
        'ok',
        {
          paymentEventsDeleted: result.paymentEventsDeleted,
          retryHistoryDeleted: result.retryHistoryDeleted,
          webhookIngressAuditsDeleted: result.webhookIngressAuditsDeleted,
          retainedDays: result.retainedDays,
        },
      );
    } catch (error) {
      this.logger.warn(
        `Payment telemetry retention cron failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );

      await this.paymentRuntimeHealthService.recordCronHeartbeat(
        'payment-telemetry-retention',
        'error',
        {
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }
}
