import { getQueueToken } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Queue } from 'bullmq';
import { promises as fs } from 'fs';
import * as os from 'os';
import { PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY } from 'src/common/runtime/payment-runtime.keys';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BULK_UPLOAD_QUEUE,
  IMAGE_PROCESSING_QUEUE,
  NOTIFICATIONS_QUEUE,
  REVIEW_AGGREGATE_QUEUE,
  REVIEW_REMINDER_QUEUE,
  SEARCH_QUEUE,
  TELEGRAM_MONITORING_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
} from 'src/queue/queue.constants';
import { describe, TelegramDeliveryService } from './telegram-delivery.service';
import { TelegramMonitoringConfig } from './telegram-monitoring.config';

export const MONITORED_QUEUES = [
  IMAGE_PROCESSING_QUEUE,
  NOTIFICATIONS_QUEUE,
  WEBHOOK_EVENTS_QUEUE,
  BULK_UPLOAD_QUEUE,
  SEARCH_QUEUE,
  REVIEW_AGGREGATE_QUEUE,
  REVIEW_REMINDER_QUEUE,
  TELEGRAM_MONITORING_QUEUE,
] as const;

const PROBE_TIMEOUT_MS = 3_000;
const WORKER_STALE_AFTER_SECONDS = 150;

export type ProbeResult = { ok: boolean; detail: string; latencyMs?: number };

export type QueueStat =
  | { name: string; waiting: number; active: number; delayed: number; failed: number; paused: number }
  | { name: string; error: string };

export type InfraSnapshot = {
  takenAt: Date;
  database: ProbeResult;
  redis: ProbeResult;
  api: ProbeResult;
  worker: ProbeResult;
  queues: QueueStat[];
  memory: { totalMb: number; availableMb: number; swapTotalMb: number; swapUsedPct: number | null } | null;
  disk: { usedPct: number; freeGb: number } | null;
  processRssMb: number;
};

@Injectable()
export class InfraProbeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: TelegramMonitoringConfig,
    private readonly delivery: TelegramDeliveryService,
    private readonly moduleRef: ModuleRef,
  ) {}

  async snapshot(): Promise<InfraSnapshot> {
    const [database, redis, api, worker, queues, memory, disk] = await Promise.all([
      this.probeDatabase(),
      this.probeRedis(),
      this.probeApi(),
      this.probeWorker(),
      this.queueStats(),
      this.memory(),
      this.disk(),
    ]);
    return {
      takenAt: new Date(),
      database,
      redis,
      api,
      worker,
      queues,
      memory,
      disk,
      processRssMb: Math.round(process.memoryUsage().rss / 1_048_576),
    };
  }

  async probeDatabase(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      await bounded(this.prisma.$queryRaw`SELECT 1`, 'database');
      return { ok: true, detail: 'reachable', latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, detail: describeProbeError(error), latencyMs: Date.now() - started };
    }
  }

  async probeRedis(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const redis = await this.delivery.redis();
      if (!redis) return { ok: false, detail: 'no connection' };
      await bounded(redis.ping(), 'redis');
      return { ok: true, detail: 'reachable', latencyMs: Date.now() - started };
    } catch (error) {
      return { ok: false, detail: describeProbeError(error), latencyMs: Date.now() - started };
    }
  }

  async probeApi(): Promise<ProbeResult> {
    const started = Date.now();
    try {
      const response = await fetch(this.config.healthcheckUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      return {
        ok: response.ok,
        detail: response.ok ? 'healthz OK' : `healthz HTTP ${response.status}`,
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      return { ok: false, detail: describeProbeError(error), latencyMs: Date.now() - started };
    }
  }

  async probeWorker(): Promise<ProbeResult> {
    try {
      const redis = await this.delivery.redis();
      if (!redis) return { ok: false, detail: 'Redis unavailable; heartbeat unknown' };
      const raw = await bounded(redis.get(PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY), 'heartbeat');
      if (!raw) return { ok: false, detail: 'no heartbeat seen' };
      const runAt = new Date(JSON.parse(raw)?.runAt ?? '');
      const ageSeconds = Math.round((Date.now() - runAt.getTime()) / 1000);
      if (!Number.isFinite(ageSeconds)) return { ok: false, detail: 'heartbeat unreadable' };
      return ageSeconds > WORKER_STALE_AFTER_SECONDS
        ? { ok: false, detail: `heartbeat stale (${ageSeconds}s old)` }
        : { ok: true, detail: `heartbeat ${ageSeconds}s ago` };
    } catch (error) {
      return { ok: false, detail: describeProbeError(error) };
    }
  }

  async queueStats(): Promise<QueueStat[]> {
    return Promise.all(
      MONITORED_QUEUES.map(async (name): Promise<QueueStat> => {
        try {
          const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
          const counts = await bounded(
            queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'paused'),
            `queue ${name}`,
          );
          return {
            name,
            waiting: counts.waiting ?? 0,
            active: counts.active ?? 0,
            delayed: counts.delayed ?? 0,
            failed: counts.failed ?? 0,
            paused: counts.paused ?? 0,
          };
        } catch (error) {
          return { name, error: describeProbeError(error) };
        }
      }),
    );
  }

  /** Recent failed jobs for one queue: names and a short, scrubbed reason only. */
  async recentFailures(name: string, limit = 3): Promise<Array<{ jobName: string; reason: string; at: Date | null }>> {
    try {
      const queue = this.moduleRef.get<Queue>(getQueueToken(name), { strict: false });
      const jobs = await bounded(queue.getFailed(0, Math.max(0, limit - 1)), `failed ${name}`);
      return jobs.map((job) => ({
        jobName: String(job?.name ?? 'unknown'),
        reason: scrubReason(job?.failedReason),
        at: job?.finishedOn ? new Date(job.finishedOn) : null,
      }));
    } catch {
      return [];
    }
  }

  private async memory(): Promise<InfraSnapshot['memory']> {
    try {
      const meminfo = await fs.readFile('/proc/meminfo', 'utf8');
      const read = (key: string) => {
        const match = meminfo.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'));
        return match ? Number(match[1]) / 1024 : null;
      };
      const total = read('MemTotal');
      const available = read('MemAvailable');
      const swapTotal = read('SwapTotal') ?? 0;
      const swapFree = read('SwapFree') ?? 0;
      if (total === null || available === null) throw new Error('meminfo incomplete');
      return {
        totalMb: Math.round(total),
        availableMb: Math.round(available),
        swapTotalMb: Math.round(swapTotal),
        swapUsedPct: swapTotal > 0 ? Math.round(((swapTotal - swapFree) / swapTotal) * 100) : null,
      };
    } catch {
      // Non-Linux (local dev): os.freemem() excludes reclaimable cache, so it
      // is reported but is pessimistic.
      return {
        totalMb: Math.round(os.totalmem() / 1_048_576),
        availableMb: Math.round(os.freemem() / 1_048_576),
        swapTotalMb: 0,
        swapUsedPct: null,
      };
    }
  }

  private async disk(): Promise<InfraSnapshot['disk']> {
    try {
      const stats = await fs.statfs(process.platform === 'win32' ? process.cwd() : '/');
      const total = stats.blocks * stats.bsize;
      const free = stats.bavail * stats.bsize;
      if (!total) return null;
      return {
        usedPct: Math.round(((total - free) / total) * 100),
        freeGb: Math.round((free / 1_073_741_824) * 10) / 10,
      };
    } catch {
      return null;
    }
  }
}

function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} probe timed out`)), PROBE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function describeProbeError(error: unknown): string {
  // Connection errors can embed URLs with credentials; keep only the name and
  // a scrubbed first line.
  return scrubReason(describe(error));
}

export function scrubReason(value: unknown): string {
  return String(value ?? 'unknown')
    .split('\n')[0]
    .replace(/[a-z]+:\/\/[^\s]+/gi, '<url>')
    .replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<email>')
    .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '<redacted>')
    .slice(0, 160);
}
