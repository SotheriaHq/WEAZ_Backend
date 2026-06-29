import { Injectable } from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type MarketSignalAggregationIdentity = {
  userId?: string | null;
  anonymousSessionId?: string | null;
};

export type MarketSignalAggregationEvent = {
  targetType: MarketSignalTargetType;
  targetId: string;
  signalType: MarketSignalType;
  surface: MarketSignalSurface;
  sectionKey?: string | null;
  suggestionBlockKey?: string | null;
};

export type MarketSignalAggregationResult = {
  bucketsUpdated: number;
  eventsAggregated: number;
  mode: 'synchronous-db';
};

export type MarketSignalAggregateRebuildOptions = {
  bucketDate: Date;
  batchSize?: number;
};

export type MarketSignalAggregateRebuildResult = {
  bucketsUpserted: number;
  eventsRead: number;
  batchesRead: number;
  mode: 'date-scoped-rebuild';
};

type AggregateCounters = {
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

type AggregateBucket = {
  aggregateKey: string;
  bucketDate: Date;
  userId: string | null;
  anonymousSessionId: string | null;
  surface: MarketSignalSurface;
  sectionKey: string | null;
  suggestionBlockKey: string | null;
  targetType: MarketSignalTargetType;
  targetId: string;
  counters: AggregateCounters;
};

const SEEN_SIGNAL_TYPES = new Set<MarketSignalType>([
  MarketSignalType.ITEM_IMPRESSION,
  MarketSignalType.ITEM_VIEW,
  MarketSignalType.IMPRESSION,
  MarketSignalType.VIEW,
  MarketSignalType.OPEN,
  MarketSignalType.PRODUCT_VIEW,
  MarketSignalType.SUGGESTION_ITEM_VIEW,
]);

const ITEM_TARGET_TYPES = new Set<MarketSignalTargetType>([
  MarketSignalTargetType.PRODUCT,
  MarketSignalTargetType.COLLECTION,
  MarketSignalTargetType.DESIGN,
  MarketSignalTargetType.BRAND,
  MarketSignalTargetType.CATEGORY,
]);

const DEFAULT_REBUILD_BATCH_SIZE = 500;
const MAX_REBUILD_BATCH_SIZE = 1000;

@Injectable()
export class MarketSignalAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregateBatch(
    events: MarketSignalAggregationEvent[],
    identity: MarketSignalAggregationIdentity,
    observedAt = new Date(),
  ): Promise<MarketSignalAggregationResult> {
    if (events.length === 0) {
      return { bucketsUpdated: 0, eventsAggregated: 0, mode: 'synchronous-db' };
    }

    const bucketDate = this.toUtcBucketDate(observedAt);
    const buckets = new Map<string, AggregateBucket>();

    for (const event of events) {
      this.addEventToBuckets(buckets, event, identity, bucketDate, observedAt);
      this.addEventToBuckets(
        buckets,
        event,
        { userId: null, anonymousSessionId: null },
        bucketDate,
        observedAt,
        'global',
      );
    }

    for (const bucket of buckets.values()) {
      await this.prisma.marketSignalAggregateDaily.upsert({
        where: { aggregateKey: bucket.aggregateKey },
        create: {
          aggregateKey: bucket.aggregateKey,
          bucketDate: bucket.bucketDate,
          userId: bucket.userId,
          anonymousSessionId: bucket.anonymousSessionId,
          surface: bucket.surface,
          sectionKey: bucket.sectionKey,
          suggestionBlockKey: bucket.suggestionBlockKey,
          targetType: bucket.targetType,
          targetId: bucket.targetId,
          ...bucket.counters,
        },
        update: this.buildCounterUpdate(bucket.counters),
      });
    }

    return {
      bucketsUpdated: buckets.size,
      eventsAggregated: events.length,
      mode: 'synchronous-db',
    };
  }

  async rebuildDailyAggregatesFromStoredSignals(
    options: MarketSignalAggregateRebuildOptions,
  ): Promise<MarketSignalAggregateRebuildResult> {
    const bucketDate = this.toUtcBucketDate(options.bucketDate);
    const nextBucketDate = new Date(bucketDate.getTime() + 24 * 60 * 60 * 1000);
    const batchSize = this.normalizeRebuildBatchSize(options.batchSize);
    const buckets = new Map<string, AggregateBucket>();
    let cursorId: string | undefined;
    let eventsRead = 0;
    let batchesRead = 0;

    for (;;) {
      const rows = await this.prisma.userFeedSignal.findMany({
        where: {
          createdAt: {
            gte: bucketDate,
            lt: nextBucketDate,
          },
        },
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        select: {
          id: true,
          userId: true,
          anonymousSessionId: true,
          targetType: true,
          targetId: true,
          signalType: true,
          surface: true,
          sectionKey: true,
          suggestionBlockKey: true,
          createdAt: true,
        },
      });

      if (rows.length === 0) break;
      batchesRead += 1;
      eventsRead += rows.length;

      for (const row of rows) {
        const event = {
          targetType: row.targetType,
          targetId: row.targetId,
          signalType: row.signalType,
          surface: row.surface ?? MarketSignalSurface.MARKET_HOME,
          sectionKey: row.sectionKey,
          suggestionBlockKey: row.suggestionBlockKey,
        };
        const identity = row.userId
          ? { userId: row.userId, anonymousSessionId: null }
          : { userId: null, anonymousSessionId: row.anonymousSessionId };
        this.addEventToBuckets(
          buckets,
          event,
          identity,
          bucketDate,
          row.createdAt,
        );
        this.addEventToBuckets(
          buckets,
          event,
          { userId: null, anonymousSessionId: null },
          bucketDate,
          row.createdAt,
          'global',
        );
      }

      cursorId = rows[rows.length - 1]?.id;
      if (rows.length < batchSize) break;
    }

    for (const bucket of buckets.values()) {
      await this.prisma.marketSignalAggregateDaily.upsert({
        where: { aggregateKey: bucket.aggregateKey },
        create: {
          aggregateKey: bucket.aggregateKey,
          bucketDate: bucket.bucketDate,
          userId: bucket.userId,
          anonymousSessionId: bucket.anonymousSessionId,
          surface: bucket.surface,
          sectionKey: bucket.sectionKey,
          suggestionBlockKey: bucket.suggestionBlockKey,
          targetType: bucket.targetType,
          targetId: bucket.targetId,
          ...bucket.counters,
        },
        update: this.buildCounterSet(bucket.counters),
      });
    }

    return {
      bucketsUpserted: buckets.size,
      eventsRead,
      batchesRead,
      mode: 'date-scoped-rebuild',
    };
  }

  private buildCounterUpdate(
    counters: AggregateCounters,
  ): Prisma.MarketSignalAggregateDailyUpdateInput {
    const update: Prisma.MarketSignalAggregateDailyUpdateInput = {
      eventCount: { increment: counters.eventCount },
    };
    if (counters.sectionImpressions) {
      update.sectionImpressions = { increment: counters.sectionImpressions };
    }
    if (counters.itemImpressions) {
      update.itemImpressions = { increment: counters.itemImpressions };
    }
    if (counters.productOpens) {
      update.productOpens = { increment: counters.productOpens };
    }
    if (counters.itemOpens) {
      update.itemOpens = { increment: counters.itemOpens };
    }
    if (counters.clicks) update.clicks = { increment: counters.clicks };
    if (counters.viewAllClicks) {
      update.viewAllClicks = { increment: counters.viewAllClicks };
    }
    if (counters.suppressions) {
      update.suppressions = { increment: counters.suppressions };
    }
    if (counters.seenItems)
      update.seenItems = { increment: counters.seenItems };
    if (counters.latestSeenAt) update.latestSeenAt = counters.latestSeenAt;
    return update;
  }

  private buildCounterSet(
    counters: AggregateCounters,
  ): Prisma.MarketSignalAggregateDailyUpdateInput {
    return {
      sectionImpressions: counters.sectionImpressions,
      itemImpressions: counters.itemImpressions,
      productOpens: counters.productOpens,
      itemOpens: counters.itemOpens,
      clicks: counters.clicks,
      viewAllClicks: counters.viewAllClicks,
      suppressions: counters.suppressions,
      seenItems: counters.seenItems,
      eventCount: counters.eventCount,
      latestSeenAt: counters.latestSeenAt,
    };
  }

  private addEventToBuckets(
    buckets: Map<string, AggregateBucket>,
    event: MarketSignalAggregationEvent,
    identity: MarketSignalAggregationIdentity,
    bucketDate: Date,
    observedAt: Date,
    ownerOverride?: 'global',
  ) {
    const aggregateKey = this.buildAggregateKey(
      event,
      identity,
      bucketDate,
      ownerOverride,
    );
    const existing = buckets.get(aggregateKey);
    if (existing) {
      this.addCounters(existing.counters, event, observedAt);
      return;
    }

    const counters = this.emptyCounters();
    this.addCounters(counters, event, observedAt);
    buckets.set(aggregateKey, {
      aggregateKey,
      bucketDate,
      userId: ownerOverride === 'global' ? null : (identity.userId ?? null),
      anonymousSessionId:
        ownerOverride === 'global' || identity.userId
          ? null
          : (identity.anonymousSessionId ?? null),
      surface: event.surface,
      sectionKey: event.sectionKey ?? null,
      suggestionBlockKey: event.suggestionBlockKey ?? null,
      targetType: event.targetType,
      targetId: event.targetId,
      counters,
    });
  }

  private addCounters(
    counters: AggregateCounters,
    event: MarketSignalAggregationEvent,
    observedAt: Date,
  ) {
    counters.eventCount += 1;

    if (
      event.signalType === MarketSignalType.SECTION_VIEW ||
      event.signalType === MarketSignalType.MARKET_SECTION_VIEW ||
      (event.targetType === MarketSignalTargetType.SECTION &&
        (event.signalType === MarketSignalType.IMPRESSION ||
          event.signalType === MarketSignalType.ITEM_IMPRESSION ||
          event.signalType === MarketSignalType.VIEW))
    ) {
      counters.sectionImpressions += 1;
    }

    if (
      (event.signalType === MarketSignalType.IMPRESSION ||
        event.signalType === MarketSignalType.ITEM_IMPRESSION ||
        event.signalType === MarketSignalType.SUGGESTION_ITEM_VIEW) &&
      ITEM_TARGET_TYPES.has(event.targetType)
    ) {
      counters.itemImpressions += 1;
    }

    if (
      event.signalType === MarketSignalType.OPEN ||
      event.signalType === MarketSignalType.ITEM_VIEW ||
      event.signalType === MarketSignalType.PRODUCT_VIEW
    ) {
      counters.itemOpens += 1;
      if (event.targetType === MarketSignalTargetType.PRODUCT) {
        counters.productOpens += 1;
      }
    }

    if (
      event.signalType === MarketSignalType.CLICK ||
      event.signalType === MarketSignalType.ITEM_CLICK ||
      event.signalType === MarketSignalType.SUGGESTION_ITEM_CLICK
    ) {
      counters.clicks += 1;
    }

    if (
      event.signalType === MarketSignalType.SECTION_VIEW_ALL_CLICK ||
      event.signalType === MarketSignalType.VIEW_ALL_CLICK ||
      event.signalType === MarketSignalType.MARKET_SECTION_VIEW_ALL_CLICK ||
      event.signalType === MarketSignalType.SUGGESTION_VIEW_ALL_CLICK
    ) {
      counters.viewAllClicks += 1;
    }

    if (
      event.signalType === MarketSignalType.HIDE ||
      event.signalType === MarketSignalType.NOT_INTERESTED ||
      event.signalType === MarketSignalType.MARKET_SECTION_DISMISS ||
      event.signalType === MarketSignalType.SUGGESTION_ITEM_HIDE ||
      event.signalType === MarketSignalType.SUGGESTION_BLOCK_HIDE
    ) {
      counters.suppressions += 1;
    }

    if (
      SEEN_SIGNAL_TYPES.has(event.signalType) &&
      ITEM_TARGET_TYPES.has(event.targetType)
    ) {
      counters.seenItems += 1;
      counters.latestSeenAt = observedAt;
    }
  }

  private emptyCounters(): AggregateCounters {
    return {
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

  private buildAggregateKey(
    event: MarketSignalAggregationEvent,
    identity: MarketSignalAggregationIdentity,
    bucketDate: Date,
    ownerOverride?: 'global',
  ) {
    const owner =
      ownerOverride === 'global'
        ? 'global'
        : identity.userId
          ? `user:${identity.userId}`
          : `anon:${identity.anonymousSessionId ?? 'none'}`;
    return [
      bucketDate.toISOString().slice(0, 10),
      owner,
      event.surface,
      event.sectionKey ?? '',
      event.suggestionBlockKey ?? '',
      event.targetType,
      event.targetId,
    ].join('|');
  }

  private normalizeRebuildBatchSize(value?: number) {
    if (!Number.isFinite(value)) return DEFAULT_REBUILD_BATCH_SIZE;
    return Math.min(
      MAX_REBUILD_BATCH_SIZE,
      Math.max(1, Math.floor(value as number)),
    );
  }

  private toUtcBucketDate(value: Date) {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }
}
