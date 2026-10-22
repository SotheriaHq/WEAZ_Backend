import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import type { Queue } from 'bullmq';
import {
  TELEGRAM_MONITORING_QUEUE,
  TELEGRAM_REPORT_JOB,
  TELEGRAM_WATCHDOG_JOB,
} from 'src/queue/queue.constants';
import { REPORT_SCHEDULE } from './report-window';
import { describe } from './telegram-delivery.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

export const REPORT_SCHEDULER_IDS = {
  morning: 'telegram-report-morning',
  evening: 'telegram-report-evening',
} as const;
export const WATCHDOG_SCHEDULER_ID = 'telegram-infra-watchdog';
const WATCHDOG_EVERY_MS = 5 * 60_000;

/**
 * Registers the repeatable jobs in Redis (BullMQ job schedulers).
 *
 * `upsertJobScheduler` is idempotent by scheduler id, so every worker restart
 * re-asserts the same three schedulers instead of adding new ones — the
 * restart-duplication guard at the scheduling layer. The per-window record in
 * MonitoringReportService is the guard at the delivery layer.
 */
@Injectable()
export class TelegramMonitoringScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(TelegramMonitoringScheduler.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    @InjectQueue(TELEGRAM_MONITORING_QUEUE) private readonly queue: Queue,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      await this.sync();
    } catch (error) {
      // Never block worker boot on monitoring.
      this.logger.error(`Telegram monitoring schedulers not synced: ${describe(error)}`);
    }
  }

  async sync(): Promise<void> {
    const active = this.config.isActive();
    const tz = this.config.reportTimeZone;

    for (const kind of ['morning', 'evening'] as const) {
      const id = REPORT_SCHEDULER_IDS[kind];
      if (active && this.config.reportsEnabled) {
        await this.queue.upsertJobScheduler(
          id,
          { pattern: `0 0 ${REPORT_SCHEDULE[kind].endHour} * * *`, tz },
          {
            name: TELEGRAM_REPORT_JOB,
            data: { kind },
            opts: { attempts: 4, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: 50, removeOnFail: 50 },
          },
        );
      } else {
        await this.queue.removeJobScheduler(id);
      }
    }

    if (active) {
      await this.queue.upsertJobScheduler(
        WATCHDOG_SCHEDULER_ID,
        { every: WATCHDOG_EVERY_MS },
        { name: TELEGRAM_WATCHDOG_JOB, data: {}, opts: { attempts: 1, removeOnComplete: 20, removeOnFail: 20 } },
      );
    } else {
      await this.queue.removeJobScheduler(WATCHDOG_SCHEDULER_ID);
    }

    this.logger.log(
      active
        ? `Telegram monitoring active (${this.config.environment}); reports ${this.config.reportsEnabled ? `07:00/22:00 ${tz}` : 'disabled'}, watchdog every 5m`
        : `Telegram monitoring inactive (${this.config.problems().join(', ')}); schedulers removed`,
    );
  }
}
