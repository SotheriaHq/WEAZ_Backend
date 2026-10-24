// Exercises the production aggregate SQL in an isolated schema on loopback PostgreSQL.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const ts = require('typescript');
require('dotenv').config({ quiet: true });

const filename = path.resolve(__dirname, '../src/store/collection-price-range.util.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled, filename);
const { refreshCollectionPriceRanges } = loaded.exports;
const schema = `wiez_price_test_${randomUUID().replaceAll('-', '')}`;
const ids = Array.from({ length: 16 }, () => randomUUID());
const tx = (client) => ({
  $queryRaw: async (query) => (await client.query(query.text, query.values)).rows,
  $executeRaw: async (query) => (await client.query(query.text, query.values)).rowCount,
});

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const client = new Client({ connectionString: source.toString() });
  const second = new Client({ connectionString: source.toString() });
  await client.connect();
  let created = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query(`CREATE TABLE "StoreCollection" (
      "_id" uuid PRIMARY KEY, "minPrice" float8, "maxPrice" float8,
      "saleMinPrice" float8, "saleMaxPrice" float8, "updatedAt" timestamp);
      CREATE TABLE "Product" ("_id" uuid PRIMARY KEY, price numeric,
        "salePrice" numeric, "saleStartAt" timestamp, "saleEndAt" timestamp,
        "deletedAt" timestamp, "archivedAt" timestamp, "isActive" boolean DEFAULT true, "publishAt" timestamp);
      CREATE TABLE "ProductVariant" ("productId" uuid, price numeric);
      CREATE TABLE "StoreCollectionProduct" ("collectionId" uuid, "productId" uuid, "isPrimary" boolean DEFAULT false);`);
    const [collection, empty, product, variantProduct, inactive, deleted, archived, scheduled, expired, future] = ids;
    await client.query('INSERT INTO "StoreCollection" ("_id") VALUES ($1), ($2)', [collection, empty]);
    await client.query(`INSERT INTO "Product" ("_id", price, "salePrice", "saleStartAt", "saleEndAt")
      VALUES ($1, 100, 80, now()-interval '1 day', now()+interval '1 day'),
      ($2, 999, 50, null, null), ($3, 1, null, null, null), ($4, 2, null, null, null),
      ($5, 3, null, null, null), ($6, 4, null, null, null),
      ($7, 200, 1, null, now()-interval '1 day'),
      ($8, 300, 2, now()+interval '1 day', null)`,
      [product, variantProduct, inactive, deleted, archived, scheduled, expired, future]);
    await client.query(`UPDATE "Product" SET "isActive"=false WHERE "_id"=$1;
    `.trim(), [inactive]);
    await client.query('UPDATE "Product" SET "deletedAt"=now() WHERE "_id"=$1', [deleted]);
    await client.query('UPDATE "Product" SET "archivedAt"=now() WHERE "_id"=$1', [archived]);
    await client.query(`UPDATE "Product" SET "publishAt"=now()+interval '1 day' WHERE "_id"=$1`, [scheduled]);
    await client.query('INSERT INTO "ProductVariant" ("productId",price) VALUES ($1,40),($1,400),($1,0),($1,-1),($1,null)', [variantProduct]);
    await client.query('INSERT INTO "StoreCollectionProduct" ("collectionId","productId") SELECT $1, unnest($2::uuid[])',
      [collection, [product, variantProduct, inactive, deleted, archived, scheduled, expired, future]]);
    await client.query('BEGIN');
    await refreshCollectionPriceRanges(tx(client), [collection, empty, collection]);
    await client.query('COMMIT');
    const read = async (id) => (await client.query('SELECT "minPrice","maxPrice","saleMinPrice","saleMaxPrice" FROM "StoreCollection" WHERE "_id"=$1', [id])).rows[0];
    assert.deepEqual(await read(collection), { minPrice: 40, maxPrice: 400, saleMinPrice: 50, saleMaxPrice: 80 });
    assert.deepEqual(await read(empty), { minPrice: null, maxPrice: null, saleMinPrice: null, saleMaxPrice: null });
    await client.query('UPDATE "ProductVariant" SET price=null WHERE "productId"=$1', [variantProduct]);
    await client.query('BEGIN'); await refreshCollectionPriceRanges(tx(client), [collection]); await client.query('COMMIT');
    assert.equal((await read(collection)).maxPrice, 999, 'Base price must be used when no positive variants exist');

    // The second refresh must wait for the first lock, then read the committed price.
    await second.connect();
    await second.query(`SET search_path TO "${schema}"`);
    await client.query('BEGIN');
    await client.query('SELECT "_id" FROM "StoreCollection" WHERE "_id"=$1 FOR UPDATE', [collection]);
    await second.query('BEGIN');
    await second.query(`SET LOCAL statement_timeout = '5s'`);
    const secondPid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waiting = refreshCollectionPriceRanges(tx(second), [collection]);
    let blocked = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      const result = await client.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [secondPid]);
      if (result.rows[0]?.wait_event_type === 'Lock') { blocked = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(blocked, 'Concurrent refresher must acquire the collection lock');
    await client.query('UPDATE "Product" SET price=1200 WHERE "_id"=$1', [product]);
    await client.query('COMMIT');
    await waiting; await second.query('COMMIT');
    assert.equal((await read(collection)).maxPrice, 1200, 'Post-lock statement must see committed competing update');
    const migration = fs.readFileSync(path.resolve(__dirname, '../prisma/migrations/20261023100000_enforce_one_primary_store_membership/migration.sql'), 'utf8');
    await client.query('BEGIN');
    await client.query('INSERT INTO "StoreCollectionProduct" VALUES ($1,$2,true),($3,$2,true)', [collection, product, empty]);
    await assert.rejects(client.query(migration), /Primary store memberships are inconsistent/);
    await client.query('ROLLBACK');
    await client.query(migration);
    await client.query('UPDATE "StoreCollectionProduct" SET "isPrimary"=true WHERE "productId"=$1', [product]);
    await assert.rejects(client.query('INSERT INTO "StoreCollectionProduct" VALUES ($1,$2,true)', [empty, product]), { code: '23505' });
    console.log('PASS: variants/base/empty/visibility/sale windows and concurrent price refresh; dirty-data migration guard and unique primary membership enforcement.');
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    await second.query('ROLLBACK').catch(() => {});
    await second.end().catch(() => {});
    if (created) {
      assert(/^wiez_price_test_[a-f0-9]{32}$/.test(schema));
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await client.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
