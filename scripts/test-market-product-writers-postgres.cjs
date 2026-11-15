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
const name = 'wiez_market_writers_' + randomUUID().replaceAll('-', '');
if (!/^wiez_market_writers_[a-f0-9]{32}$/.test(name))
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
    const legacy = (
      await db.query(
        'INSERT INTO "Product" ("createdAt","publicationStatus","isActive") VALUES ((statement_timestamp() AT TIME ZONE \'UTC\')-interval \'10 days\',\'PUBLISHED\',true) RETURNING "_id"',
      )
    ).rows[0]._id;
    const bad = (
      await db.query(
        'INSERT INTO "Product" (price) VALUES (-1) RETURNING "_id"',
      )
    ).rows[0]._id;
    for (const dir of [
      '20261115090000_product_first_published_at',
      '20261115090100_product_effective_price',
    ])
      await db.query(
        fs.readFileSync(
          path.join(work, 'prisma/migrations', dir, 'migration.sql'),
          'utf8',
        ),
      );
    proof.push(
      'actual first two migration SQL files applied to populated fixture',
    );
    const read = async (id) =>
      (
        await db.query(
          'SELECT *,"publishAt" AT TIME ZONE \'UTC\' AS scheduled FROM "Product" WHERE "_id"=$1',
          [id],
        )
      ).rows[0];
    const insert = async () =>
      (await db.query('INSERT INTO "Product" DEFAULT VALUES RETURNING "_id"'))
        .rows[0]._id;
    const draft = await insert();
    assert.equal((await read(draft)).firstPublishedAt, null);
    await db.query(
      'UPDATE "Product" SET "publicationStatus"=\'PUBLISHED\',"isActive"=true WHERE "_id"=$1',
      [draft],
    );
    let row = await read(draft);
    const first = row.firstPublishedAt.getTime();
    assert.equal(row.firstPublicationSource, 'OBSERVED');
    const originalXid = row.priceChangeXid;
    const priceTime = row.effectivePriceComputedAt.getTime();
    await db.query('UPDATE "Product" SET name=\'Renamed\' WHERE "_id"=$1', [
      draft,
    ]);
    row = await read(draft);
    assert.equal(row.firstPublishedAt.getTime(), first);
    assert.equal(row.priceChangeXid, originalXid);
    assert.equal(row.effectivePriceComputedAt.getTime(), priceTime);
    await db.query(
      'UPDATE "Product" SET "publicationStatus"=\'DRAFT\',"isActive"=false WHERE "_id"=$1',
      [draft],
    );
    await db.query(
      'UPDATE "Product" SET "publicationStatus"=\'PUBLISHED\',"isActive"=true WHERE "_id"=$1',
      [draft],
    );
    row = await read(draft);
    assert.equal(row.firstPublishedAt.getTime(), first);
    assert(row.lastRelistedAt.getTime() >= first);
    await db.query(
      'UPDATE "Product" SET "firstPublishedAt"=statement_timestamp()+interval \'1 day\',"firstPublicationSource"=\'INFERRED\' WHERE "_id"=$1',
      [draft],
    );
    assert.equal((await read(draft)).firstPublishedAt.getTime(), first);
    proof.push(
      'immediate publication, unrelated edits, unpublish/relist and timestamp tampering preserve first date',
    );
    const planned = (
      await db.query(
        'INSERT INTO "Product" ("publicationStatus","isActive","publishAt") VALUES (\'PUBLISHED\',true,(statement_timestamp() AT TIME ZONE \'UTC\')+interval \'1 day\') RETURNING "_id"',
      )
    ).rows[0]._id;
    row = await read(planned);
    assert.equal(row.firstPublicationSource, 'SCHEDULED');
    assert.equal(row.firstPublishedAt.getTime(), row.scheduled.getTime());
    await db.query(
      'UPDATE "Product" SET "publishAt"="publishAt"+interval \'1 day\' WHERE "_id"=$1',
      [planned],
    );
    row = await read(planned);
    assert.equal(row.firstPublishedAt.getTime(), row.scheduled.getTime());
    await db.query(
      'UPDATE "Product" SET "publicationStatus"=\'DRAFT\',"isActive"=false WHERE "_id"=$1',
      [planned],
    );
    assert.equal((await read(planned)).firstPublishedAt, null);
    proof.push(
      'rescheduling and cancellation before first scheduled visibility',
    );
    const due = (
      await db.query(
        'INSERT INTO "Product" ("publicationStatus","isActive","publishAt") VALUES (\'PUBLISHED\',true,(date_trunc(\'milliseconds\',statement_timestamp()) AT TIME ZONE \'UTC\')+interval \'50 milliseconds\') RETURNING "_id"',
      )
    ).rows[0]._id;
    const scheduled = (await read(due)).firstPublishedAt.getTime();
    require('ts-node').register({ transpileOnly: true });
    const {
      isEligibleProduct,
    } = require('../src/market/eligibility/market-eligibility');
    const scheduledProduct = {
      ...(await read(due)),
      publishAt: new Date(scheduled),
      totalStock: 1,
      customOrderEnabled: false,
      thumbnail: 'https://media.example.test/piece.jpg',
      images: [],
      collections: [],
      brand: { isStoreOpen: true, owner: { status: 'ACTIVE' } },
    };
    assert.equal(
      isEligibleProduct(scheduledProduct, new Date(scheduled - 1)),
      false,
    );
    assert.equal(
      isEligibleProduct(scheduledProduct, new Date(scheduled)),
      true,
    );
    await db.query('SELECT pg_sleep(0.08)');
    row = await read(due);
    assert.equal(row.firstPublishedAt.getTime(), scheduled);
    assert(row.firstPublishedAt.getTime() <= Date.now());
    await db.query(
      'UPDATE "Product" SET "publishAt"=(statement_timestamp() AT TIME ZONE \'UTC\')+interval \'2 days\' WHERE "_id"=$1',
      [due],
    );
    await db.query(
      'UPDATE "Product" SET name=\'Still same first date\' WHERE "_id"=$1',
      [due],
    );
    assert.equal((await read(due)).firstPublishedAt.getTime(), scheduled);
    proof.push(
      'clock-only first visibility and later schedule edits never reset its first date',
    );
    const concurrent = new Client({ connectionString: tu.toString() });
    await concurrent.connect();
    try {
      const waiting = (
        await db.query(`INSERT INTO "Product" ("publicationStatus","isActive","publishAt")
        VALUES ('PUBLISHED',true,(statement_timestamp() AT TIME ZONE 'UTC')+interval '1 second')
        RETURNING "_id","firstPublishedAt"`)
      ).rows[0];
      await db.query('BEGIN');
      await db.query('SELECT "_id" FROM "Product" WHERE "_id"=$1 FOR UPDATE', [
        waiting._id,
      ]);
      const pending = concurrent.query(
        `UPDATE "Product" SET "publicationStatus"='DRAFT',"isActive"=false
        WHERE "_id"=$1 RETURNING "firstPublishedAt"`,
        [waiting._id],
      );
      await db.query('SELECT pg_sleep(1.1)');
      await db.query('COMMIT');
      const changed = (await pending).rows[0];
      assert.equal(
        changed.firstPublishedAt?.getTime(),
        waiting.firstPublishedAt.getTime(),
        'A cancellation waiting across scheduled visibility must retain the first public date',
      );
      proof.push(
        'row-lock wait crossing the scheduled time preserves actual first visibility',
      );
    } finally {
      await db.query('ROLLBACK');
      await concurrent.end();
    }
    await db.query(
      'UPDATE "Product" SET name=\'Edited during backfill\' WHERE "_id"=$1',
      [legacy],
    );
    row = await read(legacy);
    assert.equal(row.firstPublicationSource, 'INFERRED');
    assert(row.firstPublishedAt.getTime() < Date.now() - 9 * 86400000);
    proof.push(
      'public row edited between expansion and backfill retains inferred age',
    );
    const clone = (
      await db.query(
        'INSERT INTO "Product" ("firstPublishedAt","firstPublicationSource","lastRelistedAt") SELECT "firstPublishedAt","firstPublicationSource","lastRelistedAt" FROM "Product" WHERE "_id"=$1 RETURNING "_id"',
        [draft],
      )
    ).rows[0]._id;
    row = await read(clone);
    assert.equal(row.firstPublishedAt, null);
    assert.equal(row.lastRelistedAt, null);
    proof.push('cloning does not copy publication history');
    await db.query('UPDATE "Product" SET "salePrice"=90 WHERE "_id"=$1', [
      draft,
    ]);
    row = await read(draft);
    assert.equal(row.effectivePrice, '90.00');
    assert.notEqual(row.priceChangeXid, originalXid);
    const saleXid = row.priceChangeXid;
    await db.query('UPDATE "Product" SET "effectivePrice"=1 WHERE "_id"=$1', [
      draft,
    ]);
    row = await read(draft);
    assert.equal(row.effectivePrice, '90.00');
    assert.equal(row.priceChangeXid, saleXid);
    await db.query('UPDATE "Product" SET "salePrice"=110 WHERE "_id"=$1', [
      draft,
    ]);
    assert.equal((await read(draft)).effectivePrice, '100.00');
    proof.push(
      'raw price writes recompute cache and XID; invalid promotion ignored; cache tampering repaired',
    );
    let rejected = false;
    try {
      await db.query(
        'ALTER TABLE "Product" VALIDATE CONSTRAINT "Product_base_price_finite_check"',
      );
    } catch (e) {
      assert.equal(e.code, '23514');
      rejected = true;
    }
    assert(rejected);
    assert.equal((await read(bad)).price, '-1.00');
    await db.query('DELETE FROM "Product" WHERE "_id"=$1', [bad]);
    for (const constraint of [
      'Product_base_price_finite_check',
      'Product_sale_price_finite_check',
      'Product_sale_dates_finite_check',
    ])
      await db.query(
        'ALTER TABLE "Product" VALIDATE CONSTRAINT "' + constraint + '"',
      );
    proof.push(
      'invalid historical fixture blocks validation without deletion; valid fixture validates',
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
