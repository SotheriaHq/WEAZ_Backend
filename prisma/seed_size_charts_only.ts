import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { seedSizeCharts } from './seed_size_charts';

/**
 * Publish the operational size charts, and nothing else.
 *
 * `seedSizeCharts` previously only ran as one step of `prisma/seed.ts`, which
 * seeds the whole database. That is not something anyone can run against an
 * environment with real accounts in it, so on a deployed environment the charts
 * were simply never published — and with no chart rows, `SizeComputationService`
 * has nothing to score against and every shopper's profile answers "standard
 * sizing charts have not been published yet, so a size cannot be estimated".
 *
 * That message is accurate and the shopper can do nothing about it: it is a
 * setup step on our side. This script IS that setup step.
 *
 * Safe to re-run: `upsertApprovedFallbackChart` upserts by
 * (region, garmentCategory, scope) and replaces that version's rows, so running
 * it twice publishes the same charts rather than duplicating them.
 *
 *   npm run seed:size-charts
 *
 * On the SIT box, run it with `TS_NODE_TRANSPILE_ONLY=1` — full type-checking
 * ts-node is what OOMs that host.
 */

const datasourceUrl = process.env.DATABASE_URL;

if (!datasourceUrl) {
  throw new Error('DATABASE_URL must be set to seed size charts.');
}

const pool = new Pool({ connectionString: datasourceUrl });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

/**
 * Count APPROVED charts that actually carry rows.
 *
 * Rows are the whole point: a chart record with none is what produced the
 * "not published yet" message in the first place, so counting charts alone
 * would report success for exactly the broken state this fixes.
 */
async function countUsableCharts() {
  return (prisma as any).sizeChart.count({
    where: {
      status: 'APPROVED',
      versions: { some: { rows: { some: {} } } },
    },
  });
}

async function main() {
  const before = await countUsableCharts();
  await seedSizeCharts(prisma);
  const after = await countUsableCharts();

  console.log(`Approved size charts with rows: before=${before} after=${after}`);

  if (after === 0) {
    throw new Error(
      'Seed completed but no approved chart carries rows — computed sizes will still be unavailable.',
    );
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    await pool.end();
  })
  .catch(async (error) => {
    console.error(error);
    await prisma.$disconnect();
    await pool.end();
    process.exit(1);
  });
