import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MarketCursorState, MarketSort } from './market-cursor';
import { marketSnapshotPageSql } from './market-snapshot-order.sql';
import { CatalogEpoch, catalogEpochSelect } from './market-catalog-epoch';
import {
  MARKET_FEATURE_STATE_KEY,
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_MAX_SOURCE_AGE_MS,
} from '../intelligence/market-intelligence.contracts';
import { marketPlatformPaidOrderFloorSql } from '../intelligence/market-intelligence.sql';

export type { CatalogEpoch };
export type CatalogSort = Exclude<MarketSort, 'recommended' | 'relevance'>;
type Tx = Pick<
  Prisma.TransactionClient,
  'marketFeatureEpoch' | 'marketFeatureState' | '$queryRaw'
>;
const ordered = ['newest', 'price_asc', 'price_desc'] as const;
export const MARKET_SORT_FLOORS = Object.freeze({
  popular: 8,
  trending: 8,
  saved: 100,
  paid: 50,
});

/**
 * Every Market-wide floor in one statement. Rows arrive best first, so a floor
 * of N is met exactly when the first N rows all qualify, and each ranked read
 * stops there. Paid orders sit in a CASE arm, counted only when a ranked sales
 * product exists.
 */
export function marketSortEvidenceSql(epochId: string, now: Date): Prisma.Sql {
  const ranked = (
    sort: 'popular' | 'trending' | 'most_saved' | 'best_selling',
    limit: number,
  ) =>
    marketSnapshotPageSql({
      epochId,
      sort,
      filters: {},
      now,
      limit,
      evidence: true,
    });
  return Prisma.sql`SELECT
    (SELECT count(*)::int FROM (${ranked('popular', MARKET_SORT_FLOORS.popular)}) popular WHERE popular.score>0) AS popular,
    (SELECT count(*)::int FROM (${ranked('trending', MARKET_SORT_FLOORS.trending)}) trending WHERE trending."trendEligible") AS trending,
    (SELECT count(*)::int FROM (${ranked('most_saved', MARKET_SORT_FLOORS.saved)}) saved WHERE saved.score>0) AS saved,
    CASE WHEN EXISTS(${ranked('best_selling', 1)}) THEN (${marketPlatformPaidOrderFloorSql(now)}) ELSE 0 END AS paid`;
}

/**
 * `probe: false` validates the epoch but skips the whole-catalogue evidence
 * read. Use it only when a verified cursor already fixes an ordered sort; the
 * result then lists just the always-available ordered sorts.
 */
export async function marketSortAvailability(
  tx: Tx,
  now: Date,
  cursor: MarketCursorState | null,
  options: {
    readonly probe: boolean;
    /** Read with the request clock; undefined means it was not captured. */
    readonly currentEpoch?: CatalogEpoch | null;
  } = { probe: true },
) {
  let epoch: CatalogEpoch | null;
  if (cursor?.epoch)
    epoch =
      options.currentEpoch?.id === cursor.epoch.id
        ? options.currentEpoch
        : await tx.marketFeatureEpoch.findUnique({
            where: { id: cursor.epoch.id },
            select: catalogEpochSelect,
          });
  else if (options.currentEpoch !== undefined) epoch = options.currentEpoch;
  else
    epoch =
      (
        await tx.marketFeatureState.findUnique({
          where: { key: MARKET_FEATURE_STATE_KEY },
          select: { currentEpoch: { select: catalogEpochSelect } },
        })
      )?.currentEpoch ?? null;
  const parameters = epoch?.parameters;
  const compatible =
    parameters &&
    typeof parameters === 'object' &&
    !Array.isArray(parameters) &&
    Object.keys(parameters).length ===
      Object.keys(MARKET_FEATURE_PARAMETERS).length &&
    Object.entries(MARKET_FEATURE_PARAMETERS).every(
      ([key, value]) => (parameters as Record<string, unknown>)[key] === value,
    );
  if (
    !epoch ||
    epoch.stateKey !== MARKET_FEATURE_STATE_KEY ||
    epoch.status !== 'READY' ||
    epoch.readyAt === null ||
    epoch.readyAt > now ||
    epoch.sourceAsOf > now ||
    epoch.sourceAsOf.getTime() <=
      now.getTime() - MARKET_FEATURE_MAX_SOURCE_AGE_MS ||
    epoch.epochStart > now ||
    epoch.acceptUntil <= now ||
    epoch.featureSchemaVersion !== 1 ||
    epoch.policyVersion !== 1 ||
    !compatible ||
    (cursor?.epoch &&
      (cursor.epoch.generation !== epoch.generation.toString() ||
        cursor.epoch.featureVersion !== epoch.featureSchemaVersion ||
        cursor.epoch.policyVersion !== epoch.policyVersion))
  )
    epoch = null;
  const available: CatalogSort[] = [...ordered];
  if (!epoch) return { available, epoch: null, currentMissing: true };
  if (!options.probe) return { available, epoch, currentMissing: false };
  // Owner decision: sample floors use the whole eligible Market, not a filter's
  // narrowed result count. The eventual results still use every selected filter.
  const evidence = await tx.$queryRaw<
    Array<{ popular: number; trending: number; saved: number; paid: number }>
  >(marketSortEvidenceSql(epoch.id, now));
  const counts = evidence[0];
  if (!counts) throw new Error('Catalogue sort evidence unavailable');
  if (counts.popular >= MARKET_SORT_FLOORS.popular) available.push('popular');
  if (counts.trending >= MARKET_SORT_FLOORS.trending)
    available.push('trending');
  if (counts.saved >= MARKET_SORT_FLOORS.saved) available.push('most_saved');
  if (counts.paid >= MARKET_SORT_FLOORS.paid) available.push('best_selling');
  return { available, epoch, currentMissing: false };
}

export function selectMarketSort(
  requested: MarketSort,
  available: readonly CatalogSort[],
): CatalogSort {
  if (requested === 'popular')
    return available.includes('popular') ? 'popular' : 'newest';
  if (!available.includes(requested as CatalogSort))
    throw new BadRequestException({
      code: 'UNSUPPORTED_SORT',
      message: 'Choose an available catalogue sort.',
    });
  return requested as CatalogSort;
}
