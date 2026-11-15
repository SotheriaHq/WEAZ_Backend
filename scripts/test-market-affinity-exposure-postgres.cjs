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
const name = 'wiez_market_storage_' + randomUUID().replaceAll('-', '');
if (!/^wiez_market_storage_[a-f0-9]{32}$/.test(name))
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
    await db.query('CREATE TABLE "User" ("_id" uuid PRIMARY KEY)');
    for (const dir of [
      '20261115090000_product_first_published_at',
      '20261115090100_product_effective_price',
      '20261115090200_market_item_features',
      '20261115090300_user_market_affinity',
      '20261115090400_market_section_exposure',
    ])
      await db.query(
        fs.readFileSync(
          path.join(work, 'prisma/migrations', dir, 'migration.sql'),
          'utf8',
        ),
      );
    proof.push('actual migration groups1–5 apply together');
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
    const user = randomUUID();
    await db.query('INSERT INTO "User" VALUES ($1)', [user]);
    await fails(
      'INSERT INTO user_market_affinity("userId","sourceWindowStart","sourceWindowEnd","updatedAt") VALUES ($1,statement_timestamp()-interval \'1 day\',statement_timestamp(),statement_timestamp())',
      [user],
      '23502',
    );
    await db.query(
      'INSERT INTO user_market_affinity("userId","sourceWindowStart","sourceWindowEnd","expiresAt","updatedAt") VALUES ($1,statement_timestamp()-interval \'1 day\',statement_timestamp(),statement_timestamp()+interval \'1 hour\',statement_timestamp())',
      [user],
    );
    let row = (
      await db.query('SELECT * FROM user_market_affinity WHERE "userId"=$1', [
        user,
      ])
    ).rows[0];
    assert.equal(row.hardActions, null);
    assert.equal(row.recentOpens, null);
    assert.equal(row.sourceCompleteness, 'UNAVAILABLE');
    await fails(
      'UPDATE user_market_affinity SET "hardActions"=0 WHERE "userId"=$1',
      [user],
    );
    await fails(
      'UPDATE user_market_affinity SET "expiresAt"="computedAt" WHERE "userId"=$1',
      [user],
    );
    const brand = randomUUID();
    await db.query(
      'UPDATE user_market_affinity SET brands=$2,sizes=$3,"sourceCompleteness"=\'PARTIAL\' WHERE "userId"=$1',
      [user, JSON.stringify([{ id: brand, w: 0.5 }]), ['XS–S', '子供（小）']],
    );
    await fails('UPDATE user_market_affinity SET brands=$2 WHERE "userId"=$1', [
      user,
      JSON.stringify([
        { id: brand, w: 0.5 },
        { id: brand, w: -0.2 },
      ]),
    ]);
    await fails('UPDATE user_market_affinity SET brands=$2 WHERE "userId"=$1', [
      user,
      JSON.stringify([{ id: brand, w: 0.5, actorId: user }]),
    ]);
    await fails(
      'UPDATE user_market_affinity SET dimensions=$2 WHERE "userId"=$1',
      [
        user,
        JSON.stringify([
          { dimension: 'email', value: 'private@example.test', w: 0.5 },
        ]),
      ],
    );
    await db.query(
      'UPDATE user_market_affinity SET dimensions=$2 WHERE "userId"=$1',
      [
        user,
        JSON.stringify([
          { dimension: randomUUID(), value: randomUUID(), w: -0.5 },
        ]),
      ],
    );
    await fails(
      'UPDATE user_market_affinity SET "recentBrands"=brands WHERE "userId"=$1',
      [user],
    );
    proof.push(
      'affinity requires expiry, distinguishes unknown counts and bounds vectors while preserving international sizes',
    );
    await db.query('DELETE FROM "User" WHERE "_id"=$1', [user]);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM user_market_affinity'))
        .rows[0].n,
      0,
    );
    proof.push('user deletion cascades affinity erasure');
    const product = (
      await db.query('INSERT INTO "Product" DEFAULT VALUES RETURNING "_id"')
    ).rows[0]._id;
    const placement =
      "INSERT INTO market_section_exposure(\"sectionKey\",\"productId\",epoch,slot) VALUES ('fresh-drops',$1,date_bin(interval '6 hours',statement_timestamp(),'1970-01-01Z'::timestamptz),$2)";
    await db.query(placement, [product, 0]);
    await db.query(
      placement + ' ON CONFLICT ("sectionKey","productId",epoch) DO NOTHING',
      [product, 1],
    );
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM market_section_exposure'))
        .rows[0].n,
      1,
    );
    await fails(placement, [product, 12]);
    await fails(
      'UPDATE market_section_exposure SET epoch=epoch+interval \'1 second\' WHERE "productId"=$1',
      [product],
    );
    await db.query(
      'INSERT INTO market_feature_state(key,generation,"updatedAt") VALUES (\'placement\',1,statement_timestamp())',
    );
    const epoch = randomUUID();
    await db.query(
      'INSERT INTO market_feature_epochs(id,"stateKey",generation,"epochStart","epochEnd","sourceAsOf","acceptUntil","cleanupAfter") VALUES ($1,\'placement\',1,statement_timestamp()-interval \'1 minute\',statement_timestamp()+interval \'1 hour\',statement_timestamp(),statement_timestamp()+interval \'1 hour\',statement_timestamp()+interval \'2 hours\')',
      [epoch],
    );
    await fails(
      'UPDATE market_section_exposure SET "epochId"=$2 WHERE "productId"=$1',
      [product, epoch],
    );
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
    await db.query(
      'UPDATE market_feature_epochs SET "writerXid"=pg_current_xact_id() WHERE id=$1',
      [epoch],
    );
    await db.query(
      'UPDATE market_feature_epochs SET status=\'READY\',"rowCount"=0 WHERE id=$1',
      [epoch],
    );
    await db.query(
      'UPDATE market_feature_state SET "currentEpochId"=$1 WHERE key=\'placement\'',
      [epoch],
    );
    await db.query('COMMIT');
    await db.query(
      'UPDATE market_section_exposure SET "epochId"=$2 WHERE "productId"=$1',
      [product, epoch],
    );
    proof.push(
      'preview tenure dedupes, bounds slots/time buckets and rejects unpublished snapshot references',
    );
    await db.query('DELETE FROM "Product" WHERE "_id"=$1', [product]);
    assert.equal(
      (await db.query('SELECT count(*)::int AS n FROM market_section_exposure'))
        .rows[0].n,
      0,
    );
    proof.push('product deletion cascades global tenure records');
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
