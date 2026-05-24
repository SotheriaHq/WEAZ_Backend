import {
  BadRequestException,
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
  MarketSignalBatchDto,
  MarketSignalEventDto,
} from './dto/market-signal.dto';
import {
  MarketSignalAggregationResult,
  MarketSignalAggregationService,
} from './market-signal-aggregation.service';

export interface MarketSignalIdentity {
  userId?: string | null;
  anonymousSessionId?: string | null;
}

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
  clientEventId: string | null;
  sectionKey: string | null;
  suggestionBlockKey: string | null;
  screenContext: string | null;
  sessionId: string | null;
  value: number | null;
  position: number | null;
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

type PersistedCounts = {
  userFeedSignals: number;
  seenItems: number;
  marketSectionSignals: number;
  suggestionSignals: number;
};

@Injectable()
export class MarketSignalService {
  private readonly logger = new Logger(MarketSignalService.name);
  private readonly duplicateReplayWindowMs = 24 * 60 * 60 * 1000;

  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly aggregationService?: MarketSignalAggregationService,
  ) {}

  async ingestBatch(dto: MarketSignalBatchDto, identity: MarketSignalIdentity) {
    const userId = this.clean(identity.userId);
    const anonymousSessionId = this.clean(
      userId ? undefined : identity.anonymousSessionId ?? dto.anonymousSessionId,
    );

    if (!userId && !anonymousSessionId) {
      throw new BadRequestException(
        'anonymousSessionId is required for guest signal batches',
      );
    }

    const events = Array.isArray(dto.events) ? dto.events : [];
    if (events.length > MARKET_SIGNAL_MAX_BATCH_EVENTS) {
      throw new BadRequestException(
        `Signal batch cannot exceed ${MARKET_SIGNAL_MAX_BATCH_EVENTS} events`,
      );
    }

    const batchId = this.clean(dto.batchId);
    const defaultSessionId = this.clean(dto.sessionId);
    const now = new Date();

    const existingBatchReceipt = batchId
      ? await this.findBatchReceipt(userId, anonymousSessionId, batchId)
      : null;
    if (existingBatchReceipt) {
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
      normalizedEvents
        .map((event) => event.clientEventId)
        .filter((value): value is string => Boolean(value)),
      userId,
      anonymousSessionId,
      now,
    );
    const acceptedEvents = normalizedEvents.filter(
      (event) =>
        !event.clientEventId || !existingClientEventIds.has(event.clientEventId),
    );

    const userFeedSignals: Prisma.UserFeedSignalCreateManyInput[] = [];
    const seenItems: Prisma.UserSeenItemCreateManyInput[] = [];
    const marketSectionSignals: Prisma.MarketSectionSignalCreateManyInput[] = [];
    const suggestionSignals: Prisma.SuggestionSignalCreateManyInput[] = [];

    for (const normalized of acceptedEvents) {
      const common = {
        userId,
        anonymousSessionId,
        clientEventId: normalized.clientEventId,
        batchId,
        signalType: normalized.signalType,
        value: normalized.value,
        surface: normalized.surface,
        screenContext: normalized.screenContext,
        sessionId: normalized.sessionId,
        metadata: this.sanitizeMetadata(normalized.metadata),
        createdAt: now,
      };

      userFeedSignals.push({
        ...common,
        targetType: normalized.targetType,
        targetId: normalized.targetId,
        sectionKey: normalized.sectionKey,
        suggestionBlockKey: normalized.suggestionBlockKey,
        position: normalized.position,
      });

      if (
        SEEN_SIGNAL_TYPES.has(normalized.signalType) &&
        ITEM_TARGET_TYPES.has(normalized.targetType)
      ) {
        seenItems.push({
          userId,
          anonymousSessionId,
          clientEventId: normalized.clientEventId,
          targetType: normalized.targetType,
          targetId: normalized.targetId,
          surface: normalized.surface,
          sectionKey: normalized.sectionKey,
          suggestionBlockKey: normalized.suggestionBlockKey,
          sessionId: normalized.sessionId,
          batchId,
          seenAt: now,
          createdAt: now,
        });
      }

      const sectionKey = this.getSectionSignalKey(normalized);
      if (sectionKey) {
        marketSectionSignals.push({
          ...common,
          sectionKey,
        });
      }

      const blockKey = this.getSuggestionBlockKey(normalized);
      if (blockKey) {
        suggestionSignals.push({
          ...common,
          blockKey,
          targetType:
            normalized.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
              ? null
              : normalized.targetType,
          targetId:
            normalized.targetType === MarketSignalTargetType.SUGGESTION_BLOCK
              ? null
              : normalized.targetId,
        });
      }
    }

    const writes: Prisma.PrismaPromise<unknown>[] = [];
    if (userFeedSignals.length) {
      writes.push(
        this.prisma.userFeedSignal.createMany({ data: userFeedSignals }),
      );
    }
    if (seenItems.length) {
      writes.push(this.prisma.userSeenItem.createMany({ data: seenItems }));
    }
    if (marketSectionSignals.length) {
      writes.push(
        this.prisma.marketSectionSignal.createMany({
          data: marketSectionSignals,
        }),
      );
    }
    if (suggestionSignals.length) {
      writes.push(
        this.prisma.suggestionSignal.createMany({ data: suggestionSignals }),
      );
    }

    if (writes.length) {
      await this.prisma.$transaction(writes);
    }

    const persisted: PersistedCounts = {
      userFeedSignals: userFeedSignals.length,
      seenItems: seenItems.length,
      marketSectionSignals: marketSectionSignals.length,
      suggestionSignals: suggestionSignals.length,
    };

    const aggregation = await this.aggregateAcceptedEvents(
      acceptedEvents,
      { userId, anonymousSessionId },
      now,
    );

    if (batchId) {
      await this.createBatchReceipt(userId, anonymousSessionId, batchId, {
        received: events.length,
        persisted,
      });
    }

    return {
      accepted: true,
      batchId,
      received: events.length,
      persisted,
      deduplicated: events.length - acceptedEvents.length,
      aggregation,
    };
  }

  private async aggregateAcceptedEvents(
    events: NormalizedMarketSignalEvent[],
    identity: MarketSignalIdentity,
    now: Date,
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
        );
      return {
        ...result,
        status: 'ok' as const,
      };
    } catch (error) {
      this.logger.warn(
        `Signal aggregation failed; raw signals were retained: ${
          (error as any)?.message || error
        }`,
      );
      return {
        mode: 'synchronous-db' as const,
        status: 'failed' as const,
        eventsAggregated: 0,
        bucketsUpdated: 0,
      };
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
      const key = normalized.clientEventId ?? this.eventFingerprint(normalized);
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

    const targetId = this.clean(event.targetId);
    if (!targetId) {
      throw new BadRequestException('targetId is required for signal events');
    }

    return {
      ...event,
      targetId,
      clientEventId: this.clean(event.clientEventId),
      sectionKey: this.clean(event.sectionKey),
      suggestionBlockKey: this.clean(event.suggestionBlockKey),
      screenContext: this.clean(event.screenContext),
      sessionId: this.clean(event.sessionId) ?? defaultSessionId ?? null,
      value: Number.isFinite(event.value) ? event.value : null,
      position:
        typeof event.position === 'number' && Number.isFinite(event.position)
          ? Math.max(0, Math.floor(event.position))
          : null,
    };
  }

  private eventFingerprint(event: NormalizedMarketSignalEvent) {
    return [
      event.signalType,
      event.targetType,
      event.targetId,
      event.surface,
      event.sectionKey ?? '',
      event.suggestionBlockKey ?? '',
      event.sessionId ?? '',
      event.position ?? '',
    ].join(':');
  }

  private async getExistingClientEventIds(
    clientEventIds: string[],
    userId: string | null,
    anonymousSessionId: string | null,
    now: Date,
  ) {
    if (clientEventIds.length === 0) return new Set<string>();
    const since = new Date(now.getTime() - this.duplicateReplayWindowMs);
    const where: Prisma.UserFeedSignalWhereInput = {
      clientEventId: { in: Array.from(new Set(clientEventIds)) },
      createdAt: { gte: since },
      ...(userId ? { userId } : { anonymousSessionId }),
    };

    const rows = await this.prisma.userFeedSignal.findMany({
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

  private async findBatchReceipt(
    userId: string | null,
    anonymousSessionId: string | null,
    batchId: string,
  ) {
    const ownerWhere: Prisma.MarketSignalBatchReceiptWhereInput[] = [];
    if (userId) ownerWhere.push({ userId, batchId });
    if (anonymousSessionId) ownerWhere.push({ anonymousSessionId, batchId });
    if (!ownerWhere.length) return null;

    return this.prisma.marketSignalBatchReceipt.findFirst({
      where: { OR: ownerWhere },
    });
  }

  private async createBatchReceipt(
    userId: string | null,
    anonymousSessionId: string | null,
    batchId: string,
    input: {
      received: number;
      persisted: PersistedCounts;
    },
  ) {
    try {
      await this.prisma.marketSignalBatchReceipt.create({
        data: {
          userId,
          anonymousSessionId,
          batchId,
          received: input.received,
          persisted: input.persisted,
        },
      });
    } catch (error) {
      if ((error as any)?.code !== 'P2002') {
        throw error;
      }
    }
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
    if (event.targetType === MarketSignalTargetType.SECTION) return event.targetId;
    return event.signalType.startsWith('MARKET_SECTION_') ? event.targetId : null;
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

  private enumIncludes<T extends Record<string, string>>(
    enumType: T,
    value: unknown,
  ): value is T[keyof T] {
    return Object.values(enumType).includes(value as string);
  }
}
