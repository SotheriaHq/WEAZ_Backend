// Rehearses the real price trigger in a disposable loopback-only database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const { Prisma, PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const {
  marketPriceWritesSinceSql,
} = require('../src/market/catalog/market-price-fence.sql');
const { parseMarketSnapshot } = require('../src/market/catalog/market-cursor');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_price_fence_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_price_fence_[a-f0-9]{32}$/.test(name));
  const au = new URL(source),
    tu = new URL(source);
  au.pathname = '/postgres';
  tu.pathname = '/' + name;
  const admin = new Client({ connectionString: au.toString() });
  const clients = [];
  let created = false,
    prisma,
    checks = 0;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    const connect = async () => {
      const client = new Client({ connectionString: tu.toString() });
      await client.connect();
      clients.push(client);
      await client.query(
        "SET statement_timeout='5s'; SET lock_timeout='1s'; SET timezone='UTC'",
      );
      return client;
    };
    const db = await connect(),
      a = await connect(),
      b = await connect(),
      reader = await connect();
    await db.query(`CREATE TABLE "Product" (
      "_id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text DEFAULT 'Fixture',
      price numeric(10,2) NOT NULL DEFAULT 100, "salePrice" numeric(10,2),
      "saleStartAt" timestamp(3), "saleEndAt" timestamp(3), currency text NOT NULL DEFAULT 'NGN'
    )`);
    await db.query(
      fs.readFileSync(
        path.join(
          __dirname,
          '../prisma/migrations/20261115090100_product_effective_price/migration.sql',
        ),
        'utf8',
      ),
    );
    await db.query(
      'CREATE INDEX "Product_market_price_change_idx" ON "Product" ("priceChangeXid","_id")',
    );
    const ids = (
      await db.query(
        'INSERT INTO "Product" (price) VALUES (100),(200) RETURNING "_id"',
      )
    ).rows.map((row) => row._id);
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: withUtcDatabaseUrl(tu.toString()),
      }),
    });
    const snapshot = async (client = db) =>
      (await client.query('SELECT pg_current_snapshot()::text AS snapshot'))
        .rows[0].snapshot;
    const probe = async (captured, expected, label) => {
      const result = await prisma.$queryRaw(
        Prisma.sql`SELECT ${marketPriceWritesSinceSql(captured)} AS changed`,
      );
      assert.equal(result[0].changed, expected, label);
      checks++;
    };
    const update = (client, id, price) =>
      client.query('UPDATE "Product" SET price=$2 WHERE "_id"=$1', [id, price]);
    await probe(await snapshot(), false, 'No writes after capture');

    await a.query('BEGIN');
    const activeId = (await a.query('SELECT pg_current_xact_id()::text AS xid'))
      .rows[0].xid;
    // Advance xmax beyond the held transaction to exercise the active-xid
    // branch independently from the next-xid/future branch below.
    await db.query('SELECT pg_current_xact_id()');
    let captured = await snapshot();
    assert(parseMarketSnapshot(captured).active.includes(activeId));
    await update(a, ids[0], 110);
    await probe(
      captured,
      false,
      'Uncommitted price is not in the current request snapshot',
    );
    await a.query('COMMIT');
    await probe(
      captured,
      true,
      'Older active transaction commits after page one',
    );

    captured = await snapshot();
    await a.query('BEGIN');
    await update(a, ids[0], 120);
    await a.query('ROLLBACK');
    await probe(
      captured,
      false,
      'Rolled-back writes do not cause a false changed-price event',
    );
    captured = await snapshot();
    await update(db, ids[0], 130);
    await probe(
      captured,
      true,
      'A later allocated transaction crosses the captured xmax',
    );

    await a.query('BEGIN');
    captured = await snapshot();
    await update(a, ids[0], 140);
    await a.query('COMMIT');
    await probe(
      captured,
      true,
      'Transaction began earlier but allocated its top-level xid later',
    );

    captured = await snapshot();
    await db.query(
      'UPDATE "Product" SET name=\'Unrelated edit\' WHERE "_id"=$1',
      [ids[0]],
    );
    await db.query('UPDATE "Product" SET "effectivePrice"=1 WHERE "_id"=$1', [
      ids[0],
    ]);
    await probe(
      captured,
      false,
      'Unrelated edits and repaired cache tampering retain the old price xid',
    );

    await a.query('BEGIN');
    const parent = (await a.query('SELECT pg_current_xact_id()::text AS xid'))
      .rows[0].xid;
    captured = await snapshot();
    await a.query('SAVEPOINT inner_price');
    await update(a, ids[0], 150);
    assert.equal(
      (
        await a.query(
          'SELECT "priceChangeXid"::text AS xid FROM "Product" WHERE "_id"=$1',
          [ids[0]],
        )
      ).rows[0].xid,
      parent,
    );
    await a.query('RELEASE SAVEPOINT inner_price');
    await a.query('COMMIT');
    await probe(
      captured,
      true,
      'Savepoint writes stamp the parent xid, not an invisible subtransaction id',
    );

    await reader.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    captured = await snapshot(reader);
    const before = (
      await reader.query('SELECT price::text FROM "Product" WHERE "_id"=$1', [
        ids[0],
      ])
    ).rows[0].price;
    await update(db, ids[0], 160);
    const fence = marketPriceWritesSinceSql(captured);
    const within = await reader.query(
      'SELECT ' + fence.text + ' AS changed',
      fence.values,
    );
    assert.equal(within.rows[0].changed, false);
    assert.equal(
      (
        await reader.query('SELECT price::text FROM "Product" WHERE "_id"=$1', [
          ids[0],
        ])
      ).rows[0].price,
      before,
    );
    await reader.query('COMMIT');
    checks++;
    await probe(
      captured,
      true,
      'Next request sees the price update; a request never mixes MVCC views',
    );

    captured = await snapshot();
    await db.query('UPDATE "Product" SET currency=\'USD\' WHERE "_id"=$1', [
      ids[0],
    ]);
    await probe(
      captured,
      true,
      'Currency/filter exits are not excluded from the write fence',
    );
    captured = await snapshot();
    await db.query('DELETE FROM "Product" WHERE "_id"=$1', [ids[0]]);
    await probe(
      captured,
      false,
      'Deletion removes a row without moving surviving price keys',
    );

    const independent = (
      await db.query(
        'INSERT INTO "Product" (price) VALUES (100) RETURNING "_id"',
      )
    ).rows[0]._id;
    captured = await snapshot();
    await a.query('BEGIN');
    await b.query('BEGIN');
    await Promise.all([update(a, ids[1], 210), update(b, independent, 110)]);
    await Promise.all([a.query('COMMIT'), b.query('COMMIT')]);
    await probe(
      captured,
      true,
      'Independent product writers complete without a catalogue-wide lock',
    );

    // A transaction unrelated to products holds xmin far behind a large batch.
    // xmax plus active-xid probes must still prove no later price writes, rather
    // than scanning every committed row between xmin and xmax.
    await a.query('BEGIN');
    await a.query('SELECT pg_current_xact_id()');
    await db.query(
      'INSERT INTO "Product" (price) SELECT 100 FROM generate_series(1,20000)',
    );
    await db.query('ANALYZE "Product"');
    captured = await snapshot();
    await probe(
      captured,
      false,
      'Long unrelated transaction plus 20k already-visible rows',
    );
    const predicate = marketPriceWritesSinceSql(captured);
    const plan = (
      await db.query(
        'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) SELECT ' +
          predicate.text +
          ' AS changed',
        predicate.values,
      )
    ).rows[0]['QUERY PLAN'][0];
    const nodes = [];
    const visit = (node) => {
      nodes.push(node);
      for (const child of node.Plans ?? []) visit(child);
    };
    visit(plan.Plan);
    assert(
      nodes.some(
        (node) =>
          node['Index Name'] === 'Product_market_price_change_idx' &&
          node['Index Cond'],
      ),
      'Real xid8 index condition required',
    );
    assert(
      !nodes.some(
        (node) =>
          node['Relation Name'] === 'Product' &&
          node['Node Type'] === 'Seq Scan',
      ),
      'Fence must not scan the catalogue',
    );
    assert(
      nodes
        .filter((node) => node['Relation Name'] === 'Product')
        .every((node) => (node['Actual Rows'] ?? 0) <= 1),
    );
    await a.query('ROLLBACK');
    checks++;
    console.log(
      'PASS ' +
        checks +
        ' PostgreSQL transaction-fence proofs, actual migration trigger and indexed 20k-row probes',
    );
    console.log(
      'Fixture execution ' +
        plan['Execution Time'] +
        ' ms; this is not a production capacity claim',
    );
  } finally {
    if (prisma) await prisma.$disconnect();
    for (const client of clients) {
      await client.query('ROLLBACK');
      await client.end();
    }
    if (created) {
      assert(/^aru_market_price_fence_[a-f0-9]{32}$/.test(name));
      await admin.query('DROP DATABASE "' + name + '"');
    }
    await admin.end();
  }
}
main().catch((error) => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
