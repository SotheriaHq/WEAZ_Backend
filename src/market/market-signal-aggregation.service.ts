import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { lockSecurityAccount } from '../auth/access/lock-security-account';
import { MARKET_SIGNAL_MAX_BATCH_EVENTS } from './dto/market-signal.dto';
import { createHash } from 'node:crypto';

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

/** Account erasure and telemetry share one bounded database unit of work. */
export function withMarketSignalTransaction<T>(
  prisma: PrismaService,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SET LOCAL lock_timeout = '250ms'`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '1500ms'`;
      return work(tx);
    },
    {
      maxWait: 500,
      timeout: 5_000,
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
    },
  );
}

@Injectable()
export class MarketSignalAggregationService {
  constructor(private readonly prisma: PrismaService) {}

  async aggregateBatch(
    events: MarketSignalAggregationEvent[],
    identity: MarketSignalAggregationIdentity,
    observedAt = new Date(),
    transaction?: Prisma.TransactionClient,
  ): Promise<MarketSignalAggregationResult> {
    if (
      events.length > MARKET_SIGNAL_MAX_BATCH_EVENTS ||
      !Number.isFinite(observedAt.getTime())
    )
      throw new RangeError('Invalid Market signal aggregate batch');
    if (events.length === 0) {
      return { bucketsUpdated: 0, eventsAggregated: 0, mode: 'synchronous-db' };
    }
    return transaction
      ? this.aggregateInTransaction(events, identity, observedAt, transaction)
      : withMarketSignalTransaction(this.prisma, (tx) =>
          this.aggregateInTransaction(events, identity, observedAt, tx),
        );
  }

  private async aggregateInTransaction(
    events: MarketSignalAggregationEvent[],
    identity: MarketSignalAggregationIdentity,
    observedAt: Date,
    client: Prisma.TransactionClient,
  ): Promise<MarketSignalAggregationResult> {
    if (events.length === 0) {
      return { bucketsUpdated: 0, eventsAggregated: 0, mode: 'synchronous-db' };
    }

    const bucketDate = this.toUtcBucketDate(observedAt);
    const buckets = new Map<string, AggregateBucket>();
    if (identity.userId) {
      await lockSecurityAccount(client, identity.userId);
      const actor = await client.user.findUnique({
        where: { id: identity.userId },
        select: { status: true, deactivatedAt: true },
      });
      if (!actor || actor.status !== 'ACTIVE' || actor.deactivatedAt !== null)
        throw new ForbiddenException(
          'Inactive accounts cannot contribute Market signals',
        );
    }

    for (const event of events) {
      this.addEventToBuckets(buckets, event, bucketDate, observedAt);
    }

    // One parameterized statement increments every global bucket. Ordering the
    // inserts inside PostgreSQL gives all accounts the same row-lock order.
    const ordered = [...buckets.values()].sort((a, b) =>
      a.aggregateKey < b.aggregateKey
        ? -1
        : a.aggregateKey > b.aggregateKey
          ? 1
          : 0,
    );
    const rows = ordered.map((bucket) => ({
      aggregateKey: bucket.aggregateKey,
      bucketDate: bucket.bucketDate.toISOString(),
      surface: bucket.surface,
      sectionKey: bucket.sectionKey,
      suggestionBlockKey: bucket.suggestionBlockKey,
      targetType: bucket.targetType,
      targetId: bucket.targetId,
      ...bucket.counters,
      latestSeenAt: bucket.counters.latestSeenAt?.toISOString() ?? null,
    }));
    await client.$executeRaw(Prisma.sql`INSERT INTO market_signal_aggregate_daily (
      "_id","aggregateKey","bucketDate","surface","sectionKey","suggestionBlockKey","targetType","targetId",
      "sectionImpressions","itemImpressions","productOpens","itemOpens",clicks,"viewAllClicks",suppressions,"seenItems","eventCount","latestSeenAt","updatedAt")
      SELECT gen_random_uuid(),input."aggregateKey",input."bucketDate",input.surface::"MarketSignalSurface",input."sectionKey",input."suggestionBlockKey",input."targetType"::"MarketSignalTargetType",input."targetId",
        input."sectionImpressions",input."itemImpressions",input."productOpens",input."itemOpens",input.clicks,input."viewAllClicks",input.suppressions,input."seenItems",input."eventCount",input."latestSeenAt",statement_timestamp()
      FROM jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) AS input("aggregateKey" text,"bucketDate" timestamptz,surface text,"sectionKey" text,"suggestionBlockKey" text,"targetType" text,"targetId" text,
        "sectionImpressions" integer,"itemImpressions" integer,"productOpens" integer,"itemOpens" integer,clicks integer,"viewAllClicks" integer,suppressions integer,"seenItems" integer,"eventCount" integer,"latestSeenAt" timestamptz)
      ORDER BY input."aggregateKey" COLLATE "C"
      ON CONFLICT("aggregateKey") DO UPDATE SET
        "sectionImpressions"=market_signal_aggregate_daily."sectionImpressions"+EXCLUDED."sectionImpressions",
        "itemImpressions"=market_signal_aggregate_daily."itemImpressions"+EXCLUDED."itemImpressions",
        "productOpens"=market_signal_aggregate_daily."productOpens"+EXCLUDED."productOpens",
        "itemOpens"=market_signal_aggregate_daily."itemOpens"+EXCLUDED."itemOpens",
        clicks=market_signal_aggregate_daily.clicks+EXCLUDED.clicks,
        "viewAllClicks"=market_signal_aggregate_daily."viewAllClicks"+EXCLUDED."viewAllClicks",
        suppressions=market_signal_aggregate_daily.suppressions+EXCLUDED.suppressions,
        "seenItems"=market_signal_aggregate_daily."seenItems"+EXCLUDED."seenItems",
        "eventCount"=market_signal_aggregate_daily."eventCount"+EXCLUDED."eventCount",
        "latestSeenAt"=GREATEST(market_signal_aggregate_daily."latestSeenAt",EXCLUDED."latestSeenAt"),
        "updatedAt"=statement_timestamp()`);

    return {
      bucketsUpdated: buckets.size,
      eventsAggregated: events.length,
      mode: 'synchronous-db',
    };
  }

  async rebuildDailyAggregatesFromStoredSignals(
    options: MarketSignalAggregateRebuildOptions,
  ): Promise<MarketSignalAggregateRebuildResult> {
    // A closed UTC day cannot remain wholly inside a rolling 24-hour source
    // window once a rebuild starts. Replacing totals would also lose concurrent
    // incremental contributions. Retain the endpoint, but require an audited
    // complete, anonymized source before implementing a replacement rebuild.
    void options;
    throw new ServiceUnavailableException(
      'A complete daily source window is unavailable under R1; retained global totals are preserved',
    );
  }

  private addEventToBuckets(
    buckets: Map<string, AggregateBucket>,
    event: MarketSignalAggregationEvent,
    bucketDate: Date,
    observedAt: Date,
  ) {
    const aggregateKey = this.buildAggregateKey(event, bucketDate);
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
      userId: null,
      anonymousSessionId: null,
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
    bucketDate: Date,
  ) {
    const day = bucketDate.toISOString().slice(0, 10);
    const tuple = [
      day,
      event.surface,
      event.sectionKey ?? null,
      event.suggestionBlockKey ?? null,
      event.targetType,
      event.targetId,
    ];
    // Delimiters inside a section, block or target cannot alias another tuple.
    // Existing totals remain untouched and readers group their explicit columns.
    return `${day}|global|v2|${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
  }

  private toUtcBucketDate(value: Date) {
    return new Date(
      Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
    );
  }
}
