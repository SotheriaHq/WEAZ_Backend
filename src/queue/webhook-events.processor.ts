import { Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PaymentService } from 'src/payment/payment.service';
import { AdminPayoutsService } from 'src/admin/payouts/admin-payouts.service';
import { CustomOrdersPaymentsService } from 'src/custom-orders/custom-orders-payments.service';
import {
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_PAYMENT_PROCESS_JOB,
  WEBHOOK_PAYOUT_PROCESS_JOB,
} from './queue.constants';
import type {
  PaymentWebhookProcessJob,
  PayoutWebhookProcessJob,
} from './webhook-events.queue.service';

@Processor(WEBHOOK_EVENTS_QUEUE)
export class WebhookEventsProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookEventsProcessor.name);

  constructor(
    private readonly paymentService: PaymentService,
    private readonly adminPayoutsService: AdminPayoutsService,
    private readonly customOrdersPaymentsService: CustomOrdersPaymentsService,
  ) {
    super();
  }

  async process(
    job: Job<PaymentWebhookProcessJob | PayoutWebhookProcessJob>,
  ): Promise<void> {
    try {
      if (job.name === WEBHOOK_PAYMENT_PROCESS_JOB) {
        const paymentJob = job.data as PaymentWebhookProcessJob;
        await this.paymentService.processQueuedWebhook(
          paymentJob,
          {
            queueAttempt:
              Number.isFinite(job.attemptsMade) && job.attemptsMade >= 0
                ? job.attemptsMade + 1
                : null,
            queueJobId: job.id != null ? String(job.id) : null,
          },
        );
        await this.customOrdersPaymentsService.reconcilePaidAttemptByReference(
          paymentJob.reference,
        );
        return;
      }

      if (job.name === WEBHOOK_PAYOUT_PROCESS_JOB) {
        await this.adminPayoutsService.processQueuedPaystackWebhook(
          job.data as PayoutWebhookProcessJob,
        );
        return;
      }

      this.logger.warn(`Ignoring unsupported webhook job ${job.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      this.logger.error(
        `Webhook worker process failure for ${this.describeJob(job)}: ${message}`,
        stack,
      );
      throw error;
    }
  }

  @OnWorkerEvent('failed')
  onFailed(
    job: Job<PaymentWebhookProcessJob | PayoutWebhookProcessJob> | undefined,
    error: Error,
  ): void {
    this.logger.error(
      `Webhook worker marked job as failed: ${this.describeJob(job)} :: ${error.message}`,
      error.stack,
    );
  }

  @OnWorkerEvent('stalled')
  onStalled(jobId: string): void {
    this.logger.warn(`Webhook worker detected stalled job ${jobId}`);
  }

  private describeJob(
    job: Job<PaymentWebhookProcessJob | PayoutWebhookProcessJob> | undefined,
  ): string {
    if (!job) {
      return 'unknown-job';
    }

    const data = job.data as Partial<PaymentWebhookProcessJob & PayoutWebhookProcessJob>;
    const providerEventKey = String(data.providerEventKey ?? '').trim() || 'n/a';
    const reference =
      String(data.reference ?? data.payoutId ?? '').trim() || 'n/a';
    return `${job.name} id=${job.id ?? 'n/a'} eventKey=${providerEventKey} ref=${reference}`;
  }
}
