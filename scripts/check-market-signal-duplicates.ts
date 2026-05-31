import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaPg } from '@prisma/adapter-pg';
import { createHash } from 'crypto';
import { Pool } from 'pg';

type DuplicateRow = {
  scope: string | null;
  clientEventId: string | null;
  duplicateCount: bigint | number;
};

type DuplicateCheck = {
  label: string;
  rows: DuplicateRow[];
};

async function main() {
  const datasourceUrl = process.env.DATABASE_URL;
  if (!datasourceUrl) {
    throw new Error('DATABASE_URL is required for duplicate preflight checks.');
  }

  const pool = new Pool({ connectionString: datasourceUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

  const checks: DuplicateCheck[] = [
    {
      label: 'user_feed_signals:user',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "userId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "user_feed_signals"
        WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "userId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'user_feed_signals:anonymous',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "anonymousSessionId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "user_feed_signals"
        WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "anonymousSessionId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'user_seen_items:user',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "userId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "user_seen_items"
        WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "userId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'user_seen_items:anonymous',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "anonymousSessionId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "user_seen_items"
        WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "anonymousSessionId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'market_section_signals:user',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "userId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "market_section_signals"
        WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "userId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'market_section_signals:anonymous',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "anonymousSessionId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "market_section_signals"
        WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "anonymousSessionId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'suggestion_signals:user',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "userId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "suggestion_signals"
        WHERE "userId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "userId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
    {
      label: 'suggestion_signals:anonymous',
      rows: await prisma.$queryRaw<DuplicateRow[]>`
        SELECT "anonymousSessionId" AS scope, "clientEventId", COUNT(*) AS "duplicateCount"
        FROM "suggestion_signals"
        WHERE "anonymousSessionId" IS NOT NULL AND "clientEventId" IS NOT NULL
        GROUP BY "anonymousSessionId", "clientEventId"
        HAVING COUNT(*) > 1
        ORDER BY COUNT(*) DESC
        LIMIT 20
      `,
    },
  ];

  const duplicateGroups = checks.reduce(
    (total, check) => total + check.rows.length,
    0,
  );

  const report = checks.map((check) => ({
    label: check.label,
    duplicateGroups: check.rows.length,
    maxDuplicateCount: check.rows.reduce(
      (max, row) => Math.max(max, Number(row.duplicateCount)),
      0,
    ),
    samples: check.rows.slice(0, 5).map((row) => ({
      fingerprint: fingerprint(`${row.scope ?? ''}:${row.clientEventId ?? ''}`),
      duplicateCount: Number(row.duplicateCount),
    })),
  }));

  console.log(JSON.stringify({ duplicateGroups, checks: report }, null, 2));

  if (duplicateGroups > 0) {
    process.exitCode = 1;
  }

  await prisma.$disconnect();
  await pool.end();
}

function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        error: 'market_signal_duplicate_check_failed',
        message:
          error instanceof Error
            ? error.message
            : 'Unknown duplicate check failure',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
