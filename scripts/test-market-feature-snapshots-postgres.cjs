// All fixture writes use a newly created loopback-only database.
const fs = require('node:fs'),
  path = require('node:path'),
  assert = require('node:assert/strict'),
  { randomUUID } = require('node:crypto');
const work = path.resolve(__dirname, '..');
const { Client } = require(path.join(work, 'node_modules/pg')),
  dotenv = require(path.join(work, 'node_modules/dotenv'));
const source = new URL(
  (dotenv.config({ quiet: true }), process.env.DATABASE_URL) || '',
);
if (!['localhost', '127.0.0.1', '[::1]'].includes(source.hostname))
  throw Error('Loopback only');
const name = 'wiez_market_features_' + randomUUID().replaceAll('-', '');
if (!/^wiez_market_features_[a-f0-9]{32}$/.test(name))
  throw Error('Invalid database');
const au = new URL(source);
au.pathname = '/postgres';
const tu = new URL(source);
tu.pathname = '/' + name;
(async () => {
  const admin = new Client({ connectionString: au.toString() });
  await admin.connect();
  let created = false,
    db;
  const proof = [];
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    db = new Client({ connectionString: tu.toString() });
    await db.connect();
    await db.query(
      "CREATE TYPE \"CollectionStatus\" AS ENUM('DRAFT','PUBLISHED','IN_REVIEW','ARCHIVED','REJECTED','CHANGES_REQUESTED')",
    );
    await db.query(
      'CREATE TABLE "Product" ("_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),name text NOT NULL DEFAULT \'Piece\',price numeric(10,2) NOT NULL DEFAULT 100,"salePrice" numeric(10,2),"saleStartAt" timestamp(3),"saleEndAt" timestamp(3),currency text NOT NULL DEFAULT \'NGN\',"createdAt" timestamp(3) NOT NULL DEFAULT (statement_timestamp() AT TIME ZONE \'UTC\'),"publishAt" timestamp(3),"publishNotifiedAt" timestamp(3),"publicationStatus" "CollectionStatus" NOT NULL DEFAULT \'DRAFT\',"isActive" boolean NOT NULL DEFAULT false,"deletedAt" timestamp(3),"archivedAt" timestamp(3))',
    );
    for (const dir of [
      '20261115090000_product_first_published_at',
      '20261115090100_product_effective_price',
      '20261115090200_market_item_features',
    ])
      await db.query(
        fs.readFileSync(
          path.join(work, 'prisma/migrations', dir, 'migration.sql'),
          'utf8',
        ),
      );
    proof.push('actual migration groups1–3 applied');
    assert.equal(
      (
        await db.query(
          'SELECT wiez_market_parameters_valid($1::jsonb) AS valid',
          [
            JSON.stringify({
              featureSchemaVersion: 1000,
              policyVersion: 2,
              halfLifeDays: 7,
              qualityPriorMean: 0.05,
            }),
          ],
        )
      ).rows[0].valid,
      true,
    );
    assert.equal(
      (
        await db.query(
          'SELECT wiez_market_parameters_valid($1::jsonb) AS valid',
          [JSON.stringify({ actorIds: ['forbidden'] })],
        )
      ).rows[0].valid,
      false,
    );
    assert.equal(
      (
        await db.query(
          'SELECT wiez_market_parameters_valid($1::jsonb) AS valid',
          [JSON.stringify({ qualityPriorMean: 0 })],
        )
      ).rows[0].valid,
      false,
    );
    const product = (
      await db.query('INSERT INTO "Product" DEFAULT VALUES RETURNING "_id"')
    ).rows[0]._id;
    await db.query(
      'INSERT INTO market_item_features("productId","computedAt","sourceAsOf","updatedAt") VALUES ($1,date_trunc(\'milliseconds\',statement_timestamp()),date_trunc(\'milliseconds\',statement_timestamp()),statement_timestamp())',
      [product],
    );
    let row = (
      await db.query(
        'SELECT * FROM market_item_features WHERE "productId"=$1',
        [product],
      )
    ).rows[0];
    assert.equal(row.actors7d, null);
    assert.equal(row.qualityScore, null);
    assert.equal(row.trendEligible, false);
    async function fails(sql, args = [], code = '23514') {
      let failed = false;
      try {
        await db.query(sql, args);
      } catch (e) {
        assert.equal(e.code, code, e.message);
        failed = true;
      }
      assert(failed, 'Expected rejected statement');
    }
    await fails(
      'UPDATE market_item_features SET "actors7d"=0 WHERE "productId"=$1',
      [product],
    );
    await fails(
      'UPDATE market_item_features SET coverage=$2 WHERE "productId"=$1',
      [product, JSON.stringify({ actorHash: 'not-allowed' })],
    );
    proof.push(
      'unknown evidence stays NULL; unproven zero and actor metadata rejected',
    );
    const evidenceEnd = new Date(Date.now() - 1000).toISOString(),
      evidenceStart = new Date(Date.now() - 7 * 86400000).toISOString();
    const complete = {
      completeness: 'COMPLETE',
      reason: 'SOURCE_COMPLETE',
      requiredWindowStart: evidenceStart,
      requiredWindowEnd: evidenceEnd,
      observedFrom: evidenceStart,
      observedThrough: evidenceEnd,
    };
    const coverage = {
      actors7d: complete,
      qualityScore: complete,
      trendScore: complete,
    };
    await db.query(
      'UPDATE market_item_features SET "actors7d"=0,"qualityScore"=0.5,"trendScore"=-0.2,coverage=$2 WHERE "productId"=$1',
      [product, JSON.stringify(coverage)],
    );
    row = (
      await db.query(
        'SELECT * FROM market_item_features WHERE "productId"=$1',
        [product],
      )
    ).rows[0];
    assert.equal(row.actors7d, 0);
    assert.equal(row.trendScore, -0.2);
    await fails(
      'UPDATE market_item_features SET "qualityScore"=1.5 WHERE "productId"=$1',
      [product],
    );
    await fails(
      'UPDATE market_item_features SET coverage=$2 WHERE "productId"=$1',
      [
        product,
        JSON.stringify({
          actors7d: { ...complete, observedFrom: '2026-99-99T00:00:00.000Z' },
        }),
      ],
    );
    await fails(
      'UPDATE market_item_features SET coverage=$2 WHERE "productId"=$1',
      [
        product,
        JSON.stringify({
          ...coverage,
          actors7d: { ...complete, actorIds: ['forbidden'] },
        }),
      ],
    );
    proof.push(
      'complete evidence accepts measured zero/finite negative trend; invalid dates, probabilities and identifiers rejected',
    );
    await db.query(
      'INSERT INTO market_feature_state(key,"updatedAt") VALUES (\'global\',statement_timestamp())',
    );
    async function epoch(policy = 1) {
      const generation = (
        await db.query(
          'UPDATE market_feature_state SET generation=generation+1,"updatedAt"=statement_timestamp() WHERE key=\'global\' RETURNING generation',
        )
      ).rows[0].generation;
      const id = randomUUID();
      await db.query(
        "INSERT INTO market_feature_epochs(id,\"stateKey\",generation,\"epochStart\",\"epochEnd\",\"policyVersion\",\"sourceAsOf\",\"acceptUntil\",\"cleanupAfter\") SELECT $1,'global',$2,date_bin(interval '6 hours',statement_timestamp(),'1970-01-01Z'::timestamptz),date_bin(interval '6 hours',statement_timestamp(),'1970-01-01Z'::timestamptz)+interval '6 hours',$3,statement_timestamp(),date_bin(interval '6 hours',statement_timestamp(),'1970-01-01Z'::timestamptz)+interval '6 hours',date_bin(interval '6 hours',statement_timestamp(),'1970-01-01Z'::timestamptz)+interval '12 hours 30 minutes'",
        [id, generation, policy],
      );
      return { id, generation };
    }
    const e1 = await epoch();
    await fails(
      'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
      [e1.id],
    );
    const copy =
      'INSERT INTO market_item_feature_snapshots("epochId","productId","sourceComputedAt","sourceAsOf","actors7d","qualityScore","trendScore",coverage) SELECT $1,"productId","computedAt","sourceAsOf","actors7d","qualityScore","trendScore",coverage FROM market_item_features';
    await fails(copy, [e1.id]);
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query(
      'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
      [e1.id],
    );
    await db.query(copy, [e1.id]);
    await db.query(
      'UPDATE market_feature_epochs SET status=\'READY\',"rowCount"=1 WHERE id=$1',
      [e1.id],
    );
    await db.query(
      'UPDATE market_feature_state SET "currentEpochId"=$1,"updatedAt"=statement_timestamp() WHERE key=\'global\' AND generation=$2',
      [e1.id, e1.generation],
    );
    await db.query('COMMIT');
    const frozen = (
      await db.query(
        'SELECT * FROM market_item_feature_snapshots WHERE "epochId"=$1',
        [e1.id],
      )
    ).rows[0];
    assert.equal(frozen.actors7d, 0);
    assert.equal(frozen.qualityScore, 0.5);
    assert.equal(frozen.trendScore, -0.2);
    proof.push(
      'one consistent owning transaction publishes snapshot and current pointer',
    );
    await fails(
      'UPDATE market_item_feature_snapshots SET "lowStockVariants"=1 WHERE "epochId"=$1',
      [e1.id],
    );
    await fails('UPDATE market_feature_epochs SET "rowCount"=2 WHERE id=$1', [
      e1.id,
    ]);
    await fails(
      'DELETE FROM market_item_feature_snapshots WHERE "epochId"=$1',
      [e1.id],
    );
    await fails('DELETE FROM market_feature_epochs WHERE id=$1', [e1.id]);
    proof.push(
      'published scores, metadata and accepted generations cannot mutate/prune',
    );
    const e2 = await epoch();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query(
      'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
      [e2.id],
    );
    await db.query(copy, [e2.id]);
    let incomplete = false;
    try {
      await db.query('COMMIT');
    } catch (e) {
      assert.equal(e.code, '23514', e.message);
      incomplete = true;
    }
    assert(incomplete);
    await db.query('ROLLBACK');
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM market_item_feature_snapshots WHERE "epochId"=$1',
          [e2.id],
        )
      ).rows[0].n,
      0,
    );
    proof.push('partial copied generation cannot commit');
    const other = new Client({ connectionString: tu.toString() });
    await other.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await db.query(
        'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
        [e2.id],
      );
      await other.query(
        'UPDATE market_feature_state SET generation=generation+1,"updatedAt"=statement_timestamp() WHERE key=\'global\'',
      );
      await db.query(copy, [e2.id]);
      await db.query(
        'UPDATE market_feature_epochs SET status=\'READY\',"rowCount"=1 WHERE id=$1',
        [e2.id],
      );
      let stale = false;
      try {
        await db.query(
          'UPDATE market_feature_state SET "currentEpochId"=$1 WHERE key=\'global\' AND generation=$2',
          [e2.id, e2.generation],
        );
        await db.query('COMMIT');
      } catch (e) {
        assert(['40001', '23514'].includes(e.code), e.message);
        stale = true;
      }
      assert(stale);
      await db.query('ROLLBACK');
    } finally {
      await other.end();
    }
    assert.equal(
      (
        await db.query(
          'SELECT "currentEpochId" FROM market_feature_state WHERE key=\'global\'',
        )
      ).rows[0].currentEpochId,
      e1.id,
    );
    proof.push(
      'newer generation fences stale publisher with real concurrent transactions',
    );
    await db.query('DELETE FROM "Product" WHERE "_id"=$1', [product]);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM market_item_feature_snapshots',
        )
      ).rows[0].n,
      0,
    );
    proof.push(
      'product erasure cascades without blocking on snapshot retention',
    );
    await db.query(
      'INSERT INTO "Product" (price) SELECT 100 FROM generate_series(1,10000)',
    );
    await db.query(
      'INSERT INTO market_item_features("productId","computedAt","sourceAsOf","updatedAt") SELECT "_id",date_trunc(\'milliseconds\',statement_timestamp()),date_trunc(\'milliseconds\',statement_timestamp()),statement_timestamp() FROM "Product"',
    );
    await db.query(
      'INSERT INTO market_feature_state(key,generation,"updatedAt") VALUES (\'bulk\',1,statement_timestamp())',
    );
    const bulkId = randomUUID();
    await db.query(
      'INSERT INTO market_feature_epochs(id,"stateKey",generation,"epochStart","epochEnd","sourceAsOf","acceptUntil","cleanupAfter") SELECT $1,\'bulk\',1,"epochStart","epochEnd",statement_timestamp(),"acceptUntil","cleanupAfter" FROM market_feature_epochs WHERE id=$2',
      [bulkId, e1.id],
    );
    let tracking = true;
    try {
      await db.query("SET track_functions='all'");
    } catch (e) {
      if (e.code === '42501') tracking = false;
      else throw e;
    }
    const began = Date.now();
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query(
      'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
      [bulkId],
    );
    let cursor = null;
    for (let batch = 0; batch < 5; batch++) {
      const written = (
        await db.query(
          'WITH written AS (INSERT INTO market_item_feature_snapshots("epochId","productId","sourceComputedAt","sourceAsOf") SELECT $1,"productId","computedAt","sourceAsOf" FROM market_item_features WHERE $2::uuid IS NULL OR "productId">$2::uuid ORDER BY "productId" LIMIT 2000 RETURNING "productId") SELECT "productId" FROM written ORDER BY "productId" DESC LIMIT 1',
          [bulkId, cursor],
        )
      ).rows;
      assert.equal(written.length, 1);
      cursor = written[0].productId;
    }
    await db.query(
      'UPDATE market_feature_epochs SET status=\'READY\',"rowCount"=10000 WHERE id=$1',
      [bulkId],
    );
    await db.query(
      'UPDATE market_feature_state SET "currentEpochId"=$1 WHERE key=\'bulk\'',
      [bulkId],
    );
    let statementGuardCalls = null;
    if (tracking) {
      statementGuardCalls = Number(
        (
          await db.query(
            "SELECT calls FROM pg_stat_xact_user_functions WHERE funcname='wiez_market_snapshot_write_guard'",
          )
        ).rows[0].calls,
      );
      assert.equal(statementGuardCalls, 5);
    }
    await db.query('COMMIT');
    const snapshotMs = Date.now() - began;
    const snapshotBytes = Number(
      (
        await db.query(
          "SELECT pg_total_relation_size('market_item_feature_snapshots') AS bytes",
        )
      ).rows[0].bytes,
    );
    proof.push(
      '10000 frozen rows committed in five keyset batches; guard calls=' +
        (statementGuardCalls ?? 'unavailable') +
        '; local elapsed=' +
        snapshotMs +
        'ms; snapshot storage=' +
        snapshotBytes +
        'bytes',
    );
    for (const item of proof) console.log('PASS ' + item);
  } finally {
    if (db) await db.end();
    if (created) await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
    console.log('Disposable writer database removed');
  }
})().catch((e) => {
  console.error(e.code || e.message);
  if (e.code === 'ERR_ASSERTION') console.error(e.message);
  process.exitCode = 1;
});
