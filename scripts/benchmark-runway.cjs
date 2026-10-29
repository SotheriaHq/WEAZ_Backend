/* Isolated local PostgreSQL benchmark. Never connects to a remote database. */
require('dotenv').config({ quiet: true });
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { Client, Pool } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { RunwayFeedService } = require('../src/collections/runway-feed.service');
const { randomUUID } = require('crypto');
require('@nestjs/common').Logger.overrideLogger(['error', 'warn']);
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Benchmark requires local PostgreSQL.');
const name = `wiez_bench_${Date.now()}`;
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const testUrl = new URL(url);
testUrl.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.toString() });
let prisma, pool;
const captured = new Map();
const report = {
  generatedAt: new Date().toISOString(),
  sourceHashes: Object.fromEntries(
    [
      'src/collections/runway-feed.service.ts',
      'src/collections/runway-ranking.util.ts',
    ].map((file) => [
      file,
      require('crypto')
        .createHash('sha256')
        .update(fs.readFileSync(file))
        .digest('hex'),
    ]),
  ),
  runtime: {
    node: process.version,
    platform: process.platform,
    cpu: require('os').cpus()[0]?.model,
    logicalCpus: require('os').cpus().length,
    memoryGiB: require('os').totalmem() / 1073741824,
    poolConnections: 10,
  },
  scope:
    'Local PostgreSQL service/query benchmark; excludes HTTP, images, network and device rendering.',
  fixture: {
    brands: 100,
    shoppers: 21,
    savesPerShopper: 25,
    structuredFacetCoverage: 0.1,
    fitValues: 8,
    sharedReadyUploads: 1,
    bulkIndexBuild: true,
  },
  results: [],
};
const percentile = (values, p) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  ];
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  pool = new Pool({ connectionString: testUrl.toString(), max: 10 });
  const schema = execFileSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      'prisma/schema.prisma',
      '--script',
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  await pool.query(schema);
  await pool.query(
    fs.readFileSync(
      'prisma/migrations/20260309191500_add_search_fts_foundation/migration.sql',
      'utf8',
    ),
  );
  const indexes = fs.readFileSync(
    'prisma/migrations/20261021122000_runway_affinity_cache/migration.sql',
    'utf8',
  );
  await pool.query(
    indexes.slice(
      indexes.indexOf('CREATE INDEX \"Collection_runway_fresh_idx\"'),
    ),
  );
  prisma = new PrismaClient({
    adapter: new PrismaPg(pool),
    log: [{ level: 'query', emit: 'event' }],
  });
  prisma.$on('query', (event) => {
    if (
      (event.query.includes('"Collection"') ||
        event.query.includes('"EntityFilter"')) &&
      (event.query.includes('LIMIT') || event.query.includes('ORDER BY')) &&
      !captured.has(event.query)
    )
      captured.set(event.query, {
        query: event.query,
        params: JSON.parse(event.params),
        durationMs: event.duration,
      });
  });
  const shopper = randomUUID();
  await pool.query(
    `INSERT INTO "User" ("_id", username,email,type,"updatedAt") SELECT md5('bench-u-'||i)::uuid,'brand-'||i,'brand-'||i||'@example.invalid','BRAND',NOW() FROM generate_series(1,100) i`,
  );
  await pool.query(
    `INSERT INTO "Brand" ("_id",name,"ownerId",country,"isStoreOpen","verificationStatus","updatedAt") SELECT md5('bench-b-'||i)::uuid,'Brand '||i,md5('bench-u-'||i)::uuid,'Nigeria',true,'APPROVED',NOW() FROM generate_series(1,100) i`,
  );
  await pool.query(
    `INSERT INTO "User" ("_id",username,email,"updatedAt") VALUES ($1,'shopper','shopper@example.invalid',NOW())`,
    [shopper],
  );
  const shoppers = Array.from({ length: 20 }, () => randomUUID());
  await pool.query(
    `INSERT INTO "User" ("_id",username,email,"updatedAt") SELECT id,'shopper-'||ordinality,'shopper-'||ordinality||'@example.invalid',NOW() FROM unnest($1::uuid[]) WITH ORDINALITY AS t(id,ordinality)`,
    [shoppers],
  );
  const upload = randomUUID();
  await pool.query(
    `INSERT INTO "FileUpload" ("_id","userId","originalName","fileName","s3Key","s3Url","fileType","mimeType",size,"processingStatus","updatedAt") VALUES ($1,md5('bench-u-1')::uuid,'fixture.jpg','fixture.jpg','bench/fixture.jpg','https://example.invalid/fixture.jpg','POST_IMAGE','image/jpeg',1000,'READY',NOW())`,
    [upload],
  );
  const service = new RunwayFeedService(prisma);
  const where = {
    domain: 'DESIGN',
    status: 'PUBLISHED',
    visibility: 'PUBLIC',
    deletedAt: null,
    owner: { status: 'ACTIVE' },
    medias: {
      some: {
        file: {
          processingStatus: 'READY',
          originalDeletedAt: null,
          s3Url: { not: '' },
        },
      },
    },
  };
  const dimension = randomUUID();
  const featureIds = Array.from({ length: 8 }, () => randomUUID());
  await pool.query(
    'INSERT INTO "FilterDimension" ("_id",slug,name,"updatedAt") VALUES ($1,\'fixture-fit\',\'Fixture fit\',NOW())',
    [dimension],
  );
  await pool.query(
    `INSERT INTO "FilterValue" ("_id","dimensionId",slug,name,"updatedAt") SELECT id,$2::uuid,'fit-'||ordinality,'Fit '||ordinality,NOW() FROM unnest($1::uuid[]) WITH ORDINALITY AS f(id,ordinality)`,
    [featureIds, dimension],
  );
  const bulkIndexes = (
    await pool.query(
      `SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename IN ('Collection','CollectionMedia','EntityFilter') AND indexdef NOT LIKE '%UNIQUE INDEX%'`,
    )
  ).rows;
  let previous = 0;
  const sizes = process.env.WIEZ_BENCH_SIZES
    ? process.env.WIEZ_BENCH_SIZES.split(',').map(Number)
    : [10000, 100000];
  for (const size of sizes) {
    if (!Number.isSafeInteger(size) || size <= previous || size > 1000000)
      throw new Error('Invalid benchmark size');
    for (const index of bulkIndexes)
      await pool.query(
        'DROP INDEX "' + index.indexname.replace(/"/g, '""') + '"',
      );
    await pool.query(
      `INSERT INTO "Collection" ("_id","ownerId",domain,title,status,visibility,tags,"likesCount","createdAt","updatedAt") SELECT md5('bench-d-'||i)::uuid,md5('bench-u-'||(1+i%100))::uuid,'DESIGN',CASE WHEN i%1000=0 THEN 'Rare Adire Casual' ELSE 'Everyday fashion '||i END,'PUBLISHED','PUBLIC',ARRAY['casual-style','african-fashion'],i%71,NOW()-i*INTERVAL '1 second',NOW() FROM generate_series($1::int,$2::int) i`,
      [previous + 1, size],
    );
    await pool.query(
      `INSERT INTO "CollectionMedia" ("_id","collectionId","fileUploadId","mediaType") SELECT md5('bench-m-'||i)::uuid,md5('bench-d-'||i)::uuid,$3::uuid,'POST_IMAGE' FROM generate_series($1::int,$2::int) i`,
      [previous + 1, size, upload],
    );
    await pool.query(
      `INSERT INTO "EntityFilter" ("_id","filterValueId","entityType","entityId") SELECT md5('bench-feature-'||i)::uuid,($3::uuid[])[1+i%8],'DESIGN',md5('bench-d-'||i)::uuid FROM generate_series($1::int,$2::int) i WHERE i%10=0`,
      [previous + 1, size, featureIds],
    );
    for (const index of bulkIndexes) await pool.query(index.indexdef);
    for (const table of [
      'Collection',
      'CollectionMedia',
      'User',
      'Brand',
      'EntityFilter',
      'FilterValue',
    ])
      await pool.query(`VACUUM (ANALYZE) \"${table}\"`);
    const fts = {};
    for (const [kind, predicate] of Object.entries({
      before: `COALESCE(search_vector,''::tsvector)`,
      after: 'search_vector',
    })) {
      const plan = await pool.query(
        `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT "_id" FROM "Collection" WHERE ${predicate} @@ to_tsquery('english','rare') LIMIT 20`,
      );
      const value = plan.rows[0]['QUERY PLAN'][0];
      fts[kind] = {
        executionMs: value['Execution Time'],
        plan: JSON.stringify(value.Plan).match(
          /(?:Bitmap Index Scan|Index Scan|Seq Scan)/g,
        ),
      };
    }
    await pool.query(
      `DELETE FROM "SavedItem" WHERE "userId" = ANY($1::uuid[])`,
      [[shopper, ...shoppers]],
    );
    for (const viewer of [shopper, ...shoppers])
      await pool.query(
        `INSERT INTO "SavedItem" ("_id","userId","targetType","targetId") SELECT md5($1||'-save-'||i)::uuid,$1::uuid,'DESIGN',md5('bench-d-'||i)::uuid FROM generate_series(1,25) i`,
        [viewer],
      );
    for (const concurrency of process.env.WIEZ_BENCH_CONCURRENCY
      ? process.env.WIEZ_BENCH_CONCURRENCY.split(',').map(Number)
      : [1, 5, 20]) {
      const durations = [];
      const pages = [];
      let busyResponses = 0;
      for (let batch = 0; batch < 3; batch++)
        await Promise.all(
          Array.from({ length: concurrency }, async (_, index) => {
            const started = performance.now();
            const viewer = concurrency === 1 ? shopper : shoppers[index];
            let first;
            try {
              first = await service.page(
                where,
                viewer,
                'for-you',
                undefined,
                20,
              );
            } catch (error) {
              if (error.getStatus?.() !== 503) throw error;
              busyResponses++;
              return;
            }
            durations.push(performance.now() - started);
            pages.push({ ...first, viewer });
          }),
        );
      const first = pages[0];
      if (!first) throw new Error('No benchmark requests were admitted');
      const nextStart = performance.now();
      const second = await service.page(
        where,
        first.viewer,
        'for-you',
        first.nextCursor,
        20,
      );
      if (first.ids.some((id) => second.ids.includes(id)))
        throw new Error('Pagination duplicated a design');
      report.results.push({
        designs: size,
        concurrency,
        viewerScenario:
          concurrency === 1
            ? 'one-returning-shopper'
            : 'distinct-shoppers-with-saves',
        samples: durations.length,
        requests: concurrency * 3,
        busyResponses,
        p50Ms: percentile(durations, 0.5),
        p95Ms: percentile(durations, 0.95),
        nextPageMs: performance.now() - nextStart,
        fts,
      });
    }
    previous = size;
  }
  report.plans = [];
  for (const query of captured.values()) {
    const plan = await pool.query(
      'EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + query.query,
      query.params,
    );
    report.plans.push({ ...query, plan: plan.rows[0]['QUERY PLAN'] });
  }
  fs.mkdirSync('docs/performance', { recursive: true });
  fs.writeFileSync(
    'docs/performance/runway-local-benchmark.json',
    JSON.stringify(report, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        ...report,
        plans: report.plans.map((p) => ({
          durationMs: p.durationMs,
          executionMs: p.plan[0]['Execution Time'],
        })),
      },
      null,
      2,
    ),
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (prisma) await prisma.$disconnect();
    if (pool) await pool.end();
    if (process.env.WIEZ_BENCH_KEEP_DB === '1')
      console.log('Retained isolated benchmark database: ' + name);
    if (
      process.env.WIEZ_BENCH_KEEP_DB !== '1' &&
      admin._connected &&
      /^wiez_bench_\d+$/.test(name)
    )
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });
