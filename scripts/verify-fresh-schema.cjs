// Validates the complete migration history in its own disposable local database.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(source.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(source.hostname)) {
    throw new Error('A loopback PostgreSQL connection is required.');
  }
  const database = `wiez_fresh_schema_${Date.now()}`;
  const adminUrl = new URL(source); adminUrl.pathname = '/postgres';
  const testUrl = new URL(source); testUrl.pathname = `/${database}`;
  testUrl.searchParams.set('options', '-c timezone=UTC');
  const admin = new Client({ connectionString: adminUrl.toString() });
  const evidence = { checkedAt: new Date().toISOString(), passed: false, appliedMigrations: 0,
    failures: [], cleanupPassed: false };
  let created = false;
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE "${database}"`); created = true;
    const outcome = await new Promise((resolve, reject) => {
      let output = '';
      const child = spawn(process.execPath, ['node_modules/prisma/build/index.js', 'migrate', 'deploy'], {
        cwd: path.resolve(__dirname, '..'), windowsHide: true,
        env: { ...process.env, DATABASE_URL: testUrl.toString(), THREADLY_PRISMA_SKIP_SEED: 'true' },
      });
      child.stdout.on('data', (chunk) => { output += chunk; });
      child.stderr.on('data', (chunk) => { output += chunk; });
      child.once('error', reject);
      child.once('close', (code) => resolve({ code, output }));
    });
    const inspect = new Client({ connectionString: testUrl.toString() });
    await inspect.connect();
    try {
      const rows = (await inspect.query('SELECT migration_name,finished_at,rolled_back_at FROM "_prisma_migrations"')).rows;
      evidence.appliedMigrations = rows.filter((row) => row.finished_at && !row.rolled_back_at).length;
      evidence.failures = rows.filter((row) => !row.finished_at && !row.rolled_back_at).map((row) => row.migration_name);
      evidence.subscriptionTierValues = (await inspect.query(`SELECT enumlabel FROM pg_enum
        JOIN pg_type ON pg_type.oid = pg_enum.enumtypid WHERE typname = 'SubscriptionTierKey'
        ORDER BY enumsortorder`)).rows.map((row) => row.enumlabel);
      evidence.grandfatherFlagRemoved = (await inspect.query(`SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'Brand' AND column_name = 'customOrderLegacyEligible'`)).rowCount === 0;
    } finally { await inspect.end(); }
    evidence.passed = outcome.code === 0 && !evidence.failures.length && evidence.grandfatherFlagRemoved &&
      JSON.stringify(evidence.subscriptionTierValues) === JSON.stringify(['THREAD', 'ASO_OKE', 'ARU', 'IGWE']);
    evidence.errorCodes = [...new Set(outcome.output.match(/\bP\d{4}\b/g) || [])];
    if (evidence.passed && process.argv.includes('--seed')) {
      // Disposable credentials stay in the child environment and disappear with this database.
      const seedEnv = { ...process.env, DATABASE_URL: testUrl.toString(),
        TS_NODE_TRANSPILE_ONLY: 'true',
        SYSTEM_ADMIN_EMAIL: 'schema-regression-admin@example.invalid', SYSTEM_ADMIN_PASSWORD: randomBytes(32).toString('base64url') };
      const seedCodes = [];
      const reference = new Client({ connectionString: testUrl.toString() });
      await reference.connect();
      try {
      for (let attempt = 0; attempt < 2; attempt++) {
        seedCodes.push(await new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-r', 'ts-node/register', '-r', 'tsconfig-paths/register', 'prisma/seed.ts'], {
            cwd: path.resolve(__dirname, '..'), env: seedEnv, windowsHide: true, stdio: 'ignore',
          });
          child.once('error', reject); child.once('close', resolve);
        }));
        if (seedCodes[attempt] !== 0) break;
        if (attempt === 0) {
          evidence.openingSubscriptionCatalog = (await reference.query(`SELECT "key"::text AS key,
            "monthlyPriceNgn", "maxActive", "maxInDelivery", "maxUpNext", "queueJumpAllowed"
            FROM "SubscriptionTier" ORDER BY "key"`)).rows;
          // Reseeding must preserve a deliberate admin catalog edit. This
          // change exists only inside this process's disposable database.
          await reference.query(`UPDATE "SubscriptionTier" SET "monthlyPriceNgn"=12345 WHERE "key"='THREAD'`);
        }
      }
      } finally { await reference.end(); }
      evidence.seedExitCodes = seedCodes;
      const verify = new Client({ connectionString: testUrl.toString() });
      await verify.connect();
      try {
        const counts = (await verify.query(`SELECT
          (SELECT count(*)::int FROM "User") AS users,
          (SELECT count(*)::int FROM "User" WHERE role='SuperAdmin') AS admins,
          (SELECT count(*)::int FROM "FileUpload") AS uploads,
          (SELECT count(*)::int FROM "Collection") AS content,
          (SELECT count(*)::int FROM "MeasurementPoint") AS measurements,
          (SELECT count(*)::int FROM "SizeChart") AS charts,
          (SELECT count(*)::int FROM "Tag") AS tags,
          (SELECT count(*)::int FROM "CollectionCategory") AS categories,
          (SELECT count(*)::int FROM system_config) AS settings,
          (SELECT count(*)::int FROM settlement_policy) AS settlement_policies`)).rows[0];
        evidence.seedCounts = counts;
        const expectedCatalog = [
          { key:'THREAD', monthlyPriceNgn:10000, maxActive:2, maxInDelivery:2, maxUpNext:1, queueJumpAllowed:false },
          { key:'ASO_OKE', monthlyPriceNgn:15000, maxActive:3, maxInDelivery:4, maxUpNext:1, queueJumpAllowed:false },
          { key:'ARU', monthlyPriceNgn:30000, maxActive:4, maxInDelivery:5, maxUpNext:1, queueJumpAllowed:true },
          { key:'IGWE', monthlyPriceNgn:50000, maxActive:6, maxInDelivery:5, maxUpNext:1, queueJumpAllowed:true },
        ];
        const byKey = (rows) => [...rows].sort((left, right) => left.key.localeCompare(right.key));
        evidence.subscriptionCatalogMatchesApprovedPolicy = JSON.stringify(byKey(evidence.openingSubscriptionCatalog ?? [])) === JSON.stringify(byKey(expectedCatalog));
        evidence.reseedPreservesEditedTierPrice = (await verify.query(`SELECT "monthlyPriceNgn" FROM "SubscriptionTier" WHERE "key"='THREAD'`)).rows[0]?.monthlyPriceNgn === 12345;
        evidence.defaultCustomerMinimumOrders = (await verify.query(`SELECT column_default FROM information_schema.columns
          WHERE table_schema='public' AND table_name='Brand' AND column_name='customerMinimumOrders'`)).rows[0]?.column_default;
        evidence.seededSubscriptionAgreements = (await verify.query(`SELECT count(*)::int AS count FROM "BrandSubscription"`)).rows[0].count;
        evidence.passed = seedCodes.length === 2 && seedCodes.every((code) => code === 0) &&
          counts.users === 1 && counts.admins === 1 && counts.uploads === 0 && counts.content === 0 &&
          counts.measurements > 0 && counts.charts > 0 && counts.tags > 0 && counts.categories > 0 &&
          counts.settings > 0 && counts.settlement_policies === 2 &&
          evidence.subscriptionCatalogMatchesApprovedPolicy && evidence.reseedPreservesEditedTierPrice &&
          evidence.defaultCustomerMinimumOrders === '3' && evidence.seededSubscriptionAgreements === 0;
      } finally { await verify.end(); }
    }
  } finally {
    if (created) {
      await admin.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [database]);
      await admin.query(`DROP DATABASE "${database}"`);
      evidence.cleanupPassed = true;
    }
    await admin.end();
    const target = path.resolve(__dirname, process.argv.includes('--seed')
      ? '../docs/storage/evidence/fresh-schema.json' : '../docs/storage/evidence/fresh-migrations.json');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(JSON.stringify(evidence));
    if (!evidence.passed || !evidence.cleanupPassed) process.exitCode = 1;
  }
}
main().catch(() => { console.error('Fresh-schema verification failed; no connection details were logged.'); process.exitCode = 1; });
