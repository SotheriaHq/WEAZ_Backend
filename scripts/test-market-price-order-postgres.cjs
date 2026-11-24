// Exact-price rehearsal uses only a newly created loopback fixture database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { Prisma, PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const {
  RENDERABLE_COVER_FIXTURE_SQL,
} = require('./lib/market-fixture-renderable-covers.cjs');
const {
  marketPriceDirtyIdsSql,
  marketPricePageSql,
  marketNextPriceBoundarySql,
  MARKET_PRICE_DIRTY_LIMIT,
  marketPriceCacheReadinessSql,
} = require('../src/market/catalog/market-price-order.sql');
const {
  marketProductFilterSql,
} = require('../src/market/catalog/market-filter.sql');
const {
  productEffectivePriceSql,
} = require('../src/common/pricing/product-price.sql');
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const {
  marketNewestPageSql,
} = require('../src/market/catalog/market-newest-order.sql');
const {
  readMarketOrderedPage,
} = require('../src/market/catalog/market-ordered-reader');
const {
  MarketCatalogReadService,
} = require('../src/market/catalog/market-catalog-read.service');
const {
  MarketCursorCodec,
  MARKET_CURSOR_TTL_MS,
} = require('../src/market/catalog/market-cursor');
const { marketFilterHash } = require('../src/market/catalog/market-filters');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_price_order_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_price_order_[a-f0-9]{32}$/.test(name));
  const au = new URL(source),
    tu = new URL(source);
  au.pathname = '/postgres';
  tu.pathname = '/' + name;
  const admin = new Client({ connectionString: au.toString() });
  const db = new Client({ connectionString: tu.toString() });
  let created = false,
    connected = false,
    prisma,
    checks = 0;
  await admin.connect();
  try {
    await admin.query("SET statement_timeout='30s'; SET lock_timeout='1s'");
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    await db.query(
      "SET statement_timeout='30s'; SET lock_timeout='1s'; SET timezone='UTC'",
    );
    await db.query(`
      CREATE TABLE "User" ("_id" uuid PRIMARY KEY,status text NOT NULL);
      CREATE TABLE "Brand" ("_id" uuid PRIMARY KEY,"ownerId" uuid REFERENCES "User","isStoreOpen" boolean);
      CREATE TABLE "StoreCollection" ("_id" uuid PRIMARY KEY,status text,"isAvailableInStore" boolean,"deletedAt" timestamp);
      CREATE TABLE "StoreCollectionProduct" ("collectionId" uuid REFERENCES "StoreCollection","productId" uuid);
      CREATE TABLE "Product" (
        "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),"brandId" uuid REFERENCES "Brand",
        "isActive" boolean DEFAULT true,"publicationStatus" text DEFAULT 'PUBLISHED',
        "deletedAt" timestamp,"archivedAt" timestamp,"publishAt" timestamp,
        price numeric(10,2) DEFAULT 100,"salePrice" numeric(10,2),"saleStartAt" timestamp(3),"saleEndAt" timestamp(3),
        currency text DEFAULT 'NGN',thumbnail text,images text[] DEFAULT ARRAY['https://media.example/p.webp'],
        "totalStock" integer DEFAULT 5,"customOrderEnabled" boolean DEFAULT false,
        "standardCheckoutEnabled" boolean DEFAULT true,"trackInventory" boolean DEFAULT true,"categoryId" uuid,"categoryTypeId" uuid,
        gender text DEFAULT 'EVERYBODY',colors text[] DEFAULT '{}',"sizeStock" jsonb DEFAULT '{}',
        "firstPublishedAt" timestamptz(3) DEFAULT date_trunc('milliseconds',statement_timestamp())
      );
    `);
    await db.query(RENDERABLE_COVER_FIXTURE_SQL);
    await db.query(
      fs.readFileSync(
        path.join(
          __dirname,
          '../prisma/migrations/20261115090100_product_effective_price/migration.sql',
        ),
        'utf8',
      ),
    );
    // Candidate prerequisites, not an assertion that these indexes are live.
    await db.query(`
      CREATE INDEX "Product_market_effective_price_idx" ON "Product" ("effectivePrice","_id")
        WHERE "isActive" AND "publicationStatus"='PUBLISHED' AND "deletedAt" IS NULL AND "archivedAt" IS NULL;
      CREATE INDEX "Product_market_effective_price_desc_idx" ON "Product" ("effectivePrice" DESC,"_id" ASC)
        WHERE "isActive" AND "publicationStatus"='PUBLISHED' AND "deletedAt" IS NULL AND "archivedAt" IS NULL;
      CREATE INDEX "Product_market_price_boundary_idx" ON "Product" ("effectivePriceValidUntil","_id") WHERE "effectivePriceValidUntil" IS NOT NULL;
      CREATE INDEX "Product_market_price_computed_idx" ON "Product" ("effectivePriceComputedAt","_id");
      CREATE INDEX "Product_market_price_change_idx" ON "Product" ("priceChangeXid","_id");
      CREATE INDEX "Product_market_first_publication_idx" ON "Product" ("firstPublishedAt" DESC,"_id" DESC)
        WHERE "isActive" AND "publicationStatus"='PUBLISHED' AND "deletedAt" IS NULL AND "archivedAt" IS NULL;
    `);
    const owner = randomUUID(),
      brand = randomUUID();
    await db.query('INSERT INTO "User" VALUES ($1,\'ACTIVE\')', [owner]);
    await db.query('INSERT INTO "Brand" VALUES ($1,$2,true)', [brand, owner]);
    const base = (
      await db.query(
        "SELECT date_trunc('milliseconds',statement_timestamp()) AS now",
      )
    ).rows[0].now;
    const start = new Date(base.getTime() + 3600000),
      end = new Date(base.getTime() + 7200000);
    await db.query(
      'INSERT INTO "Product" ("brandId",price) SELECT $1,1+(n%50) FROM generate_series(1,20000) n',
      [brand],
    );
    const sales = (
      await db.query(
        `INSERT INTO "Product" ("brandId",price,"salePrice","saleStartAt","saleEndAt")
      SELECT $1,100+n,10+n,$2::timestamptz AT TIME ZONE 'UTC',$3::timestamptz AT TIME ZONE 'UTC'
      FROM generate_series(1,20) n RETURNING "_id"`,
        [brand, start.toISOString(), end.toISOString()],
      )
    ).rows.map((row) => row._id);
    const readUrl = new URL(withUtcDatabaseUrl(tu.toString()));
    readUrl.searchParams.set(
      'options',
      `${readUrl.searchParams.get('options')} -c statement_timeout=1500 -c lock_timeout=250`,
    );
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: readUrl.toString(),
      }),
    });
    const query = (sql) => prisma.$queryRaw(sql);
    const assertSnapshotOrder = require('./lib/market-snapshot-order-assertions.cjs');
    const snapshotChecks = await assertSnapshotOrder({ db, query, now: base });
    console.log(
      'PASS ' +
        snapshotChecks +
        ' frozen-score keyset/evidence/live-eligibility groups',
    );
    const newestTime = new Date(start.getTime() - 1);
    const newestOracle =
      await query(Prisma.sql`SELECT p."_id" AS id FROM "Product" p
      WHERE ${marketProductFilterSql({}, newestTime)} AND p."firstPublishedAt" <= ${newestTime.toISOString()}::timestamptz
      ORDER BY p."firstPublishedAt" DESC,p."_id" DESC LIMIT 140`);
    const newestActual = [];
    let newestAfter;
    for (let page = 0; page < 20; page++) {
      const rows = await query(
        marketNewestPageSql({
          filters: {},
          now: newestTime,
          limit: 7,
          after: newestAfter,
        }),
      );
      newestActual.push(...rows);
      if (rows.length < 7) break;
      const last = rows[rows.length - 1];
      newestAfter = {
        id: last.id,
        publishedAt: last.firstPublishedAt.toISOString(),
      };
    }
    assert.deepEqual(
      newestActual.map((row) => row.id),
      newestOracle.map((row) => row.id),
      'Newest keyset keeps descending UUID ties',
    );
    assert.equal(
      new Set(newestActual.map((row) => row.id)).size,
      newestActual.length,
    );
    checks++;
    assert.equal(
      (await query(marketPriceCacheReadinessSql()))[0].ready,
      false,
      'Unvalidated metadata must block the indexed reader',
    );
    await db.query(
      'ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_market_price_cache_ready_check"',
    );
    assert.equal((await query(marketPriceCacheReadinessSql()))[0].ready, true);
    checks++;
    const readService = new MarketCatalogReadService(prisma);
    assert(
      Number(
        (await db.query('SHOW server_version_num')).rows[0].server_version_num,
      ) >= 170000,
      'Deadline proof requires PostgreSQL 17+ transaction_timeout',
    );
    // The production runner must stop the whole transaction, not only one
    // statement. Several individually short statements cannot reset its budget.
    const deadlineStarted = performance.now();
    await assert.rejects(
      () =>
        readService.run(
          async (tx) => {
            for (let i = 0; i < 20; i++)
              await tx.$queryRaw`SELECT 1 AS slept FROM pg_sleep(0.05)`;
            return 'must not complete';
          },
          { deadline: deadlineStarted + 180 },
        ),
      (error) => error.getResponse?.().code === 'CATALOGUE_READ_LIMIT',
    );
    assert(
      performance.now() - deadlineStarted < 1000,
      'Server and adapter must terminate deadline work without an abandoned query',
    );
    assert.equal(
      (await readService.run((tx) => tx.$queryRaw`SELECT 1 AS recovered`))[0]
        .recovered,
      1,
      'Pool recovers after transaction-timeout connection termination',
    );
    checks++;
    await assert.rejects(
      () =>
        readService.run((tx) => tx.$queryRaw`SELECT 1`, {
          deadline: performance.now() - 1,
        }),
      (error) => error.getResponse?.().code === 'CATALOGUE_READ_LIMIT',
    );
    checks++;
    const readOrdered = (sort, cursor = null, fixedFilters = {}) =>
      readService.run(async (tx) =>
        readMarketOrderedPage(tx, {
          filters: {},
          fixedFilters,
          sort,
          limit: 21,
          cursor,
        }),
      );
    await assert.rejects(
      () => readService.run((tx) => tx.$queryRaw`SELECT pg_sleep(3)`),
      (error) => error.getResponse?.().code === 'CATALOGUE_READ_LIMIT',
    );
    assert.equal(
      (await readService.run((tx) => tx.$queryRaw`SELECT 1 AS recovered`))[0]
        .recovered,
      1,
    );
    checks++;
    for (const configuration of [
      {
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
        readOnly: true,
        statementTimeout: 1500,
        lockTimeout: 250,
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        readOnly: false,
        statementTimeout: 1500,
        lockTimeout: 250,
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        readOnly: true,
        statementTimeout: 0,
        lockTimeout: 250,
      },
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        readOnly: true,
        statementTimeout: 1500,
        lockTimeout: 0,
      },
    ]) {
      await assert.rejects(
        () =>
          prisma.$transaction(
            async (tx) => {
              if (configuration.readOnly)
                await tx.$executeRaw`SET TRANSACTION READ ONLY`;
              await tx.$queryRaw`SELECT set_config('statement_timeout', ${String(configuration.statementTimeout)}, true), set_config('lock_timeout', ${String(configuration.lockTimeout)}, true)`;
              return readMarketOrderedPage(tx, {
                filters: {},
                sort: 'newest',
                limit: 21,
                cursor: null,
              });
            },
            {
              isolationLevel: configuration.isolationLevel,
              maxWait: 1000,
              timeout: 2000,
            },
          ),
        (error) =>
          error.getResponse?.().code === 'CATALOGUE_READ_CONTEXT_UNAVAILABLE',
      );
      checks++;
    }
    const first = await readOrdered('price_asc');
    assert.equal(first.rows.length, 21);
    assert.equal(first.reanchored, false);
    const codec = new MarketCursorCodec(
      'price-reader-fixture-key-with-at-least-32-bytes',
      owner,
    );
    const context = {
      requestedSort: 'price_asc',
      filterHash: marketFilterHash({}),
      scopeContext: 'fixture-catalog',
      viewerContext: 'guest',
    };
    const last = first.rows[first.rows.length - 1];
    const cursor = {
      v: 1,
      namespace: owner,
      requestedSort: 'price_asc',
      sort: 'price_asc',
      filterHash: context.filterHash,
      scopeHash: codec.contextHash('scope', context.scopeContext),
      viewerHash: codec.contextHash('viewer', context.viewerContext),
      asOf: first.asOf.getTime(),
      expiresAt: first.asOf.getTime() + MARKET_CURSOR_TTL_MS,
      key: [last.amount.toFixed(2), last.id],
      epoch: null,
      price: {
        snapshot: first.snapshot,
        nextChangeAt: first.nextPriceChangeAt?.getTime() ?? null,
      },
    };
    const decoded = codec.decode(
      codec.encode(cursor),
      context,
      first.asOf.getTime(),
    );
    assert.equal(decoded.kind, 'valid');
    const second = await readOrdered('price_asc', decoded.cursor);
    assert.equal(second.reanchored, false);
    assert(
      !second.rows.some((row) =>
        first.rows.some((previous) => previous.id === row.id),
      ),
      'Stable page two is disjoint',
    );
    await db.query('UPDATE "Product" SET price=0.50 WHERE "_id"=$1', [
      first.rows[0].id,
    ]);
    const changed = await readOrdered('price_asc', decoded.cursor);
    assert.equal(changed.reanchored, true);
    assert.equal(changed.notice, 'Prices updated');
    assert.equal(changed.rows[0].amount.toFixed(2), '0.50');
    const short = codec.decode(
      codec.encode({ ...cursor, expiresAt: cursor.asOf + 1 }),
      context,
      cursor.asOf,
    );
    assert.equal(short.kind, 'valid');
    const expired = await readOrdered('price_asc', short.cursor);
    assert.equal(expired.reanchored, true);
    assert.equal(expired.notice, 'Updated');
    const absentBrand = { brandIds: [randomUUID()] };
    assert.deepEqual((await readOrdered('newest', null, absentBrand)).rows, []);
    assert.deepEqual(
      (await readOrdered('price_asc', null, absentBrand)).rows,
      [],
    );
    checks++;
    const newestRead = await readOrdered('newest');
    assert.equal(newestRead.rows.length, 21);
    assert.equal(
      newestRead.snapshot,
      '',
      'Newest reads do not transfer unneeded transaction-ID lists',
    );
    const missingPublication = newestRead.rows[0].id;
    const originalPublication = newestRead.rows[0].firstPublishedAt;
    await db.query(
      'UPDATE "Product" SET "firstPublishedAt"=NULL WHERE "_id"=$1',
      [missingPublication],
    );
    await assert.rejects(
      () => readOrdered('newest'),
      (error) =>
        error.getResponse?.().code ===
        'CATALOGUE_PUBLICATION_BACKFILL_REQUIRED',
    );
    await db.query(
      'UPDATE "Product" SET "firstPublishedAt"=$2 WHERE "_id"=$1',
      [missingPublication, originalPublication.toISOString()],
    );
    await assert.rejects(
      () =>
        prisma.$transaction((tx) =>
          readMarketOrderedPage(tx, {
            filters: {},
            sort: 'newest',
            limit: 21,
            cursor: null,
          }),
        ),
      (error) =>
        error.getResponse?.().code === 'CATALOGUE_READ_CONTEXT_UNAVAILABLE',
    );
    checks++;
    const check = async (now, sort, filters = {}) => {
      const dirty = (await query(marketPriceDirtyIdsSql(now))).map(
        (row) => row.id,
      );
      assert(dirty.length <= MARKET_PRICE_DIRTY_LIMIT);
      const price = productEffectivePriceSql(now),
        eligible = marketProductFilterSql(filters, now);
      const order = sort === 'price_asc' ? Prisma.sql`ASC` : Prisma.sql`DESC`;
      const oracle =
        await query(Prisma.sql`SELECT p."_id" AS id,(${price}) AS amount FROM "Product" p
        WHERE ${eligible} ORDER BY amount ${order},p."_id" ASC LIMIT 140`);
      const actual = [];
      let after;
      for (let page = 0; page < 20; page++) {
        const rows = await query(
          marketPricePageSql({ filters, now, dirty, sort, limit: 7, after }),
        );
        actual.push(...rows);
        if (rows.length < 7) break;
        const last = rows[rows.length - 1];
        after = { id: last.id, amount: last.amount.toFixed(2) };
      }
      assert.deepEqual(
        actual.map((row) => [row.id, row.amount.toFixed(2)]),
        oracle.map((row) => [row.id, row.amount.toFixed(2)]),
        sort + ' at ' + now.toISOString(),
      );
      assert.equal(
        new Set(actual.map((row) => row.id)).size,
        actual.length,
        'No duplicate price ties across pages',
      );
      const boundary = (await query(marketNextPriceBoundarySql(now, dirty)))[0]
        .boundary;
      const expected = (
        await db.query(
          'SELECT min(wiez_product_price_boundary(price,"salePrice","saleStartAt","saleEndAt",$1::timestamptz)) AS boundary FROM "Product"',
          [now.toISOString()],
        )
      ).rows[0].boundary;
      assert.equal(
        boundary?.getTime() ?? null,
        expected?.getTime() ?? null,
        'Next boundary includes dirty rows at ' + now.toISOString(),
      );
      checks++;
      return { dirty, rows: actual };
    };
    for (const time of [
      start.getTime() - 1,
      start.getTime(),
      end.getTime(),
      end.getTime() + 1,
    ]) {
      for (const sort of ['price_asc', 'price_desc'])
        await check(new Date(time), sort);
    }
    for (const sort of ['price_asc', 'price_desc']) {
      await check(new Date(start.getTime() + 1000), sort, {
        price: { min: 15, max: 25 },
        onSale: true,
      });
      await check(new Date(end.getTime() + 1), sort, {
        price: { min: 15, max: 25 },
        onSale: true,
      });
    }
    // Simulate a cache written before a backward wall-clock correction. Only
    // this disposable fixture disables a trigger; live code never does.
    await db.query(
      'ALTER TABLE "Product" DISABLE TRIGGER trg_product_price_cache',
    );
    await db.query(
      'UPDATE "Product" SET "effectivePriceComputedAt"=$2,"effectivePrice"=1 WHERE "_id"=$1',
      [sales[0], new Date(end.getTime() + 1000).toISOString()],
    );
    await db.query(
      'ALTER TABLE "Product" ENABLE TRIGGER trg_product_price_cache',
    );
    const anomaly = await check(new Date(start.getTime() + 1000), 'price_asc');
    assert(anomaly.dirty.includes(sales[0]));

    await db.query('ANALYZE "Product"');
    const now = new Date(start.getTime() + 1000),
      dirty = anomaly.dirty;
    const plans = [];
    for (const sort of ['price_asc', 'price_desc']) {
      const sql = marketPricePageSql({
        filters: {},
        fixedFilters: { price: { min: 40, max: 50 } },
        now,
        dirty,
        sort,
        limit: 21,
      });
      const plan = (
        await db.query(
          'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql.text,
          sql.values.map((value) =>
            value instanceof Date ? value.toISOString() : value,
          ),
        )
      ).rows[0]['QUERY PLAN'][0];
      const nodes = [];
      const visit = (node) => {
        nodes.push(node);
        for (const child of node.Plans ?? []) visit(child);
      };
      visit(plan.Plan);
      const expectedIndex =
        sort === 'price_asc'
          ? 'Product_market_effective_price_idx'
          : 'Product_market_effective_price_desc_idx';
      assert(
        nodes.some((node) => node['Index Name'] === expectedIndex),
        sort + ' must use its real directional price index',
      );
      assert(
        nodes.some(
          (node) =>
            node['Index Name'] === expectedIndex &&
            node['Index Cond']?.includes('effectivePrice'),
        ),
        'Fixed section price bounds must participate in the price index condition',
      );
      assert(
        !nodes.some(
          (node) =>
            node['Relation Name'] === 'Product' &&
            node['Node Type'] === 'Seq Scan',
        ),
      );
      plans.push({ sort, milliseconds: plan['Execution Time'] });
      checks++;
    }
    await db.query(
      `INSERT INTO "Product" ("brandId",price,"salePrice","saleStartAt")
      SELECT $1,100,80,$2::timestamptz AT TIME ZONE 'UTC' FROM generate_series(1,2001)`,
      [brand, start.toISOString()],
    );
    const overBudget = (await query(marketPriceDirtyIdsSql(now))).map(
      (row) => row.id,
    );
    assert.equal(overBudget.length, MARKET_PRICE_DIRTY_LIMIT + 1);
    assert.throws(
      () =>
        marketPricePageSql({
          filters: {},
          now,
          dirty: overBudget,
          sort: 'price_asc',
          limit: 21,
        }),
      RangeError,
    );
    checks++;
    console.log(
      'PASS ' +
        checks +
        ' exact-price oracle/pagination/boundary/clock/budget/plan groups on 20k products',
    );
    console.log(JSON.stringify({ fixtureOnly: true, plans }));
  } finally {
    if (prisma) await prisma.$disconnect();
    if (connected) await db.end();
    if (created) {
      assert(/^aru_market_price_order_[a-f0-9]{32}$/.test(name));
      await admin.query('DROP DATABASE "' + name + '"');
    }
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
