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
      const aggregateKey = this.buildAggregateKey(event, identity, bucketDate);
      const existing = buckets.get(aggregateKey);
      if (existing) {
        this.addCounters(existing.counters, event, observedAt);
        continue;
      }

      const counters = this.emptyCounters();
      this.addCounters(counters, event, observedAt);
      buckets.set(aggregateKey, {
        aggregateKey,
        bucketDate,
        userId: identity.userId ?? null,
        anonymousSessionId: identity.userId
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

  private addCounters(
    counters: AggregateCounters,
    event: MarketSignalAggregationEvent,
    observedAt: Date,
  ) {
    counters.eventCount += 1;

    if (
      event.signalType === MarketSignalType.MARKET_SECTION_VIEW ||
      (event.targetType === MarketSignalTargetType.SECTION &&
        (event.signalType === MarketSignalType.IMPRESSION ||
          event.signalType === MarketSignalType.VIEW))
    ) {
      counters.sectionImpressions += 1;
    }

    if (
      (event.signalType === MarketSignalType.IMPRESSION ||
        event.signalType === MarketSignalType.SUGGESTION_ITEM_VIEW) &&
      ITEM_TARGET_TYPES.has(event.targetType)
    ) {
      counters.itemImpressions += 1;
    }

    if (
      event.signalType === MarketSignalType.OPEN ||
      event.signalType === MarketSignalType.PRODUCT_VIEW
    ) {
      counters.itemOpens += 1;
      if (event.targetType === MarketSignalTargetType.PRODUCT) {
        counters.productOpens += 1;
      }
    }

    if (
      event.signalType === MarketSignalType.CLICK ||
      event.signalType === MarketSignalType.SUGGESTION_ITEM_CLICK
    ) {
      counters.clicks += 1;
    }

    if (
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
  ) {
    const owner = identity.userId
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

  private toUtcBucketDate(value: Date) {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }
}
