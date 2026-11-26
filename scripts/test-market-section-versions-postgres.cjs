// Every write targets a newly created, loopback-only disposable database.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const migrationRoot = path.resolve(__dirname, '../prisma/migrations');
const readMigration = (name) =>
  fs.readFileSync(path.join(migrationRoot, name, 'migration.sql'), 'utf8');
const presentationFields = [
  'sectionKey',
  'title',
  'subtitle',
  'enabled',
  'status',
  'sourceType',
  'rankingProfileKey',
  'displayOrder',
  'previewItemLimit',
  'detailPageLimit',
  'minimumItems',
  'viewAllEnabled',
  'viewAllLabel',
  'fallbackMode',
  'fallbackSectionKey',
  'guestEnabled',
  'requiresAuth',
  'newBrandReservedRatio',
  'metadata',
  'startsAt',
  'endsAt',
];

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(['localhost', '127.0.0.1', '[::1]'].includes(source.hostname));
  const name = 'wiez_section_versions_' + randomUUID().replaceAll('-', '');
  assert(/^wiez_section_versions_[a-f0-9]{32}$/.test(name));
  const adminUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  const testUrl = new URL(source);
  testUrl.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: testUrl.toString() });
  let created = false,
    connected = false;
  const results = [];
  await admin.connect();
  try {
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    await db.query("SET statement_timeout='5s'; SET lock_timeout='2s'");
    // Extract the existing table and its exact foundation columns, rather than
    // making an invented approximation of the published configuration model.
    const original = readMigration(
      '20260526042133_add_market_governance_config',
    );
    const foundation = readMigration(
      '20260612160000_add_feed_categories_market_section_foundation',
    );
    await db.query('CREATE TABLE "User" ("_id" uuid PRIMARY KEY)');
    await db.query(
      original.match(/CREATE TABLE "MarketSectionConfig" \([\s\S]*?\n\);/)[0],
    );
    for (const type of [
      'MarketSectionConfigStatus',
      'MarketSectionConfigSourceType',
    ]) {
      await db.query(
        foundation.match(new RegExp('CREATE TYPE "' + type + '"[^;]+;'))[0],
      );
    }
    await db.query(
      foundation.match(/ALTER TABLE "MarketSectionConfig"[\s\S]*?;/)[0],
    );
    await db.query(readMigration('20261115090500_market_section_spec'));
    const id = randomUUID(),
      author = randomUUID();
    await db.query('INSERT INTO "User" VALUES ($1)', [author]);
    await db.query(
      `INSERT INTO "MarketSectionConfig" ("_id","sectionKey",title,"updatedAt")
      VALUES ($1,'fresh-drops','Fresh Drops',statement_timestamp())`,
      [id],
    );
    await db.query(
      'UPDATE "MarketSectionConfig" SET title=\'Existing facade\' WHERE "_id"=$1',
      [id],
    );
    const get = async () =>
      (
        await db.query(
          `SELECT *,wiez_market_section_presentation(s) AS presentation
      FROM "MarketSectionConfig" s WHERE "_id"=$1`,
          [id],
        )
      ).rows[0];
    const initial = await get();
    assert.equal(initial.specVersion, 0);
    assert.equal(initial.title, 'Existing facade');
    results.push(
      'existing V1 configuration remains editable until explicitly versioned',
    );

    const rejects = async (operation, code = '23514') => {
      await assert.rejects(operation, (error) => error.code === code);
    };
    const save = async (definition, expected) =>
      db.query(
        `UPDATE "MarketSectionConfig"
      SET "draftDefinition"=$2,"draftRevision"="draftRevision"+1
      WHERE "_id"=$1 AND "draftRevision"=$3`,
        [id, definition, expected],
      );
    const insertVersion = async (versionId, version, revision, definition) =>
      db.query(
        `
      INSERT INTO "MarketSectionConfigVersion"
      (id,"configId",version,"draftRevision",spec,presentation,"publishedById",reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'Reviewed section definition')`,
        [
          versionId,
          id,
          version,
          revision,
          definition.spec,
          definition.presentation,
          author,
        ],
      );
    const project = async (versionId, version, definition) =>
      db.query(
        `
      UPDATE "MarketSectionConfig" s SET "publishedVersionId"=$2,"specVersion"=$3,spec=$4,
      ${presentationFields.map((field) => '"' + field + '"=p."' + field + '"').join(',')}
      FROM jsonb_populate_record(NULL::"MarketSectionConfig",$5::jsonb) p
      WHERE s."_id"=$1`,
        [id, versionId, version, definition.spec, definition.presentation],
      );
    const publish = async (definition, version, revision) => {
      const versionId = randomUUID();
      await db.query('BEGIN');
      try {
        await insertVersion(versionId, version, revision, definition);
        await project(versionId, version, definition);
        await db.query('COMMIT');
      } catch (error) {
        await db.query('ROLLBACK');
        throw error;
      }
      return versionId;
    };
    const first = {
      spec: { source: 'NEW_RELEASES' },
      presentation: {
        ...initial.presentation,
        title: 'Published A',
        displayOrder: 110,
        guestEnabled: false,
        requiresAuth: true,
        startsAt: '2026-11-16T12:00:00.000Z',
        endsAt: '2026-11-17T12:00:00.000Z',
      },
    };
    assert.equal((await save(first, 0)).rowCount, 1);
    assert.equal((await save(first, 0)).rowCount, 0);
    assert.deepEqual((await get()).presentation, initial.presentation);
    await rejects(() =>
      db.query(
        'UPDATE "MarketSectionConfig" SET "draftDefinition"=\'{}\' WHERE "_id"=$1',
        [id],
      ),
    );
    await rejects(() => insertVersion(randomUUID(), 1, 1, first));
    assert.equal((await get()).publishedVersionId, null);
    results.push(
      'draft edits are isolated, stale revision loses and orphan publication rolls back',
    );

    const firstId = await publish(first, 1, 1);
    assert.deepEqual((await get()).presentation, first.presentation);
    await rejects(() =>
      db.query(
        'UPDATE "MarketSectionConfig" SET title=\'Bypass\' WHERE "_id"=$1',
        [id],
      ),
    );
    await rejects(() =>
      db.query(
        'UPDATE "MarketSectionConfig" SET "publishedVersionId"=NULL,"specVersion"=0,spec=NULL WHERE "_id"=$1',
        [id],
      ),
    );
    await rejects(() =>
      db.query(
        'UPDATE "MarketSectionConfigVersion" SET spec=\'{}\' WHERE id=$1',
        [firstId],
      ),
    );
    await rejects(() =>
      db.query('DELETE FROM "MarketSectionConfigVersion" WHERE id=$1', [
        firstId,
      ]),
    );
    results.push(
      'published projection and history reject legacy-writer bypass and rollback-in-place',
    );

    const second = {
      spec: { source: 'TRENDING' },
      presentation: {
        ...first.presentation,
        title: 'Published B',
        displayOrder: 20,
        guestEnabled: true,
        requiresAuth: false,
        metadata: { editorial: 'B' },
        startsAt: null,
        endsAt: null,
      },
    };
    await save(second, 1);
    assert.deepEqual((await get()).presentation, first.presentation);
    await rejects(() => publish(first, 2, 1));
    await publish(second, 2, 2);
    assert.deepEqual((await get()).presentation, second.presentation);
    await save(first, 2);
    await publish(first, 3, 3);
    assert.deepEqual((await get()).presentation, first.presentation);
    assert.deepEqual((await get()).spec, first.spec);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM "MarketSectionConfigVersion"',
        )
      ).rows[0].n,
      3,
    );
    results.push(
      'restore appends a version and restores labels, order, audience, schedule and ranking together',
    );

    const other = randomUUID();
    await db.query(
      `INSERT INTO "MarketSectionConfig" ("_id","sectionKey",title,"updatedAt")
      VALUES ($1,'another','Another',statement_timestamp())`,
      [other],
    );
    await rejects(() =>
      db.query(
        `UPDATE "MarketSectionConfig" SET "publishedVersionId"=$2,
      "specVersion"=1,spec=$3 WHERE "_id"=$1`,
        [other, firstId, first.spec],
      ),
    );
    await db.query('DELETE FROM "User" WHERE "_id"=$1', [author]);
    assert.equal(
      (
        await db.query(
          'SELECT count(*)::int AS n FROM "MarketSectionConfigVersion" WHERE "publishedById" IS NULL',
        )
      ).rows[0].n,
      3,
    );
    assert.deepEqual((await get()).presentation, first.presentation);
    results.push(
      'cross-section pointers are denied; author erasure preserves immutable definitions',
    );
    for (const result of results) console.log('PASS ' + result);
  } finally {
    if (connected) await db.end();
    if (created) await admin.query('DROP DATABASE "' + name + '"');
    await admin.end();
    console.log('Disposable section-version database removed');
  }
}

main().catch((error) => {
  console.error(error.code || error.message);
  process.exitCode = 1;
});
