import { Injectable, Logger } from '@nestjs/common';
import { MarketSignalTargetType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type MarketRankingAggregateTarget = {
  targetType: MarketSignalTargetType;
  targetId: string;
};

export type MarketRankingAggregateStats = {
  targetType: MarketSignalTargetType;
  targetId: string;
  sectionImpressions: number;
  itemImpressions: number;
  productOpens: number;
  itemOpens: number;
  clicks: number;
  viewAllClicks: number;
  suppressions: number;
  seenItems: number;
  eventCount: number;
  latestSeenAt: Date | null;
};

export type MarketRankingAggregateReadResult = {
  ok: boolean;
  timedOut: boolean;
  fallbackReason: string | null;
  durationMs: number;
  aggregates: Map<string, MarketRankingAggregateStats>;
};

export type MarketRankingAggregateReadOptions = {
  sectionKey: string;
  targets: MarketRankingAggregateTarget[];
  lookbackDays?: number;
  timeoutMs: number;
  requestId?: string | null;
};

const DEFAULT_LOOKBACK_DAYS = 14;
const MAX_TARGETS = 80;

@Injectable()
export class MarketRankingAggregateReaderService {
  private readonly logger = new Logger(MarketRankingAggregateReaderService.name);

  constructor(private readonly prisma: PrismaService) {}

  async readItemAggregates(
    options: MarketRankingAggregateReadOptions,
  ): Promise<MarketRankingAggregateReadResult> {
    const startedAt = Date.now();
    const targets = this.normalizeTargets(options.targets);
    if (targets.length === 0) {
      return this.success(new Map(), startedAt);
    }

    const timeoutMs = this.normalizeTimeout(options.timeoutMs);
    const lookbackStart = this.buildLookbackStart(options.lookbackDays);

    try {
      const rows = await this.withTimeout(
        this.prisma.marketSignalAggregateDaily.findMany({
          where: {
            bucketDate: { gte: lookbackStart },
            targetType: { in: [...new Set(targets.map((target) => target.targetType))] },
            targetId: { in: [...new Set(targets.map((target) => target.targetId))] },
            OR: [{ sectionKey: options.sectionKey }, { sectionKey: null }],
          },
          select: {
            targetType: true,
            targetId: true,
            sectionImpressions: true,
            itemImpressions: true,
            productOpens: true,
            itemOpens: true,
            clicks: true,
            viewAllClicks: true,
            suppressions: true,
            seenItems: true,
            eventCount: true,
            latestSeenAt: true,
          },
        }),
        timeoutMs,
      );

      if (rows === 'timeout') {
        const durationMs = Date.now() - startedAt;
        this.log('aggregate-read-timeout', {
          sectionKey: options.sectionKey,
          requestId: options.requestId,
          candidateCount: targets.length,
          durationMs,
        });
        return this.fallback('aggregate-timeout', true, startedAt);
      }

      const targetKeys = new Set(
        targets.map((target) => this.aggregateKey(target.targetType, target.targetId)),
      );
      const aggregates = new Map<string, MarketRankingAggregateStats>();

      for (const row of rows) {
        if (!row.targetType || !row.targetId) continue;
        const key = this.aggregateKey(row.targetType, row.targetId);
        if (!targetKeys.has(key)) continue;
        const current = aggregates.get(key) ?? this.emptyStats(row.targetType, row.targetId);
        current.sectionImpressions += row.sectionImpressions ?? 0;
        current.itemImpressions += row.itemImpressions ?? 0;
        current.productOpens += row.productOpens ?? 0;
        current.itemOpens += row.itemOpens ?? 0;
        current.clicks += row.clicks ?? 0;
        current.viewAllClicks += row.viewAllClicks ?? 0;
        current.suppressions += row.suppressions ?? 0;
        current.seenItems += row.seenItems ?? 0;
        current.eventCount += row.eventCount ?? 0;
        if (
          row.latestSeenAt &&
          (!current.latestSeenAt || row.latestSeenAt > current.latestSeenAt)
        ) {
          current.latestSeenAt = row.latestSeenAt;
        }
        aggregates.set(key, current);
      }

      this.log('aggregate-read-success', {
        sectionKey: options.sectionKey,
        requestId: options.requestId,
        candidateCount: targets.length,
        aggregateCount: aggregates.size,
        durationMs: Date.now() - startedAt,
      });

      return this.success(aggregates, startedAt);
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      this.log('aggregate-read-failed', {
        sectionKey: options.sectionKey,
        requestId: options.requestId,
        candidateCount: targets.length,
        durationMs,
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return this.fallback('aggregate-read-failed', false, startedAt);
    }
  }

  aggregateKey(targetType: MarketSignalTargetType, targetId: string) {
    return `${targetType}:${targetId}`;
  }

  private normalizeTargets(targets: MarketRankingAggregateTarget[]) {
    const seen = new Set<string>();
    const normalized: MarketRankingAggregateTarget[] = [];
    for (const target of targets) {
      if (!target.targetId) continue;
      const key = this.aggregateKey(target.targetType, target.targetId);
      if (seen.has(key)) continue;
      seen.add(key);
      normalized.push(target);
      if (normalized.length >= MAX_TARGETS) break;
    }
    return normalized;
  }

  private normalizeTimeout(timeoutMs: number) {
    if (!Number.isFinite(timeoutMs)) return 150;
    return Math.min(500, Math.max(25, Math.floor(timeoutMs)));
  }

  private buildLookbackStart(lookbackDays = DEFAULT_LOOKBACK_DAYS) {
    const days = Math.min(30, Math.max(1, Math.floor(lookbackDays)));
    const value = new Date();
    value.setUTCDate(value.getUTCDate() - days);
    return value;
  }

  private withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | 'timeout'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });
    return Promise.race([
      promise.finally(() => {
        if (timer) clearTimeout(timer);
      }),
      timeout,
    ]);
  }

  private emptyStats(
    targetType: MarketSignalTargetType,
    targetId: string,
  ): MarketRankingAggregateStats {
    return {
      targetType,
      targetId,
      sectionImpressions: 0,
      itemImpressions: 0,
      productOpens: 0,
      itemOpens: 0,
      clicks: 0,
      viewAllClicks: 0,
      suppressions: 0,
      seenItems: 0,
      eventCount: 0,
      latestSeenAt: null,
    };
  }

  private success(
    aggregates: Map<string, MarketRankingAggregateStats>,
    startedAt: number,
  ): MarketRankingAggregateReadResult {
    return {
      ok: true,
      timedOut: false,
      fallbackReason: null,
      durationMs: Date.now() - startedAt,
      aggregates,
    };
  }

  private fallback(
    fallbackReason: string,
    timedOut: boolean,
    startedAt: number,
  ): MarketRankingAggregateReadResult {
    return {
      ok: false,
      timedOut,
      fallbackReason,
      durationMs: Date.now() - startedAt,
      aggregates: new Map(),
    };
  }

  private log(event: string, payload: Record<string, unknown>) {
    this.logger.debug(JSON.stringify({ event, ...payload }));
  }
}
