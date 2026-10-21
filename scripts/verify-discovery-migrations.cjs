require('dotenv').config({ quiet: true });
const { Client } = require('pg');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert/strict');
const { randomUUID } = require('crypto');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Local PostgreSQL required');
const name = 'wiez_migration_' + Date.now();
const adminUrl = new URL(url);
adminUrl.pathname = '/postgres';
const testUrl = new URL(url);
testUrl.pathname = '/' + name;
const admin = new Client({ connectionString: adminUrl.toString() });
const client = new Client({ connectionString: testUrl.toString() });
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wiez-migrations-'));
const schemaFile = path.join(directory, 'schema.prisma');
async function main() {
  await admin.connect();
  await admin.query(`CREATE DATABASE "${name}"`);
  await client.connect();
  fs.writeFileSync(
    schemaFile,
    execFileSync('git', ['show', 'HEAD:prisma/schema.prisma']),
  );
  const baseline = execFileSync(
    process.execPath,
    [
      require.resolve('prisma/build/index.js'),
      'migrate',
      'diff',
      '--from-empty',
      '--to-schema',
      schemaFile,
      '--script',
    ],
    { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
  );
  await client.query(baseline);
  for (const migration of [
    '20261021120000_brand_customers',
    '20261021121000_runway_feed_sessions',
    '20261021122000_runway_affinity_cache',
    '20261021123000_featured_active_history',
    '20261021124000_storage_deletion_outbox',
    '20261021125000_cart_selection_integrity',
    '20261021126000_reference_integrity',
    '20261021127000_image_processing_lease',
  ])
    await client.query(
      fs.readFileSync(`prisma/migrations/${migration}/migration.sql`, 'utf8'),
    );
  const tables = await client.query(
    `SELECT relname,relrowsecurity FROM pg_class WHERE relname IN ('RunwayAffinityCache','RunwayFeedSession','StorageObjectDeletion')`,
  );
  assert.equal(tables.rows.length, 3);
  assert(tables.rows.every((row) => row.relrowsecurity));
  const user = randomUUID(),
    brand = randomUUID();
  await client.query(
    `INSERT INTO "User" ("_id",username,email,type,"updatedAt") VALUES ($1,'migration-fixture','migration@example.invalid','BRAND',NOW())`,
    [user],
  );
  await client.query(
    `INSERT INTO "Brand" ("_id",name,"ownerId","updatedAt") VALUES ($1,'Migration fixture',$2,NOW())`,
    [brand, user],
  );
  assert.equal(
    (
      await client.query(
        'SELECT "customerMinimumOrders" AS minimum FROM "Brand" WHERE "_id"=$1',
        [brand],
      )
    ).rows[0].minimum,
    3,
  );
  await assert.rejects(
    client.query(
      'UPDATE "Brand" SET "customerMinimumOrders"=0 WHERE "_id"=$1',
      [brand],
    ),
    (error) => error.code === '23514',
  );
  await client.query(
    `INSERT INTO "RunwayFeedSession" (id,"userId","categoryKey","designIds","expiresAt") VALUES ($1,$2,'discover',ARRAY[]::uuid[],NOW())`,
    [randomUUID(), user],
  );
  await client.query(
    `INSERT INTO "RunwayAffinityCache" ("userId",payload,"builtAt","expiresAt") VALUES ($1,'{}',NOW(),NOW())`,
    [user],
  );
  const buyer = randomUUID(), product = randomUUID();
  await client.query(`INSERT INTO "User" ("_id",username,email,"updatedAt") VALUES ($1,'migration-buyer','migration-buyer@example.invalid',NOW())`, [buyer]);
  await client.query(`INSERT INTO "Product" ("_id", name, "brandId",price,"updatedAt") VALUES ($1,'Jacket',$2,120,NOW())`, [product, brand]);
  const cart = randomUUID();
  await client.query(`INSERT INTO "CartItem" ("_id","userId","productId",quantity,"updatedAt") VALUES ($1,$2,$3,5,NOW())`, [cart,buyer,product]);
  await assert.rejects(client.query(`INSERT INTO "CartItem" ("_id","userId","productId",quantity,"updatedAt") VALUES ($1,$2,$3,1,NOW())`, [randomUUID(),buyer,product]), (error) => error.code === '23505');
  await assert.rejects(client.query(`UPDATE "CartItem" SET quantity=0 WHERE "_id"=$1`, [cart]), (error) => error.code === '23514');
  await assert.rejects(client.query(`INSERT INTO "CartItem" ("_id","userId","productId",quantity,"updatedAt") VALUES ($1,$2,$3,1,NOW())`, [randomUUID(),randomUUID(),product]), (error) => error.code === '23503');
  await client.query(`INSERT INTO "WishlistItem" ("_id","userId","productId") VALUES ($1,$2,$3)`, [randomUUID(),buyer,product]);
  for (let i=0;i<3;i++) await client.query(`INSERT INTO "FeaturedItem" ("_id","entityType","entityId","brandId","startsAt","expiresAt","isActive","featuredById","updatedAt") VALUES ($1,'PRODUCT',$2,$3,NOW(),NOW()+interval '7 days',false,$4,NOW())`, [randomUUID(),product,brand,user]);
  await client.query(`INSERT INTO "FeaturedItem" ("_id","entityType","entityId","brandId","startsAt","expiresAt","isActive","featuredById","updatedAt") VALUES ($1,'PRODUCT',$2,$3,NOW(),NOW()+interval '7 days',true,$4,NOW())`, [randomUUID(),product,brand,user]);
  await assert.rejects(client.query(`INSERT INTO "FeaturedItem" ("_id","entityType","entityId","brandId","startsAt","expiresAt","isActive","featuredById","updatedAt") VALUES ($1,'PRODUCT',$2,$3,NOW(),NOW()+interval '7 days',true,$4,NOW())`, [randomUUID(),randomUUID(),brand,user]), (error) => error.code === '23505' && error.constraint === 'FeaturedItem_active_brand_key');
  await client.query('DELETE FROM "User" WHERE "_id"=$1', [buyer]);
  for (const table of ['CartItem','WishlistItem']) assert.equal((await client.query(`SELECT COUNT(*)::int count FROM "${table}" WHERE "userId"=$1`, [buyer])).rows[0].count,0);
  await client.query(`INSERT INTO "StorageObjectDeletion" ("s3Key") VALUES ('migration-fixture')`);
  await assert.rejects(client.query(`UPDATE "StorageObjectDeletion" SET attempts=-1`), (error)=>error.code==='23514');
  await client.query('DELETE FROM "Brand" WHERE "_id"=$1', [brand]);
  await client.query('DELETE FROM "User" WHERE "_id"=$1', [user]);
  for (const table of ['RunwayFeedSession', 'RunwayAffinityCache'])
    assert.equal(
      (await client.query(`SELECT COUNT(*)::int count FROM "${table}"`)).rows[0]
        .count,
      0,
    );
  console.log(
    'Eight migrations passed against the previous schema: feed privacy/defaults, active-only featured uniqueness with retained history, storage outbox/RLS, NULL-safe cart uniqueness, quantity checks and cart/wishlist ownership cascades.',
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.end().catch(() => {});
    if (admin._connected && /^wiez_migration_\d+$/.test(name))
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
    if (fs.existsSync(schemaFile)) fs.unlinkSync(schemaFile);
    fs.rmdirSync(directory);
  });
