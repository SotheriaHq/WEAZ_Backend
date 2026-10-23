const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { Client } = require('pg');
const assert = require('node:assert/strict');
require('dotenv').config({ quiet: true });

async function main() {
  const url = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Loopback PostgreSQL is required');
  const client = new Client({ connectionString: url.toString() });
  const sql = await fs.readFile(path.resolve(__dirname, '../prisma/migrations/20261023090000_retire_grandfathered_subscription_tier/migration.sql'), 'utf8');
  const evidence = { checkedAt: new Date().toISOString(), passed: false, cases: [], cleanupPassed: true };
  await client.connect();
  try {
    for (const scenario of ['paid-tiers', 'assigned-grandfather', 'active-grandfather', 'scheduled-grandfather', 'paid-disputed-null', 'paid-delivery-issue-null']) {
      const schema = `wiez_tier_check_${randomBytes(8).toString('hex')}`;
      await client.query(`CREATE SCHEMA "${schema}"`);
      try {
        await client.query(`SET search_path TO "${schema}"`);
        await client.query(`CREATE TYPE "SubscriptionTierKey" AS ENUM ('THREAD','ASO_OKE','ARU','IGWE','LEGACY');
          CREATE TYPE "PaymentStatus" AS ENUM ('PENDING','PAID','FAILED','REFUNDED');
          CREATE TYPE "CustomOrderStatus" AS ENUM ('DRAFT','PENDING_PAYMENT','ACCEPTED','DISPUTED','DELIVERY_ISSUE_REPORTED');
          CREATE TABLE "CustomOrder" ("lane" text, "paymentStatus" "PaymentStatus", "status" "CustomOrderStatus");
          CREATE TABLE "SubscriptionTier" ("key" "SubscriptionTierKey" PRIMARY KEY);
          CREATE TABLE "Brand" (id text PRIMARY KEY, "assignedSubscriptionTierKey" "SubscriptionTierKey", "customOrderLegacyEligible" boolean NOT NULL DEFAULT false);
          CREATE TABLE "BrandSubscription" (id text PRIMARY KEY, "tierKey" "SubscriptionTierKey" NOT NULL, "scheduledTierKey" "SubscriptionTierKey",
            CONSTRAINT "BrandSubscription_tierKey_fkey" FOREIGN KEY ("tierKey") REFERENCES "SubscriptionTier"("key") ON DELETE RESTRICT ON UPDATE CASCADE);
          INSERT INTO "SubscriptionTier" VALUES ('THREAD'),('ASO_OKE'),('ARU'),('IGWE'),('LEGACY');
          INSERT INTO "Brand" (id) VALUES ('brand');
          INSERT INTO "BrandSubscription" (id,"tierKey","scheduledTierKey") VALUES ('agreement','ASO_OKE','IGWE');
          INSERT INTO "CustomOrder" VALUES (NULL,'PENDING','PENDING_PAYMENT');`);
        if (scenario === 'assigned-grandfather') await client.query(`UPDATE "Brand" SET "assignedSubscriptionTierKey"='LEGACY'`);
        if (scenario === 'active-grandfather') await client.query(`UPDATE "BrandSubscription" SET "tierKey"='LEGACY'`);
        if (scenario === 'scheduled-grandfather') await client.query(`UPDATE "BrandSubscription" SET "scheduledTierKey"='LEGACY'`);
        if (scenario === 'paid-disputed-null') await client.query(`INSERT INTO "CustomOrder" VALUES (NULL,'PAID','DISPUTED')`);
        if (scenario === 'paid-delivery-issue-null') await client.query(`INSERT INTO "CustomOrder" VALUES (NULL,'PAID','DELIVERY_ISSUE_REPORTED')`);
        let rejected = false;
        try { await client.query(sql); } catch (error) {
          rejected = true; await client.query('ROLLBACK');
          assert.match(String(error.message), /Cannot retire/);
        }
        if (scenario === 'paid-tiers') {
          assert.equal(rejected, false);
          assert.deepEqual((await client.query('SELECT "key"::text AS key FROM "SubscriptionTier" ORDER BY "SubscriptionTier"."key"')).rows.map((row) => row.key), ['THREAD','ASO_OKE','ARU','IGWE']);
          assert.deepEqual((await client.query('SELECT "tierKey"::text AS tier, "scheduledTierKey"::text AS scheduled FROM "BrandSubscription"')).rows, [{ tier: 'ASO_OKE', scheduled: 'IGWE' }]);
          assert.equal((await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND column_name='customOrderLegacyEligible'`, [schema])).rowCount, 0);
          assert.equal((await client.query(`SELECT 1 FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1 AND c.conname='BrandSubscription_tierKey_fkey'`, [schema])).rowCount, 1);
        } else {
          assert.equal(rejected, true);
          assert.equal((await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema=$1 AND column_name='customOrderLegacyEligible'`, [schema])).rowCount, 1);
          assert.equal((await client.query(`SELECT count(*)::int AS count FROM "SubscriptionTier"`)).rows[0].count, 5);
        }
        evidence.cases.push({ scenario, passed: true });
      } finally {
        await client.query('ROLLBACK');
        await client.query('SET search_path TO public');
        // Only the random schema created by this process is ever removed.
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      }
    }
    evidence.passed = evidence.cases.length === 6;
  } finally {
    await client.end();
    await fs.writeFile(path.resolve(__dirname, '../docs/storage/evidence/subscription-tier-contraction.json'), JSON.stringify(evidence, null, 2) + '\n');
    console.log(JSON.stringify(evidence));
  }
}
main().catch(() => { console.error('Subscription contraction verification failed; no connection details logged'); process.exitCode = 1; });
