import { BadRequestException, Injectable } from '@nestjs/common';
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

export interface MarketSignalIdentity {
  userId?: string | null;
  anonymousSessionId?: string | null;
}

type NormalizedMarketSignalEvent = Omit<
  MarketSignalEventDto,
  | 'targetId'
  | 'sectionKey'
  | 'suggestionBlockKey'
  | 'screenContext'
  | 'sessionId'
  | 'value'
  | 'position'
> & {
  targetId: string;
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

@Injectable()
export class MarketSignalService {
  constructor(private readonly prisma: PrismaService) {}

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

    const userFeedSignals: Prisma.UserFeedSignalCreateManyInput[] = [];
    const seenItems: Prisma.UserSeenItemCreateManyInput[] = [];
    const marketSectionSignals: Prisma.MarketSectionSignalCreateManyInput[] = [];
    const suggestionSignals: Prisma.SuggestionSignalCreateManyInput[] = [];

    for (const event of events) {
      const normalized = this.normalizeEvent(event, defaultSessionId);
      const common = {
        userId,
        anonymousSessionId,
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
      writes.push(this.prisma.userFeedSignal.createMany({ data: userFeedSignals }));
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

    return {
      accepted: true,
      batchId,
      received: events.length,
      persisted: {
        userFeedSignals: userFeedSignals.length,
        seenItems: seenItems.length,
        marketSectionSignals: marketSectionSignals.length,
        suggestionSignals: suggestionSignals.length,
      },
    };
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
    try {
      const encoded = JSON.stringify(metadata);
      if (Buffer.byteLength(encoded, 'utf8') <= MARKET_SIGNAL_MAX_METADATA_BYTES) {
        return metadata as Prisma.InputJsonObject;
      }
      return {
        pruned: true,
        originalBytes: Buffer.byteLength(encoded, 'utf8'),
      };
    } catch {
      return { pruned: true, reason: 'unserializable' };
    }
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
