import { Prisma } from '@prisma/client';
import { MARKET_FEATURE_STATE_KEY } from '../intelligence/market-intelligence.contracts';

export const catalogEpochSelect = {
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
  select: typeof catalogEpochSelect;
}>;

/** The current epoch as one JSON column, so it can travel with another read. */
export function marketCurrentEpochJsonSql(): Prisma.Sql {
  return Prisma.sql`(SELECT jsonb_build_object('id',epoch.id,'stateKey',epoch."stateKey",'generation',epoch.generation::text,'status',epoch.status,
      'epochStart',epoch."epochStart",'epochEnd',epoch."epochEnd",'acceptUntil',epoch."acceptUntil",'sourceAsOf',epoch."sourceAsOf",'readyAt',epoch."readyAt",
      'featureSchemaVersion',epoch."featureSchemaVersion",'policyVersion',epoch."policyVersion",'parameters',epoch.parameters)
    FROM market_feature_state state JOIN market_feature_epochs epoch ON epoch.id=state."currentEpochId" AND epoch."stateKey"=state.key
    WHERE state.key=${MARKET_FEATURE_STATE_KEY})`;
}

const instant = (value: unknown): Date => {
  const date = typeof value === 'string' ? new Date(value) : new Date(NaN);
  if (!Number.isFinite(date.getTime()))
    throw new Error('Catalogue epoch clock unavailable');
  return date;
};

/** Restores the exact Prisma payload; a malformed row is an error, not "none". */
export function parseCatalogEpoch(value: unknown): CatalogEpoch | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || Array.isArray(value))
    throw new Error('Catalogue epoch unavailable');
  const row = value as Record<string, unknown>;
  return {
    id: row.id as string,
    stateKey: row.stateKey as string,
    generation: BigInt(row.generation as string),
    status: row.status as CatalogEpoch['status'],
    epochStart: instant(row.epochStart),
    epochEnd: instant(row.epochEnd),
    acceptUntil: instant(row.acceptUntil),
    sourceAsOf: instant(row.sourceAsOf),
    readyAt: row.readyAt === null ? null : instant(row.readyAt),
    featureSchemaVersion: row.featureSchemaVersion as number,
    policyVersion: row.policyVersion as number,
    parameters: row.parameters as Prisma.JsonValue,
  };
}
