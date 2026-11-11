const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');

module.exports = async ({ record }) => {
  const url = new URL(process.env.DATABASE_URL);
  assert(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
  assert(/^\/wiez_adaptive_test_[a-f0-9]{32}$/.test(url.pathname));
  const schema = `wiez_schedule_test_${randomUUID().replaceAll('-', '')}`;
  assert(/^wiez_schedule_test_[a-f0-9]{32}$/.test(schema));
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  let created = false;
  try {
    const [database] = (await client.query('SELECT current_database() AS name')).rows;
    assert.equal(database.name, url.pathname.slice(1));
    await client.query(`CREATE SCHEMA "${schema}"`); created = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('CREATE TABLE "BrandSubscription" (id INTEGER PRIMARY KEY, "scheduledTierKey" TEXT)');
    await client.query('INSERT INTO "BrandSubscription" VALUES (1, $1)', ['THREAD']);
    const sql = await readFile(path.join(__dirname, '../prisma/migrations/20261102160000_snapshot_scheduled_subscription_price/migration.sql'), 'utf8');
    await assert.rejects(client.query(sql), error => error.code === 'P0001' && /No historical approved price will be guessed/.test(error.message));
    await client.query('ROLLBACK');
    assert.equal((await client.query('SELECT "scheduledTierKey" FROM "BrandSubscription" WHERE id=1')).rows[0].scheduledTierKey, 'THREAD');
    assert.equal((await client.query('SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 AND column_name=$3',
      [schema, 'BrandSubscription', 'scheduledPriceSnapshotNgn'])).rowCount, 0);
    record('scheduled-price migration refuses an unknown historical approved price and rolls back without partially changing the schema');
    await client.query('DELETE FROM "BrandSubscription"');
    await client.query(sql);
    for (const [tier, price] of [['THREAD', null], [null, 10000], ['THREAD', -1]]) {
      await assert.rejects(client.query('INSERT INTO "BrandSubscription" (id,"scheduledTierKey","scheduledPriceSnapshotNgn") VALUES (1,$1,$2)', [tier, price]),
        error => error.code === '23514');
    }
    await client.query('INSERT INTO "BrandSubscription" (id,"scheduledTierKey","scheduledPriceSnapshotNgn") VALUES (1,$1,$2),(2,NULL,NULL)', ['THREAD', 10000]);
    assert.equal((await client.query('SELECT COUNT(*)::int AS count FROM "BrandSubscription"')).rows[0].count, 2);
    record('scheduled-price migration accepts complete approved snapshots and rejects missing, orphaned or negative prices');
  } finally {
    await client.query('ROLLBACK');
    await client.query('SET search_path TO public');
    if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    await client.end();
  }
};
