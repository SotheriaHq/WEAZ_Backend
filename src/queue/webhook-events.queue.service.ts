import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  WEBHOOK_EVENTS_QUEUE,
  WEBHOOK_PAYMENT_PROCESS_JOB,
  WEBHOOK_PAYOUT_PROCESS_JOB,
} from './queue.constants';

export interface PaymentWebhookProcessJob {
  gateway: string;
  payload: Record<string, any>;
  providerEventKey: string;
  reference: string;
}

export interface PayoutWebhookProcessJob {
  payload: Record<string, any>;
  providerEventKey: string;
  payoutId: string;
  providerEventType: string;
}

@Injectable()
export class WebhookEventsQueueService {
  constructor(@InjectQueue(WEBHOOK_EVENTS_QUEUE) private readonly queue: Queue) {}

  async enqueuePaymentWebhook(job: PaymentWebhookProcessJob): Promise<void> {
    await this.queue.add(WEBHOOK_PAYMENT_PROCESS_JOB, job, {
      jobId: `payment:${job.providerEventKey}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }

  async enqueuePayoutWebhook(job: PayoutWebhookProcessJob): Promise<void> {
    await this.queue.add(WEBHOOK_PAYOUT_PROCESS_JOB, job, {
      jobId: `payout:${job.providerEventKey}`,
      attempts: 8,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: 500,
    });
  }
}
