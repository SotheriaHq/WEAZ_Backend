import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job } from 'bullmq';
import { PaymentService } from 'src/payment/payment.service';
import { AdminPayoutsService } from 'src/admin/payouts/admin-payouts.service';
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
  ) {
    super();
  }

  async process(
    job: Job<PaymentWebhookProcessJob | PayoutWebhookProcessJob>,
  ): Promise<void> {
    if (job.name === WEBHOOK_PAYMENT_PROCESS_JOB) {
      await this.paymentService.processQueuedWebhook(
        job.data as PaymentWebhookProcessJob,
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
  }
}
