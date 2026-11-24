// Fixture writes are restricted to a fresh, generated loopback PostgreSQL database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const {
  MarketIntelligenceService,
} = require('../src/market/intelligence/market-intelligence.service');
const {
  marketPlatformPaidOrderFloorSql,
} = require('../src/market/intelligence/market-intelligence.sql');
const {
  MARKET_MAX_PRODUCTS,
  r1FeatureCoverage,
  parseMarketSnapshotReadSummary,
} = require('../src/market/intelligence/market-intelligence.contracts');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_intelligence_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_intelligence_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  let db,
    prisma,
    created = false,
    checks = 0;
  const check = (run) => {
    run();
    checks++;
  };
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    db = new Client({
      connectionString: withUtcDatabaseUrl(target.toString()),
    });
    await db.connect();
    await db.query(
      "SET statement_timeout='10s'; SET lock_timeout='500ms'; SET timezone='UTC'",
    );
    await db.query(`
      CREATE TABLE "User" ("_id" uuid PRIMARY KEY,status text DEFAULT 'ACTIVE',role text DEFAULT 'User',"deactivatedAt" timestamp);
      CREATE TABLE "Brand" ("_id" uuid PRIMARY KEY,"ownerId" uuid,"isStoreOpen" boolean DEFAULT true);
      CREATE TABLE "BrandMember" ("brandId" uuid,"userId" uuid,status text DEFAULT 'ACTIVE',PRIMARY KEY("brandId","userId"));
      CREATE TABLE "Product" ("_id" uuid PRIMARY KEY,"brandId" uuid,"isActive" boolean DEFAULT true,
        "publicationStatus" text DEFAULT 'PUBLISHED',"deletedAt" timestamp,"archivedAt" timestamp,"publishAt" timestamp,
        price numeric(10,2) DEFAULT 100,"salePrice" numeric(10,2),"saleStartAt" timestamp(3),"saleEndAt" timestamp(3),
        currency text DEFAULT 'NGN',thumbnail text DEFAULT 'photo.webp',images text[] DEFAULT '{}',
        "totalStock" integer DEFAULT 8,"customOrderEnabled" boolean DEFAULT false,"sizeStock" jsonb);
      CREATE TABLE "ProductVariant" ("_id" uuid PRIMARY KEY,"productId" uuid,stock integer);
      CREATE INDEX ON "ProductVariant"("productId",stock);
      CREATE TABLE "StoreCollectionProduct" ("productId" uuid,"collectionId" uuid);
      CREATE TABLE "StoreCollection" ("_id" uuid,status text,"isAvailableInStore" boolean,"deletedAt" timestamp);
      CREATE TABLE "WishlistItem" ("_id" uuid PRIMARY KEY,"productId" uuid,"userId" uuid,UNIQUE("userId","productId"));
      CREATE INDEX ON "WishlistItem"("productId");
      CREATE TABLE "Order" ("_id" uuid PRIMARY KEY,"brandId" uuid,"buyerId" uuid,"paymentStatus" text DEFAULT 'PAID',
        status text DEFAULT 'DELIVERED',"paidAt" timestamp(3) DEFAULT (statement_timestamp() AT TIME ZONE 'UTC'));
      CREATE TABLE "OrderItem" (id uuid PRIMARY KEY,"orderId" uuid,"productId" uuid,quantity integer);
      CREATE INDEX ON "OrderItem"("productId"); CREATE INDEX ON "OrderItem"("orderId");
      CREATE TABLE "StandardOrderRefund" ("orderId" uuid UNIQUE);
      CREATE TABLE system_config (key text PRIMARY KEY,value text,"updatedAt" timestamp);
      CREATE TABLE user_market_affinity ("userId" uuid PRIMARY KEY);
      CREATE TABLE "RunwayAffinityCache" ("userId" uuid PRIMARY KEY,payload jsonb,"builtAt" timestamp,"expiresAt" timestamp);
      CREATE TABLE market_signal_aggregate_daily ("_id" uuid PRIMARY KEY,"userId" uuid,"anonymousSessionId" text,
        "bucketDate" timestamp NOT NULL DEFAULT (statement_timestamp() AT TIME ZONE 'UTC'));
      CREATE INDEX ON market_signal_aggregate_daily("userId","bucketDate");
      CREATE INDEX ON market_signal_aggregate_daily("anonymousSessionId","bucketDate");
    `);
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ]) {
      assert(/^[a-z_]+$/.test(table));
      await db.query(`CREATE TABLE ${table} ("_id" uuid PRIMARY KEY,"createdAt" timestamp NOT NULL,"seenAt" timestamp,"userId" uuid);
        CREATE INDEX ON ${table}("createdAt","_id"); CREATE INDEX ON ${table}("userId","createdAt")`);
    }
    // Execute the exact production SQL guards, without invoking a migration runner.
    for (const migration of [
      '20261115090100_product_effective_price',
      '20261115090200_market_item_features',
    ]) {
      await db.query(
        fs.readFileSync(
          path.join(
            __dirname,
            '../prisma/migrations',
            migration,
            'migration.sql',
          ),
          'utf8',
        ),
      );
    }
    await db.query(`CREATE TABLE market_section_exposure ("sectionKey" text,"productId" uuid,
      epoch timestamptz,"epochId" uuid REFERENCES market_feature_epochs(id) ON DELETE SET NULL,slot integer,
      PRIMARY KEY("sectionKey","productId",epoch));`);
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: withUtcDatabaseUrl(target.toString()),
      }),
    });
    const implementation = new MarketIntelligenceService(prisma);
    let operation = 0;
    const service = Object.fromEntries(
      [
        'refreshFeatures',
        'publishSnapshot',
        'sweepPrices',
        'cleanupPrivacy',
      ].map((name) => [
        name,
        async () => {
          const label = `${name}#${++operation}`;
          const started = Date.now();
          try {
            const result = await implementation[name]();
            console.log(
              `${label}: ${result.status}/${result.reason || result.rows} (${Date.now() - started}ms)`,
            );
            return result;
          } catch (error) {
            error.message = label + ': ' + error.message;
            throw error;
          }
        },
      ]),
    );
    const owner = randomUUID(),
      staff = randomUUID(),
      buyer = randomUUID(),
      adminUser = randomUUID(),
      inactive = randomUUID(),
      brand = randomUUID(),
      product = randomUUID();
    await db.query(
      "INSERT INTO \"User\"(\"_id\",status,role) VALUES ($1,'ACTIVE','User'),($2,'ACTIVE','User'),($3,'ACTIVE','User'),($4,'ACTIVE','Admin'),($5,'SUSPENDED','User')",
      [owner, staff, buyer, adminUser, inactive],
    );
    await db.query('INSERT INTO "Brand"("_id","ownerId") VALUES ($1,$2)', [
      brand,
      owner,
    ]);
    await db.query(
      'INSERT INTO "BrandMember"("brandId","userId") VALUES ($1,$2)',
      [brand, staff],
    );
    await db.query('INSERT INTO "Product"("_id","brandId") VALUES ($1,$2)', [
      product,
      brand,
    ]);
    for (const user of [owner, staff, buyer, adminUser, inactive])
      await db.query('INSERT INTO "WishlistItem" VALUES ($1,$2,$3)', [
        randomUUID(),
        product,
        user,
      ]);
    for (const stock of [0, 1, 3, 4])
      await db.query('INSERT INTO "ProductVariant" VALUES ($1,$2,$3)', [
        randomUUID(),
        product,
        stock,
      ]);
    let result = await service.refreshFeatures();
    check(() => assert.equal(result.rows, 1));
    let feature = (await db.query('SELECT * FROM market_item_features'))
      .rows[0];
    check(() => assert.equal(feature.purchasable, true));
    check(() => assert.equal(feature.minVariantStock, 1));
    check(() => assert.equal(feature.lowStockVariants, 2));
    check(() => assert.equal(feature.savesCount, 1));
    check(() => assert.equal(feature.actors7d, null));
    check(() => assert.equal(feature.units28d, null));
    check(() =>
      assert.equal(feature.coverage.units28d.completeness, 'UNAVAILABLE'),
    );
    await db.query(
      'UPDATE "BrandMember" SET status=\'REMOVED\' WHERE "userId"=$1',
      [staff],
    );
    await service.refreshFeatures();
    const formerStaffSaves = (
      await db.query('SELECT "savesCount" FROM market_item_features')
    ).rows[0].savesCount;
    check(() => assert.equal(formerStaffSaves, 2));
    await db.query(
      'UPDATE "BrandMember" SET status=\'ACTIVE\' WHERE "userId"=$1',
      [staff],
    );

    async function order(user, quantity, status = 'DELIVERED', refund = false) {
      const id = randomUUID();
      await db.query(
        'INSERT INTO "Order"("_id","brandId","buyerId",status) VALUES ($1,$2,$3,$4)',
        [id, brand, user, status],
      );
      await db.query('INSERT INTO "OrderItem" VALUES ($1,$2,$3,$4)', [
        randomUUID(),
        id,
        product,
        quantity,
      ]);
      if (refund)
        await db.query('INSERT INTO "StandardOrderRefund" VALUES ($1)', [id]);
      return id;
    }
    await order(buyer, 5);
    await order(buyer, 100, 'CANCELLED');
    await order(buyer, 100, 'RETURNED');
    await order(buyer, 100, 'DELIVERED', true);
    for (const user of [owner, staff, adminUser, inactive, null])
      await order(user, 100);
    const clock = (
      await db.query(
        "SELECT date_trunc('milliseconds',statement_timestamp()) AS now",
      )
    ).rows[0].now;
    const manifest = {
      version: 1,
      source: 'Order/OrderItem',
      observedFrom: new Date(clock.getTime() - 29 * 86_400_000).toISOString(),
      verifiedAt: new Date(clock.getTime() - 1_000).toISOString(),
      evidenceRef: 'disposable-fixture-complete-history',
    };
    await db.query(
      "INSERT INTO system_config VALUES ('market.sales.source.coverage',$1,statement_timestamp())",
      [JSON.stringify(manifest)],
    );
    await service.refreshFeatures();
    feature = (await db.query('SELECT * FROM market_item_features')).rows[0];
    check(() => assert.equal(feature.units28d, 5));
    check(() =>
      assert.equal(feature.coverage.units28d.completeness, 'COMPLETE'),
    );
    let floor = (
      await prisma.$queryRaw(marketPlatformPaidOrderFloorSql(new Date()))
    )[0];
    check(() => assert.equal(floor.count, 1));
    for (let i = 0; i < 50; i++) await order(buyer, 1);
    floor = (
      await prisma.$queryRaw(marketPlatformPaidOrderFloorSql(new Date()))
    )[0];
    check(() => assert.equal(floor.count, 50));

    // Admission counts actual serialized evidence and preserves the live data on refusal.
    await db.query(
      'INSERT INTO "Product"("_id","brandId") SELECT gen_random_uuid(),$1 FROM generate_series(1,1000)',
      [brand],
    );
    await service.refreshFeatures();
    const oldBudget = process.env.MARKET_SNAPSHOT_STORAGE_BUDGET_MIB;
    process.env.MARKET_SNAPSHOT_STORAGE_BUDGET_MIB = '1';
    try {
      result = await service.publishSnapshot();
      check(() => assert.equal(result.reason, 'STORAGE_BUDGET'));
      const retained = (
        await db.query(
          'SELECT count(*)::int AS count FROM market_feature_epochs',
        )
      ).rows[0].count;
      check(() => assert.equal(retained, 0));
    } finally {
      if (oldBudget === undefined)
        delete process.env.MARKET_SNAPSHOT_STORAGE_BUDGET_MIB;
      else process.env.MARKET_SNAPSHOT_STORAGE_BUDGET_MIB = oldBudget;
    }
    await db.query('DELETE FROM "Product" WHERE "_id"<>$1', [product]);
    await service.refreshFeatures();
    result = await service.publishSnapshot();
    const epochId = result.epochId;
    const publication = (
      await db.query('SELECT * FROM market_feature_epochs WHERE id=$1', [
        epochId,
      ])
    ).rows[0];
    const checkpoint = JSON.parse(
      (
        await db.query(
          "SELECT value FROM system_config WHERE key='market.features.snapshot'",
        )
      ).rows[0].value,
    );
    const checkedSummary = parseMarketSnapshotReadSummary(
      checkpoint.readSummary,
      {
        epochId,
        generation: String(publication.generation),
        sourceAsOf: publication.sourceAsOf,
        acceptUntil: publication.acceptUntil,
        rows: publication.rowCount,
      },
    );
    check(() =>
      assert(
        checkedSummary,
        'Current publication carries its validated id-bound summary',
      ),
    );
    check(() =>
      assert.deepEqual(
        checkedSummary.complete,
        { popularity: false, trend: false, quality: false },
        'R1 unavailable histories remain unavailable after publication',
      ),
    );
    check(() => assert.equal(publication.status, 'READY'));
    check(() => assert.equal(checkpoint.readSummary.epochId, epochId));
    const frozen = (
      await db.query(
        'SELECT * FROM market_item_feature_snapshots WHERE "epochId"=$1',
        [epochId],
      )
    ).rows[0];
    check(() => assert.equal(frozen.savesCount, 1));
    result = await service.publishSnapshot();
    check(() => assert.equal(result.reason, 'PUBLICATION_INTERVAL'));
    const seedManifests = async (count, oldBucket) =>
      db.query(
        `INSERT INTO market_feature_epochs
      (id,"stateKey",generation,"epochStart","epochEnd","sourceAsOf","acceptUntil",parameters,"cleanupAfter")
      SELECT gen_random_uuid(),e."stateKey",n+1,e."epochStart"-($3::int*interval '6h'),
        e."epochEnd"-($3::int*interval '6h'),e."sourceAsOf",e."acceptUntil"-($3::int*interval '6h'),
        e.parameters,e."cleanupAfter" FROM market_feature_epochs e CROSS JOIN generate_series(1,$2::int) n WHERE e.id=$1`,
        [epochId, count, oldBucket ? 1 : 0],
      );
    await seedManifests(31, false);
    result = await service.publishSnapshot();
    check(() => assert.equal(result.reason, 'GENERATION_BUDGET'));
    await db.query("DELETE FROM market_feature_epochs WHERE status='BUILDING'");
    await seedManifests(63, true);
    result = await service.publishSnapshot();
    check(() => assert.equal(result.reason, 'GENERATION_BUDGET'));
    await db.query("DELETE FROM market_feature_epochs WHERE status='BUILDING'");
    const stale = new Date(Date.now() - 2 * 3_600_000 - 60_000);
    await db.query(
      'UPDATE market_item_features SET "computedAt"=$1,"sourceAsOf"=$1,coverage=$2,"units28d"=NULL',
      [stale, JSON.stringify(r1FeatureCoverage(stale))],
    );
    result = await service.publishSnapshot();
    check(() => assert.equal(result.reason, 'STALE_SOURCE'));
    const preserved = (
      await db.query(
        'SELECT count(*)::int AS count FROM market_item_feature_snapshots WHERE "epochId"=$1',
        [epochId],
      )
    ).rows[0].count;
    check(() => assert.equal(preserved, 1));
    await db.query('DELETE FROM "WishlistItem" WHERE "userId"=$1', [buyer]);
    await service.refreshFeatures();
    const refreshedSaved = (
      await db.query('SELECT "savesCount" FROM market_item_features')
    ).rows[0].savesCount;
    const frozenSaved = (
      await db.query(
        'SELECT "savesCount" FROM market_item_feature_snapshots WHERE "epochId"=$1',
        [epochId],
      )
    ).rows[0].savesCount;
    check(() => assert.equal(refreshedSaved, 0));
    check(() => assert.equal(frozenSaved, 1));
    await assert.rejects(
      db.query(
        'UPDATE market_item_feature_snapshots SET "savesCount"=999 WHERE "epochId"=$1',
        [epochId],
      ),
      /owning|rewritten/,
    );
    checks++;
    await db.query('BEGIN');
    await db.query('SELECT pg_advisory_xact_lock(72304,1)');
    result = await service.refreshFeatures();
    check(() => assert.equal(result.status, 'skipped'));
    await db.query('ROLLBACK');
    result = await service.refreshFeatures();
    check(() => assert.equal(result.status, 'completed'));

    // A failure after the first 500-row page rolls back feature writes and watermark.
    const beforeFailure = (
      await db.query(
        "SELECT value FROM system_config WHERE key='market.features.watermark'",
      )
    ).rows[0].value;
    await db.query(
      'INSERT INTO "Product"("_id","brandId") SELECT gen_random_uuid(),$1 FROM generate_series(1,600)',
      [brand],
    );
    const poison = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
    await db.query('INSERT INTO "Product"("_id","brandId") VALUES ($1,$2)', [
      poison,
      brand,
    ]);
    await db.query(`CREATE FUNCTION reject_fixture_product() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW."productId"='ffffffff-ffff-ffff-ffff-ffffffffffff'::uuid THEN RAISE EXCEPTION 'fixture-interrupted-batch'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_fixture BEFORE INSERT OR UPDATE ON market_item_features FOR EACH ROW EXECUTE FUNCTION reject_fixture_product()`);
    await assert.rejects(
      service.refreshFeatures(),
      /fixture-interrupted-batch/,
    );
    checks++;
    const afterFailure = (
      await db.query(
        "SELECT value FROM system_config WHERE key='market.features.watermark'",
      )
    ).rows[0].value;
    const rowCount = (
      await db.query('SELECT count(*)::int AS count FROM market_item_features')
    ).rows[0].count;
    check(() => assert.equal(afterFailure, beforeFailure));
    check(() => assert.equal(rowCount, 1));
    await db.query(
      'DROP TRIGGER reject_fixture ON market_item_features; DROP FUNCTION reject_fixture_product()',
    );
    await db.query('DELETE FROM "Product" WHERE "_id"<>$1', [product]);

    // Clock advancement repairs the cache even without a new product mutation.
    await db.query(
      'UPDATE "Product" SET "salePrice"=50,"saleEndAt"=(statement_timestamp() AT TIME ZONE \'UTC\')+interval \'100 milliseconds\' WHERE "_id"=$1',
      [product],
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    result = await service.sweepPrices();
    check(() => assert.equal(result.rows, 1));
    const effective = (
      await db.query(
        'SELECT "effectivePrice"::text AS price FROM "Product" WHERE "_id"=$1',
        [product],
      )
    ).rows[0].price;
    check(() => assert.equal(effective, '100.00'));

    // A catalogue above measured capacity is refused before any feature write.
    const capacityWatermark = (
      await db.query(
        "SELECT value FROM system_config WHERE key='market.features.watermark'",
      )
    ).rows[0].value;
    await db.query(
      'INSERT INTO "Product"("_id","brandId") SELECT gen_random_uuid(),$1 FROM generate_series(1,$2::int)',
      [brand, MARKET_MAX_PRODUCTS],
    );
    result = await service.refreshFeatures();
    check(() => assert.equal(result.status, 'backlog'));
    check(() => assert.equal(result.reason, 'PRODUCT_CAPACITY'));
    check(() => assert.equal(result.products, MARKET_MAX_PRODUCTS + 1));
    const refusedWatermark = (
      await db.query(
        "SELECT value FROM system_config WHERE key='market.features.watermark'",
      )
    ).rows[0].value;
    check(() => assert.equal(refusedWatermark, capacityWatermark));
    await db.query('DELETE FROM "Product" WHERE "_id"<>$1', [product]);

    // Expired identities are deleted while current events and global totals survive.
    const old = randomUUID(),
      fresh = randomUUID();
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ])
      await db.query(
        `INSERT INTO ${table}("_id","createdAt","seenAt") VALUES ($1,statement_timestamp()-interval '25h',statement_timestamp()-interval '25h'),($2,statement_timestamp()-interval '1h',statement_timestamp()-interval '1h')`,
        [old, fresh],
      );
    await db.query(
      'INSERT INTO market_signal_aggregate_daily VALUES ($1,NULL,NULL),($2,$3,NULL)',
      [randomUUID(), randomUUID(), buyer],
    );
    await db.query('INSERT INTO user_market_affinity VALUES ($1)', [buyer]);
    await db.query('BEGIN');
    await db.query(
      'SELECT * FROM user_feed_signals WHERE "_id"=$1 FOR UPDATE',
      [old],
    );
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'backlog'));
    await db.query('ROLLBACK');
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'completed'));
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ]) {
      const rows = (await db.query(`SELECT "_id" FROM ${table}`)).rows;
      check(() =>
        assert.deepEqual(
          rows.map((row) => row._id),
          [fresh],
        ),
      );
    }
    const aggregates = (
      await db.query(
        'SELECT count(*)::int AS count FROM market_signal_aggregate_daily',
      )
    ).rows[0].count;
    const profiles = (
      await db.query('SELECT count(*)::int AS count FROM user_market_affinity')
    ).rows[0].count;
    check(() => assert.equal(aggregates, 1));
    check(() => assert.equal(profiles, 0));
    // Restore-safety: a second sweep is idempotent and retains the fresh events/global totals.
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.rows, 0));

    // Fresh rows of inactive, vanished and erased identities go before 24h,
    // across more identities than one bounded actor scan examines.
    const vanished = randomUUID();
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ])
      await db.query(
        `INSERT INTO ${table}("_id","createdAt","seenAt","userId") VALUES
          ($1,statement_timestamp()-interval '1h',statement_timestamp()-interval '1h',$4),
          ($2,statement_timestamp()-interval '1h',statement_timestamp()-interval '1h',$5),
          ($3,statement_timestamp()-interval '1h',statement_timestamp()-interval '1h',$6)`,
        [randomUUID(), randomUUID(), randomUUID(), inactive, vanished, buyer],
      );
    await db.query(`INSERT INTO user_feed_signals("_id","createdAt","userId")
      SELECT gen_random_uuid(),statement_timestamp()-interval '1h',gen_random_uuid() FROM generate_series(1,600)`);
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'completed'));
    check(() => assert.equal(result.rows, 5 * 2 + 600));
    for (const table of [
      'user_feed_signals',
      'user_seen_items',
      'market_section_signals',
      'suggestion_signals',
      'market_signal_batch_receipts',
    ]) {
      const owners = (
        await db.query(
          `SELECT "userId" FROM ${table} WHERE "userId" IS NOT NULL`,
        )
      ).rows;
      check(() =>
        assert.deepEqual(
          owners.map((row) => row.userId),
          [buyer],
        ),
      );
    }

    // Malformed cache proof is removed without a version-specific cast.
    const cacheUsers = Array.from({ length: 4 }, () => randomUUID());
    await db.query(
      'INSERT INTO "User"("_id",status,role) SELECT id,\'ACTIVE\',\'User\' FROM unnest($1::uuid[]) id',
      [cacheUsers],
    );
    const cacheClock = (
      await db.query(
        "SELECT date_trunc('milliseconds',statement_timestamp()) AS now",
      )
    ).rows[0].now;
    const cacheStarts = [
      new Date(cacheClock.getTime() - 3_600_000).toISOString(),
      '2026-02-30T00:00:00.000Z',
      'not-a-timestamp',
      new Date(cacheClock.getTime() - 25 * 3_600_000).toISOString(),
    ];
    for (let i = 0; i < cacheUsers.length; i++)
      await db.query(
        `INSERT INTO "RunwayAffinityCache" VALUES ($1,$2,
          statement_timestamp() AT TIME ZONE 'UTC',(statement_timestamp()+interval '30 seconds') AT TIME ZONE 'UTC')`,
        [
          cacheUsers[i],
          JSON.stringify({
            version: 'runway-r1-v1',
            sourceWindowStart: cacheStarts[i],
          }),
        ],
      );
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'completed'));
    const caches = (
      await db.query('SELECT "userId" FROM "RunwayAffinityCache"')
    ).rows;
    check(() =>
      assert.deepEqual(
        caches.map((row) => row.userId),
        [cacheUsers[0]],
      ),
    );

    // One failing class neither stops the erasure classes after it nor hides
    // its failure: the status record names it and the result is failed.
    await db.query(
      `INSERT INTO market_section_signals("_id","createdAt") VALUES ($1,statement_timestamp()-interval '25h')`,
      [randomUUID()],
    );
    await db.query('INSERT INTO user_market_affinity VALUES ($1)', [buyer]);
    await db.query(
      `UPDATE "RunwayAffinityCache" SET "expiresAt"=(statement_timestamp()-interval '1 second') AT TIME ZONE 'UTC'`,
    );
    await db.query(`CREATE FUNCTION reject_fixture_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'fixture-cleanup-failure'; END $$;
      CREATE TRIGGER reject_cleanup BEFORE DELETE ON market_section_signals FOR EACH ROW EXECUTE FUNCTION reject_fixture_cleanup()`);
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'failed'));
    check(() => assert.deepEqual(result.failedClasses, ['sections']));
    const afterFailedCleanup = (
      await db.query(`SELECT (SELECT count(*)::int FROM user_market_affinity) AS profiles,
        (SELECT count(*)::int FROM "RunwayAffinityCache") AS caches`)
    ).rows[0];
    check(() =>
      assert.deepEqual(afterFailedCleanup, { profiles: 0, caches: 0 }),
    );
    const failedRecord = JSON.parse(
      (
        await db.query(
          "SELECT value FROM system_config WHERE key='market.privacy.cleanup'",
        )
      ).rows[0].value,
    );
    check(() => assert.equal(failedRecord.status, 'failed'));
    check(() => assert.deepEqual(failedRecord.failedClasses, ['sections']));
    await db.query(
      'DROP TRIGGER reject_cleanup ON market_section_signals; DROP FUNCTION reject_fixture_cleanup()',
    );
    result = await service.cleanupPrivacy();
    check(() => assert.equal(result.status, 'completed'));
    check(() => assert.deepEqual(result.failedClasses, []));
    if (process.argv.includes('--heap')) {
      // Only this generated disposable database is reset; accepted app generations are never touched.
      assert(/^aru_market_intelligence_[a-f0-9]{32}$/.test(name));
      await db.query(
        'TRUNCATE market_feature_state,market_feature_epochs CASCADE',
      );
      await db.query(
        'INSERT INTO "Product"("_id","brandId") SELECT gen_random_uuid(),$1 FROM generate_series(1,9999)',
        [brand],
      );
      const started = Date.now();
      result = await service.refreshFeatures();
      check(() => assert.equal(result.rows, 10_000));
      result = await service.publishSnapshot();
      check(() => assert.equal(result.rows, 10_000));
      check(() =>
        assert(
          process.memoryUsage().heapUsed < 256 * 1024 * 1024,
          '10k fixture heap must remain below 256 MiB',
        ),
      );
      console.log(
        JSON.stringify({
          fixtureProducts: 10_000,
          elapsedMs: Date.now() - started,
          heapUsed: process.memoryUsage().heapUsed,
        }),
      );
    }
    console.log(`Market Intelligence: ${checks} actual PostgreSQL checks PASS`);
  } finally {
    if (prisma) await prisma.$disconnect();
    if (db) {
      await db.query('ROLLBACK').catch(() => {});
      await db.end();
    }
    if (created) {
      assert(/^aru_market_intelligence_[a-f0-9]{32}$/.test(name));
      assert.equal(target.pathname, '/' + name);
      await admin.query('DROP DATABASE "' + name + '"');
      assert.equal(
        (
          await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [
            name,
          ])
        ).rowCount,
        0,
        'Owned fixture database removed',
      );
      console.log(
        'CLEANUP PASS owned disposable database dropped and absence verified',
      );
    }
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.code || error.name, error.message);
  process.exitCode = 1;
});
