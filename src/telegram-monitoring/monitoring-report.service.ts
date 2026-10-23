import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import * as os from 'os';
import { PrismaService } from 'src/prisma/prisma.service';
import { EVENT_POLICY, MonitoringEventKey } from './monitoring-events';
import { REPORT_RECORD_TTL_SECONDS } from './monitoring-keys';
import { InfraProbeService, InfraSnapshot } from './infra-probe.service';
import {
  formatZoned,
  hourBucketsBetween,
  ReportKind,
  ReportWindow,
  resolveReportWindow,
} from './report-window';
import { SentryApiClient, SentryIssueSummary } from './sentry-api.client';
import { cleanText, formatDuration } from './telegram-message.format';
import { describe, TelegramDeliveryService } from './telegram-delivery.service';
import { TELEGRAM_MAX_TEXT, TelegramClient } from './telegram.client';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

/** Server-side cap per report query: a slow count must not hold the DB. */
const QUERY_TIMEOUT_MS = 5_000;
const SENDING_LEASE_MS = 10 * 60_000;
const REPORT_LOG_LENGTH = 60;

type Metric = number | null;

export type ReportData = {
  window: ReportWindow;
  generatedAt: Date;
  platform: Record<string, Metric>;
  payments: {
    succeeded: Array<{
      currency: string;
      count: number;
      amount: number;
    }> | null;
    failed: Metric;
  };
  counters: Record<string, number> | null;
  sentry:
    | {
        available: true;
        newIssues: SentryIssueSummary[];
        regressed: SentryIssueSummary[];
        fatal: SentryIssueSummary[];
        top: SentryIssueSummary[];
      }
    | { available: false; reason: string };
  infra: InfraSnapshot | null;
  queryMs: number;
};

type ReportRecord = {
  status: 'sending' | 'sent' | 'failed';
  kind: ReportKind;
  windowStart: string;
  windowEnd: string;
  sentParts: number;
  totalParts?: number;
  messageIds?: number[];
  sendingUntil?: number;
  sentAt?: string;
  lastError?: string;
  sections?: Record<string, 'ok' | 'unavailable'>;
};

@Injectable()
export class MonitoringReportService {
  private readonly logger = new Logger(MonitoringReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramMonitoringConfig,
    private readonly delivery: TelegramDeliveryService,
    private readonly client: TelegramClient,
    private readonly sentry: SentryApiClient,
    private readonly infra: InfraProbeService,
  ) {}

  window(kind: ReportKind, now = new Date()): ReportWindow {
    return resolveReportWindow(kind, now, this.config.reportTimeZone);
  }

  async collect(window: ReportWindow): Promise<ReportData> {
    const started = Date.now();
    const [platform, payments, counters, sentry, infra] = await Promise.all([
      this.platformMetrics(window),
      this.paymentMetrics(window),
      this.counterTotals(window),
      this.sentryMetrics(window),
      this.infra.snapshot().catch(() => null),
    ]);
    return {
      window,
      generatedAt: new Date(),
      platform,
      payments,
      counters,
      sentry,
      infra,
      queryMs: Date.now() - started,
    };
  }

  /**
   * Scheduled delivery with duplicate protection keyed on (kind, window end).
   * A worker restart, a BullMQ retry or a second scheduler firing for the same
   * window all find the record and stop; a crash mid-send resumes from the
   * first unsent part instead of repeating the ones already delivered.
   */
  async deliverScheduled(
    kind: ReportKind,
    now = new Date(),
  ): Promise<{
    status: 'sent' | 'duplicate';
    parts: number;
    window: ReportWindow;
  }> {
    const window = this.window(kind, now);
    const redis = await this.delivery.redis();
    const key = this.delivery.keys.report(kind, window.end.toISOString());

    let record: ReportRecord | null = null;
    if (redis) {
      const raw = await redis.get(key).catch(() => null);
      record = raw ? (JSON.parse(raw) as ReportRecord) : null;
      if (record?.status === 'sent')
        return { status: 'duplicate', parts: record.totalParts ?? 0, window };
      if (
        record?.status === 'sending' &&
        (record.sendingUntil ?? 0) > Date.now()
      ) {
        throw new Error(
          `report ${kind} ${window.end.toISOString()} already being sent`,
        );
      }
    }

    const data = await this.collect(window);
    const parts = this.render(data);
    const base: ReportRecord = {
      status: 'sending',
      kind,
      windowStart: window.start.toISOString(),
      windowEnd: window.end.toISOString(),
      sentParts: record?.sentParts ?? 0,
      totalParts: parts.length,
      messageIds: record?.messageIds ?? [],
      sendingUntil: Date.now() + SENDING_LEASE_MS,
      sections: this.sectionStatus(data),
    };
    const save = async (value: ReportRecord) => {
      if (!redis) return;
      await redis
        .set(key, JSON.stringify(value), 'EX', REPORT_RECORD_TTL_SECONDS)
        .catch(() => undefined);
    };
    await save(base);

    try {
      for (let index = base.sentParts; index < parts.length; index += 1) {
        const { messageId } = await this.client.sendMessage(parts[index]);
        base.sentParts = index + 1;
        base.messageIds = [...(base.messageIds ?? []), messageId];
        await save(base);
      }
    } catch (error) {
      await save({
        ...base,
        status: 'failed',
        sendingUntil: undefined,
        lastError: describe(error),
      });
      throw error;
    }

    const done: ReportRecord = {
      ...base,
      status: 'sent',
      sendingUntil: undefined,
      sentAt: new Date().toISOString(),
    };
    await save(done);
    if (redis) {
      await redis
        .multi()
        .lpush(this.delivery.keys.reportLog(), JSON.stringify(done))
        .ltrim(this.delivery.keys.reportLog(), 0, REPORT_LOG_LENGTH - 1)
        .exec()
        .catch(() => undefined);
    }
    this.logger.log(
      `Telegram ${kind} report sent for window ending ${window.end.toISOString()} (${parts.length} part(s))`,
    );
    return { status: 'sent', parts: parts.length, window };
  }

  async recentDeliveries(limit = 10): Promise<ReportRecord[]> {
    const redis = await this.delivery.redis();
    if (!redis) return [];
    const rows = await redis
      .lrange(this.delivery.keys.reportLog(), 0, limit - 1)
      .catch(() => []);
    return rows.map((row) => JSON.parse(row) as ReportRecord);
  }

  // ---------------------------------------------------------------- metrics

  private async bounded<T>(query: Prisma.PrismaPromise<T>): Promise<T> {
    // One short transaction per metric so SET LOCAL scopes the timeout to it.
    const [, result] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe(
        `SET LOCAL statement_timeout = ${QUERY_TIMEOUT_MS}`,
      ),
      query,
    ]);
    return result as T;
  }

  private async metric(
    label: string,
    query: () => Prisma.PrismaPromise<number>,
  ): Promise<Metric> {
    try {
      return Number(await this.bounded(query()));
    } catch (error) {
      this.logger.warn(
        `Report metric "${label}" unavailable: ${describe(error)}`,
      );
      return null;
    }
  }

  private async platformMetrics(
    window: ReportWindow,
  ): Promise<Record<string, Metric>> {
    const range = { gte: window.start, lt: window.end };
    const p = this.prisma;
    const entries: Array<[string, () => Prisma.PrismaPromise<number>]> = [
      [
        'New shoppers',
        () => p.user.count({ where: { createdAt: range, type: 'REGULAR' } }),
      ],
      [
        'New brand accounts',
        () => p.user.count({ where: { createdAt: range, type: 'BRAND' } }),
      ],
      [
        'New brands (stores)',
        () => p.brand.count({ where: { createdAt: range } }),
      ],
      [
        'Uploads started',
        () => p.fileUpload.count({ where: { createdAt: range } }),
      ],
      [
        'Uploads processed OK',
        () =>
          p.fileUpload.count({
            where: { createdAt: range, processingStatus: 'READY' },
          }),
      ],
      [
        'Uploads failed processing',
        () =>
          p.fileUpload.count({
            where: { createdAt: range, processingStatus: 'FAILED' },
          }),
      ],
      [
        'Uploads still pending',
        () =>
          p.fileUpload.count({
            where: { createdAt: range, processingStatus: 'PENDING' },
          }),
      ],
      [
        'New products now published',
        () =>
          p.product.count({
            where: { createdAt: range, publicationStatus: 'PUBLISHED' },
          }),
      ],
      [
        'New designs now published',
        () =>
          p.collection.count({
            where: { createdAt: range, status: 'PUBLISHED' },
          }),
      ],
      [
        'New designs failed/rejected',
        () =>
          p.collection.count({
            where: { createdAt: range, status: { in: ['FAILED', 'REJECTED'] } },
          }),
      ],
      ['Orders created', () => p.order.count({ where: { createdAt: range } })],
      [
        'Custom orders created',
        () => p.customOrder.count({ where: { createdAt: range } }),
      ],
      [
        'Design likes/reactions',
        () => p.collectionReaction.count({ where: { createdAt: range } }),
      ],
      ['Follows', () => p.follow.count({ where: { createdAt: range } })],
      [
        'Comments',
        () =>
          p.commentV2.count({ where: { createdAt: range, deletedAt: null } }),
      ],
      [
        'Design comments',
        () => p.collectionComment.count({ where: { createdAt: range } }),
      ],
      [
        'Wishlist adds',
        () => p.wishlistItem.count({ where: { createdAt: range } }),
      ],
      ['Saves', () => p.savedItem.count({ where: { createdAt: range } })],
    ];
    const values = await Promise.all(
      entries.map(([label, query]) => this.metric(label, query)),
    );
    const result: Record<string, Metric> = {};
    entries.forEach(([label], index) => {
      result[label] = values[index];
    });

    // Distinct users whose session was created or refreshed in the window.
    // RefreshToken.lastUsedAt is overwritten on rotation, so a user active
    // both inside and after the window is missed: a LOWER BOUND, labelled so.
    try {
      const rows = await this.bounded(
        this.prisma.$queryRaw<Array<{ n: number }>>`
          SELECT COUNT(DISTINCT "userId")::int AS n FROM "RefreshToken"
          WHERE "lastUsedAt" >= ${window.start} AND "lastUsedAt" < ${window.end}`,
      );
      result['Signed-in users (login/refresh, lower bound)'] = Number(
        rows?.[0]?.n ?? 0,
      );
    } catch (error) {
      this.logger.warn(
        `Report metric "active users" unavailable: ${describe(error)}`,
      );
      result['Signed-in users (login/refresh, lower bound)'] = null;
    }
    return result;
  }

  private async paymentMetrics(
    window: ReportWindow,
  ): Promise<ReportData['payments']> {
    // createdAt lower bound lets Postgres use @@index([status, createdAt]);
    // checkout attempts expire well within two days.
    const createdFloor = new Date(
      window.start.getTime() - 2 * 24 * 60 * 60_000,
    );
    let succeeded: ReportData['payments']['succeeded'] = null;
    try {
      const groups = await this.bounded(
        this.prisma.paymentAttempt.groupBy({
          by: ['currency'],
          where: {
            status: 'PAID',
            createdAt: { gte: createdFloor },
            confirmedAt: { gte: window.start, lt: window.end },
          },
          _count: { _all: true },
          _sum: { amount: true },
        }) as unknown as Prisma.PrismaPromise<any[]>,
      );
      succeeded = groups.map((group: any) => ({
        currency: String(group.currency),
        count: Number(group._count?._all ?? 0),
        amount: Number(group._sum?.amount ?? 0),
      }));
    } catch (error) {
      this.logger.warn(`Report payments unavailable: ${describe(error)}`);
    }
    const failed = await this.metric('payments failed', () =>
      this.prisma.paymentAttempt.count({
        where: {
          status: { in: ['FAILED', 'CANCELLED', 'EXPIRED'] },
          createdAt: { gte: createdFloor },
          finalizedAt: { gte: window.start, lt: window.end },
        },
      }),
    );
    return { succeeded, failed };
  }

  private async counterTotals(
    window: ReportWindow,
  ): Promise<Record<string, number> | null> {
    const redis = await this.delivery.redis();
    if (!redis) return null;
    try {
      const buckets = hourBucketsBetween(window.start, window.end);
      const pipeline = redis.multi();
      for (const bucket of buckets)
        pipeline.hgetall(this.delivery.keys.counter(bucket));
      const results = (await pipeline.exec()) ?? [];
      const totals: Record<string, number> = {};
      for (const [error, hash] of results) {
        if (error || !hash) continue;
        for (const [field, value] of Object.entries(
          hash as Record<string, string>,
        )) {
          totals[field] = (totals[field] ?? 0) + Number(value);
        }
      }
      return totals;
    } catch (error) {
      this.logger.warn(`Report counters unavailable: ${describe(error)}`);
      return null;
    }
  }

  private async sentryMetrics(
    window: ReportWindow,
  ): Promise<ReportData['sentry']> {
    if (!this.sentry.isConfigured()) {
      return {
        available: false,
        reason: 'SENTRY_API_TOKEN / SENTRY_ORG_SLUG not configured',
      };
    }
    const environments = this.config.sentryAlertEnvironments;
    const iso = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, '');
    try {
      const [newIssues, regressed, fatal, top] = await Promise.all([
        this.sentry.searchIssues({
          query: `firstSeen:>=${iso(window.start)} firstSeen:<${iso(window.end)}`,
          start: window.start,
          end: window.end,
          environments,
          sort: 'freq',
          limit: 100,
        }),
        this.sentry.searchIssues({
          query: 'is:regressed',
          start: window.start,
          end: window.end,
          environments,
          limit: 25,
        }),
        this.sentry.searchIssues({
          query: 'level:fatal',
          start: window.start,
          end: window.end,
          environments,
          limit: 25,
        }),
        this.sentry.searchIssues({
          query: 'is:unresolved',
          start: window.start,
          end: window.end,
          environments,
          sort: 'freq',
          limit: 5,
        }),
      ]);
      return { available: true, newIssues, regressed, fatal, top };
    } catch (error) {
      return { available: false, reason: describe(error) };
    }
  }

  private sectionStatus(
    data: ReportData,
  ): Record<string, 'ok' | 'unavailable'> {
    return {
      platform: Object.values(data.platform).some((value) => value !== null)
        ? 'ok'
        : 'unavailable',
      payments: data.payments.succeeded !== null ? 'ok' : 'unavailable',
      counters: data.counters !== null ? 'ok' : 'unavailable',
      sentry: data.sentry.available ? 'ok' : 'unavailable',
      infra: data.infra ? 'ok' : 'unavailable',
    };
  }

  // ---------------------------------------------------------------- render

  render(data: ReportData): string[] {
    const tz = this.config.reportTimeZone;
    const env = this.config.environment;
    const title =
      data.window.kind === 'morning' ? 'Morning report' : 'Evening report';
    const show = (value: Metric) =>
      value === null ? 'unavailable' : String(value);

    const header = [
      `📊 [${env}] WIEZ ${title}`,
      `Window: ${formatZoned(data.window.start, tz)} → ${formatZoned(data.window.end, tz)}`,
      `Generated: ${formatZoned(data.generatedAt, tz)} (${data.queryMs} ms)`,
    ].join('\n');

    const platform = [
      '🛍️ Platform activity',
      ...Object.entries(data.platform).map(
        ([label, value]) => `• ${label}: ${show(value)}`,
      ),
    ];
    if (data.payments.succeeded === null) {
      platform.push('• Payments succeeded: unavailable');
    } else if (data.payments.succeeded.length === 0) {
      platform.push('• Payments succeeded: 0');
    } else {
      for (const row of data.payments.succeeded) {
        platform.push(
          `• Payments succeeded: ${row.count} (${row.currency} ${row.amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })})`,
        );
      }
    }
    platform.push(
      `• Payments failed/cancelled/expired: ${show(data.payments.failed)}`,
    );

    const failures = ['⚠️ Failed operations & alerts'];
    if (!data.counters) {
      failures.push('• Live event counters: unavailable (Redis)');
    } else {
      const counted: MonitoringEventKey[] = [
        'auth.signup_system_failure',
        'auth.signup_rejected',
        'design.publish_failed',
        'payment.failed',
        'http.server_error',
        'http.auth_failure',
        'operational.alert',
        'brand.verification_decided',
        'infra.alert',
      ];
      for (const key of counted) {
        failures.push(
          `• ${EVENT_POLICY[key].reportLabel}: ${data.counters[key] ?? 0}`,
        );
      }
      const operational = Object.entries(data.counters)
        .filter(([field]) => field.startsWith('operational.alert:'))
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5);
      for (const [field, count] of operational) {
        failures.push(
          `   ◦ ${cleanText(field.slice('operational.alert:'.length), 60)}: ${count}`,
        );
      }
    }

    const sentry = ['🐞 Sentry'];
    if (data.counters) {
      sentry.push(
        `• Alerts received via webhook: ${data.counters['sentry.alert'] ?? 0}`,
      );
    }
    // `in` narrowing: this project compiles without strictNullChecks, where
    // boolean-discriminant narrowing does not apply.
    if ('reason' in data.sentry) {
      sentry.push(
        `• Issue statistics: UNAVAILABLE — ${cleanText(data.sentry.reason, 160)}`,
      );
    } else {
      const fmt = (issue: SentryIssueSummary) =>
        `   ◦ ${issue.shortId ?? issue.id} ${cleanText(issue.title, 70)} — ${issue.count ?? '?'} events, ${issue.userCount ?? '?'} users`;
      const newCount =
        data.sentry.newIssues.length >= 100
          ? '100+'
          : String(data.sentry.newIssues.length);
      sentry.push(`• New issues: ${newCount}`);
      sentry.push(`• Regressed issues: ${data.sentry.regressed.length}`);
      sentry.push(`• Fatal-level issues: ${data.sentry.fatal.length}`);
      if (data.sentry.top.length > 0) {
        sentry.push('• Most frequent:');
        data.sentry.top.forEach((issue) => sentry.push(fmt(issue)));
      }
    }

    const infra = ['🖥️ Infrastructure (at report time)'];
    if (!data.infra) {
      infra.push('• Snapshot unavailable');
    } else {
      const s = data.infra;
      const mark = (ok: boolean) => (ok ? '✅' : '❌');
      infra.push(
        `• API: ${mark(s.api.ok)} ${s.api.detail}${s.api.latencyMs !== undefined ? ` (${s.api.latencyMs} ms)` : ''}`,
      );
      infra.push(`• Worker: ${mark(s.worker.ok)} ${s.worker.detail}`);
      infra.push(
        `• PostgreSQL: ${mark(s.database.ok)} ${s.database.detail}${s.database.latencyMs !== undefined ? ` (${s.database.latencyMs} ms)` : ''}`,
      );
      infra.push(
        `• Redis: ${mark(s.redis.ok)} ${s.redis.detail}${s.redis.latencyMs !== undefined ? ` (${s.redis.latencyMs} ms)` : ''}`,
      );
      if (s.memory) {
        const swap =
          s.memory.swapUsedPct === null
            ? ''
            : `, swap ${s.memory.swapUsedPct}% used`;
        infra.push(
          `• Memory: ${s.memory.availableMb} MB available of ${s.memory.totalMb} MB${swap}`,
        );
      }
      if (s.disk)
        infra.push(
          `• Disk: ${s.disk.usedPct}% used (${s.disk.freeGb} GB free)`,
        );
      infra.push(`• Host uptime: ${formatDuration(os.uptime() * 1000)}`);
      infra.push('• Queues (waiting/active/delayed/failed):');
      for (const queue of s.queues) {
        infra.push(
          'error' in queue
            ? `   ◦ ${queue.name}: unavailable`
            : `   ◦ ${queue.name}: ${queue.waiting}/${queue.active}/${queue.delayed}/${queue.failed}`,
        );
      }
    }

    const footer =
      'Counts cover the window above, start inclusive, end exclusive. "unavailable" means the source could not be read; it is not zero.';
    const sections = [
      header,
      platform.join('\n'),
      failures.join('\n'),
      sentry.join('\n'),
      infra.join('\n'),
      footer,
    ];

    // Pack sections into as few Telegram messages as fit.
    const parts: string[] = [];
    let current = '';
    for (const section of sections) {
      const candidate = current ? `${current}\n\n${section}` : section;
      if (candidate.length > TELEGRAM_MAX_TEXT && current) {
        parts.push(current);
        current = section;
      } else {
        current = candidate;
      }
    }
    if (current) parts.push(current);
    return parts.length > 1
      ? parts.map((part, index) => `${part}\n\n(${index + 1}/${parts.length})`)
      : parts;
  }
}
