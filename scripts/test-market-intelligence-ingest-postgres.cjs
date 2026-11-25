// Actual production services; all data belongs to one fresh loopback database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const {
  PrismaClient,
  MarketSignalType,
  MarketSignalSurface,
  MarketSignalTargetType,
} = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
// Explicit constructors below need no Nest reflection graph. Source semantics
// and full typechecking are validated separately by the integrated backend gate.
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { emitDecoratorMetadata: false },
});
require('tsconfig-paths/register');
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const { MarketSignalService } = require('../src/market/market-signal.service');
const {
  MarketSignalAggregationService,
} = require('../src/market/market-signal-aggregation.service');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_ingest_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_ingest_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({
    connectionString: withUtcDatabaseUrl(target.toString()),
  });
  let created = false,
    connected = false,
    prisma,
    checks = 0;
  const check = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    await db.query(
      "SET statement_timeout='10s'; SET lock_timeout='1s'; SET timezone='UTC'; CREATE EXTENSION IF NOT EXISTS pg_trgm",
    );
    // Minimal current column/enum contract, not a migration replay. These tests
    // execute real production Prisma/service writes and PostgreSQL row locks.
    for (const [name, values] of Object.entries({
      MarketSignalType,
      MarketSignalSurface,
      MarketSignalTargetType,
    })) {
      assert(/^[A-Za-z]+$/.test(name));
      assert(Object.values(values).every((value) => /^[A-Z_]+$/.test(value)));
      await db.query(
        'CREATE TYPE "' +
          name +
          '" AS ENUM (' +
          Object.values(values)
            .map((value) => "'" + value + "'")
            .join(',') +
          ')',
      );
    }
    const common =
      '"_id" uuid PRIMARY KEY,"userId" uuid,"anonymousSessionId" varchar(128),"clientEventId" varchar(128),"signalType" "MarketSignalType" NOT NULL,value double precision,surface "MarketSignalSurface","screenContext" varchar(120),"sessionId" varchar(128),"batchId" varchar(128),metadata jsonb,"createdAt" timestamp(3) NOT NULL DEFAULT now()';
    await db.query(`
      CREATE TABLE "User"("_id" uuid PRIMARY KEY,status text NOT NULL DEFAULT 'ACTIVE',"deactivatedAt" timestamp(3));
      CREATE TABLE user_feed_signals(${common},"targetType" "MarketSignalTargetType" NOT NULL,"targetId" varchar(128) NOT NULL,"sectionKey" varchar(80),"suggestionBlockKey" varchar(80),position int);
      CREATE TABLE user_seen_items("_id" uuid PRIMARY KEY,"userId" uuid,"anonymousSessionId" varchar(128),"clientEventId" varchar(128),"targetType" "MarketSignalTargetType" NOT NULL,"targetId" varchar(128) NOT NULL,surface "MarketSignalSurface" NOT NULL,"sectionKey" varchar(80),"suggestionBlockKey" varchar(80),"sessionId" varchar(128),"batchId" varchar(128),"seenAt" timestamp(3) NOT NULL,"createdAt" timestamp(3) NOT NULL DEFAULT now());
      CREATE TABLE market_section_signals(${common},"sectionKey" varchar(80) NOT NULL);
      CREATE TABLE suggestion_signals(${common},"blockKey" varchar(80) NOT NULL,"targetType" "MarketSignalTargetType","targetId" varchar(128));
      CREATE TABLE market_signal_batch_receipts("_id" uuid PRIMARY KEY,"userId" uuid,"anonymousSessionId" varchar(128),"batchId" varchar(128) NOT NULL,received int NOT NULL DEFAULT 0,persisted jsonb,"createdAt" timestamp(3) NOT NULL DEFAULT now(),UNIQUE("userId","batchId"),UNIQUE("anonymousSessionId","batchId"));
      CREATE TABLE market_signal_aggregate_daily("_id" uuid PRIMARY KEY,"aggregateKey" varchar(512) UNIQUE NOT NULL,"bucketDate" timestamp(3) NOT NULL,"userId" uuid,"anonymousSessionId" varchar(128),surface "MarketSignalSurface","sectionKey" varchar(80),"suggestionBlockKey" varchar(80),"targetType" "MarketSignalTargetType","targetId" varchar(128),"sectionImpressions" int NOT NULL DEFAULT 0,"itemImpressions" int NOT NULL DEFAULT 0,"productOpens" int NOT NULL DEFAULT 0,"itemOpens" int NOT NULL DEFAULT 0,clicks int NOT NULL DEFAULT 0,"viewAllClicks" int NOT NULL DEFAULT 0,suppressions int NOT NULL DEFAULT 0,"seenItems" int NOT NULL DEFAULT 0,"eventCount" int NOT NULL DEFAULT 0,"latestSeenAt" timestamp(3),"createdAt" timestamp(3) NOT NULL DEFAULT now(),"updatedAt" timestamp(3) NOT NULL);
      CREATE INDEX ON user_feed_signals("userId","createdAt");
      CREATE INDEX ON user_feed_signals("anonymousSessionId","createdAt");
    `);
    const createUser = async ({ data }) => {
      await db.query('INSERT INTO "User"("_id") VALUES($1)', [data.id]);
      return { id: data.id };
    };
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: withUtcDatabaseUrl(target.toString()),
      }),
    });
    const aggregation = new MarketSignalAggregationService(prisma);
    const service = new MarketSignalService(prisma, aggregation);
    const event = (clientEventId) => ({
      clientEventId,
      targetType: MarketSignalTargetType.PRODUCT,
      targetId: 'fixture-product',
      signalType: MarketSignalType.IMPRESSION,
      surface: MarketSignalSurface.MARKET_HOME,
      sectionKey: 'fixture',
    });
    const countEvents = (identity) =>
      prisma.userFeedSignal.count({ where: identity });
    const countGlobal = async () =>
      Number(
        (
          await db.query(
            'SELECT COALESCE(sum("eventCount"),0)::int AS total FROM market_signal_aggregate_daily',
          )
        ).rows[0].total,
      );

    const isBusy = (error) =>
      error.getStatus?.() === 503 &&
      error.getResponse?.().code === 'MARKET_SIGNALS_BUSY';
    // Clients keep a batch queued after a busy 503 and send it again. Only that
    // response is retried here; any other failure still fails the proof.
    const ingestAsClient = async (...args) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await service.ingestBatch(...args);
        } catch (error) {
          if (attempt >= 8 || !isBusy(error)) throw error;
          await new Promise((resolve) => setTimeout(resolve, 50 << attempt));
        }
      }
    };
    const guest = 'fixture-guest-' + randomUUID();
    const before = await countGlobal();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        ingestAsClient(
          { batchId: 'same-batch', events: [event('same-event')] },
          { anonymousSessionId: guest },
        ),
      ),
    );
    check(
      results.filter((result) => !result.duplicate).length,
      1,
      'Exactly one concurrent guest batch acknowledged as new',
    );
    check(
      await countEvents({ anonymousSessionId: guest }),
      1,
      'Guest replay inserts one canonical event',
    );
    check(
      await prisma.userSeenItem.count({ where: { anonymousSessionId: guest } }),
      1,
      'Guest replay inserts one projection',
    );
    check(
      await prisma.marketSignalBatchReceipt.count({
        where: { anonymousSessionId: guest },
      }),
      1,
      'Guest replay inserts one receipt',
    );
    check(
      (await countGlobal()) - before,
      1,
      'Guest replay contributes once globally',
    );

    const secondGuest = 'fixture-events-' + randomUUID();
    const eventBefore = await countGlobal();
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        ingestAsClient(
          { batchId: 'batch-' + index, events: [event('shared-event')] },
          { anonymousSessionId: secondGuest },
        ),
      ),
    );
    check(
      await countEvents({ anonymousSessionId: secondGuest }),
      1,
      'Different batches cannot duplicate the same guest event',
    );
    check(
      (await countGlobal()) - eventBefore,
      1,
      'Different batch race cannot duplicate global contribution',
    );

    const user = await createUser({
      data: {
        id: randomUUID(),
        username: 'privacy-race-' + randomUUID(),
        email: randomUUID() + '@fixture.invalid',
        status: 'ACTIVE',
      },
    });
    // Deletion wins the account row lock first. Ingest must inspect the freshly
    // committed state after waiting, not a stale pre-lock actor snapshot.
    await db.query('BEGIN');
    await db.query('SELECT "_id" FROM "User" WHERE "_id"=$1 FOR UPDATE', [
      user.id,
    ]);
    await db.query(
      'UPDATE "User" SET status=\'DEACTIVATED\',"deactivatedAt"=now() WHERE "_id"=$1',
      [user.id],
    );
    const denied = service.ingestBatch(
      { batchId: 'deleted', events: [event('deleted-event')] },
      { userId: user.id },
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    await db.query('COMMIT');
    await assert.rejects(denied, (error) => error.getStatus?.() === 403);
    checks++;
    check(
      await countEvents({ userId: user.id }),
      0,
      'Deletion-first cannot resurrect raw history',
    );
    check(
      await prisma.marketSignalBatchReceipt.count({
        where: { userId: user.id },
      }),
      0,
      'Deletion-first never acknowledges a receipt',
    );

    // Ingestion wins first. Deletion must wait on the same account row until
    // ingestion commits, then remove that entire actor's freshly committed rows.
    const survivor = await createUser({
      data: {
        id: randomUUID(),
        username: 'ingest-first-' + randomUUID(),
        email: randomUUID() + '@fixture.invalid',
        status: 'ACTIVE',
      },
    });
    let releaseAggregation, reachedAggregation;
    const reached = new Promise((resolve) => {
      reachedAggregation = resolve;
    });
    const release = new Promise((resolve) => {
      releaseAggregation = resolve;
    });
    const heldService = new MarketSignalService(prisma, {
      aggregateBatch: async (...args) => {
        reachedAggregation();
        await release;
        return aggregation.aggregateBatch(...args);
      },
    });
    const writing = heldService.ingestBatch(
      { batchId: 'ingest-first', events: [event('ingest-first')] },
      { userId: survivor.id },
    );
    await reached;
    await db.query('BEGIN');
    const deleting = db.query(
      'UPDATE "User" SET status=\'DEACTIVATED\',"deactivatedAt"=now() WHERE "_id"=$1',
      [survivor.id],
    );
    releaseAggregation();
    await writing;
    await deleting;
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ])
      await db.query('DELETE FROM ' + table + ' WHERE "userId"=$1', [
        survivor.id,
      ]);
    await db.query('COMMIT');
    check(
      await countEvents({ userId: survivor.id }),
      0,
      'Ingest-first deletion removes committed raw data',
    );
    check(
      await prisma.userSeenItem.count({ where: { userId: survivor.id } }),
      0,
      'Ingest-first deletion removes projections',
    );
    await assert.rejects(
      service.ingestBatch(
        { events: [event('post-erasure')] },
        { userId: survivor.id },
      ),
      (error) => error.getStatus?.() === 403,
    );
    checks++;

    // Global counters retain totals while old arrivals cannot move freshness
    // backwards, and reversed bucket batches share one deterministic lock order.
    const aggregateEvent = {
      targetType: MarketSignalTargetType.PRODUCT,
      targetId: 'latest-fixture',
      signalType: MarketSignalType.IMPRESSION,
      surface: MarketSignalSurface.MARKET_HOME,
    };
    const collisions = [
      {
        ...aggregateEvent,
        targetId: 'collision-fixture',
        sectionKey: 'a|b',
        suggestionBlockKey: 'c',
      },
      {
        ...aggregateEvent,
        targetId: 'collision-fixture',
        sectionKey: 'a',
        suggestionBlockKey: 'b|c',
      },
    ];
    await aggregation.aggregateBatch(
      [collisions[0], collisions[1], collisions[0]],
      {},
      new Date(),
    );
    const collisionRows = await prisma.marketSignalAggregateDaily.findMany({
      where: { targetId: 'collision-fixture' },
    });
    check(
      collisionRows.length,
      2,
      'Delimiter-bearing tuples persist as distinct global buckets',
    );
    check(
      collisionRows.map((row) => row.eventCount).sort(),
      [1, 2],
      'Identical tuple contributions merge deterministically',
    );
    const latest = new Date(),
      older = new Date(latest.getTime() - 1000);
    await aggregation.aggregateBatch([aggregateEvent], {}, latest);
    await aggregation.aggregateBatch([aggregateEvent], {}, older);
    const latestRow = await prisma.marketSignalAggregateDaily.findFirst({
      where: { targetId: 'latest-fixture' },
    });
    check(latestRow.eventCount, 2, 'Late aggregate increments retained count');
    check(
      latestRow.latestSeenAt.toISOString(),
      latest.toISOString(),
      'Late aggregate never regresses latestSeenAt',
    );
    const pair = [
      { ...aggregateEvent, targetId: 'ordered-a' },
      { ...aggregateEvent, targetId: 'ordered-b' },
    ];
    await Promise.all([
      aggregation.aggregateBatch(pair, {}, latest),
      aggregation.aggregateBatch([...pair].reverse(), {}, latest),
    ]);
    const paired = await prisma.marketSignalAggregateDaily.findMany({
      where: { targetId: { in: ['ordered-a', 'ordered-b'] } },
      orderBy: { targetId: 'asc' },
    });
    check(
      paired.map((row) => row.eventCount),
      [2, 2],
      'Opposite input orders increment both shared buckets without deadlock',
    );

    // Rejected projection must roll back canonical inserts, counters and receipt.
    await db.query(
      `ALTER TABLE user_seen_items ADD CONSTRAINT fixture_reject_projection CHECK("clientEventId"<>'reject-projection')`,
    );
    const rollbackGuest = 'fixture-rollback-' + randomUUID(),
      rollbackBefore = await countGlobal();
    await assert.rejects(
      service.ingestBatch(
        { batchId: 'rollback', events: [event('reject-projection')] },
        { anonymousSessionId: rollbackGuest },
      ),
    );
    checks++;
    check(
      await countEvents({ anonymousSessionId: rollbackGuest }),
      0,
      'Projection failure rolls back canonical event',
    );
    check(
      await prisma.marketSignalBatchReceipt.count({
        where: { anonymousSessionId: rollbackGuest },
      }),
      0,
      'Projection failure rolls back receipt',
    );
    check(
      await countGlobal(),
      rollbackBefore,
      'Projection failure changes no aggregate',
    );
    await db.query(
      'ALTER TABLE user_seen_items DROP CONSTRAINT fixture_reject_projection',
    );

    // Aggregate failure occurs after projections; every earlier write rolls back.
    await db.query(
      `ALTER TABLE market_signal_aggregate_daily ADD CONSTRAINT fixture_reject_aggregate CHECK("targetId"<>'reject-aggregate')`,
    );
    const failedGuest = 'fixture-aggregate-' + randomUUID();
    await assert.rejects(
      service.ingestBatch(
        {
          batchId: 'aggregate-fail',
          events: [
            {
              ...event('reject-aggregate-event'),
              targetId: 'reject-aggregate',
            },
          ],
        },
        { anonymousSessionId: failedGuest },
      ),
    );
    checks++;
    check(
      await countEvents({ anonymousSessionId: failedGuest }),
      0,
      'Aggregate failure rolls back canonical event',
    );
    check(
      await prisma.userSeenItem.count({
        where: { anonymousSessionId: failedGuest },
      }),
      0,
      'Aggregate failure rolls back projection',
    );
    check(
      await prisma.marketSignalBatchReceipt.count({
        where: { anonymousSessionId: failedGuest },
      }),
      0,
      'Aggregate failure has no accepted receipt',
    );
    await db.query(
      'ALTER TABLE market_signal_aggregate_daily DROP CONSTRAINT fixture_reject_aggregate',
    );

    // Lock timeout is bounded and leaves no partial receipt; next request works.
    const blocked = await createUser({
      data: {
        id: randomUUID(),
        username: 'blocked-' + randomUUID(),
        email: randomUUID() + '@fixture.invalid',
        status: 'ACTIVE',
      },
    });
    await db.query('BEGIN');
    await db.query('SELECT "_id" FROM "User" WHERE "_id"=$1 FOR UPDATE', [
      blocked.id,
    ]);
    const lockStarted = performance.now();
    await assert.rejects(
      service.ingestBatch(
        { batchId: 'blocked', events: [event('blocked-event')] },
        { userId: blocked.id },
      ),
      isBusy,
    );
    checks++;
    assert(
      performance.now() - lockStarted < 1500,
      'Account lock bounded to short acquisition, not transaction ceiling',
    );
    checks++;
    await db.query('ROLLBACK');
    check(
      await countEvents({ userId: blocked.id }),
      0,
      'Timed-out lock writes nothing',
    );
    const recovered = await service.ingestBatch(
      { batchId: 'recovered', events: [event('recovered-event')] },
      { userId: blocked.id },
    );
    check(
      recovered.persisted.userFeedSignals,
      1,
      'Service and pool recover after timeout',
    );
    check(
      await prisma.marketSignalAggregateDaily.count({
        where: {
          OR: [
            { userId: { not: null } },
            { anonymousSessionId: { not: null } },
          ],
        },
      }),
      0,
      'Only global aggregates exist',
    );
    console.log(
      `PASS ${checks} actual PostgreSQL ingestion/dedupe/erasure/rollback/lock proofs`,
    );
  } finally {
    try {
      if (prisma) await prisma.$disconnect();
    } finally {
      try {
        if (connected) {
          await db.query('ROLLBACK');
          await db.end();
        }
      } finally {
        try {
          if (created) {
            assert(/^aru_market_ingest_[a-f0-9]{32}$/.test(name));
            assert.equal(target.pathname, '/' + name);
            await admin.query('DROP DATABASE "' + name + '"');
            check(
              (
                await admin.query(
                  'SELECT 1 FROM pg_database WHERE datname=$1',
                  [name],
                )
              ).rowCount,
              0,
              'Owned database removed',
            );
            console.log(
              'CLEANUP PASS owned disposable database dropped and absence verified',
            );
          }
        } finally {
          await admin.end();
        }
      }
    }
  }
}
main().catch((error) => {
  const redact = (text) =>
    String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]');
  console.error(error.name + ': ' + redact(error.message));
  // Frames only: they name the failing step without repeating SQL or values.
  console.error(
    redact(error.stack)
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 12)
      .join('\n'),
  );
  process.exitCode = 1;
});
