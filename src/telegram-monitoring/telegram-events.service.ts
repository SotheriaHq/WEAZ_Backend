import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import type { JobsOptions, Queue } from 'bullmq';
import {
  TELEGRAM_MONITORING_QUEUE,
  TELEGRAM_SEND_JOB,
  TELEGRAM_SENTRY_ALERT_JOB,
} from 'src/queue/queue.constants';
import { PrismaService } from 'src/prisma/prisma.service';
import { hourBucket } from './report-window';
import { COUNTER_TTL_SECONDS, stableId } from './monitoring-keys';
import { EVENT_POLICY, MonitoringEventKey, MonitoringSeverity } from './monitoring-events';
import {
  MessageField,
  renderMessage,
  TimelineEntry,
  UserIdentity,
} from './telegram-message.format';
import { describe, TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';
import type { NormalizedSentryAlert } from './sentry-alert.parser';

const DISPATCH_TIMEOUT_MS = 5_000;

export type MonitoringEventInput = {
  key: MonitoringEventKey;
  /** Stable per business fact (e.g. payment reference): the dedupe key. */
  idempotencyKey: string;
  occurredAt?: Date;
  title?: string;
  severity?: MonitoringSeverity;
  summary?: string;
  fields?: MessageField[];
  identity?: UserIdentity | null;
  timeline?: TimelineEntry[];
  links?: Array<[string, string | null | undefined]>;
  /** Optional extra report counter, e.g. `payment.failed:EXPIRED`. */
  counterSuffix?: string;
};

export type SendJobData = { idempotencyId: string; text: string };
export type SentryAlertJobData = { idempotencyId: string; alert: NormalizedSentryAlert };

export const SEND_JOB_OPTIONS: JobsOptions = {
  attempts: 6,
  backoff: { type: 'exponential', delay: 15_000 },
  removeOnComplete: 200,
  removeOnFail: 200,
};

/**
 * The only thing business code calls.
 *
 * `record()` returns synchronously and never throws: counting and enqueueing
 * happen on a detached promise bounded by a timeout, so a slow or dead Redis,
 * a full queue or a Telegram outage cannot add latency to, or fail, the user
 * operation that produced the event. Callers must invoke it AFTER their
 * transaction commits so only real outcomes are reported.
 */
@Injectable()
export class TelegramEventsService {
  private readonly logger = new Logger(TelegramEventsService.name);

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly delivery: TelegramDeliveryService,
    @InjectQueue(TELEGRAM_MONITORING_QUEUE) private readonly queue: Queue,
    private readonly prisma: PrismaService,
  ) {}

  get identityEnabled(): boolean {
    return this.config.includeUserIdentity;
  }

  record(event: MonitoringEventInput): void {
    try {
      if (!this.config.isActive()) return;
      void this.withTimeout(this.dispatch(event)).catch((error) => {
        this.logger.warn(`Monitoring event ${event.key} not dispatched: ${describe(error)}`);
      });
    } catch (error) {
      this.logger.warn(`Monitoring event ${event?.key} rejected: ${describe(error)}`);
    }
  }

  /** Counter-only bump for report metrics (no message, ever). */
  count(eventKey: string, at: Date = new Date()): void {
    try {
      if (!this.config.isActive()) return;
      void this.withTimeout(this.increment([eventKey], at)).catch(() => undefined);
    } catch {
      // Monitoring must never surface to the caller.
    }
  }

  async enqueueSentryAlert(alert: NormalizedSentryAlert, deliveryId: string): Promise<void> {
    const idempotencyId = stableId('sentry-delivery', this.config.environment, deliveryId);
    const data: SentryAlertJobData = { idempotencyId, alert };
    await this.queue.add(TELEGRAM_SENTRY_ALERT_JOB, data, {
      ...SEND_JOB_OPTIONS,
      jobId: `sentry-${idempotencyId}`,
    });
  }

  async enqueueText(idempotencyKey: string, text: string): Promise<void> {
    const idempotencyId = stableId('event', this.config.environment, idempotencyKey);
    const data: SendJobData = { idempotencyId, text };
    await this.queue.add(TELEGRAM_SEND_JOB, data, {
      ...SEND_JOB_OPTIONS,
      jobId: `send-${idempotencyId}`,
    });
  }

  render(event: MonitoringEventInput, overrides?: { title?: string; summary?: string }): string {
    const policy = EVENT_POLICY[event.key];
    return renderMessage(
      {
        environment: this.config.environment,
        severity: event.severity ?? policy.severity,
        title: overrides?.title ?? event.title ?? policy.title,
        summary: overrides?.summary ?? event.summary,
        fields: event.fields,
        identity: event.identity,
        timeline: event.timeline,
        links: event.links,
      },
      { includeIdentity: this.config.includeUserIdentity, timeZone: this.config.reportTimeZone },
    );
  }

  private async dispatch(event: MonitoringEventInput): Promise<void> {
    const policy = EVENT_POLICY[event.key];
    if (!policy) return;
    const at = event.occurredAt ?? new Date();
    await this.increment(
      event.counterSuffix ? [event.key, `${event.key}:${event.counterSuffix}`] : [event.key],
      at,
    );

    if (policy.delivery === 'count') return;

    if (policy.delivery === 'threshold') {
      const windowMs = (policy.windowMinutes ?? 60) * 60_000;
      const bucket = Math.floor(at.getTime() / windowMs);
      const redis = await this.delivery.redis();
      if (!redis) return;
      const key = this.delivery.keys.threshold(event.key, bucket);
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, Math.ceil((windowMs * 2) / 1000));
      // Exactly one message per bucket: fire on the crossing, not after it.
      if (count !== policy.threshold) return;
      const text = this.render(event, {
        title: `${policy.title} — threshold reached`,
        summary: `${count} occurrences within ${policy.windowMinutes} minutes. ${event.summary ?? ''}`.trim(),
      });
      await this.enqueueText(`threshold:${event.key}:${bucket}`, text);
      return;
    }

    const enriched = await this.withIdentity(event);
    await this.enqueueText(`${event.key}:${event.idempotencyKey}`, this.render(enriched));
  }

  /**
   * Callers usually only hold a user id. When identity display is on, fill in
   * username / email / account type and add "Account created" to the
   * timeline. One indexed primary-key read, inside the dispatch timeout.
   */
  private async withIdentity(event: MonitoringEventInput): Promise<MonitoringEventInput> {
    const identity = event.identity;
    if (!identity?.userId || !this.config.includeUserIdentity) return event;
    try {
      const user = await this.prisma.user.findUnique({
        where: { id: identity.userId },
        select: { username: true, email: true, type: true, createdAt: true },
      });
      if (!user) return event;
      const timeline = [...(event.timeline ?? [])];
      if (!timeline.some(([label]) => label === 'Account created')) {
        timeline.push(['Account created', user.createdAt]);
      }
      return {
        ...event,
        identity: {
          userId: identity.userId,
          username: identity.username ?? user.username,
          email: identity.email ?? user.email,
          accountType: identity.accountType ?? user.type,
        },
        timeline,
      };
    } catch (error) {
      this.logger.warn(`Identity lookup skipped for ${event.key}: ${describe(error)}`);
      return event;
    }
  }

  private async increment(fields: string[], at: Date): Promise<void> {
    const redis = await this.delivery.redis();
    if (!redis) return;
    const key = this.delivery.keys.counter(hourBucket(at));
    const pipeline = redis.multi();
    for (const field of fields) pipeline.hincrby(key, field, 1);
    pipeline.expire(key, COUNTER_TTL_SECONDS);
    await pipeline.exec();
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    return Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`monitoring dispatch exceeded ${DISPATCH_TIMEOUT_MS}ms`)),
          DISPATCH_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]).finally(() => {
      if (timer) clearTimeout(timer);
    });
  }
}
