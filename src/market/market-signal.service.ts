import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import {
  MarketSignalSurface,
  MarketSignalTargetType,
  MarketSignalType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  MARKET_SIGNAL_MAX_BATCH_EVENTS,
  MARKET_SIGNAL_MAX_METADATA_BYTES,
  MARKET_SIGNAL_MAX_SCREEN_CONTEXT_LENGTH,
  MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
  MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
  MarketSignalBatchDto,
  MarketSignalEventDto,
} from './dto/market-signal.dto';
import {
  MarketSignalAggregationResult,
  MarketSignalAggregationService,
  withMarketSignalTransaction,
} from './market-signal-aggregation.service';
import { MonitoringService } from 'src/monitoring/monitoring.service';
import { lockSecurityAccount } from '../auth/access/lock-security-account';
import { lockForTransaction } from '../common/transaction-lock.util';

export interface MarketSignalIdentity {
  userId?: string | null;
  anonymousSessionId?: string | null;
}

type ResolvedMarketSignalIdentity = {
  userId: string | null;
  anonymousSessionId: string | null;
};

type NormalizedMarketSignalEvent = Omit<
  MarketSignalEventDto,
  | 'targetId'
  | 'clientEventId'
  | 'sectionKey'
  | 'suggestionBlockKey'
  | 'screenContext'
  | 'sessionId'
  | 'value'
  | 'position'
> & {
  targetId: string;
  clientEventId: string;
  sectionKey: string | null;
  suggestionBlockKey: string | null;
  screenContext: string | null;
  sessionId: string | null;
  value: number | null;
  position: number | null;
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

type PersistedCounts = {
  userFeedSignals: number;
  seenItems: number;
  marketSectionSignals: number;
  suggestionSignals: number;
};

type MarketSignalCreateManyResult = {
  count?: number;
};

@Injectable()
export class MarketSignalService {
  private readonly logger = new Logger(MarketSignalService.name);
  private readonly duplicateReplayWindowMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly aggregationService?: MarketSignalAggregationService,
    @Optional()
    private readonly monitoring?: MonitoringService,
  ) {}

  async ingestBatch(dto: MarketSignalBatchDto, identity: MarketSignalIdentity) {
    const userId = this.cleanToken(
      identity.userId,
      'userId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const anonymousSessionId = this.cleanToken(
      userId
        ? undefined
        : (identity.anonymousSessionId ?? dto.anonymousSessionId),
      'anonymousSessionId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );

    if (!userId && !anonymousSessionId) {
      throw new BadRequestException(
        'anonymousSessionId is required for guest signal batches',
      );
    }

    const events = Array.isArray(dto.events) ? dto.events : [];
    if (events.length > MARKET_SIGNAL_MAX_BATCH_EVENTS) {
      this.emitRankingAlert('market_signal_batch_oversized', 'warning', {
        received: events.length,
        max: MARKET_SIGNAL_MAX_BATCH_EVENTS,
        actorType: userId ? 'USER' : 'ANONYMOUS',
      });
      throw new BadRequestException(
        `Signal batch cannot exceed ${MARKET_SIGNAL_MAX_BATCH_EVENTS} events`,
      );
    }

    const batchId = this.cleanToken(
      dto.batchId,
      'batchId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    const defaultSessionId = this.cleanToken(
      dto.sessionId,
      'sessionId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    return withMarketSignalTransaction(this.prisma, (client) =>
      this.ingestInTransaction(
        events,
        { userId, anonymousSessionId },
        batchId,
        defaultSessionId,
        client,
      ),
    );
  }

  private async ingestInTransaction(
    events: MarketSignalEventDto[],
    identity: ResolvedMarketSignalIdentity,
    batchId: string | null,
    defaultSessionId: string | null,
    client: Prisma.TransactionClient,
  ) {
    const { userId, anonymousSessionId } = identity;
    if (userId) {
      await lockSecurityAccount(client, userId);

      const actor = await client.user.findUnique({
        where: { id: userId },
        select: { status: true, deactivatedAt: true },
      });
      if (!actor || actor.status !== 'ACTIVE' || actor.deactivatedAt !== null)
        throw new ForbiddenException(
          'Inactive accounts cannot submit Market signals',
        );
    } else {
      // Serialize only this device identity so concurrent retries cannot claim
      // each other's same-millisecond canonical insert during reconciliation.
      await lockForTransaction(
        client,
        `market-signal-ingest:${anonymousSessionId}`,
      );
    }

    const now = new Date();
    const existingBatchReceipt = batchId
      ? await this.findBatchReceipt(
          client,
          userId,
          anonymousSessionId,
          batchId,
          now,
        )
      : null;
    if (existingBatchReceipt) {
      this.emitRankingAlert('market_signal_duplicate_batch_replay', 'info', {
        batchId,
        received: events.length,
        actorType: userId ? 'USER' : 'ANONYMOUS',
      });
      return {
        accepted: true,
        duplicate: true,
        batchId,
        received: existingBatchReceipt.received,
        persisted: this.toPersistedCounts(existingBatchReceipt.persisted),
        deduplicated: events.length,
        aggregation: {
          mode: 'synchronous-db',
          status: 'skipped-duplicate-batch',
          eventsAggregated: 0,
          bucketsUpdated: 0,
        },
      };
    }

    const normalizedEvents = this.normalizeEventsForIdempotency(
      events,
      defaultSessionId,
    );
    const existingClientEventIds = await this.getExistingClientEventIds(
      client,
      normalizedEvents
        .map((event) => event.clientEventId)
        .filter((value): value is string => Boolean(value)),
      userId,
      anonymousSessionId,
      now,
    );
    const acceptedEvents = normalizedEvents.filter(
      (event) => !existingClientEventIds.has(event.clientEventId),
    );

    const canonical = await this.persistCanonicalEvents(
      client,
      acceptedEvents,
      { userId, anonymousSessionId },
      batchId,
      now,
    );
    const projectionRows = this.buildProjectionRows(
      canonical.insertedEvents,
      { userId, anonymousSessionId },
      batchId,
      now,
    );
    const projectionCounts = await this.persistProjectionRows(
      client,
      projectionRows,
    );

    const persisted: PersistedCounts = {
      userFeedSignals: canonical.persistedCount,
      ...projectionCounts,
    };

    const aggregation = await this.aggregateAcceptedEvents(
      canonical.insertedEvents,
      { userId, anonymousSessionId },
      now,
      client,
    );

    if (batchId) {
      await this.createBatchReceipt(
        client,
        userId,
        anonymousSessionId,
        batchId,
        {
          received: events.length,
          persisted,
        },
      );
    }

    return {
      accepted: true,
      batchId,
      received: events.length,
      persisted,
      deduplicated: events.length - canonical.insertedEvents.length,
      aggregation,
    };
  }

  private async persistCanonicalEvents(
    client: Prisma.TransactionClient,
    events: NormalizedMarketSignalEvent[],
    identity: ResolvedMarketSignalIdentity,
    batchId: string | null,
    now: Date,
  ) {
    if (events.length === 0) {
      return { insertedEvents: [], persistedCount: 0 };
    }

    const data = events.map((event) => ({
      ...this.buildCommonSignalInput(event, identity, batchId, now),
      targetType: event.targetType,
      targetId: event.targetId,
      sectionKey: event.sectionKey,
      suggestionBlockKey: event.suggestionBlockKey,
      position: event.position,
    }));

    const result = (await client.userFeedSignal.createMany({
      data,
      skipDuplicates: true,
    })) as MarketSignalCreateManyResult;
    const persistedCount = this.toCount(result?.count);
    if (persistedCount === events.length) {
      return { insertedEvents: events, persistedCount };
    }

    const insertedClientEventIds = await this.getClientEventIdsCreatedAt(
      client,
      events.map((event) => event.clientEventId),
      identity.userId,
      identity.anonymousSessionId,
      now,
    );
    return {
      insertedEvents: events.filter((event) =>
        insertedClientEventIds.has(event.clientEventId),
      ),
      persistedCount,
    };
  }

  private buildProjectionRows(
    events: NormalizedMarketSignalEvent[],
    identity: ResolvedMarketSignalIdentity,
    batchId: string | null,
    now: Date,
  ) {
    const seenItems: Prisma.UserSeenItemCreateManyInput[] = [];
    const marketSectionSignals: Prisma.MarketSectionSignalCreateManyInput[] =
      [];
    const suggestionSignals: Prisma.SuggestionSignalCreateManyInput[] = [];

    for (const event of events) {
      const common = this.buildCommonSignalInput(event, identity, batchId, now);
      if (
        SEEN_SIGNAL_TYPES.has(event.signalType) &&
        ITEM_TARGET_TYPES.has(event.targetType)
      ) {
        seenItems.push({
          userId: identity.userId,
          anonymousSessionId: identity.anonymousSessionId,
          clientEventId: event.clientEventId,
          targetType: event.targetType,
          targetId: event.targetId,
          surface: event.surface,
          sectionKey: event.sectionKey,
          suggestionBlockKey: event.suggestionBlockKey,
          sessionId: event.sessionId,
          batchId,
          seenAt: now,
          createdAt: now,
        });
      }

      const sectionKey = this.getSectionSignalKey(event);
      if (sectionKey) {
        marketSectionSignals.push({
          ...common,
          sectionKey,
        });
      }

      const blockKey = this.getSuggestionBlockKey(event);
      if (blockKey) {
        suggestionSignals.push({
          ...common,
          blockKey,
          targetType:
            event.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
              ? null
              : event.targetType,
          targetId:
            event.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
              ? null
              : event.targetId,
        });
      }
    }

    return { seenItems, marketSectionSignals, suggestionSignals };
  }

  private async persistProjectionRows(
    client: Prisma.TransactionClient,
    input: {
      seenItems: Prisma.UserSeenItemCreateManyInput[];
      marketSectionSignals: Prisma.MarketSectionSignalCreateManyInput[];
      suggestionSignals: Prisma.SuggestionSignalCreateManyInput[];
    },
  ): Promise<Omit<PersistedCounts, 'userFeedSignals'>> {
    const persisted = {
      seenItems: 0,
      marketSectionSignals: 0,
      suggestionSignals: 0,
    };
    const writes: Array<Prisma.PrismaPromise<MarketSignalCreateManyResult>> =
      [];
    const keys: Array<keyof typeof persisted> = [];
    if (input.seenItems.length) {
      writes.push(
        client.userSeenItem.createMany({
          data: input.seenItems,
          skipDuplicates: true,
        }) as Prisma.PrismaPromise<MarketSignalCreateManyResult>,
      );
      keys.push('seenItems');
    }
    if (input.marketSectionSignals.length) {
      writes.push(
        client.marketSectionSignal.createMany({
          data: input.marketSectionSignals,
          skipDuplicates: true,
        }) as Prisma.PrismaPromise<MarketSignalCreateManyResult>,
      );
      keys.push('marketSectionSignals');
    }
    if (input.suggestionSignals.length) {
      writes.push(
        client.suggestionSignal.createMany({
          data: input.suggestionSignals,
          skipDuplicates: true,
        }) as Prisma.PrismaPromise<MarketSignalCreateManyResult>,
      );
      keys.push('suggestionSignals');
    }

    if (!writes.length) return persisted;

    const results = await Promise.all(writes);
    for (const [index, key] of keys.entries()) {
      persisted[key] = this.toCount(results[index]?.count);
    }
    return persisted;
  }

  private buildCommonSignalInput(
    event: NormalizedMarketSignalEvent,
    identity: ResolvedMarketSignalIdentity,
    batchId: string | null,
    now: Date,
  ) {
    return {
      userId: identity.userId,
      anonymousSessionId: identity.anonymousSessionId,
      clientEventId: event.clientEventId,
      batchId,
      signalType: event.signalType,
      value: event.value,
      surface: event.surface,
      screenContext: event.screenContext,
      sessionId: event.sessionId,
      metadata: this.sanitizeMetadata(event.metadata),
      createdAt: now,
    };
  }

  private async aggregateAcceptedEvents(
    events: NormalizedMarketSignalEvent[],
    identity: MarketSignalIdentity,
    now: Date,
    client: Prisma.TransactionClient,
  ) {
    if (events.length === 0) {
      return {
        mode: 'synchronous-db' as const,
        status: 'skipped-empty' as const,
        eventsAggregated: 0,
        bucketsUpdated: 0,
      };
    }

    if (!this.aggregationService) {
      return {
        mode: 'synchronous-db' as const,
        status: 'not-configured' as const,
        eventsAggregated: 0,
        bucketsUpdated: 0,
      };
    }

    try {
      const result: MarketSignalAggregationResult =
        await this.aggregationService.aggregateBatch(
          events.map((event) => ({
            targetType: event.targetType,
            targetId: event.targetId,
            signalType: event.signalType,
            surface: event.surface,
            sectionKey: event.sectionKey,
            suggestionBlockKey: event.suggestionBlockKey,
          })),
          identity,
          now,
          client,
        );
      return {
        ...result,
        status: 'ok' as const,
      };
    } catch (error) {
      this.logger.warn(
        'Signal aggregation failed; signal transaction will roll back',
      );
      this.emitRankingAlert('market_signal_aggregation_failed', 'error', {
        eventCount: events.length,
        actorType: identity.userId ? 'USER' : 'ANONYMOUS',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  private normalizeEventsForIdempotency(
    events: MarketSignalEventDto[],
    defaultSessionId?: string | null,
  ) {
    const seenKeys = new Set<string>();
    const normalizedEvents: NormalizedMarketSignalEvent[] = [];

    for (const event of events) {
      const normalized = this.normalizeEvent(event, defaultSessionId);
      const key = normalized.clientEventId;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      normalizedEvents.push(normalized);
    }

    return normalizedEvents;
  }

  private normalizeEvent(
    event: MarketSignalEventDto,
    defaultSessionId?: string | null,
  ): NormalizedMarketSignalEvent {
    if (!this.enumIncludes(MarketSignalTargetType, event.targetType)) {
      throw new BadRequestException('Invalid signal targetType');
    }
    if (!this.enumIncludes(MarketSignalType, event.signalType)) {
      throw new BadRequestException('Invalid signalType');
    }
    if (!this.enumIncludes(MarketSignalSurface, event.surface)) {
      throw new BadRequestException('Invalid signal surface');
    }

    const targetId = this.cleanToken(
      event.targetId,
      'targetId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    if (!targetId) {
      throw new BadRequestException('targetId is required for signal events');
    }

    const clientEventId = this.cleanToken(
      event.clientEventId,
      'clientEventId',
      MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
    );
    if (!clientEventId) {
      throw new BadRequestException(
        'clientEventId is required for signal events',
      );
    }

    return {
      ...event,
      targetId,
      clientEventId,
      sectionKey: this.cleanToken(
        event.sectionKey,
        'sectionKey',
        MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
      ),
      suggestionBlockKey: this.cleanToken(
        event.suggestionBlockKey,
        'suggestionBlockKey',
        MARKET_SIGNAL_MAX_SECTION_KEY_LENGTH,
      ),
      screenContext: this.cleanToken(
        event.screenContext,
        'screenContext',
        MARKET_SIGNAL_MAX_SCREEN_CONTEXT_LENGTH,
      ),
      sessionId:
        this.cleanToken(
          event.sessionId,
          'sessionId',
          MARKET_SIGNAL_MAX_TARGET_ID_LENGTH,
        ) ??
        defaultSessionId ??
        null,
      value: Number.isFinite(event.value) ? event.value : null,
      position:
        typeof event.position === 'number' && Number.isFinite(event.position)
          ? Math.max(0, Math.floor(event.position))
          : null,
    };
  }

  private async getExistingClientEventIds(
    client: Prisma.TransactionClient,
    clientEventIds: string[],
    userId: string | null,
    anonymousSessionId: string | null,
    now: Date,
  ) {
    if (clientEventIds.length === 0) return new Set<string>();
    const readAt = new Date(Math.max(now.getTime(), Date.now()));
    const since = new Date(readAt.getTime() - this.duplicateReplayWindowMs);
    const where: Prisma.UserFeedSignalWhereInput = {
      clientEventId: { in: Array.from(new Set(clientEventIds)) },
      createdAt: { gte: since, lte: readAt },
      ...(userId ? { userId } : { anonymousSessionId }),
    };

    const rows = await client.userFeedSignal.findMany({
      where,
      select: { clientEventId: true },
      take: clientEventIds.length,
    });

    return new Set(
      rows
        .map((row) => row.clientEventId)
        .filter((value): value is string => Boolean(value)),
    );
  }

  private async getClientEventIdsCreatedAt(
    client: Prisma.TransactionClient,
    clientEventIds: string[],
    userId: string | null,
    anonymousSessionId: string | null,
    createdAt: Date,
  ) {
    if (clientEventIds.length === 0) return new Set<string>();
    const rows = await client.userFeedSignal.findMany({
      where: {
        clientEventId: { in: Array.from(new Set(clientEventIds)) },
        createdAt,
        AND: [
          {
            createdAt: {
              gte: new Date(Date.now() - this.duplicateReplayWindowMs),
              lte: new Date(),
            },
          },
        ],
        ...(userId ? { userId } : { anonymousSessionId }),
      },
      select: { clientEventId: true },
      take: clientEventIds.length,
    });

    return new Set(
      rows
        .map((row) => row.clientEventId)
        .filter((value): value is string => Boolean(value)),
    );
  }

  private async findBatchReceipt(
    client: Prisma.TransactionClient,
    userId: string | null,
    anonymousSessionId: string | null,
    batchId: string,
    now: Date,
  ) {
    const ownerWhere: Prisma.MarketSignalBatchReceiptWhereInput[] = [];
    if (userId) ownerWhere.push({ userId, batchId });
    if (anonymousSessionId) ownerWhere.push({ anonymousSessionId, batchId });
    if (!ownerWhere.length) return null;

    const readAt = new Date(Math.max(now.getTime(), Date.now()));
    return client.marketSignalBatchReceipt.findFirst({
      where: {
        OR: ownerWhere,
        createdAt: {
          gte: new Date(readAt.getTime() - this.duplicateReplayWindowMs),
          lte: readAt,
        },
      },
    });
  }

  private async createBatchReceipt(
    client: Prisma.TransactionClient,
    userId: string | null,
    anonymousSessionId: string | null,
    batchId: string,
    input: {
      received: number;
      persisted: PersistedCounts;
    },
  ) {
    await client.marketSignalBatchReceipt.createMany({
      data: [
        {
          userId,
          anonymousSessionId,
          batchId,
          received: input.received,
          persisted: input.persisted,
        },
      ],
      skipDuplicates: true,
    });
  }

  private toPersistedCounts(value: Prisma.JsonValue | null): PersistedCounts {
    const fallback: PersistedCounts = {
      userFeedSignals: 0,
      seenItems: 0,
      marketSectionSignals: 0,
      suggestionSignals: 0,
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return fallback;
    }
    const source = value as Record<string, unknown>;
    return {
      userFeedSignals: this.toCount(source.userFeedSignals),
      seenItems: this.toCount(source.seenItems),
      marketSectionSignals: this.toCount(source.marketSectionSignals),
      suggestionSignals: this.toCount(source.suggestionSignals),
    };
  }

  private toCount(value: unknown) {
    return typeof value === 'number' && Number.isFinite(value)
      ? Math.max(0, Math.floor(value))
      : 0;
  }

  private getSectionSignalKey(event: NormalizedMarketSignalEvent) {
    if (event.sectionKey) return event.sectionKey;
    if (event.targetType === MarketSignalTargetType.SECTION)
      return event.targetId;
    return event.signalType.startsWith('MARKET_SECTION_') ||
      event.signalType.startsWith('SECTION_')
      ? event.targetId
      : null;
  }

  private getSuggestionBlockKey(event: NormalizedMarketSignalEvent) {
    if (event.suggestionBlockKey) return event.suggestionBlockKey;
    if (event.targetType === MarketSignalTargetType.SUGGESTION_BLOCK) {
      return event.targetId;
    }
    return event.signalType.startsWith('SUGGESTION_') ? event.targetId : null;
  }

  private sanitizeMetadata(
    metadata: Record<string, unknown> | undefined,
  ): Prisma.InputJsonValue | undefined {
    if (!metadata) return undefined;

    let encoded: string;
    try {
      encoded = JSON.stringify(metadata);
    } catch {
      throw new BadRequestException('metadata must be JSON serializable');
    }

    if (Buffer.byteLength(encoded, 'utf8') > MARKET_SIGNAL_MAX_METADATA_BYTES) {
      throw new BadRequestException(
        `metadata cannot exceed ${MARKET_SIGNAL_MAX_METADATA_BYTES} bytes`,
      );
    }
    return metadata as Prisma.InputJsonObject;
  }

  private clean(value: unknown) {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private cleanToken(value: unknown, field: string, maxLength: number) {
    const cleaned = this.clean(value);
    if (!cleaned) return null;
    if (cleaned.length > maxLength) {
      throw new BadRequestException(
        `${field} cannot exceed ${maxLength} characters`,
      );
    }
    if (/[\u0000-\u001F\u007F]/.test(cleaned)) {
      throw new BadRequestException(`${field} contains unsupported characters`);
    }
    return cleaned;
  }

  private enumIncludes<T extends Record<string, string>>(
    enumType: T,
    value: unknown,
  ): value is T[keyof T] {
    return Object.values(enumType).includes(value as string);
  }

  private emitRankingAlert(
    event: string,
    severity: 'info' | 'warning' | 'error' | 'critical',
    metadata: Record<string, unknown>,
  ): void {
    this.monitoring?.emitAlert({
      category: 'RANKING',
      severity,
      event,
      message: event,
      metadata,
    });
  }
}
