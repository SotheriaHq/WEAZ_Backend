import { Injectable } from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { PaymentRuntimeHealthService } from 'src/payment/payment-runtime-health.service';

export type ReadinessCheckName = 'database' | 'redis' | 'worker';

export type ReadinessCheckResult = {
  name: ReadinessCheckName;
  ok: boolean;
  latencyMs: number | null;
  detail: string | null;
};

export type ReadinessResponse = {
  status: 'ready' | 'degraded';
  service: string;
  timestamp: string;
  checks: ReadinessCheckResult[];
};

@Injectable()
export class ReadinessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly paymentRuntimeHealth: PaymentRuntimeHealthService,
  ) {}

  async getReadiness(): Promise<ReadinessResponse> {
    const [database, runtime] = await Promise.all([
      this.checkDatabase(),
      this.paymentRuntimeHealth.getRuntimeHealth(),
    ]);

    const redis: ReadinessCheckResult = {
      name: 'redis',
      ok: runtime.redis.ready,
      latencyMs: runtime.redis.pingMs,
      detail: runtime.redis.error,
    };

    const worker: ReadinessCheckResult = {
      name: 'worker',
      ok: runtime.worker.seen && !runtime.worker.stale,
      latencyMs: null,
      detail: runtime.worker.seen
        ? runtime.worker.stale
          ? `Worker heartbeat stale (${runtime.worker.ageSeconds ?? 'unknown'}s)`
          : null
        : 'Worker heartbeat not seen',
    };

    const checks = [database, redis, worker];
    const allOk = checks.every((check) => check.ok);

    return {
      status: allOk ? 'ready' : 'degraded',
      service: 'wiez-backend',
      timestamp: new Date().toISOString(),
      checks,
    };
  }

  private async checkDatabase(): Promise<ReadinessCheckResult> {
    const started = Date.now();
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return {
        name: 'database',
        ok: true,
        latencyMs: Date.now() - started,
        detail: null,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Database check failed';
      return {
        name: 'database',
        ok: false,
        latencyMs: Date.now() - started,
        detail: message,
      };
    }
  }
}