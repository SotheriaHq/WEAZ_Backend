import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { MONITORED_QUEUES, InfraProbeService, InfraSnapshot } from './infra-probe.service';
import { stableId } from './monitoring-keys';
import { renderMessage } from './telegram-message.format';
import { describe, TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramEventsService } from './telegram-events.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

export const WATCHDOG_THRESHOLDS = {
  memoryAvailableMb: 150,
  swapUsedPct: 80,
  diskUsedPct: 85,
  queueWaiting: 300,
};

const QUEUE_FAILURE_COOLDOWN_SECONDS = 30 * 60;
const WORKER_CHECK_INTERVAL_MS = 2 * 60_000;

type Condition = { id: string; bad: boolean; title: string; detail: string };

export type WatchdogResult = {
  transitions: Array<{ id: string; to: 'bad' | 'recovered' }>;
  queueFailureAlerts: string[];
  conditions: Condition[];
};

/**
 * Edge-triggered infrastructure alerts.
 *
 * A condition pages once when it goes bad and once when it recovers; while it
 * stays bad the chat stays quiet (the reports keep showing it). State lives in
 * Redis so a worker restart does not re-announce an ongoing problem.
 */
@Injectable()
export class InfraWatchdogService {
  private readonly logger = new Logger(InfraWatchdogService.name);
  /** Fallback when Redis itself is the thing that is down. */
  private readonly localState = new Map<string, boolean>();

  constructor(
    private readonly config: TelegramMonitoringConfig,
    private readonly probe: InfraProbeService,
    private readonly delivery: TelegramDeliveryService,
    private readonly events: TelegramEventsService,
  ) {}

  /** Worker-side sweep (BullMQ job scheduler, every 5 minutes). */
  async runWorkerSweep(options: { dryRun?: boolean } = {}): Promise<WatchdogResult> {
    const snapshot = await this.probe.snapshot();
    const conditions = this.evaluate(snapshot);
    const transitions = await this.applyTransitions(conditions, options.dryRun ?? false);
    const queueFailureAlerts = await this.checkQueueFailures(snapshot, options.dryRun ?? false);
    return { transitions, queueFailureAlerts, conditions };
  }

  /**
   * API-side check that the worker is alive. Runs only where ScheduleModule is
   * registered (the API); the worker cannot usefully report its own death.
   */
  @Interval('telegram-worker-heartbeat-watch', WORKER_CHECK_INTERVAL_MS)
  async checkWorkerHeartbeat(): Promise<void> {
    if (!this.config.isActive()) return;
    try {
      const worker = await this.probe.probeWorker();
      await this.applyTransitions(
        [
          {
            id: 'worker',
            bad: !worker.ok,
            title: 'Queue worker down',
            detail: `${worker.detail}. Uploads, image processing, notifications, emails and payment webhooks are not being processed.`,
          },
        ],
        false,
      );
    } catch (error) {
      this.logger.warn(`Worker heartbeat watch failed: ${describe(error)}`);
    }
  }

  evaluate(snapshot: InfraSnapshot): Condition[] {
    const t = WATCHDOG_THRESHOLDS;
    const conditions: Condition[] = [
      { id: 'database', bad: !snapshot.database.ok, title: 'PostgreSQL unreachable', detail: snapshot.database.detail },
      { id: 'redis', bad: !snapshot.redis.ok, title: 'Redis unreachable', detail: snapshot.redis.detail },
      { id: 'api', bad: !snapshot.api.ok, title: 'API health check failing', detail: `${snapshot.api.detail} (${this.config.healthcheckUrl.replace(/\?.*$/, '')})` },
    ];
    if (snapshot.memory) {
      conditions.push({
        id: 'memory',
        bad: snapshot.memory.availableMb < t.memoryAvailableMb,
        title: 'Low memory',
        detail: `${snapshot.memory.availableMb} MB available of ${snapshot.memory.totalMb} MB (threshold ${t.memoryAvailableMb} MB)`,
      });
      if (snapshot.memory.swapUsedPct !== null) {
        conditions.push({
          id: 'swap',
          bad: snapshot.memory.swapUsedPct >= t.swapUsedPct,
          title: 'Heavy swap usage',
          detail: `${snapshot.memory.swapUsedPct}% of ${snapshot.memory.swapTotalMb} MB swap used (threshold ${t.swapUsedPct}%)`,
        });
      }
    }
    if (snapshot.disk) {
      conditions.push({
        id: 'disk',
        bad: snapshot.disk.usedPct >= t.diskUsedPct,
        title: 'Disk nearly full',
        detail: `${snapshot.disk.usedPct}% used, ${snapshot.disk.freeGb} GB free (threshold ${t.diskUsedPct}%)`,
      });
    }
    for (const queue of snapshot.queues) {
      if ('error' in queue) continue;
      conditions.push({
        id: `backlog:${queue.name}`,
        bad: queue.waiting >= t.queueWaiting,
        title: `Queue backlog: ${queue.name}`,
        detail: `${queue.waiting} waiting, ${queue.active} active, ${queue.delayed} delayed (threshold ${t.queueWaiting})`,
      });
    }
    return conditions;
  }

  private async applyTransitions(conditions: Condition[], dryRun: boolean): Promise<WatchdogResult['transitions']> {
    const redis = await this.delivery.redis();
    const stateKey = this.delivery.keys.watchState();
    const transitions: WatchdogResult['transitions'] = [];
    for (const condition of conditions) {
      let wasBad: boolean;
      try {
        wasBad = redis ? (await redis.hget(stateKey, condition.id)) === 'bad' : (this.localState.get(condition.id) ?? false);
      } catch {
        wasBad = this.localState.get(condition.id) ?? false;
      }
      if (wasBad === condition.bad) continue;

      const to = condition.bad ? 'bad' : 'recovered';
      transitions.push({ id: condition.id, to });
      if (dryRun) continue;

      this.localState.set(condition.id, condition.bad);
      try {
        if (redis) {
          if (condition.bad) await redis.hset(stateKey, condition.id, 'bad');
          else await redis.hdel(stateKey, condition.id);
        }
      } catch {
        // Local state still prevents a repeat from this process.
      }
      const text = renderMessage(
        {
          environment: this.config.environment,
          severity: condition.bad ? 'critical' : 'info',
          title: condition.bad ? condition.title : `Recovered: ${condition.title}`,
          summary: condition.detail,
          timeline: [['Detected', new Date()]],
        },
        { includeIdentity: false, timeZone: this.config.reportTimeZone },
      );
      this.events.count('infra.alert');
      // Direct send, not the queue: the queue may be the thing that is broken.
      await this.delivery
        .deliverOnce(stableId('watch', condition.id, to, Math.floor(Date.now() / 60_000)), text)
        .catch((error) => this.logger.error(`Infra alert ${condition.id} not delivered: ${describe(error)}`));
    }
    return transitions;
  }

  private async checkQueueFailures(snapshot: InfraSnapshot, dryRun: boolean): Promise<string[]> {
    const redis = await this.delivery.redis();
    if (!redis) return [];
    const alerted: string[] = [];
    const baselineKey = this.delivery.keys.queueFailed();
    for (const queue of snapshot.queues) {
      if ('error' in queue || !MONITORED_QUEUES.includes(queue.name as any)) continue;
      const previousRaw = await redis.hget(baselineKey, queue.name).catch(() => null);
      if (!dryRun) await redis.hset(baselineKey, queue.name, String(queue.failed)).catch(() => undefined);
      // First observation only establishes the baseline; failed sets are
      // capped by removeOnFail, so a DROP just resets it.
      if (previousRaw === null) continue;
      const delta = queue.failed - Number(previousRaw);
      if (delta <= 0) continue;
      if (dryRun) {
        alerted.push(queue.name);
        continue;
      }
      const fresh = await this.delivery.acquireCooldown(`queue-failed:${queue.name}`, QUEUE_FAILURE_COOLDOWN_SECONDS);
      if (!fresh) continue;
      const recent = await this.probe.recentFailures(queue.name, 3);
      const text = renderMessage(
        {
          environment: this.config.environment,
          severity: queue.name === 'image-processing' || queue.name === 'webhook-events' ? 'critical' : 'error',
          title: `Background jobs failing: ${queue.name}`,
          summary: `${delta} job(s) exhausted their retries since the last check (${queue.failed} in the failed set).`,
          sections: [
            {
              heading: '🧩 Most recent failures',
              fields: recent.map((failure, index) => [`${index + 1}. ${failure.jobName}`, failure.reason] as [string, string]),
            },
          ],
          timeline: recent[0]?.at ? [['Latest failure', recent[0].at]] : [],
        },
        { includeIdentity: false, timeZone: this.config.reportTimeZone },
      );
      this.events.count(`queue.failed:${queue.name}`);
      await this.delivery
        .deliverOnce(stableId('queue-failed', queue.name, queue.failed), text)
        .catch((error) => this.logger.error(`Queue failure alert not delivered: ${describe(error)}`));
      alerted.push(queue.name);
    }
    return alerted;
  }
}
