import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from 'src/prisma/prisma.service';
import { WEBHOOK_EVENTS_QUEUE } from 'src/queue/queue.constants';
import {
  PAYMENT_CRON_HEARTBEAT_TTL_SECONDS,
  PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY,
  paymentCronHeartbeatKey,
} from 'src/common/runtime/payment-runtime.keys';

type CronHeartbeatStatus = 'ok' | 'error';

interface CronHeartbeatRecord {
  runAt: string;
  status: CronHeartbeatStatus;
  details?: Record<string, unknown>;
}

interface RuntimeCronCheckDefinition {
  name: string;
  maxAgeSeconds: number;
}

const RUNTIME_CRON_CHECKS: RuntimeCronCheckDefinition[] = [
  {
    name: 'webhook-reprocess',
    maxAgeSeconds: 3 * 60,
  },
  {
    name: 'paid-unified-finalize-reconcile',
    maxAgeSeconds: 15 * 60,
  },
  {
    name: 'stale-payment-reconcile',
    maxAgeSeconds: 25 * 60,
  },
  {
    name: 'custom-order-payment-reconcile',
    maxAgeSeconds: 25 * 60,
  },
];

const PAYMENT_RUNTIME_ALERT_CONTRACT_VERSION = '2026-04-17';

const PAYMENT_RUNTIME_ALERT_THRESHOLDS = {
  webhookQueueBacklogHigh: 300,
  webhookProcessingFailures24hHigh: 20,
  openFinalizationCompensationCasesHigh: 0,
} as const;

@Injectable()
export class PaymentRuntimeHealthService {
  private readonly logger = new Logger(PaymentRuntimeHealthService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(WEBHOOK_EVENTS_QUEUE)
    private readonly webhookEventsQueue: Queue,
  ) {}

  async recordCronHeartbeat(
    name: string,
    status: CronHeartbeatStatus,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const normalizedName = String(name ?? '').trim().toLowerCase();
    if (!normalizedName) {
      return;
    }

    const payload: CronHeartbeatRecord = {
      runAt: new Date().toISOString(),
      status,
      ...(details ? { details } : {}),
    };

    try {
      const redis = await this.getRedisClient();
      await redis.set(
        paymentCronHeartbeatKey(normalizedName),
        JSON.stringify(payload),
        'EX',
        PAYMENT_CRON_HEARTBEAT_TTL_SECONDS,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to record cron heartbeat for ${normalizedName}: ${this.extractErrorMessage(error)}`,
      );
    }
  }

  async getRuntimeHealth(): Promise<{
    ok: boolean;
    checkedAt: string;
    redis: {
      ready: boolean;
      pingMs: number | null;
      error: string | null;
    };
    worker: {
      seen: boolean;
      stale: boolean;
      lastHeartbeatAt: string | null;
      ageSeconds: number | null;
      maxAgeSeconds: number;
      metadata: Record<string, unknown> | null;
    };
    crons: Array<{
      name: string;
      exists: boolean;
      stale: boolean;
      status: CronHeartbeatStatus | 'unknown';
      lastRunAt: string | null;
      ageSeconds: number | null;
      maxAgeSeconds: number;
      details: Record<string, unknown> | null;
    }>;
    queue: {
      counts: {
        waiting: number;
        active: number;
        delayed: number;
        failed: number;
        paused: number;
      } | null;
      error: string | null;
    };
    backlog: {
      pendingWebhookReceipts: number;
      oldestPendingWebhookAgeSeconds: number | null;
      recentWebhookProcessingFailures24h: number;
      staleLiveAttempts: number;
      openFinalizationCompensationCases: number;
    };
    alertContract: {
      version: string;
      thresholds: {
        workerHeartbeatStaleSeconds: number;
        cronHeartbeatChecks: Array<{
          name: string;
          maxAgeSeconds: number;
        }>;
        webhookQueueBacklogHigh: number;
        webhookProcessingFailures24hHigh: number;
        openFinalizationCompensationCasesHigh: number;
      };
      states: {
        workerHeartbeat: {
          state: 'ok' | 'alert';
          reason: string | null;
          lastHeartbeatAt: string | null;
          ageSeconds: number | null;
          maxAgeSeconds: number;
        };
        cronHeartbeats: {
          state: 'ok' | 'alert';
          reason: string | null;
          staleOrMissing: string[];
        };
        webhookQueueBacklog: {
          state: 'ok' | 'alert';
          reason: string | null;
          backlog: number | null;
          threshold: number;
        };
        webhookFailureSpike24h: {
          state: 'ok' | 'alert';
          reason: string | null;
          failures: number;
          threshold: number;
        };
        finalizationCompensation: {
          state: 'ok' | 'alert';
          reason: string | null;
          openCases: number;
          threshold: number;
        };
      };
    };
    degradedReasons: string[];
  }> {
    const checkedAt = new Date();
    const checkedAtIso = checkedAt.toISOString();
    const degradedReasons: string[] = [];

    const [
      pendingWebhookReceipts,
      oldestPendingWebhookReceipt,
      staleLiveAttempts,
      recentWebhookProcessingFailures24h,
      openFinalizationCompensationCases,
    ] = await Promise.all([
      this.prisma.paymentEvent.count({
        where: {
          type: 'WEBHOOK_RECEIVED',
          processedAt: null,
        },
      }),
      this.prisma.paymentEvent.findFirst({
        where: {
          type: 'WEBHOOK_RECEIVED',
          processedAt: null,
        },
        orderBy: [
          { providerEventReceivedAt: 'asc' },
          { createdAt: 'asc' },
        ],
        select: {
          providerEventReceivedAt: true,
          createdAt: true,
        },
      }),
      this.prisma.paymentAttempt.count({
        where: {
          providerMode: 'live',
          status: {
            in: ['PENDING', 'REQUIRES_ACTION', 'PROCESSING'],
          },
          updatedAt: {
            lte: new Date(Date.now() - 30 * 60 * 1000),
          },
        },
      }),
      this.prisma.paymentEvent.count({
        where: {
          type: 'WEBHOOK_PROCESS_FAILED',
          createdAt: {
            gte: new Date(Date.now() - 24 * 60 * 60 * 1000),
          },
        },
      }),
      this.prisma.paymentAttempt.count({
        where: {
          subjectType: 'UNIFIED_CHECKOUT',
          status: 'PAID',
          finalizationCompensationStatus: {
            in: ['ESCALATED', 'REFUND_REVIEW'],
          },
        },
      }),
    ]);

    const oldestPendingWebhookAt =
      oldestPendingWebhookReceipt?.providerEventReceivedAt ??
      oldestPendingWebhookReceipt?.createdAt ??
      null;
    const oldestPendingWebhookAgeSeconds = oldestPendingWebhookAt
      ? Math.max(
          0,
          Math.floor((checkedAt.getTime() - oldestPendingWebhookAt.getTime()) / 1000),
        )
      : null;

    const redisResult: {
      ready: boolean;
      pingMs: number | null;
      error: string | null;
    } = {
      ready: false,
      pingMs: null,
      error: null,
    };

    const workerResult: {
      seen: boolean;
      stale: boolean;
      lastHeartbeatAt: string | null;
      ageSeconds: number | null;
      maxAgeSeconds: number;
      metadata: Record<string, unknown> | null;
    } = {
      seen: false,
      stale: true,
      lastHeartbeatAt: null,
      ageSeconds: null,
      maxAgeSeconds: 90,
      metadata: null,
    };

    const cronResults: Array<{
      name: string;
      exists: boolean;
      stale: boolean;
      status: CronHeartbeatStatus | 'unknown';
      lastRunAt: string | null;
      ageSeconds: number | null;
      maxAgeSeconds: number;
      details: Record<string, unknown> | null;
    }> = [];

    let redisClient: any = null;

    try {
      redisClient = await this.getRedisClient();
      const pingStart = Date.now();
      await redisClient.ping();
      redisResult.ready = true;
      redisResult.pingMs = Math.max(0, Date.now() - pingStart);
    } catch (error) {
      redisResult.error = this.extractErrorMessage(error);
      degradedReasons.push('redis_unreachable_for_payment_runtime');
    }

    if (redisClient) {
      try {
        const rawHeartbeat = await redisClient.get(PAYMENT_QUEUE_WORKER_HEARTBEAT_KEY);
        if (rawHeartbeat) {
          const parsed = this.safeParseObject(rawHeartbeat);
          const runAtCandidate = String(parsed?.runAt ?? '').trim();
          const runAt = runAtCandidate ? new Date(runAtCandidate) : null;
          const ageSeconds =
            runAt && Number.isFinite(runAt.getTime())
              ? Math.max(0, Math.floor((checkedAt.getTime() - runAt.getTime()) / 1000))
              : null;

          workerResult.seen = true;
          workerResult.lastHeartbeatAt =
            runAt && Number.isFinite(runAt.getTime()) ? runAt.toISOString() : null;
          workerResult.ageSeconds = ageSeconds;
          workerResult.stale =
            ageSeconds === null || ageSeconds > workerResult.maxAgeSeconds;
          workerResult.metadata = parsed;
        }
      } catch (error) {
        degradedReasons.push('payment_worker_heartbeat_read_failed');
        this.logger.warn(
          `Failed to read payment worker heartbeat: ${this.extractErrorMessage(error)}`,
        );
      }

      for (const cronCheck of RUNTIME_CRON_CHECKS) {
        const key = paymentCronHeartbeatKey(cronCheck.name);
        try {
          const raw = await redisClient.get(key);
          if (!raw) {
            cronResults.push({
              name: cronCheck.name,
              exists: false,
              stale: true,
              status: 'unknown',
              lastRunAt: null,
              ageSeconds: null,
              maxAgeSeconds: cronCheck.maxAgeSeconds,
              details: null,
            });
            continue;
          }

          const parsed = this.safeParseObject(raw);
          const runAtCandidate = String(parsed?.runAt ?? '').trim();
          const runAt = runAtCandidate ? new Date(runAtCandidate) : null;
          const ageSeconds =
            runAt && Number.isFinite(runAt.getTime())
              ? Math.max(0, Math.floor((checkedAt.getTime() - runAt.getTime()) / 1000))
              : null;
          const statusCandidate =
            String(parsed?.status ?? '').trim().toLowerCase() === 'error'
              ? 'error'
              : 'ok';

          cronResults.push({
            name: cronCheck.name,
            exists: true,
            stale: ageSeconds === null || ageSeconds > cronCheck.maxAgeSeconds,
            status: statusCandidate,
            lastRunAt:
              runAt && Number.isFinite(runAt.getTime()) ? runAt.toISOString() : null,
            ageSeconds,
            maxAgeSeconds: cronCheck.maxAgeSeconds,
            details: (parsed?.details as Record<string, unknown> | undefined) ?? null,
          });
        } catch (error) {
          cronResults.push({
            name: cronCheck.name,
            exists: false,
            stale: true,
            status: 'unknown',
            lastRunAt: null,
            ageSeconds: null,
            maxAgeSeconds: cronCheck.maxAgeSeconds,
            details: {
              error: this.extractErrorMessage(error),
            },
          });
          degradedReasons.push(`payment_cron_heartbeat_read_failed:${cronCheck.name}`);
        }
      }
    }

    if (!workerResult.seen) {
      degradedReasons.push('payment_worker_heartbeat_missing');
    } else if (workerResult.stale) {
      degradedReasons.push('payment_worker_heartbeat_stale');
    }

    for (const cronResult of cronResults) {
      if (!cronResult.exists) {
        degradedReasons.push(`payment_cron_missing:${cronResult.name}`);
        continue;
      }
      if (cronResult.status === 'error') {
        degradedReasons.push(`payment_cron_error:${cronResult.name}`);
      }
      if (cronResult.stale) {
        degradedReasons.push(`payment_cron_stale:${cronResult.name}`);
      }
    }

    if (pendingWebhookReceipts > 200) {
      degradedReasons.push('payment_webhook_receipts_backlog_high');
    }
    if ((oldestPendingWebhookAgeSeconds ?? 0) > 15 * 60) {
      degradedReasons.push('payment_webhook_receipts_oldest_age_high');
    }
    if (
      recentWebhookProcessingFailures24h >
      PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookProcessingFailures24hHigh
    ) {
      degradedReasons.push('payment_webhook_processing_failures_24h_high');
    }
    if (staleLiveAttempts > 120) {
      degradedReasons.push('payment_stale_live_attempts_high');
    }
    if (
      openFinalizationCompensationCases >
      PAYMENT_RUNTIME_ALERT_THRESHOLDS.openFinalizationCompensationCasesHigh
    ) {
      degradedReasons.push('payment_finalization_compensation_required');
    }

    let queueCounts: {
      waiting: number;
      active: number;
      delayed: number;
      failed: number;
      paused: number;
    } | null = null;
    let queueError: string | null = null;

    try {
      const counts = await this.webhookEventsQueue.getJobCounts(
        'waiting',
        'active',
        'delayed',
        'failed',
        'paused',
      );
      queueCounts = {
        waiting: Number(counts.waiting ?? 0),
        active: Number(counts.active ?? 0),
        delayed: Number(counts.delayed ?? 0),
        failed: Number(counts.failed ?? 0),
        paused: Number(counts.paused ?? 0),
      };

      if (
        queueCounts.waiting + queueCounts.delayed >
        PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookQueueBacklogHigh
      ) {
        degradedReasons.push('payment_webhook_queue_backlog_high');
      }
      if (queueCounts.failed > 200) {
        degradedReasons.push('payment_webhook_queue_failed_jobs_high');
      }
    } catch (error) {
      queueError = this.extractErrorMessage(error);
      degradedReasons.push('payment_webhook_queue_unavailable');
    }

    const queueBacklog = queueCounts
      ? Number(queueCounts.waiting ?? 0) + Number(queueCounts.delayed ?? 0)
      : null;
    const staleOrMissingCrons = cronResults
      .filter((cron) => !cron.exists || cron.stale || cron.status === 'error')
      .map((cron) => cron.name);

    const alertContract = {
      version: PAYMENT_RUNTIME_ALERT_CONTRACT_VERSION,
      thresholds: {
        workerHeartbeatStaleSeconds: workerResult.maxAgeSeconds,
        cronHeartbeatChecks: RUNTIME_CRON_CHECKS.map((check) => ({
          name: check.name,
          maxAgeSeconds: check.maxAgeSeconds,
        })),
        webhookQueueBacklogHigh:
          PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookQueueBacklogHigh,
        webhookProcessingFailures24hHigh:
          PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookProcessingFailures24hHigh,
        openFinalizationCompensationCasesHigh:
          PAYMENT_RUNTIME_ALERT_THRESHOLDS.openFinalizationCompensationCasesHigh,
      },
      states: {
        workerHeartbeat: {
          state:
            workerResult.seen && !workerResult.stale
              ? ('ok' as const)
              : ('alert' as const),
          reason:
            workerResult.seen && !workerResult.stale
              ? null
              : workerResult.seen
                ? 'stale'
                : 'missing',
          lastHeartbeatAt: workerResult.lastHeartbeatAt,
          ageSeconds: workerResult.ageSeconds,
          maxAgeSeconds: workerResult.maxAgeSeconds,
        },
        cronHeartbeats: {
          state: staleOrMissingCrons.length === 0 ? ('ok' as const) : ('alert' as const),
          reason: staleOrMissingCrons.length === 0 ? null : 'stale_or_missing',
          staleOrMissing: staleOrMissingCrons,
        },
        webhookQueueBacklog: {
          state:
            queueBacklog != null &&
            queueBacklog <= PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookQueueBacklogHigh &&
            !queueError
              ? ('ok' as const)
              : ('alert' as const),
          reason:
            queueError ??
            (queueBacklog != null &&
            queueBacklog > PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookQueueBacklogHigh
              ? 'backlog_high'
              : null),
          backlog: queueBacklog,
          threshold: PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookQueueBacklogHigh,
        },
        webhookFailureSpike24h: {
          state:
            recentWebhookProcessingFailures24h <=
            PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookProcessingFailures24hHigh
              ? ('ok' as const)
              : ('alert' as const),
          reason:
            recentWebhookProcessingFailures24h <=
            PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookProcessingFailures24hHigh
              ? null
              : 'failure_spike',
          failures: recentWebhookProcessingFailures24h,
          threshold: PAYMENT_RUNTIME_ALERT_THRESHOLDS.webhookProcessingFailures24hHigh,
        },
        finalizationCompensation: {
          state:
            openFinalizationCompensationCases <=
            PAYMENT_RUNTIME_ALERT_THRESHOLDS.openFinalizationCompensationCasesHigh
              ? ('ok' as const)
              : ('alert' as const),
          reason:
            openFinalizationCompensationCases <=
            PAYMENT_RUNTIME_ALERT_THRESHOLDS.openFinalizationCompensationCasesHigh
              ? null
              : 'compensation_required',
          openCases: openFinalizationCompensationCases,
          threshold:
            PAYMENT_RUNTIME_ALERT_THRESHOLDS.openFinalizationCompensationCasesHigh,
        },
      },
    };

    return {
      ok: degradedReasons.length === 0,
      checkedAt: checkedAtIso,
      redis: redisResult,
      worker: workerResult,
      crons: cronResults,
      queue: {
        counts: queueCounts,
        error: queueError,
      },
      backlog: {
        pendingWebhookReceipts,
        oldestPendingWebhookAgeSeconds,
        recentWebhookProcessingFailures24h,
        staleLiveAttempts,
        openFinalizationCompensationCases,
      },
      alertContract,
      degradedReasons: Array.from(new Set(degradedReasons)),
    };
  }

  private async getRedisClient(): Promise<any> {
    return (this.webhookEventsQueue as any).client;
  }

  private safeParseObject(value: string): Record<string, unknown> | null {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }

  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
