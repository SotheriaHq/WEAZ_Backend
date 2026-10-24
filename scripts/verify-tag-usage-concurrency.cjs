const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
const ts = require('typescript');
require('dotenv').config({ quiet: true });
const filename = path.resolve(__dirname, '../src/tags/tag-usage-query.ts');
const loaded = new Module(filename, module);
loaded.filename = filename; loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename);
const { lockTagRows, refreshTagUsageCounts } = loaded.exports;
const adapter = (client) => ({
  $queryRaw: async (query) => (await client.query(query.text, query.values)).rows,
  $executeRaw: async (query) => (await client.query(query.text, query.values)).rowCount,
});

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Loopback database required');
  const first = new Client({ connectionString: source.toString() });
  const second = new Client({ connectionString: source.toString() });
  const schema = `wiez_tag_test_${randomUUID().replaceAll('-', '')}`;
  const tag = randomUUID();
  let created = false;
  await first.connect(); await second.connect();
  try {
    await first.query(`CREATE SCHEMA "${schema}"`); created = true;
    for (const client of [first, second]) {
      await client.query(`SET search_path TO "${schema}"`);
      await client.query("SET TIME ZONE 'UTC'");
    }
    await first.query(`CREATE TABLE "Tag" ("_id" uuid PRIMARY KEY,"normalizedName" text,"isBanned" boolean,
      status text,"usageCount" int,"lastUsedAt" timestamp,"updatedAt" timestamp);
      CREATE TABLE "TagBinding" ("_id" uuid PRIMARY KEY,"tagId" uuid);`);
    await first.query(`INSERT INTO "Tag" VALUES ($1,'casual',false,'APPROVED',7,now(),now())`, [tag]);
    await first.query('BEGIN');
    await lockTagRows(adapter(first), [tag]);
    await refreshTagUsageCounts(adapter(first), [tag], new Date());
    await first.query('COMMIT');
    let row = (await first.query('SELECT * FROM "Tag"')).rows[0];
    assert.equal(row.usageCount, 0); assert.equal(row.lastUsedAt, null);
    await first.query('BEGIN');
    await lockTagRows(adapter(first), [tag]);
    await first.query('INSERT INTO "TagBinding" VALUES ($1,$2)', [randomUUID(), tag]);
    await second.query('BEGIN');
    await second.query("SET LOCAL statement_timeout='5s'");
    const pid = (await second.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const blockedLock = lockTagRows(adapter(second), [tag]);
    let observed = false;
    for (let attempt = 0; attempt < 200; attempt++) {
      if ((await first.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1', [pid])).rows[0]?.wait_event_type === 'Lock') { observed = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert(observed, 'Second binding writer must wait for the tag');
    await refreshTagUsageCounts(adapter(first), [tag], new Date());
    await first.query('COMMIT');
    await blockedLock;
    await second.query('INSERT INTO "TagBinding" VALUES ($1,$2)', [randomUUID(), tag]);
    await refreshTagUsageCounts(adapter(second), [tag], new Date());
    await second.query('COMMIT');
    row = (await first.query('SELECT * FROM "Tag"')).rows[0];
    assert.equal(row.usageCount, 2); assert(row.lastUsedAt instanceof Date);
    console.log('PASS: empty usage resets to zero/null; competing binding writers retain both counts after ordered tag locks.');
  } finally {
    await first.query('ROLLBACK').catch(() => {}); await second.query('ROLLBACK').catch(() => {});
    await second.end();
    if (created) {
      assert(/^wiez_tag_test_[a-f0-9]{32}$/.test(schema));
      await first.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
    await first.end();
  }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
