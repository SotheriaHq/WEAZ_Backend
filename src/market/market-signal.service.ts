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
  Role,
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
  MarketSignalAggregationService,
  withMarketSignalTransaction,
} from './market-signal-aggregation.service';
import {
  buildContributionContextQuery,
  contributionBudgetCrossed,
  contributionContextRequired,
  contributionVelocityCrossed,
  decideMarketSignalContributions,
  EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT,
  MARKET_SIGNAL_CONTRIBUTION_BUDGET,
  MARKET_SIGNAL_VELOCITY_EVENTS,
  MARKET_SIGNAL_VELOCITY_TARGETS,
  MarketSignalContribution,
  MarketSignalContributionActor,
  MarketSignalContributionContext,
  parseContributionContext,
} from './market-signal-contribution';
import {
  buildMarketSignalEnrichment,
  MARKET_SIGNAL_ENRICHMENT_FLAG,
  MARKET_SIGNAL_SERVER_METADATA_KEY,
  MarketSignalTelemetry,
  MarketSignalTiming,
  normalizeMarketSignalTelemetry,
  parseMarketSignalInstant,
  readMarketSignalEnrichmentFlag,
  resolveMarketSignalTiming,
} from './market-signal-telemetry';
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
  | 'metadata'
  | 'occurredAt'
  | 'visibleMs'
  | 'epoch'
  | 'policyVersion'
  | 'explore'
> & {
  targetId: string;
  clientEventId: string;
  sectionKey: string | null;
  suggestionBlockKey: string | null;
  screenContext: string | null;
  sessionId: string | null;
  value: number | null;
  position: number | null;
  metadata: Prisma.InputJsonObject | undefined;
  telemetry: MarketSignalTelemetry;
  timing: MarketSignalTiming | null;
};

type PreparedMarketSignalBatch = {
  received: number;
  events: NormalizedMarketSignalEvent[];
  batchId: string | null;
};

type MarketSignalAlert = {
  event: string;
  metadata: Record<string, unknown>;
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

/** Console operators are not an audience; view counting applies the same rule. */
const OPERATOR_ROLES: ReadonlySet<Role> = new Set([
  Role.Admin,
  Role.SuperAdmin,
]);

const MAX_POSTGRES_INTEGER = 2_147_483_647;

/** JSON text PostgreSQL cannot store: an escaped NUL or an unpaired surrogate. */
const UNSTORABLE_JSON_ESCAPE =
  /(?<!\\)(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/;

@Injectable()
export class MarketSignalService {
  private readonly logger = new Logger(MarketSignalService.name);
  private readonly duplicateReplayWindowMs = 24 * 60 * 60 * 1000;
  private invalidEnrichmentFlagReported = false;

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
    // Everything the client controls is rejected before a lock is taken.
    const receivedAt = new Date();
    const sentAt = parseMarketSignalInstant(dto.sentAt, 'sentAt');
    const batch: PreparedMarketSignalBatch = {
      received: events.length,
      events: this.normalizeEventsForIdempotency(
        events,
        defaultSessionId,
        sentAt,
        receivedAt,
      ),
      batchId,
    };
    const enrich = this.enrichmentEnabled();
    const outcome = await withMarketSignalTransaction(this.prisma, (client) =>
      this.ingestInTransaction(
        batch,
        { userId, anonymousSessionId },
        enrich,
        client,
      ),
    );
    // Reported only for committed activity, so a rolled-back batch is silent.
    for (const alert of outcome.alerts) {
      this.emitRankingAlert(alert.event, 'warning', alert.metadata);
    }
    return outcome.response;
  }

  private async ingestInTransaction(
    batch: PreparedMarketSignalBatch,
    identity: ResolvedMarketSignalIdentity,
    enrich: boolean,
    client: Prisma.TransactionClient,
  ) {
    const { userId, anonymousSessionId } = identity;
    const { batchId, received } = batch;
    let operator = false;
    if (userId) {
      await lockSecurityAccount(client, userId);

      const actor = await client.user.findUnique({
        where: { id: userId },
        select: { status: true, deactivatedAt: true, role: true },
      });
      if (!actor || actor.status !== 'ACTIVE' || actor.deactivatedAt !== null)
        throw new ForbiddenException(
          'Inactive accounts cannot submit Market signals',
        );
      operator = OPERATOR_ROLES.has(actor.role);
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
        received,
        actorType: userId ? 'USER' : 'ANONYMOUS',
      });
      return {
        response: {
          accepted: true,
          duplicate: true,
          batchId,
          received: existingBatchReceipt.received,
          persisted: this.toPersistedCounts(existingBatchReceipt.persisted),
          deduplicated: received,
          aggregation: {
            mode: 'synchronous-db',
            status: 'skipped-duplicate-batch',
            eventsAggregated: 0,
            bucketsUpdated: 0,
          },
        },
        alerts: [] as MarketSignalAlert[],
      };
    }

    // An event delivered after its replay identity could have been purged may
    // already have been counted once. It is acknowledged, never stored.
    const deliverable = batch.events.filter((event) => !event.timing?.stale);
    const existingClientEventIds = await this.getExistingClientEventIds(
      client,
      deliverable.map((event) => event.clientEventId),
      userId,
      anonymousSessionId,
      now,
    );
    const acceptedEvents = deliverable.filter(
      (event) => !existingClientEventIds.has(event.clientEventId),
    );

    // The identity lock makes this read and the inserts below one step, so a
    // batch is judged against every earlier batch and never against itself.
    const actor: MarketSignalContributionActor = {
      kind: userId ? 'USER' : 'ANONYMOUS',
      userId,
      anonymousSessionId,
      operator,
    };
    const context = await this.readContributionContext(
      client,
      acceptedEvents,
      actor,
      now,
    );
    const decisions = decideMarketSignalContributions(
      acceptedEvents,
      actor,
      context,
    );
    const contributionByEventId = new Map(
      acceptedEvents.map((event, index) => [
        event.clientEventId,
        decisions[index],
      ]),
    );

    const canonical = await this.persistCanonicalEvents(
      client,
      acceptedEvents,
      { userId, anonymousSessionId },
      batchId,
      now,
      enrich ? contributionByEventId : null,
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
      contributionByEventId,
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
          received,
          persisted,
        },
      );
    }

    this.logContributionSummary(
      batch,
      deliverable.length,
      canonical.insertedEvents,
      contributionByEventId,
      actor,
    );
    return {
      response: {
        accepted: true,
        batchId,
        received,
        persisted,
        deduplicated: received - canonical.insertedEvents.length,
        aggregation,
      },
      alerts: this.contributionAlerts(actor, context, canonical.insertedEvents),
    };
  }

  private async readContributionContext(
    client: Prisma.TransactionClient,
    events: NormalizedMarketSignalEvent[],
    actor: MarketSignalContributionActor,
    now: Date,
  ): Promise<MarketSignalContributionContext> {
    if (!contributionContextRequired(events, actor))
      return EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT;
    return parseContributionContext(
      await client.$queryRaw<Record<string, unknown>[]>(
        buildContributionContextQuery({ actor, events, readAt: now }),
      ),
    );
  }

  /** Counts only: no account, device, item or brand identifier leaves here. */
  private contributionAlerts(
    actor: MarketSignalContributionActor,
    context: MarketSignalContributionContext,
    inserted: NormalizedMarketSignalEvent[],
  ): MarketSignalAlert[] {
    const alerts: MarketSignalAlert[] = [];
    if (inserted.length === 0) return alerts;
    if (contributionBudgetCrossed(actor, context, inserted.length)) {
      alerts.push({
        event: 'market_signal_contribution_budget_crossed',
        metadata: {
          actorType: actor.kind,
          windowHours: 24,
          budget: MARKET_SIGNAL_CONTRIBUTION_BUDGET[actor.kind],
        },
      });
    }
    const velocity = contributionVelocityCrossed(context, inserted);
    if (velocity) {
      alerts.push({
        event: 'market_signal_velocity_anomaly',
        metadata: {
          actorType: actor.kind,
          windowMinutes: 60,
          events: velocity.events,
          distinctItems: velocity.targets,
          eventThreshold: MARKET_SIGNAL_VELOCITY_EVENTS,
          itemThreshold: MARKET_SIGNAL_VELOCITY_TARGETS,
        },
      });
    }
    return alerts;
  }

  private logContributionSummary(
    batch: PreparedMarketSignalBatch,
    deliverable: number,
    inserted: NormalizedMarketSignalEvent[],
    contributionByEventId: ReadonlyMap<string, MarketSignalContribution>,
    actor: MarketSignalContributionActor,
  ) {
    const contributions: Partial<Record<MarketSignalContribution, number>> = {};
    for (const event of inserted) {
      const decision = contributionByEventId.get(event.clientEventId);
      if (decision)
        contributions[decision] = (contributions[decision] ?? 0) + 1;
    }
    this.logger.debug(
      JSON.stringify({
        event: 'market-signal-batch',
        actorType: actor.kind,
        received: batch.received,
        stale: batch.events.length - deliverable,
        stored: inserted.length,
        contributions,
      }),
    );
  }

  private enrichmentEnabled() {
    const flag = readMarketSignalEnrichmentFlag();
    if (flag.invalid && !this.invalidEnrichmentFlagReported) {
      this.invalidEnrichmentFlagReported = true;
      this.logger.warn(
        `${MARKET_SIGNAL_ENRICHMENT_FLAG} must be exactly 'true' or 'false'; enrichment stays off`,
      );
    }
    return flag.enabled;
  }

  private async persistCanonicalEvents(
    client: Prisma.TransactionClient,
    events: NormalizedMarketSignalEvent[],
    identity: ResolvedMarketSignalIdentity,
    batchId: string | null,
    now: Date,
    contributionByEventId: ReadonlyMap<string, MarketSignalContribution> | null,
  ) {
    if (events.length === 0) {
      return { insertedEvents: [], persistedCount: 0 };
    }

    const data = events.map((event) => ({
      ...this.buildCommonSignalInput(event, identity, batchId, now),
      metadata: contributionByEventId
        ? this.enrichMetadata(
            event,
            contributionByEventId.get(event.clientEventId),
          )
        : event.metadata,
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
      metadata: event.metadata,
      createdAt: now,
    };
  }

  private enrichMetadata(
    event: NormalizedMarketSignalEvent,
    contribution: MarketSignalContribution | undefined,
  ): Prisma.InputJsonObject | undefined {
    if (!contribution) return event.metadata;
    return {
      ...event.metadata,
      [MARKET_SIGNAL_SERVER_METADATA_KEY]: buildMarketSignalEnrichment({
        timing: event.timing,
        telemetry: event.telemetry,
        contribution,
      }),
    };
  }

  /**
   * Only counted events reach the aggregates. The returned summary describes
   * every stored event, as before, so a client cannot learn which of its events
   * were excluded.
   */
  private async aggregateAcceptedEvents(
    events: NormalizedMarketSignalEvent[],
    contributionByEventId: ReadonlyMap<string, MarketSignalContribution>,
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

    const counted = events.filter(
      (event) => contributionByEventId.get(event.clientEventId) === 'counted',
    );
    try {
      if (counted.length > 0) {
        await this.aggregationService.aggregateBatch(
          counted.map((event) => ({
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
      }
      return {
        mode: 'synchronous-db' as const,
        status: 'ok' as const,
        eventsAggregated: events.length,
        bucketsUpdated: new Set(
          events.map((event) =>
            JSON.stringify([
              event.surface,
              event.sectionKey,
              event.suggestionBlockKey,
              event.targetType,
              event.targetId,
            ]),
          ),
        ).size,
      };
    } catch (error) {
      this.logger.warn(
        'Signal aggregation failed; signal transaction will roll back',
      );
      this.emitRankingAlert('market_signal_aggregation_failed', 'error', {
        eventCount: counted.length,
        actorType: identity.userId ? 'USER' : 'ANONYMOUS',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      throw error;
    }
  }

  private normalizeEventsForIdempotency(
    events: MarketSignalEventDto[],
    defaultSessionId: string | null,
    sentAt: Date | null,
    receivedAt: Date,
  ) {
    const seenKeys = new Set<string>();
    const normalizedEvents: NormalizedMarketSignalEvent[] = [];

    for (const event of events) {
      const normalized = this.normalizeEvent(
        event,
        defaultSessionId,
        sentAt,
        receivedAt,
      );
      const key = normalized.clientEventId;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);
      normalizedEvents.push(normalized);
    }

    return normalizedEvents;
  }

  private normalizeEvent(
    event: MarketSignalEventDto,
    defaultSessionId: string | null,
    sentAt: Date | null,
    receivedAt: Date,
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
      targetType: event.targetType,
      targetId,
      signalType: event.signalType,
      surface: event.surface,
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
        typeof event.position === 'number' &&
        Number.isFinite(event.position) &&
        event.position <= MAX_POSTGRES_INTEGER
          ? Math.max(0, Math.floor(event.position))
          : null,
      metadata: this.sanitizeMetadata(event.metadata),
      telemetry: normalizeMarketSignalTelemetry(event),
      timing: resolveMarketSignalTiming(
        parseMarketSignalInstant(event.occurredAt, 'occurredAt'),
        sentAt,
        receivedAt,
      ),
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
  ): Prisma.InputJsonObject | undefined {
    if (!metadata) return undefined;

    const clientMetadata = { ...metadata };
    delete clientMetadata[MARKET_SIGNAL_SERVER_METADATA_KEY];
    let encoded: string;
    try {
      encoded = JSON.stringify(clientMetadata);
    } catch {
      throw new BadRequestException('metadata must be JSON serializable');
    }

    if (Buffer.byteLength(encoded, 'utf8') > MARKET_SIGNAL_MAX_METADATA_BYTES) {
      throw new BadRequestException(
        `metadata cannot exceed ${MARKET_SIGNAL_MAX_METADATA_BYTES} bytes`,
      );
    }
    if (UNSTORABLE_JSON_ESCAPE.test(encoded)) {
      throw new BadRequestException('metadata contains unsupported characters');
    }
    return clientMetadata as Prisma.InputJsonObject;
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
    if (/[\u0000-\u001F\u007F\p{Surrogate}]/u.test(cleaned)) {
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
