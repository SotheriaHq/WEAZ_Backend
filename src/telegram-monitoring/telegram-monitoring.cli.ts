/**
 * Operator CLI for Telegram monitoring. Run on the server from the backend
 * directory after a build:
 *
 *   node -r module-alias/register dist/telegram-monitoring/telegram-monitoring.cli.js <command> [flags]
 *   (npm run monitoring:telegram -- <command> [flags])
 *
 * Commands
 *   check                         config + token (getMe) + Sentry settings, no message sent
 *   test-message [--note=text]    send one clearly labelled test message
 *   report --kind=morning|evening [--at=ISO] [--send] [--scheduled]
 *                                 print a report preview; --send delivers it marked PREVIEW;
 *                                 --scheduled runs the real scheduled path (duplicate-protected)
 *   report-log                    recent scheduled report deliveries (audit trail)
 *   watchdog [--dry-run]          run the infrastructure sweep once
 *   sentry-test-error             capture a labelled synthetic error in Sentry (refused in production)
 *   sentry-webhook-selftest [--url=…] [--bad-signature]
 *                                 POST a signed sample alert to this server's webhook
 *
 * Never prints the bot token, the Sentry secret or the Sentry API token.
 */
import 'src/common/observability/sentry.instrument';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { createHmac } from 'crypto';
import * as Sentry from '@sentry/nestjs';
import {
  initSentry,
  isSentryEnabled,
} from 'src/common/observability/sentry.instrument';
import { PrismaModule } from 'src/prisma/prisma.module';
import { QueueModule } from 'src/queue/queue.module';
import { InfraWatchdogService } from './infra-watchdog.service';
import { MonitoringReportService } from './monitoring-report.service';
import { ReportKind } from './report-window';
import { SentryApiClient } from './sentry-api.client';
import { TelegramClient, TelegramDeliveryError } from './telegram.client';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';
import { TelegramMonitoringModule } from './telegram-monitoring.module';
import { formatZoned } from './report-window';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, envFilePath: '.env' }),
    PrismaModule,
    QueueModule,
    TelegramMonitoringModule,
  ],
})
class TelegramMonitoringCliModule {}

type Flags = Record<string, string | boolean>;

/** JSON with Python's default separators (", " and ": "), as Sentry sends it. */
function pythonJsonDumps(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(pythonJsonDumps).join(', ')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${JSON.stringify(key)}: ${pythonJsonDumps(item)}`)
      .join(', ')}}`;
  }
  return JSON.stringify(value);
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = {};
  for (const arg of rest) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) flags[match[1]] = match[2] ?? true;
  }
  return { command, flags };
}

function print(label: string, value: unknown): void {
  console.log(
    `${label.padEnd(28)} ${typeof value === 'string' ? value : JSON.stringify(value)}`,
  );
}

async function main(): Promise<number> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  if (command === 'help' || flags.help) {
    console.log(
      'Commands: check | test-message | report | report-log | watchdog | sentry-test-error | sentry-webhook-selftest',
    );
    return 0;
  }

  const app = await NestFactory.createApplicationContext(
    TelegramMonitoringCliModule,
    {
      logger: ['warn', 'error'],
    },
  );
  try {
    const config = app.get(TelegramMonitoringConfig);
    const client = app.get(TelegramClient);

    switch (command) {
      case 'check': {
        print('Environment label', config.environment);
        print('Enabled', config.enabled);
        print(
          'Config problems',
          config.problems().length ? config.problems() : 'none',
        );
        print('Chat id (allowlisted)', config.chatId || 'missing');
        print('Include user identity', config.includeUserIdentity);
        print(
          'Reports',
          config.reportsEnabled
            ? `07:00 & 22:00 ${config.reportTimeZone}`
            : 'disabled',
        );
        print(
          'Sentry webhook secret',
          config.sentryWebhookSecret ? 'set' : 'MISSING',
        );
        print(
          'Sentry API token / org',
          app.get(SentryApiClient).isConfigured()
            ? `set / ${config.sentryOrgSlug}`
            : 'not configured',
        );
        print('Sentry envs forwarded', config.sentryAlertEnvironments);
        print('Health check URL', config.healthcheckUrl);
        try {
          const me = await client.getMe();
          print('Bot (getMe)', `@${me.username} (id ${me.id})`);
        } catch (error) {
          print('Bot (getMe)', `FAILED: ${(error as Error).message}`);
          return 2;
        }
        return config.isActive() ? 0 : 1;
      }

      case 'test-message': {
        const note =
          typeof flags.note === 'string' ? `\nNote: ${flags.note}` : '';
        const result = await client.sendMessage(
          `🧪 [${config.environment}] WIEZ monitoring — delivery test\n\nSent from the ${config.environment} server by the monitoring CLI. No action needed.${note}\n\nSent: ${formatZoned(new Date(), config.reportTimeZone)}`,
        );
        print('Delivered message id', String(result.messageId));
        return 0;
      }

      case 'report': {
        const kind: ReportKind =
          flags.kind === 'evening' ? 'evening' : 'morning';
        const at =
          typeof flags.at === 'string' ? new Date(flags.at) : new Date();
        if (Number.isNaN(at.getTime()))
          throw new Error('--at must be an ISO date-time');
        const reports = app.get(MonitoringReportService);
        if (flags.scheduled) {
          const outcome = await reports.deliverScheduled(kind, at);
          print(
            'Scheduled delivery',
            `${outcome.status} (${outcome.parts} part(s))`,
          );
          print(
            'Window',
            `${outcome.window.start.toISOString()} → ${outcome.window.end.toISOString()}`,
          );
          return 0;
        }
        const window = reports.window(kind, at);
        const data = await reports.collect(window);
        const parts = reports.render(data);
        print(
          'Window (UTC)',
          `${window.start.toISOString()} → ${window.end.toISOString()}`,
        );
        print('Parts', String(parts.length));
        console.log('\n' + parts.join('\n\n------\n\n') + '\n');
        if (flags.send) {
          for (const [index, part] of parts.entries()) {
            const { messageId } = await client.sendMessage(
              index === 0
                ? `🧪 PREVIEW (not the scheduled report)\n${part}`
                : part,
            );
            print(`Delivered part ${index + 1}`, `message id ${messageId}`);
          }
        }
        return 0;
      }

      case 'report-log': {
        const rows = await app
          .get(MonitoringReportService)
          .recentDeliveries(Number(flags.limit ?? 10));
        if (rows.length === 0)
          console.log('No scheduled report deliveries recorded yet.');
        for (const row of rows) console.log(JSON.stringify(row));
        return 0;
      }

      case 'watchdog': {
        const result = await app
          .get(InfraWatchdogService)
          .runWorkerSweep({ dryRun: Boolean(flags['dry-run']) });
        console.log(JSON.stringify(result, null, 2));
        return 0;
      }

      case 'sentry-test-error': {
        const appEnv = String(process.env.APP_ENV ?? '')
          .trim()
          .toLowerCase();
        if (
          appEnv === 'production' ||
          config.environment === 'PROD' ||
          config.environment === 'PRODUCTION'
        ) {
          console.error(
            'Refused: synthetic Sentry errors are not allowed in production.',
          );
          return 3;
        }
        initSentry();
        if (!isSentryEnabled()) {
          console.error('Sentry is not initialised (SENTRY_DSN missing).');
          return 4;
        }
        const marker = new Date().toISOString();
        const eventId = Sentry.withScope((scope) => {
          scope.setLevel('error');
          scope.setTag('monitoring_test', 'true');
          scope.setTag('http.method', 'POST');
          scope.setTag('http.path', '/monitoring/synthetic-test');
          scope.setTag('http.status_code', '500');
          scope.setTag('requestId', `monitoring-test-${Date.now()}`);
          scope.setFingerprint(['wiez-monitoring-synthetic-test', marker]);
          return Sentry.captureException(
            new Error(
              `[WIEZ monitoring synthetic test] Controlled ${config.environment} error at ${marker} — safe to resolve`,
            ),
          );
        });
        await Sentry.flush(8_000);
        print('Sentry event id', eventId);
        print(
          'Sentry environment',
          String(process.env.SENTRY_ENVIRONMENT ?? process.env.APP_ENV ?? ''),
        );
        return 0;
      }

      case 'sentry-webhook-selftest': {
        const secret = config.sentryWebhookSecret;
        if (!secret) {
          console.error('SENTRY_WEBHOOK_CLIENT_SECRET is not set.');
          return 4;
        }
        const port = process.env.APP_PORT || process.env.PORT || '3040';
        const url =
          typeof flags.url === 'string'
            ? flags.url
            : `http://127.0.0.1:${port}/webhooks/sentry`;
        const env = config.sentryAlertEnvironments[0] ?? 'sit';
        const now = new Date();
        // Serialised like Sentry's Python json.dumps (", " and ": "), so the
        // receiver must verify the raw bytes, exactly as with real Sentry.
        const body = pythonJsonDumps({
          action: 'triggered',
          installation: { uuid: 'selftest' },
          data: {
            triggered_rule: 'WIEZ monitoring self-test (signed locally)',
            event: {
              event_id: `selftest${now.getTime()}`,
              issue_id: '0',
              title:
                '[WIEZ monitoring self-test] Signed webhook delivery check',
              level: 'error',
              culprit: 'telegram-monitoring.cli sentry-webhook-selftest',
              environment: env,
              project: 'selftest',
              datetime: now.toISOString(),
              request: {
                method: 'POST',
                url: 'https://api.weaz.me/monitoring/selftest?token=should-not-appear',
              },
              tags: [
                ['http.status_code', '500'],
                ['requestId', `selftest-${now.getTime()}`],
              ],
              exception: {
                values: [
                  {
                    type: 'SelfTestError',
                    value:
                      'Synthetic failure for user test@example.com (should be scrubbed)',
                    mechanism: { type: 'generic', handled: true },
                    stacktrace: {
                      frames: [
                        {
                          filename:
                            'src/telegram-monitoring/telegram-monitoring.cli.ts',
                          function: 'selftest',
                          lineno: 1,
                          in_app: true,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        });
        const signature = flags['bad-signature']
          ? '0'.repeat(64)
          : createHmac('sha256', secret).update(body, 'utf8').digest('hex');
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'sentry-hook-resource': 'event_alert',
            'sentry-hook-timestamp': String(Math.floor(now.getTime() / 1000)),
            'sentry-hook-signature': signature,
            'request-id': `selftest-${now.getTime()}`,
          },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        print('Webhook HTTP status', String(response.status));
        print('Webhook response', (await response.text()).slice(0, 300));
        return response.ok || flags['bad-signature'] ? 0 : 5;
      }

      default:
        console.error(`Unknown command "${command}". Try: help`);
        return 64;
    }
  } catch (error) {
    if (error instanceof TelegramDeliveryError) {
      console.error(`Telegram ${error.kind} failure: ${error.message}`);
      return 6;
    }
    console.error(
      `Failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  } finally {
    await app.close().catch(() => undefined);
  }
}

void main().then((code) => process.exit(code));
