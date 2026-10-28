// Read-only SIT/local seed and storage-cutover inventory. Never resets or seeds.
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

async function audit(client, migrationRoot) {
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  try {
    const counts = (await client.query(`SELECT
      (SELECT count(*)::int FROM "User") AS users,
      (SELECT count(*)::int FROM "User" u JOIN "UserProfile" p ON p."userId"=u."_id"
        WHERE u.role='SuperAdmin' AND u.status='ACTIVE' AND u."isEmailVerified" AND u.password IS NOT NULL) AS active_admins,
      (SELECT count(*)::int FROM "MeasurementPoint") AS measurements,
      (SELECT count(*)::int FROM "SizeChart") AS size_charts,
      (SELECT count(*)::int FROM "Tag") AS tags,
      (SELECT count(*)::int FROM "CollectionCategory") AS categories,
      (SELECT count(*)::int FROM system_config) AS settings,
      (SELECT count(*)::int FROM settlement_policy) AS settlement_policies,
      (SELECT count(*)::int FROM "SubscriptionTier") AS subscription_tiers,
      (SELECT count(*)::int FROM "FileUpload") AS files,
      (SELECT count(*)::int FROM "FileVariant") AS variants,
      (SELECT count(*)::int FROM "PresignedUpload") AS upload_intents,
      (SELECT count(*)::int FROM "StorageObjectDeletion") AS storage_cleanup,
      (SELECT count(*)::int FROM "Brand" WHERE nullif(logo,'') IS NOT NULL OR nullif(banner,'') IS NOT NULL) AS brand_media,
      (SELECT count(*)::int FROM "UserProfile" WHERE nullif("profileImage",'') IS NOT NULL OR nullif("bannerImage",'') IS NOT NULL) AS profile_media,
      (SELECT count(*)::int FROM "Product") AS products,
      (SELECT count(*)::int FROM "Collection") AS designs,
      (SELECT count(*)::int FROM "Order") AS orders,
      (SELECT count(*)::int FROM "CustomOrder") AS custom_orders`)).rows[0];
    const applied = (await client.query('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"')).rows;
    const finished = new Set(applied.filter(row => row.finished_at && !row.rolled_back_at).map(row => row.migration_name));
    const pendingMigrations = fs.readdirSync(migrationRoot, { withFileTypes: true }).filter(row => row.isDirectory() && !finished.has(row.name)).map(row => row.name).sort();
    const failedMigrations = applied.filter(row => !row.finished_at && !row.rolled_back_at).map(row => row.migration_name);
    const referenceSeedsReady = counts.active_admins > 0 && counts.measurements > 0 && counts.size_charts > 0 && counts.tags > 0 && counts.categories > 0 && counts.settings > 0 && counts.settlement_policies === 2 && counts.subscription_tiers === 4;
    const emptyMedia = ['files', 'variants', 'upload_intents', 'storage_cleanup', 'brand_media', 'profile_media', 'products', 'designs'].every(key => counts[key] === 0);
    return { checkedAt: new Date().toISOString(), readOnly: true, counts, referenceSeedsReady, emptyMedia, appliedMigrations: finished.size, pendingMigrations, failedMigrations };
  } finally { await client.query('ROLLBACK'); }
}

async function main() {
  const target = process.argv.find(value => value.startsWith('--target='))?.split('=')[1];
  if (!['sit', 'local'].includes(target)) throw new Error('TARGET_REQUIRED');
  const connection = new URL(process.env.DATABASE_URL || '');
  if (!['postgres:', 'postgresql:'].includes(connection.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(connection.hostname) || connection.pathname !== (target === 'sit' ? '/wiez_sit' : '/threadly')) throw new Error('UNAPPROVED_DATABASE');
  const client = new Client({ connectionString: connection.toString(), statement_timeout: 10_000, connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const result = await audit(client, path.resolve(process.cwd(), 'prisma/migrations'));
    console.log(JSON.stringify({ target, ...result }));
    if (!result.referenceSeedsReady || result.failedMigrations.length || (process.argv.includes('--require-empty-media') && !result.emptyMedia)) process.exitCode = 1;
  } finally { await client.end(); }
}
module.exports = { audit };
if (require.main === module) main().catch(error => { console.error(JSON.stringify({ failure: error.code || error.name, message: /^[A-Z_]+$/.test(error.message) ? error.message : 'Seed audit failed; no connection or account details logged' })); process.exitCode = 1; });
