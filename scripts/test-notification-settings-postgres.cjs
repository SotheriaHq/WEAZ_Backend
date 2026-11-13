// Executes the real service SQL in a newly created loopback-only database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
require('tsconfig-paths/register');
const { NotificationsService } = require('../src/notifications/notifications.service');
const { CustomOrdersService } = require('../src/custom-orders/custom-orders.service');
async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname), 'Requires a local database connection');
  const database = 'wiez_notification_test_' + randomUUID().replaceAll('-', '');
  assert(/^wiez_notification_test_[a-f0-9]{32}$/.test(database));
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = '/' + database;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const clients = []; let created = false;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + database + '"'); created = true;
    for (let index = 0; index < 3; index++) { const client = new Client({ connectionString: testUrl.toString() }); await client.connect(); clients.push(client); }
    const [a, b, read] = clients;
    await read.query('CREATE TABLE "User" ("_id" uuid PRIMARY KEY, "notificationSettings" jsonb, "updatedAt" timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    const id = randomUUID(), other = randomUUID();
    await read.query('INSERT INTO "User" ("_id") VALUES ($1), ($2)', [id, other]);
    const service = db => { const instance = Object.create(NotificationsService.prototype); instance.prisma = {
      $queryRaw: async sql => (await db.query(sql.text, sql.values)).rows,
      $executeRaw: async sql => (await db.query(sql.text, sql.values)).rowCount,
      user: {
        findUnique: async ({ where }) => (await db.query('SELECT "notificationSettings" FROM "User" WHERE "_id"=$1', [where.id])).rows[0],
        update: async ({ where, data }) => { await db.query('UPDATE "User" SET "notificationSettings"=$1::jsonb, "updatedAt"=CURRENT_TIMESTAMP WHERE "_id"=$2', [JSON.stringify(data.notificationSettings), where.id]); },
      },
      $transaction: async work => { await db.query('BEGIN'); try { const result = await work(instance.prisma); await db.query('COMMIT'); return result; } catch (error) { await db.query('ROLLBACK'); throw error; } },
    }; return instance; };
    const sa = service(a), sb = service(b);
    const chartB = Object.create(CustomOrdersService.prototype);
    chartB.prisma = sb.prisma;
    const row = async () => (await read.query('SELECT "notificationSettings" FROM "User" WHERE "_id"=$1', [id])).rows[0].notificationSettings;
    // Force the second writer to wait on the first row lock. It must merge
    // against the newly committed row, including sibling keys in the same section.
    for (const [first, second] of [
      [{ social: { threads: false } }, { orders: { placed: false } }],
      [{ push: { sound: false } }, { push: { vibration: false } }],
    ]) {
      const current = await row() ?? {};
      const next = { ...current }; for (const [section, values] of Object.entries(first)) next[section] = { ...current[section], ...values };
      await a.query('BEGIN');
      await a.query('UPDATE "User" SET "notificationSettings"=$1::jsonb WHERE "_id"=$2', [JSON.stringify(next), id]);
      let done = false; const competing = sb.updateSettings(id, second).then(result => { done = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(done, false, 'second update should wait for the row lock');
      await a.query('COMMIT'); await competing;
      const value = await row();
      for (const patch of [first, second]) for (const [section, fields] of Object.entries(patch)) for (const [key, expected] of Object.entries(fields)) assert.equal(value[section][key], expected);
    }
    console.log('PASS simultaneous writes preserve different sections and sibling fields');
    const answer = await sa.updateSettings(id, { push: { quietHoursStart: ' 22:30 ', quietHoursEnd: null, enabled: false, invalid: true }, injected: { anything: true } });
    assert.equal(answer.push.quietHoursStart, '22:30'); assert.equal(answer.push.quietHoursEnd, null); assert.equal(answer.push.enabled, false);
    const saved = await row(); assert.equal(saved.injected, undefined); assert.equal(saved.push.invalid, undefined);
    assert.equal(saved.push.sound, false); assert.equal(saved.push.vibration, false);
    console.log('PASS defaults, explicit null, sanitation and unaffected prior preferences');
    await read.query('UPDATE "User" SET "notificationSettings"=$1::jsonb WHERE "_id"=$2', [JSON.stringify({ security: { login: false } }), id]);
    const legacy = await sa.updateSettings(id, { security: { login: true } });
    assert.deepEqual(legacy.security, { login: true, logout: false });
    console.log('PASS changing a legacy sign-in preference preserves effective sign-out choice');
    // Actual notification and fitting writers sharing the same row must keep
    // each other's changes, including when the chart writer waits for a lock.
    await a.query('BEGIN');
    await a.query('UPDATE "User" SET "notificationSettings"=$1::jsonb WHERE "_id"=$2', [JSON.stringify({ social: { threads: false } }), id]);
    let chartDone = false;
    const chartWaiting = chartB.updateDisplayChartPreference(id, { displayChartFamily: 'NIGERIA', updatedAtMs: 12345 }).then(() => { chartDone = true; });
    await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(chartDone, false);
    await a.query('COMMIT'); await chartWaiting;
    assert.equal((await row()).social.threads, false); assert.equal((await row()).customOrders.displayChartFamily, 'NIGERIA');
    for (let index = 0; index < 10; index++) {
      await Promise.all([
        sa.updateSettings(id, { push: { sound: index % 2 === 0 } }),
        chartB.updateDisplayChartPreference(id, { displayChartFamily: index % 2 === 0 ? 'UK' : 'US', updatedAtMs: index }),
      ]);
      const value = await row(); assert.equal(value.push.sound, index % 2 === 0); assert.equal(value.customOrders.displayChartFamily, index % 2 === 0 ? 'UK' : 'US');
    }
    console.log('PASS fitting-chart and notification writers preserve each other under contention');
    const untouched = await read.query('SELECT "notificationSettings" FROM "User" WHERE "_id"=$1', [other]); assert.equal(untouched.rows[0].notificationSettings, null);
    await assert.rejects(sa.updateSettings(randomUUID(), { push: { enabled: false } }), /Account not found/);
    for (const malformed of [null, [], 'bad', { push: null }]) {
      await read.query('UPDATE "User" SET "notificationSettings"=$1::jsonb WHERE "_id"=$2', [JSON.stringify(malformed), id]);
      const result = await sa.updateSettings(id, { push: { enabled: false } }); assert.equal(result.push.enabled, false); assert.equal(result.social.threads, true);
    }
    console.log('PASS account isolation, missing account and null/malformed JSON storage');
  } finally {
    for (const client of clients) { try { await client.query('ROLLBACK'); } catch {} await client.end(); }
    if (created) await admin.query('DROP DATABASE "' + database + '"');
    await admin.end();
    console.log('Disposable notification database removed; application databases unchanged.');
  }
}
main().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
