// Real PostgreSQL proof for cart/order discovery attribution: the server-side
// resolver never produces a value the actual migration's checks reject, and the
// checks do reject the raw hostile values the resolver drops.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const {
  DISCOVERY_MAX_POSITION,
  resolveDiscoveryAttribution,
} = require('../src/common/discovery-attribution');

const MIGRATION = path.join(
  __dirname,
  '../prisma/migrations/20261115090800_discovery_attribution_and_prefs/migration.sql',
);

const hostile = [
  {},
  null,
  'hot-right-now',
  { sourceSection: 'hot-right-now', sourcePosition: 3 },
  { sourceSection: 'new-releases' },
  { sourcePosition: 4 },
  { sourceSection: 'Hot Right Now', sourcePosition: 1 },
  { sourceSection: '-leading-dash', sourcePosition: 1 },
  { sourceSection: 'a'.repeat(80), sourcePosition: 0 },
  { sourceSection: 'a'.repeat(81), sourcePosition: 0 },
  { sourceSection: 'ok\n', sourcePosition: 1 },
  { sourceSection: 'x\'; DROP TABLE "CartItem";--', sourcePosition: 1 },
  { sourceSection: 'ok', sourcePosition: -1 },
  { sourceSection: 'ok', sourcePosition: DISCOVERY_MAX_POSITION },
  { sourceSection: 'ok', sourcePosition: DISCOVERY_MAX_POSITION + 1 },
  { sourceSection: 'ok', sourcePosition: 1.5 },
  { sourceSection: 'ok', sourcePosition: '7' },
  { sourceSection: 'ok', sourcePosition: Number.NaN },
  { sourceSection: 'ok', sourcePosition: 2 ** 40 },
  { sourceSection: ['ok'], sourcePosition: 1 },
  { sourceSection: 'séction', sourcePosition: 1 },
];

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_discovery_attr_' + randomUUID().replaceAll('-', '');
  assert(/^aru_discovery_attr_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: target.toString() });
  let created = false,
    connected = false,
    checks = 0;
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    // Only the tables the migration alters; the migration file runs unchanged.
    await db.query(`SET statement_timeout='30s';
      CREATE TABLE "UserProfile" ("_id" uuid PRIMARY KEY);
      CREATE TABLE "OrderItem" ("_id" uuid PRIMARY KEY);
      CREATE TABLE "CartItem" ("_id" uuid PRIMARY KEY);`);
    await db.query(fs.readFileSync(MIGRATION, 'utf8'));
    const constraints = await db.query(
      `SELECT conname FROM pg_constraint WHERE contype='c' AND conname IN
        ('cart_discovery_attribution_shape_check','order_discovery_attribution_shape_check')`,
    );
    assert.equal(constraints.rowCount, 2, 'Both attribution checks exist');
    checks++;

    for (const input of hostile) {
      const { sourceSection, sourcePosition } =
        resolveDiscoveryAttribution(input);
      await db.query(
        'INSERT INTO "CartItem" ("_id","sourceSection","sourcePosition") VALUES ($1,$2,$3)',
        [randomUUID(), sourceSection, sourcePosition],
      );
      await db.query(
        'INSERT INTO "OrderItem" ("_id","sourceSection") VALUES ($1,$2)',
        [randomUUID(), sourceSection],
      );
      checks += 2;
    }
    const kept = hostile.map(resolveDiscoveryAttribution);
    assert.deepEqual(kept[3], {
      sourceSection: 'hot-right-now',
      sourcePosition: 3,
    });
    assert.deepEqual(kept[5], { sourceSection: null, sourcePosition: null });
    assert.deepEqual(kept[8], {
      sourceSection: 'a'.repeat(80),
      sourcePosition: 0,
    });
    assert.deepEqual(kept[13], {
      sourceSection: 'ok',
      sourcePosition: DISCOVERY_MAX_POSITION,
    });
    checks += 4;

    // The database refuses what the resolver drops, so the guard is real.
    const rejected = [
      ['CartItem', 'Hot Right Now', null],
      ['CartItem', null, 4],
      ['CartItem', 'ok', -1],
      ['CartItem', 'ok\n', null],
      ['CartItem', '-leading-dash', null],
      ['OrderItem', 'séction'],
      ['OrderItem', "x'; DROP"],
    ];
    for (const [table, section, position] of rejected) {
      const cart = table === 'CartItem';
      await assert.rejects(
        db.query(
          cart
            ? 'INSERT INTO "CartItem" ("_id","sourceSection","sourcePosition") VALUES ($1,$2,$3)'
            : 'INSERT INTO "OrderItem" ("_id","sourceSection") VALUES ($1,$2)',
          cart ? [randomUUID(), section, position] : [randomUUID(), section],
        ),
        (error) => error.code === '23514',
        `${table} refuses ${JSON.stringify(section)}/${position}`,
      );
      checks++;
    }
    console.log(
      `PASS ${checks} PostgreSQL discovery attribution checks against the actual migration`,
    );
  } finally {
    try {
      if (connected) await db.end();
    } finally {
      try {
        if (created) {
          assert(/^aru_discovery_attr_[a-f0-9]{32}$/.test(name));
          await admin.query('DROP DATABASE "' + name + '"');
          const left = await admin.query(
            'SELECT 1 FROM pg_database WHERE datname=$1',
            [name],
          );
          assert.equal(left.rowCount, 0, 'Disposable database removed');
        }
      } finally {
        await admin.end();
      }
    }
  }
}

main().catch((error) => {
  console.error(
    error.name +
      ': ' +
      String(error.message).replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]'),
  );
  process.exitCode = 1;
});
