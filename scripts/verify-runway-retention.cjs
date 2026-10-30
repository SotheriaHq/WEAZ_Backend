require('dotenv').config({ quiet: true });
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { Client } = require('pg');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { RunwayFeedService } = require('../src/collections/runway-feed.service');

const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Local PostgreSQL required');
const schema = `runway_retention_${randomUUID().replace(/-/g, '')}`;
const clients = Array.from(
  { length: 3 },
  () => new Client({ connectionString: url.toString() }),
);
const [setup, reader, blocker] = clients;
const counts = [];

async function main() {
  await Promise.all(clients.map((client) => client.connect()));
  await setup.query(`CREATE SCHEMA "${schema}"`);
  for (const client of clients)
    await client.query(`SET search_path TO "${schema}"`);
  await setup.query(`
    CREATE TABLE "RunwayFeedSession" (id uuid PRIMARY KEY, "expiresAt" timestamptz NOT NULL);
    CREATE INDEX ON "RunwayFeedSession" ("expiresAt");
    CREATE TABLE "RunwayAffinityCache" ("userId" uuid PRIMARY KEY, "expiresAt" timestamptz NOT NULL);
    CREATE INDEX ON "RunwayAffinityCache" ("expiresAt");
    INSERT INTO "RunwayFeedSession"
      SELECT md5('session-' || n)::uuid, CURRENT_TIMESTAMP - interval '1 hour'
      FROM generate_series(1, 1001) n;
    INSERT INTO "RunwayAffinityCache"
      SELECT md5('affinity-' || n)::uuid, CURRENT_TIMESTAMP - interval '1 hour'
      FROM generate_series(1, 600) n;
    INSERT INTO "RunwayFeedSession"
      SELECT md5('live-session-' || n)::uuid, CURRENT_TIMESTAMP + interval '1 hour'
      FROM generate_series(1, 5) n;
    INSERT INTO "RunwayAffinityCache"
      SELECT md5('live-affinity-' || n)::uuid, CURRENT_TIMESTAMP + interval '1 hour'
      FROM generate_series(1, 5) n;
  `);
  await blocker.query('BEGIN');
  const locked = await blocker.query(`SELECT id FROM "RunwayFeedSession"
    WHERE "expiresAt" < CURRENT_TIMESTAMP ORDER BY id LIMIT 1 FOR UPDATE`);
  const service = new RunwayFeedService({
    $executeRaw: async (query) => {
      const result = await reader.query(query.text, query.values);
      counts.push(result.rowCount);
      assert(result.rowCount <= 500, 'each statement must remain bounded');
      return result.rowCount;
    },
  });
  // A blocked row cannot stall cleanup on another application instance.
  await reader.query("SET statement_timeout = '3s'");
  await service.expireSessions();
  await service.expireSessions();
  assert.deepEqual(counts, [500, 500, 500, 100]);
  assert.equal(
    (
      await reader.query('SELECT 1 FROM "RunwayFeedSession" WHERE id = $1', [
        locked.rows[0].id,
      ])
    ).rowCount,
    1,
  );
  await blocker.query('COMMIT');
  await service.expireSessions();
  assert.deepEqual(counts.slice(-2), [1, 0]);
  for (const table of ['RunwayFeedSession', 'RunwayAffinityCache']) {
    const result = await reader.query(`SELECT count(*)::int AS count,
      count(*) FILTER (WHERE "expiresAt" < CURRENT_TIMESTAMP)::int AS expired FROM "${table}"`);
    assert.deepEqual(result.rows[0], { count: 5, expired: 0 });
  }
  console.log(
    JSON.stringify({
      result: 'PASS',
      cases: [
        'bounded statements',
        'skip competing row lock',
        'eventual expiry',
        'live rows preserved',
      ],
      deletedPerStatement: counts,
      applicationRowsChanged: 0,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await blocker.query('ROLLBACK').catch(() => {});
    await setup
      .query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`)
      .catch((error) => {
        console.error('Isolated fixture cleanup failed:', error.message);
        process.exitCode = 1;
      });
    await Promise.all(clients.map((client) => client.end().catch(() => {})));
  });
