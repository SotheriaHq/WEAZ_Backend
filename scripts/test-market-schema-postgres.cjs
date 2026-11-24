const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Client } = require('pg');
const { backfillMarketProducts } = require('./lib/market-product-backfill.cjs');
const { checkDiscoverySchema } = require('./lib/market-schema-assertions.cjs');
const {
  checkMarketIndexPlans,
} = require('./lib/market-index-plan-assertions.cjs');
require('dotenv').config({ quiet: true });

const work = path.resolve(__dirname, '..');
const migrationRoot = path.join(work, 'prisma/migrations');
const packageMigrations = [
  '20261115090000_product_first_published_at',
  '20261115090100_product_effective_price',
  '20261115090200_market_item_features',
  '20261115090300_user_market_affinity',
  '20261115090400_market_section_exposure',
  '20261115090500_market_section_spec',
  '20261115090600_featured_placement',
  '20261115090700_product_complement_synonym_chipset',
  '20261115090800_discovery_attribution_and_prefs',
  '20261115090900_market_indexes_concurrently',
  '20261115091000_signal_tables_autovacuum',
];

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname));
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    for (const populated of [false, true]) {
      const name = 'wiez_market_schema_' + randomUUID().replaceAll('-', '');
      assert(/^wiez_market_schema_[a-f0-9]{32}$/.test(name));
      const target = new URL(source);
      target.pathname = '/' + name;
      const scratch = fs.mkdtempSync(
        path.join(os.tmpdir(), 'wiez-market-schema-'),
      );
      const migrations = path.join(scratch, 'migrations');
      const config = path.join(scratch, 'prisma.config.ts');
      fs.mkdirSync(migrations);
      fs.copyFileSync(
        path.join(migrationRoot, 'migration_lock.toml'),
        path.join(migrations, 'migration_lock.toml'),
      );
      fs.writeFileSync(
        config,
        'export default ' +
          JSON.stringify({
            schema: path.join(work, 'prisma/schema.prisma'),
            migrations: { path: migrations },
          }).replace(/}$/, ',datasource:{url:process.env.DATABASE_URL}}') +
          ';',
      );
      let created = false,
        connected = false;
      const db = new Client({ connectionString: target.toString() });
      const migrate = (expectedIndexConflict = false) => {
        const result = spawnSync(
          process.execPath,
          [
            path.join(work, 'node_modules/prisma/build/index.js'),
            'migrate',
            'deploy',
            '--config',
            config,
          ],
          {
            cwd: work,
            env: { ...process.env, DATABASE_URL: target.toString() },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 180000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        if (expectedIndexConflict) {
          const output = (result.stdout || '') + '\n' + (result.stderr || '');
          assert(
            result.status !== 0 &&
              /42P07/.test(output) &&
              output.includes('Product_market_category_publication_idx'),
            'Expected the deliberate index-name conflict',
          );
          return;
        }
        if (result.status !== 0) {
          let diagnostic = (result.stdout || '') + '\n' + (result.stderr || '');
          for (const secret of [
            target.toString(),
            source.password,
            decodeURIComponent(source.password),
          ]) {
            if (secret)
              diagnostic = diagnostic.replaceAll(secret, '[redacted]');
          }
          console.error(diagnostic.split(/\r?\n/).slice(-24).join('\n'));
          throw new Error(
            'Disposable migration deploy failed: ' +
              (result.error?.code || result.status),
          );
        }
      };
      try {
        await admin.query('CREATE DATABASE "' + name + '"');
        created = true;
        const existing = fs
          .readdirSync(migrationRoot, { withFileTypes: true })
          .filter(
            (entry) =>
              entry.isDirectory() && !packageMigrations.includes(entry.name),
          )
          .map((entry) => entry.name)
          .sort();
        for (const migration of existing)
          fs.cpSync(
            path.join(migrationRoot, migration),
            path.join(migrations, migration),
            { recursive: true },
          );
        if (populated) migrate();
        await db.connect();
        connected = true;
        await db.query("SET statement_timeout='15s'; SET lock_timeout='2s'");
        const user = randomUUID(),
          brand = randomUUID();
        const products = [randomUUID(), randomUUID(), randomUUID()];
        if (populated) {
          await db.query(
            `INSERT INTO "User" ("_id",username,email,"updatedAt") VALUES ($1,$2,$3,statement_timestamp())`,
            [user, 'schema-' + user, user + '@example.test'],
          );
          await db.query(
            `INSERT INTO "Brand" ("_id",name,"ownerId","updatedAt") VALUES ($1,'Fixture brand',$2,statement_timestamp())`,
            [brand, user],
          );
          for (let i = 0; i < products.length; i += 1) {
            await db.query(
              `INSERT INTO "Product" ("_id","brandId",name,price,"salePrice","saleEndAt",
              "isActive","publicationStatus","publishAt","createdAt","updatedAt")
              VALUES ($1,$2,'Fixture piece',200,150,(statement_timestamp()+interval '1 day') AT TIME ZONE 'UTC',
                $3,$4,CASE WHEN $5 THEN (statement_timestamp()+interval '1 day') AT TIME ZONE 'UTC' ELSE NULL END,
                (statement_timestamp()-interval '7 days') AT TIME ZONE 'UTC',statement_timestamp())`,
              [
                products[i],
                brand,
                i !== 1,
                i === 1 ? 'DRAFT' : 'PUBLISHED',
                i === 2,
              ],
            );
          }
        }
        for (const migration of populated
          ? packageMigrations.slice(0, 9)
          : packageMigrations)
          fs.cpSync(
            path.join(migrationRoot, migration),
            path.join(migrations, migration),
            { recursive: true },
          );
        if (populated) {
          migrate();
          // Fail the real concurrent-index migration after two successful
          // statements, using only this disposable database's owned names.
          await db.query(
            'CREATE INDEX "Product_market_category_publication_idx" ON "Product" (price)',
          );
          for (const migration of packageMigrations.slice(9))
            fs.cpSync(
              path.join(migrationRoot, migration),
              path.join(migrations, migration),
              { recursive: true },
            );
          migrate(true);
          const failed = (
            await db.query(
              `SELECT count(*)::int AS n FROM _prisma_migrations
            WHERE migration_name=$1 AND finished_at IS NULL AND rolled_back_at IS NULL`,
              [packageMigrations[9]],
            )
          ).rows[0].n;
          assert.equal(failed, 1);
          for (const index of [
            'Product_market_first_publication_idx',
            'Product_market_effective_price_idx',
            'Product_market_category_publication_idx',
          ]) {
            await db.query('DROP INDEX CONCURRENTLY "' + index + '"');
          }
          const resolved = spawnSync(
            process.execPath,
            [
              path.join(work, 'node_modules/prisma/build/index.js'),
              'migrate',
              'resolve',
              '--rolled-back',
              packageMigrations[9],
              '--config',
              config,
            ],
            {
              cwd: work,
              env: { ...process.env, DATABASE_URL: target.toString() },
              encoding: 'utf8',
              windowsHide: true,
              timeout: 60000,
            },
          );
          assert.equal(
            resolved.status,
            0,
            'Failed migration must resolve as rolled back before retry',
          );
          console.log(
            'PASS real Prisma concurrent-index partial-prefix failure and reviewed-name rollback/retry rehearsal',
          );
        }
        migrate();
        migrate();
        const applied = (
          await db.query(
            `SELECT count(*)::int AS n FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL AND migration_name=ANY($1::text[])`,
            [packageMigrations],
          )
        ).rows[0].n;
        assert.equal(applied, 11);
        const indexes = (
          await db.query(`SELECT c.relname,i.indisvalid,i.indisready FROM pg_index i
          JOIN pg_class c ON c.oid=i.indexrelid WHERE c.relname LIKE 'Product_market_%'`)
        ).rows;
        assert.equal(indexes.length, 9);
        assert(indexes.every((index) => index.indisvalid && index.indisready));
        const reloptions = (
          await db.query(
            `SELECT relname,reloptions FROM pg_class WHERE relname=ANY($1::text[])`,
            [
              [
                'user_feed_signals',
                'user_seen_items',
                'market_section_signals',
                'suggestion_signals',
                'market_item_features',
              ],
            ],
          )
        ).rows;
        assert.equal(reloptions.length, 5);
        assert(
          reloptions.every((row) =>
            row.reloptions.includes('autovacuum_vacuum_scale_factor=0.05'),
          ),
        );
        const runTool = (file, args = []) => {
          const result = spawnSync(
            process.execPath,
            [path.join(work, 'scripts', file), ...args],
            {
              cwd: work,
              env: { ...process.env, DATABASE_URL: target.toString() },
              encoding: 'utf8',
              windowsHide: true,
              timeout: 90000,
            },
          );
          assert.equal(
            result.status,
            0,
            file + ': ' + (result.stderr || result.error?.code || 'failed'),
          );
          return result.stdout;
        };
        const dry = await backfillMarketProducts(db, { batchSize: 2 });
        assert.equal(dry.written, 0);
        if (populated) {
          assert.equal(dry.scanned, 3);
          const first = await backfillMarketProducts(db, {
            apply: true,
            batchSize: 2,
            maxBatches: 1,
          });
          assert.equal(first.exhausted, false);
          const rest = await backfillMarketProducts(db, {
            apply: true,
            batchSize: 2,
            after: first.after,
          });
          assert.equal(first.written + rest.written, 3);
          assert.equal(rest.exhausted, true);
          assert.equal(
            (await backfillMarketProducts(db, { apply: true })).written,
            0,
          );
          const values = (
            await db.query(
              `SELECT "_id" AS id,"firstPublishedAt","firstPublicationSource",
            "effectivePrice" FROM "Product" WHERE "_id"=ANY($1::uuid[])`,
              [products],
            )
          ).rows;
          const byId = new Map(values.map((row) => [row.id, row]));
          assert.equal(
            byId.get(products[0]).firstPublicationSource,
            'INFERRED',
          );
          assert.equal(byId.get(products[1]).firstPublishedAt, null);
          assert.equal(
            byId.get(products[2]).firstPublicationSource,
            'SCHEDULED',
          );
          assert(values.every((row) => row.effectivePrice === '150.00'));
          await checkDiscoverySchema(db, target.toString(), { user, products });
          await checkMarketIndexPlans(db, brand);
        } else assert.equal(dry.scanned, 0);
        runTool('validate-market-schema.cjs', ['--confirm-database=' + name]);
        const preflight = JSON.parse(runTool('market-schema-preflight.cjs'));
        assert.equal(preflight.mutations, false);
        assert.equal(preflight.invalidPrices, '0');
        assert.equal(preflight.additiveColumnsPresent.length, 3);
        const diff = spawnSync(
          process.execPath,
          [
            path.join(work, 'node_modules/prisma/build/index.js'),
            'migrate',
            'diff',
            '--config',
            config,
            '--from-config-datasource',
            '--to-schema',
            path.join(work, 'prisma/schema.prisma'),
            '--script',
          ],
          {
            cwd: work,
            env: { ...process.env, DATABASE_URL: target.toString() },
            encoding: 'utf8',
            windowsHide: true,
            timeout: 90000,
            maxBuffer: 4 * 1024 * 1024,
          },
        );
        assert.equal(diff.status, 0, 'Schema comparison failed');
        fs.mkdirSync(path.join(work, '.tmp'), { recursive: true });
        fs.writeFileSync(
          path.join(work, '.tmp/market-schema-drift.sql'),
          diff.stdout,
        );
        // Historical hand-written generated columns/defaults are deliberately
        // outside Prisma's model. Never execute this comparison as a migration.
        // This package's managed tables and fields must nevertheless match.
        for (const owned of [
          'firstPublishedAt',
          'firstPublicationSource',
          'lastRelistedAt',
          'effectivePrice',
          'effectivePriceComputedAt',
          'effectivePriceValidUntil',
          'priceChangeXid',
          'market_item_features',
          'market_item_features_regional',
          'market_feature_state',
          'market_feature_epochs',
          'market_item_feature_snapshots',
          'user_market_affinity',
          'market_section_exposure',
          'MarketSectionConfigVersion',
          'draftDefinition',
          'draftRevision',
          'publishedVersionId',
          'specVersion',
          'placementKey',
          'ProductComplement',
          'SearchSynonym',
          'MarketChipSet',
          'aliases',
          'sourceSection',
          'sourcePosition',
          'marketPersonalization',
          'marketRegionalOptIn',
        ])
          assert(
            !diff.stdout.includes('"' + owned + '"'),
            'New schema drift: ' + owned,
          );
        console.log(
          'PASS full migration history + eleven groups + replay + nine valid concurrent indexes + bounded backfill: ' +
            (populated ? 'populated upgrade' : 'empty database'),
        );
      } finally {
        if (connected) await db.end();
        if (created)
          await admin.query('DROP DATABASE "' + name + '" WITH (FORCE)');
        // Only this invocation's registered temporary directory is eligible.
        const resolved = fs.realpathSync(scratch);
        assert(path.dirname(resolved) === fs.realpathSync(os.tmpdir()));
        assert(
          /^wiez-market-schema-[a-zA-Z0-9]+$/.test(path.basename(resolved)),
        );
        fs.rmSync(resolved, { recursive: true });
        console.log(
          'Disposable migration database and temporary configuration removed',
        );
      }
    }
  } finally {
    await admin.end();
  }
}
main().catch((error) => {
  console.error(
    error.code === 'ERR_ASSERTION'
      ? error.message
      : error.code || error.message,
  );
  process.exitCode = 1;
});
