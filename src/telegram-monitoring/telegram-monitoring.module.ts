import { Global, Module } from '@nestjs/common';
import { PrismaModule } from 'src/prisma/prisma.module';
import { QueueModule } from 'src/queue/queue.module';
import { InfraProbeService } from './infra-probe.service';
import { InfraWatchdogService } from './infra-watchdog.service';
import { MonitoringReportService } from './monitoring-report.service';
import { SentryAlertHandler } from './sentry-alert.handler';
import { SentryApiClient } from './sentry-api.client';
import { SentryWebhookController } from './sentry-webhook.controller';
import { TelegramClient } from './telegram.client';
import { TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramEventsService } from './telegram-events.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

/**
 * Shared by the API, the worker and the CLI.
 *
 * @Global so business services can inject TelegramEventsService without each
 * feature module importing this one. It depends only on leaf modules (Queue,
 * Prisma), so it cannot close a module cycle. Global scope is per application
 * graph: AppModule AND QueueWorkerModule both import it.
 *
 * The queue processor and the scheduler are NOT here; they are registered in
 * QueueWorkerModule only, so only the worker consumes jobs.
 */
@Global()
@Module({
  imports: [PrismaModule, QueueModule],
  controllers: [SentryWebhookController],
  providers: [
    TelegramMonitoringConfig,
    TelegramClient,
    TelegramDeliveryService,
    TelegramEventsService,
    SentryApiClient,
    SentryAlertHandler,
    InfraProbeService,
    InfraWatchdogService,
    MonitoringReportService,
  ],
  exports: [
    TelegramMonitoringConfig,
    TelegramClient,
    TelegramDeliveryService,
    TelegramEventsService,
    SentryApiClient,
    SentryAlertHandler,
    InfraProbeService,
    InfraWatchdogService,
    MonitoringReportService,
  ],
})
export class TelegramMonitoringModule {}
