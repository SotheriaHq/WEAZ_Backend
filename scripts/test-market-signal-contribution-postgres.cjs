// Real PostgreSQL proof for Market signal contribution rules on the current
// schema: who may move global popularity, through the actual ingestion service.
// Raw events are always stored; only counted events reach the global aggregates.
const assert = require('node:assert/strict');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({
  transpileOnly: true,
  compilerOptions: { emitDecoratorMetadata: false },
});
require('tsconfig-paths/register');
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const { MarketSignalService } = require('../src/market/market-signal.service');
const {
  MarketSignalAggregationService,
} = require('../src/market/market-signal-aggregation.service');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_signals_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_signals_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source),
    target = new URL(source);
  adminUrl.pathname = '/postgres';
  target.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: target.toString() });
  let created = false,
    connected = false,
    prisma,
    checks = 0;
  const check = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    await db.query(
      "SET statement_timeout='60s'; CREATE EXTENSION IF NOT EXISTS pg_trgm",
    );
    const generated = spawnSync(
      process.execPath,
      [
        path.join(__dirname, '../node_modules/prisma/build/index.js'),
        'migrate',
        'diff',
        '--from-empty',
        '--to-schema',
        'prisma/schema.prisma',
        '--script',
      ],
      {
        cwd: path.join(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: target.toString() },
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    assert.equal(generated.status, 0, 'Current schema DDL generation failed');
    await db.query(generated.stdout);
    let statements = 0;
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: withUtcDatabaseUrl(target.toString()),
      }),
      log: [{ level: 'query', emit: 'event' }],
    });
    prisma.$on('query', () => statements++);
    const service = new MarketSignalService(
      prisma,
      new MarketSignalAggregationService(prisma),
    );

    const user = (username, extra = {}) =>
      prisma.user.create({
        data: {
          id: randomUUID(),
          username,
          email: username + '@fixture.invalid',
          status: 'ACTIVE',
          ...extra,
        },
      });
    const owner = await user('signal-owner');
    const staff = await user('signal-staff');
    const suspended = await user('signal-suspended-staff');
    const shopper = await user('signal-shopper');
    const operator = await user('signal-operator', { role: 'Admin' });
    const brand = await prisma.brand.create({
      data: {
        id: randomUUID(),
        ownerId: owner.id,
        name: 'Signal brand',
        isStoreOpen: true,
      },
    });
    await prisma.brandMember.createMany({
      data: [
        {
          brandId: brand.id,
          userId: staff.id,
          role: 'CATALOG_MANAGER',
          status: 'ACTIVE',
        },
        {
          brandId: brand.id,
          userId: suspended.id,
          role: 'CATALOG_MANAGER',
          status: 'SUSPENDED',
        },
      ],
    });
    const product = async () =>
      (
        await prisma.product.create({
          data: {
            id: randomUUID(),
            brandId: brand.id,
            name: 'Signal piece',
            price: 10000,
          },
        })
      ).id;
    const design = (
      await prisma.collection.create({
        data: {
          id: randomUUID(),
          ownerId: owner.id,
          title: 'Signal design',
          domain: 'DESIGN',
        },
      })
    ).id;

    const count = async (sql, targetId) =>
      Number((await db.query(sql, [targetId])).rows[0].n);
    const counted = (targetId) =>
      count(
        'SELECT COALESCE(sum("eventCount"),0)::int AS n FROM market_signal_aggregate_daily WHERE "targetId"=$1',
        targetId,
      );
    const stored = (targetId) =>
      count(
        'SELECT count(*)::int AS n FROM user_feed_signals WHERE "targetId"=$1',
        targetId,
      );
    const event = (targetId, signalType = 'IMPRESSION', extra = {}) => ({
      clientEventId: randomUUID(),
      targetType: 'PRODUCT',
      targetId,
      signalType,
      surface: 'MARKET_HOME',
      sectionKey: 'signal-proof',
      ...extra,
    });
    const send = (events, identity) =>
      service.ingestBatch({ batchId: randomUUID(), events }, identity);
    const guest = () => ({
      anonymousSessionId: 'proof_' + randomUUID().replaceAll('-', ''),
    });

    // A shopper's impression counts; the raw row is always stored.
    const plain = await product();
    await send([event(plain)], { userId: shopper.id });
    check(
      [await stored(plain), await counted(plain)],
      [1, 1],
      'Shopper impression is stored and counted',
    );

    // Owners, active staff, collection creators and operators never count.
    const own = await product();
    await send([event(own)], { userId: owner.id });
    await send([event(own)], { userId: staff.id });
    await send([event(own)], { userId: operator.id });
    check(
      [await stored(own), await counted(own)],
      [3, 0],
      'Owner, active staff and operator are stored, never counted',
    );
    await send([event(own)], { userId: suspended.id });
    check(await counted(own), 1, 'Suspended staff count as ordinary shoppers');
    await send([{ ...event(design), targetType: 'DESIGN' }], {
      userId: owner.id,
    });
    check(
      [await stored(design), await counted(design)],
      [1, 0],
      'A design creator cannot promote their own design',
    );

    // A guest counts once per item and class per day.
    const capped = await product();
    const device = guest();
    await send([event(capped)], device);
    await send([event(capped), event(capped)], device);
    check(
      [await stored(capped), await counted(capped)],
      [3, 1],
      'Guest impressions are capped at one per item per day',
    );

    // Opens count only after an impression served to the same viewer.
    const gated = await product();
    await send([event(gated, 'OPEN')], guest());
    check(
      await counted(gated),
      0,
      'An open with no served impression is not counted',
    );
    const opened = await product();
    await send([event(opened), event(opened, 'OPEN')], guest());
    check(await counted(opened), 2, 'An impression then an open both count');

    // Commerce actions are counted only from domain records.
    const claimed = await product();
    await send([event(claimed, 'ADD_TO_CART'), event(claimed, 'PURCHASE')], {
      userId: shopper.id,
    });
    check(
      [await stored(claimed), await counted(claimed)],
      [2, 0],
      'Client cart and purchase claims never count',
    );

    // Client-supplied server metadata is always stripped; enrichment is
    // written only when the flag is exactly "true".
    const metadataOf = async (targetId) =>
      (
        await db.query(
          'SELECT metadata FROM user_feed_signals WHERE "targetId"=$1 ORDER BY "createdAt" DESC LIMIT 1',
          [targetId],
        )
      ).rows[0].metadata ?? {};
    const forged = await product();
    const previous = process.env.MARKET_SIGNAL_ENRICHMENT_V1;
    try {
      delete process.env.MARKET_SIGNAL_ENRICHMENT_V1;
      await send(
        [
          event(forged, 'IMPRESSION', {
            metadata: { $server: { contribution: 'counted' }, card: 'x' },
          }),
        ],
        { userId: shopper.id },
      );
      const off = await metadataOf(forged);
      check(
        [off.$server, off.card],
        [undefined, 'x'],
        'Forged server metadata is stripped with the flag off',
      );
      process.env.MARKET_SIGNAL_ENRICHMENT_V1 = 'true';
      await send(
        [
          event(forged, 'IMPRESSION', {
            metadata: { $server: { contribution: 'forged' } },
          }),
        ],
        { userId: owner.id },
      );
      check(
        (await metadataOf(forged)).$server?.contribution,
        'owner',
        'With the flag on, the server records its own decision',
      );
    } finally {
      if (previous === undefined)
        delete process.env.MARKET_SIGNAL_ENRICHMENT_V1;
      else process.env.MARKET_SIGNAL_ENRICHMENT_V1 = previous;
    }

    // The contribution read is one bounded statement: a bigger batch costs no
    // more statements than a small one.
    const measure = async (size) => {
      const targets = [];
      for (let index = 0; index < size; index++) targets.push(await product());
      const before = statements;
      await send(
        targets.map((id) => event(id)),
        { userId: shopper.id },
      );
      return statements - before;
    };
    const one = await measure(1),
      twenty = await measure(20);
    check(
      twenty,
      one,
      `Statements per batch do not grow with batch size (1: ${one}, 20: ${twenty})`,
    );
    console.log(`QUERY_BUDGET signals batch=1:${one} batch=20:${twenty}`);
    console.log(
      `PASS ${checks} PostgreSQL signal contribution proofs on the current schema`,
    );
  } finally {
    try {
      if (prisma) await prisma.$disconnect();
    } finally {
      try {
        if (connected) await db.end();
      } finally {
        try {
          if (created) {
            assert(/^aru_market_signals_[a-f0-9]{32}$/.test(name));
            await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
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
}

main().catch((error) => {
  const redact = (text) =>
    String(text ?? '').replace(/postgres(?:ql)?:\/\/\S+/g, '[redacted]');
  console.error(error.name + ': ' + redact(error.message));
  console.error(
    redact(error.stack)
      .split('\n')
      .filter((line) => /^\s+at /.test(line))
      .slice(0, 10)
      .join('\n'),
  );
  process.exitCode = 1;
});
