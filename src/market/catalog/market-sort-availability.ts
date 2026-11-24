import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { MarketCursorState, MarketSort } from './market-cursor';
import { marketSnapshotPageSql } from './market-snapshot-order.sql';
import {
  MARKET_FEATURE_STATE_KEY,
  MARKET_FEATURE_PARAMETERS,
  MARKET_FEATURE_MAX_SOURCE_AGE_MS,
} from '../intelligence/market-intelligence.contracts';
import { marketPlatformPaidOrderFloorSql } from '../intelligence/market-intelligence.sql';

const epochSelect = {
  id: true,
  stateKey: true,
  generation: true,
  status: true,
  epochStart: true,
  epochEnd: true,
  acceptUntil: true,
  sourceAsOf: true,
  readyAt: true,
  featureSchemaVersion: true,
  policyVersion: true,
  parameters: true,
} satisfies Prisma.MarketFeatureEpochSelect;
export type CatalogEpoch = Prisma.MarketFeatureEpochGetPayload<{
  select: typeof epochSelect;
}>;
export type CatalogSort = Exclude<MarketSort, 'recommended' | 'relevance'>;
type Tx = Pick<
  Prisma.TransactionClient,
  'marketFeatureEpoch' | 'marketFeatureState' | '$queryRaw'
>;
const ordered = ['newest', 'price_asc', 'price_desc'] as const;

/**
 * `probe: false` validates the epoch but skips the whole-catalogue evidence
 * probes. Use it only when a verified cursor already fixes an ordered sort; the
 * result then lists just the always-available ordered sorts.
 */
export async function marketSortAvailability(
  tx: Tx,
  now: Date,
  cursor: MarketCursorState | null,
  options: { readonly probe: boolean } = { probe: true },
) {
  let epoch = cursor?.epoch
    ? await tx.marketFeatureEpoch.findUnique({
        where: { id: cursor.epoch.id },
        select: epochSelect,
      })
    : ((
        await tx.marketFeatureState.findUnique({
          where: { key: MARKET_FEATURE_STATE_KEY },
          select: { currentEpoch: { select: epochSelect } },
        })
      )?.currentEpoch ?? null);
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
  const page = (
    sort: 'popular' | 'trending' | 'most_saved' | 'best_selling',
    after?: readonly (number | string | null)[],
  ) =>
    tx.$queryRaw<
      Array<{
        id: string;
        score: number;
        trendEligible?: boolean;
        trendScore?: number | null;
      }>
    >(
      marketSnapshotPageSql({
        epochId: epoch!.id,
        sort,
        filters: {},
        now,
        limit: 61,
        after,
      }),
    );
  // Owner decision: sample floors use the whole eligible Market, not a filter's
  // narrowed result count. The eventual results still use every selected filter.
  const popular = await page('popular');
  if (popular.filter((row) => row.score > 0).length >= 8)
    available.push('popular');
  const trending = await page('trending');
  if (trending.filter((row) => row.trendEligible).length >= 8)
    available.push('trending');
  const saved = await page('most_saved');
  let savedCount = saved.filter((row) => row.score > 0).length;
  if (savedCount === 61) {
    const last = saved[saved.length - 1];
    savedCount += (await page('most_saved', [last.score, last.id])).filter(
      (row) => row.score > 0,
    ).length;
  }
  if (savedCount >= 100) available.push('most_saved');
  if ((await page('best_selling')).length) {
    const paid = await tx.$queryRaw<Array<{ count: number }>>(
      marketPlatformPaidOrderFloorSql(now),
    );
    if (paid[0]?.count === 50) available.push('best_selling');
  }
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
