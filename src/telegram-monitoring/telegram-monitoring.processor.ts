import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, RateLimitError, UnrecoverableError } from 'bullmq';
import {
  TELEGRAM_MONITORING_QUEUE,
  TELEGRAM_REPORT_JOB,
  TELEGRAM_SEND_JOB,
  TELEGRAM_SENTRY_ALERT_JOB,
  TELEGRAM_WATCHDOG_JOB,
} from 'src/queue/queue.constants';
import { InfraWatchdogService } from './infra-watchdog.service';
import { MonitoringReportService } from './monitoring-report.service';
import type { ReportKind } from './report-window';
import { SentryAlertHandler } from './sentry-alert.handler';
import { describe, TelegramDeliveryService } from './telegram-delivery.service';
import type { SendJobData, SentryAlertJobData } from './telegram-events.service';
import { TelegramDeliveryError } from './telegram.client';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

/**
 * Concurrency 1 + limiter 1/s matches Telegram's per-chat limit (~1 msg/s)
 * and makes check→send→mark in TelegramDeliveryService race-free.
 * Cost: one extra blocking Redis connection in the worker process.
 */
@Processor(TELEGRAM_MONITORING_QUEUE, {
  concurrency: 1,
  limiter: { max: 1, duration: 1_000 },
})
export class TelegramMonitoringProcessor extends WorkerHost {
  private readonly logger = new Logger(TelegramMonitoringProcessor.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly delivery: TelegramDeliveryService,
    private readonly sentryHandler: SentryAlertHandler,
    private readonly reports: MonitoringReportService,
    private readonly watchdog: InfraWatchdogService,
  ) {
    super();
  }

  async process(job: Job): Promise<unknown> {
    if (!this.config.isActive()) {
      // Disabled after enqueue: drop quietly rather than retrying for hours.
      return { skipped: 'monitoring inactive' };
    }
    try {
      switch (job.name) {
        case TELEGRAM_SEND_JOB: {
          const data = job.data as SendJobData;
          return await this.delivery.deliverOnce(data.idempotencyId, data.text);
        }
        case TELEGRAM_SENTRY_ALERT_JOB: {
          const data = job.data as SentryAlertJobData;
          return await this.sentryHandler.handle(data.alert, data.idempotencyId);
        }
        case TELEGRAM_REPORT_JOB: {
          if (!this.config.reportsEnabled) return { skipped: 'reports disabled' };
          const kind = (job.data?.kind === 'evening' ? 'evening' : 'morning') as ReportKind;
          return await this.reports.deliverScheduled(kind);
        }
        case TELEGRAM_WATCHDOG_JOB:
          return await this.watchdog.runWorkerSweep();
        default:
          this.logger.warn(`Unknown telegram-monitoring job: ${job.name}`);
          return { skipped: 'unknown job' };
      }
    } catch (error) {
      if (error instanceof TelegramDeliveryError) {
        if (error.kind === 'rate_limited') {
          // Pause the whole queue for Telegram's retry_after, then retry this
          // job without consuming an attempt.
          await this.worker.rateLimit((error.retryAfterSeconds ?? 5) * 1_000);
          throw new RateLimitError();
        }
        if (error.kind === 'fatal' || error.kind === 'inactive') {
          this.logger.error(`Telegram delivery permanently failed (${job.name}): ${error.message}`);
          throw new UnrecoverableError(error.message);
        }
      }
      this.logger.warn(
        `Telegram monitoring job ${job.name} attempt ${job.attemptsMade + 1} failed: ${describe(error)}`,
      );
      throw error;
    }
  }
}
