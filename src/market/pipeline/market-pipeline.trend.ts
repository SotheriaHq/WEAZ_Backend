import { Prisma } from '@prisma/client';
const aliases = { f: Prisma.sql`f`, entry: Prisma.sql`entry` } as const;
/** Raw velocity ratio, not ln(T), its actor-confidence multiplier or a
 * candidate-relative policy blend. Missing first-entry evidence is unknown. */
export function pipelineTrendRatioSql(alias: keyof typeof aliases): Prisma.Sql {
  if (!Object.prototype.hasOwnProperty.call(aliases, alias))
    throw new RangeError('Invalid trend source alias');
  const f = aliases[alias];
  return Prisma.sql`CASE WHEN ${f}."sourceFeatureSchemaVersion"=1 AND ${f}."sourcePolicyVersion"=1
    AND ${f}."intent3d">=0 AND ${f}."intent3d"<'Infinity'::float8 AND ${f}."intent28d">=${f}."intent3d" AND ${f}."intent28d"<'Infinity'::float8
    AND ${f}.coverage->'intent3d'->>'completeness'='COMPLETE' AND ${f}.coverage->'intent28d'->>'completeness'='COMPLETE'
    AND (${f}.coverage->'intent3d'->>'requiredWindowEnd')::timestamptz=${f}."sourceAsOf"
    AND (${f}.coverage->'intent28d'->>'requiredWindowEnd')::timestamptz=${f}."sourceAsOf"
    AND (${f}.coverage->'intent3d'->>'requiredWindowStart')::timestamptz<=${f}."sourceAsOf"-interval '3 days'
    AND (${f}.coverage->'intent28d'->>'requiredWindowStart')::timestamptz<=${f}."sourceAsOf"-interval '28 days'
    THEN (${f}."intent3d"+1.0)/(((${f}."intent28d"-${f}."intent3d")/25.0)*3.0+2.0) END`;
}
