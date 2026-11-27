import {
  MarketSignalTargetType,
  MarketSignalType,
  Prisma,
} from '@prisma/client';

/**
 * Decides whether an accepted raw event may move the global Market aggregates.
 * Raw events are still stored for the viewer's own history; only popularity
 * contributions are gated. These controls are mandatory and never depend on
 * the optional enrichment flag.
 */
export type MarketSignalContribution =
  | 'counted'
  | 'hard-claim'
  | 'operator'
  | 'owner'
  | 'ungated'
  | 'capped';

export type MarketSignalActorKind = 'USER' | 'ANONYMOUS';

/**
 * Commerce and social actions are counted only from their domain records
 * (cart lines, paid orders, wishlist rows, follows, likes, comments). A client
 * telemetry claim of the same action never contributes.
 */
export const MARKET_SIGNAL_HARD_CLAIM_TYPES: ReadonlySet<MarketSignalType> =
  new Set([
    MarketSignalType.ADD_TO_CART,
    MarketSignalType.PURCHASE,
    MarketSignalType.WISHLIST,
    MarketSignalType.SAVE,
    MarketSignalType.LIKE,
    MarketSignalType.COMMENT,
    MarketSignalType.THREAD,
    MarketSignalType.SUGGESTION_ITEM_CART_ADD,
    MarketSignalType.SUGGESTION_ITEM_WISHLIST,
  ]);

/** Impressions that prove an item was served to this viewer. */
export const MARKET_SIGNAL_IMPRESSION_TYPES: readonly MarketSignalType[] = [
  MarketSignalType.IMPRESSION,
  MarketSignalType.ITEM_IMPRESSION,
  MarketSignalType.SUGGESTION_ITEM_VIEW,
];

/** Opens and item taps count as discovery only after a served impression. */
export const MARKET_SIGNAL_GATED_TYPES: ReadonlySet<MarketSignalType> = new Set(
  [
    MarketSignalType.OPEN,
    MarketSignalType.ITEM_VIEW,
    MarketSignalType.PRODUCT_VIEW,
    MarketSignalType.CLICK,
    MarketSignalType.ITEM_CLICK,
    MarketSignalType.SUGGESTION_ITEM_CLICK,
  ],
);

export const MARKET_SIGNAL_GATED_TARGET_TYPES: ReadonlySet<MarketSignalTargetType> =
  new Set([
    MarketSignalTargetType.PRODUCT,
    MarketSignalTargetType.COLLECTION,
    MarketSignalTargetType.DESIGN,
  ]);

const OWNABLE_TARGET_TYPES: ReadonlySet<MarketSignalTargetType> = new Set([
  MarketSignalTargetType.PRODUCT,
  MarketSignalTargetType.COLLECTION,
  MarketSignalTargetType.DESIGN,
  MarketSignalTargetType.BRAND,
]);

export const MARKET_SIGNAL_IMPRESSION_GATE_MS = 30 * 60 * 1000;
/** Identified raw events are retained for 24 hours (R1); caps use that window. */
export const MARKET_SIGNAL_CONTRIBUTION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Raw events one identity may submit in the rolling window before its events
 * stop moving global aggregates. Batches stay accepted and stored. The bound
 * also caps the rows the per-batch history read can touch.
 */
export const MARKET_SIGNAL_CONTRIBUTION_BUDGET: Readonly<
  Record<MarketSignalActorKind, number>
> = Object.freeze({ USER: 5_000, ANONYMOUS: 1_000 });

/**
 * One identity sending more than this many item events inside an hour on at
 * most this many distinct items is reported to operators. Reporting never
 * changes what is stored or counted.
 */
export const MARKET_SIGNAL_VELOCITY_WINDOW_MS = 60 * 60 * 1000;
export const MARKET_SIGNAL_VELOCITY_EVENTS = 200;
export const MARKET_SIGNAL_VELOCITY_TARGETS = 5;

type ContributionClass = 'impression' | 'open' | 'click' | 'other';

/**
 * Raw events per item and class that may still count in the rolling window.
 * An anonymous device counts once per item and class per day, because rotating
 * device identifiers is free; authenticated limits follow the approved
 * per-identity daily caps.
 */
export const MARKET_SIGNAL_ITEM_CLASS_CAPS: Readonly<
  Record<MarketSignalActorKind, Readonly<Record<ContributionClass, number>>>
> = Object.freeze({
  USER: Object.freeze({ impression: 50, open: 10, click: 10, other: 10 }),
  ANONYMOUS: Object.freeze({ impression: 1, open: 1, click: 1, other: 1 }),
});

const CLASS_BY_TYPE = new Map<MarketSignalType, ContributionClass>([
  ...[
    MarketSignalType.IMPRESSION,
    MarketSignalType.ITEM_IMPRESSION,
    MarketSignalType.SUGGESTION_ITEM_VIEW,
    MarketSignalType.SECTION_VIEW,
    MarketSignalType.MARKET_SECTION_VIEW,
    MarketSignalType.SUGGESTION_BLOCK_VIEW,
    MarketSignalType.VIEW,
  ].map((type) => [type, 'impression'] as const),
  ...[
    MarketSignalType.OPEN,
    MarketSignalType.ITEM_VIEW,
    MarketSignalType.PRODUCT_VIEW,
    MarketSignalType.MARKET_SECTION_DETAIL_VIEW,
  ].map((type) => [type, 'open'] as const),
  ...[
    MarketSignalType.CLICK,
    MarketSignalType.ITEM_CLICK,
    MarketSignalType.SUGGESTION_ITEM_CLICK,
    MarketSignalType.VIEW_ALL_CLICK,
    MarketSignalType.SECTION_VIEW_ALL_CLICK,
    MarketSignalType.MARKET_SECTION_VIEW_ALL_CLICK,
    MarketSignalType.SUGGESTION_VIEW_ALL_CLICK,
  ].map((type) => [type, 'click'] as const),
]);

function classOf(signalType: MarketSignalType) {
  const kind = CLASS_BY_TYPE.get(signalType) ?? 'other';
  // Unclassified types are capped individually so one cannot exhaust another.
  return { kind, key: kind === 'other' ? `other:${signalType}` : kind };
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const targetKey = (targetType: string, targetId: string) =>
  `${targetType}\u0000${targetId}`;
const ownedKey = (targetType: string, targetId: string) =>
  targetKey(targetType, targetId.toLowerCase());

export type MarketSignalContributionEvent = {
  targetType: MarketSignalTargetType;
  targetId: string;
  signalType: MarketSignalType;
};

export type MarketSignalContributionActor = {
  kind: MarketSignalActorKind;
  userId: string | null;
  anonymousSessionId: string | null;
  operator: boolean;
};

type HistoryEntry = { total: number; withinGate: number };

type VelocityWindow = { events: number; targets: ReadonlySet<string> };

export type MarketSignalContributionContext = {
  recentCount: number;
  history: ReadonlyMap<string, HistoryEntry>;
  ownedTargets: ReadonlySet<string>;
  velocity: {
    /** Hour ending at the identity's previous event. */
    previous: VelocityWindow;
    /** Hour ending now, before this batch. */
    current: VelocityWindow;
  };
};

const emptyVelocityWindow = (): VelocityWindow => ({
  events: 0,
  targets: new Set<string>(),
});

export const EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT: MarketSignalContributionContext =
  Object.freeze({
    recentCount: 0,
    history: new Map<string, HistoryEntry>(),
    ownedTargets: new Set<string>(),
    velocity: {
      previous: emptyVelocityWindow(),
      current: emptyVelocityWindow(),
    },
  });

const historyKey = (targetType: string, targetId: string, signalType: string) =>
  `${targetKey(targetType, targetId)}\u0000${signalType}`;

/** History is read only when some accepted event could still contribute. */
export function contributionContextRequired(
  events: readonly MarketSignalContributionEvent[],
  actor: MarketSignalContributionActor,
) {
  return (
    !actor.operator &&
    events.some(
      (event) => !MARKET_SIGNAL_HARD_CLAIM_TYPES.has(event.signalType),
    )
  );
}

/**
 * One bounded statement returns the identity's rolling-window raw count, the
 * per-item history of this batch's targets, two hourly velocity windows and, for
 * accounts, the targets the viewer owns or staffs. The newest `budget + 1` rows are read through the
 * identity/createdAt index, so a flooding identity cannot make this read grow.
 */
export function buildContributionContextQuery(input: {
  actor: MarketSignalContributionActor;
  events: readonly MarketSignalContributionEvent[];
  readAt: Date;
}): Prisma.Sql {
  const { actor, events, readAt } = input;
  const budget = MARKET_SIGNAL_CONTRIBUTION_BUDGET[actor.kind];
  const since = new Date(
    readAt.getTime() - MARKET_SIGNAL_CONTRIBUTION_WINDOW_MS,
  ).toISOString();
  const gateSince = new Date(
    readAt.getTime() - MARKET_SIGNAL_IMPRESSION_GATE_MS,
  ).toISOString();
  const hourSince = new Date(
    readAt.getTime() - MARKET_SIGNAL_VELOCITY_WINDOW_MS,
  ).toISOString();
  const until = readAt.toISOString();
  const identity =
    actor.kind === 'USER'
      ? Prisma.sql`s."userId" = ${actor.userId}::uuid`
      : Prisma.sql`s."anonymousSessionId" = ${actor.anonymousSessionId}`;
  const targets = uniqueTargets(events);
  const owned =
    actor.kind === 'USER' && actor.userId
      ? ownedTargetsSql(actor.userId, events)
      : null;

  return Prisma.sql`WITH recent AS MATERIALIZED (
      SELECT s."targetType"::text AS "targetType", s."targetId", s."signalType"::text AS "signalType", s."createdAt"
      FROM user_feed_signals s
      WHERE ${identity}
        AND s."createdAt" > (${since}::timestamptz AT TIME ZONE 'UTC')
        AND s."createdAt" <= (${until}::timestamptz AT TIME ZONE 'UTC')
      ORDER BY s."createdAt" DESC
      LIMIT ${budget + 1}
    ), targets AS (
      SELECT DISTINCT t."targetType", t."targetId"
      FROM unnest(${targets.map((target) => target.targetType)}::text[], ${targets.map((target) => target.targetId)}::text[]) AS t("targetType", "targetId")
    ), recent_items AS MATERIALIZED (
      SELECT r."targetType", r."targetId", r."createdAt",
        r."createdAt" > (${hourSince}::timestamptz AT TIME ZONE 'UTC') AS current,
        r."createdAt" > (SELECT max(l."createdAt") FROM recent l) - interval '1 hour' AS previous
      FROM recent r
      WHERE r."targetType" IN (${Prisma.join([...MARKET_SIGNAL_GATED_TARGET_TYPES])})
    )
    SELECT
      (SELECT count(*)::int FROM recent) AS "recentCount",
      COALESCE((
        SELECT jsonb_agg(jsonb_build_array(h."targetType", h."targetId", h."signalType", h.total, h."withinGate"))
        FROM (
          SELECT r."targetType", r."targetId", r."signalType", count(*)::int AS total,
            (count(*) FILTER (WHERE r."createdAt" >= (${gateSince}::timestamptz AT TIME ZONE 'UTC')))::int AS "withinGate"
          FROM recent r
          JOIN targets t ON t."targetType" = r."targetType" AND t."targetId" = r."targetId"
          GROUP BY r."targetType", r."targetId", r."signalType"
        ) h
      ), '[]'::jsonb) AS history,
      (SELECT count(*) FILTER (WHERE v.current)::int FROM recent_items v) AS "currentEvents",
      ${velocityTargetsSql(Prisma.sql`v.current`)} AS "currentTargets",
      (SELECT count(*) FILTER (WHERE v.previous)::int FROM recent_items v) AS "previousEvents",
      ${velocityTargetsSql(Prisma.sql`v.previous`)} AS "previousTargets",
      ${owned ?? Prisma.sql`'[]'::jsonb`} AS "ownedTargets"`;
}

/** One more target than the limit is enough to know the limit is exceeded. */
function velocityTargetsSql(window: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`COALESCE((
        SELECT jsonb_agg(jsonb_build_array(d."targetType", d."targetId"))
        FROM (
          SELECT DISTINCT v."targetType", v."targetId" FROM recent_items v
          WHERE ${window} LIMIT ${MARKET_SIGNAL_VELOCITY_TARGETS + 1}
        ) d
      ), '[]'::jsonb)`;
}

function uniqueTargets(events: readonly MarketSignalContributionEvent[]) {
  const seen = new Map<string, { targetType: string; targetId: string }>();
  for (const event of events) {
    seen.set(targetKey(event.targetType, event.targetId), {
      targetType: event.targetType,
      targetId: event.targetId,
    });
  }
  return [...seen.values()];
}

/**
 * Brand owners, ACTIVE brand members and creators of a collection or design
 * cannot add popularity to their own work. Only UUID-shaped identifiers can
 * name a domain row, so other identifiers never reach a UUID cast.
 */
function ownedTargetsSql(
  userId: string,
  events: readonly MarketSignalContributionEvent[],
): Prisma.Sql | null {
  const candidates = new Map<
    string,
    { targetType: string; targetId: string }
  >();
  for (const event of events) {
    if (
      !OWNABLE_TARGET_TYPES.has(event.targetType) ||
      !UUID_PATTERN.test(event.targetId)
    )
      continue;
    candidates.set(ownedKey(event.targetType, event.targetId), {
      targetType: event.targetType,
      targetId: event.targetId.toLowerCase(),
    });
  }
  if (candidates.size === 0) return null;
  const list = [...candidates.values()];
  return Prisma.sql`COALESCE((
      SELECT jsonb_agg(jsonb_build_array(o."targetType", o."targetId"))
      FROM (
        SELECT c."targetType", c."targetId"::text AS "targetId"
        FROM unnest(${list.map((item) => item.targetType)}::text[], ${list.map((item) => item.targetId)}::uuid[]) AS c("targetType", "targetId")
        LEFT JOIN "Product" p ON c."targetType" = 'PRODUCT' AND p."_id" = c."targetId"
        LEFT JOIN "Collection" col ON c."targetType" IN ('COLLECTION', 'DESIGN') AND col."_id" = c."targetId"
        LEFT JOIN "Brand" b ON b."_id" = CASE c."targetType" WHEN 'PRODUCT' THEN p."brandId" WHEN 'BRAND' THEN c."targetId" END
        LEFT JOIN "Brand" cb ON cb."ownerId" = col."ownerId"
        WHERE col."ownerId" = ${userId}::uuid
          OR b."ownerId" = ${userId}::uuid
          OR EXISTS (
            SELECT 1 FROM "BrandMember" m
            WHERE m."userId" = ${userId}::uuid AND m.status = 'ACTIVE'
              AND (m."brandId" = b."_id" OR m."brandId" = cb."_id")
          )
      ) o
    ), '[]'::jsonb)`;
}

function asJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  }
  return [];
}

function asCount(value: unknown) {
  const count = typeof value === 'bigint' ? Number(value) : value;
  return typeof count === 'number' && Number.isFinite(count) && count > 0
    ? Math.floor(count)
    : 0;
}

export function parseContributionContext(
  rows: readonly Record<string, unknown>[] | null | undefined,
): MarketSignalContributionContext {
  const row = rows?.[0];
  if (!row) return EMPTY_MARKET_SIGNAL_CONTRIBUTION_CONTEXT;
  const history = new Map<string, HistoryEntry>();
  for (const entry of asJsonArray(row.history)) {
    if (!Array.isArray(entry) || entry.length !== 5) continue;
    const [targetType, targetId, signalType, total, withinGate] = entry;
    if (
      typeof targetType !== 'string' ||
      typeof targetId !== 'string' ||
      typeof signalType !== 'string'
    )
      continue;
    history.set(historyKey(targetType, targetId, signalType), {
      total: asCount(total),
      withinGate: asCount(withinGate),
    });
  }
  const ownedTargets = new Set<string>();
  for (const entry of asJsonArray(row.ownedTargets)) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
    )
      ownedTargets.add(ownedKey(entry[0], entry[1]));
  }
  return {
    recentCount: asCount(row.recentCount),
    history,
    ownedTargets,
    velocity: {
      previous: parseVelocity(row.previousEvents, row.previousTargets),
      current: parseVelocity(row.currentEvents, row.currentTargets),
    },
  };
}

function parseVelocity(events: unknown, targets: unknown): VelocityWindow {
  const distinct = new Set<string>();
  for (const entry of asJsonArray(targets)) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === 'string' &&
      typeof entry[1] === 'string'
    )
      distinct.add(targetKey(entry[0], entry[1]));
  }
  return { events: asCount(events), targets: distinct };
}

function priorCount(
  context: MarketSignalContributionContext,
  event: MarketSignalContributionEvent,
  types: readonly MarketSignalType[],
  field: keyof HistoryEntry,
) {
  let total = 0;
  for (const type of types) {
    total +=
      context.history.get(historyKey(event.targetType, event.targetId, type))?.[
        field
      ] ?? 0;
  }
  return total;
}

const TYPES_BY_CLASS_KEY = new Map<string, MarketSignalType[]>();
for (const type of Object.values(MarketSignalType)) {
  const { key } = classOf(type);
  TYPES_BY_CLASS_KEY.set(key, [...(TYPES_BY_CLASS_KEY.get(key) ?? []), type]);
}

/**
 * Pure decision in submission order. Prior counts are raw events, so the first
 * events of a class decide; a later event never displaces an earlier one.
 */
export function decideMarketSignalContributions(
  events: readonly MarketSignalContributionEvent[],
  actor: MarketSignalContributionActor,
  context: MarketSignalContributionContext,
): MarketSignalContribution[] {
  const budget = MARKET_SIGNAL_CONTRIBUTION_BUDGET[actor.kind];
  const caps = MARKET_SIGNAL_ITEM_CLASS_CAPS[actor.kind];
  const impressionTypes = new Set<MarketSignalType>(
    MARKET_SIGNAL_IMPRESSION_TYPES,
  );
  const batchImpressions = new Set<string>();
  for (const event of events) {
    if (impressionTypes.has(event.signalType))
      batchImpressions.add(targetKey(event.targetType, event.targetId));
  }
  const batchClassCounts = new Map<string, number>();

  return events.map((event, index) => {
    const { kind, key } = classOf(event.signalType);
    const itemClassKey = `${targetKey(event.targetType, event.targetId)}\u0000${key}`;
    const seenInBatch = batchClassCounts.get(itemClassKey) ?? 0;
    batchClassCounts.set(itemClassKey, seenInBatch + 1);

    if (MARKET_SIGNAL_HARD_CLAIM_TYPES.has(event.signalType))
      return 'hard-claim';
    if (actor.operator) return 'operator';
    if (context.ownedTargets.has(ownedKey(event.targetType, event.targetId)))
      return 'owner';
    if (context.recentCount + index >= budget) return 'capped';
    if (
      MARKET_SIGNAL_GATED_TYPES.has(event.signalType) &&
      MARKET_SIGNAL_GATED_TARGET_TYPES.has(event.targetType) &&
      !batchImpressions.has(targetKey(event.targetType, event.targetId)) &&
      priorCount(
        context,
        event,
        MARKET_SIGNAL_IMPRESSION_TYPES,
        'withinGate',
      ) === 0
    )
      return 'ungated';
    const prior = priorCount(
      context,
      event,
      TYPES_BY_CLASS_KEY.get(key) ?? [event.signalType],
      'total',
    );
    if (prior + seenInBatch >= caps[kind]) return 'capped';
    return 'counted';
  });
}

/** True when this batch moves the identity across its rolling budget. */
export function contributionBudgetCrossed(
  actor: MarketSignalContributionActor,
  context: MarketSignalContributionContext,
  acceptedCount: number,
) {
  const budget = MARKET_SIGNAL_CONTRIBUTION_BUDGET[actor.kind];
  return (
    context.recentCount <= budget &&
    context.recentCount + acceptedCount > budget
  );
}

const isVelocityAnomaly = (window: VelocityWindow) =>
  window.events > MARKET_SIGNAL_VELOCITY_EVENTS &&
  window.targets.size <= MARKET_SIGNAL_VELOCITY_TARGETS;

/**
 * The concentrated-activity measurement when this batch is the first to make
 * the identity anomalous, otherwise null. The previous state is measured at the
 * identity's last event, so targets that age out of the hour between batches
 * cannot hide the transition.
 */
export function contributionVelocityCrossed(
  context: MarketSignalContributionContext,
  accepted: readonly MarketSignalContributionEvent[],
): { events: number; targets: number } | null {
  if (isVelocityAnomaly(context.velocity.previous)) return null;
  const targets = new Set(context.velocity.current.targets);
  let events = context.velocity.current.events;
  for (const event of accepted) {
    if (!MARKET_SIGNAL_GATED_TARGET_TYPES.has(event.targetType)) continue;
    events += 1;
    targets.add(targetKey(event.targetType, event.targetId));
  }
  return isVelocityAnomaly({ events, targets })
    ? { events, targets: targets.size }
    : null;
}
