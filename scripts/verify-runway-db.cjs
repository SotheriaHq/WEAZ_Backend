require('dotenv').config({ quiet: true });
process.env.TS_NODE_TRANSPILE_ONLY = 'true';
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const { Client } = require('pg');
const { randomUUID } = require('crypto');
const assert = require('assert/strict');
const { RunwayFeedService } = require('../src/collections/runway-feed.service');
const {
  RUNWAY_CASUAL_TERMS,
} = require('../src/collections/runway-ranking.util');
const url = new URL(process.env.DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
  throw new Error('Local PostgreSQL required');
const client = new Client({ connectionString: url.toString() });
async function main() {
  await client.connect();
  await client.query('BEGIN');
  await client.query(`CREATE TEMP TABLE "User" ("_id" uuid PRIMARY KEY,status text);
    CREATE TEMP TABLE "Brand" ("ownerId" uuid,country text);
    CREATE TEMP TABLE "Collection" ("_id" uuid PRIMARY KEY,"ownerId" uuid,domain text,status text,visibility text,"deletedAt" timestamp,tags text[],"categoryId" uuid,"createdAt" timestamp,"likesCount" int);
    CREATE TEMP TABLE "FileUpload" ("_id" uuid PRIMARY KEY,"processingStatus" text,"originalDeletedAt" timestamp,"s3Url" text);
    CREATE TEMP TABLE "CollectionMedia" ("collectionId" uuid,"fileUploadId" uuid);
    CREATE TEMP TABLE "CollectionCategory" ("_id" uuid,slug text);
    CREATE TEMP TABLE "EntityFilter" ("entityId" uuid,"entityType" text,"filterValueId" uuid);
    CREATE TEMP TABLE "FilterValue" ("_id" uuid,slug text,"isActive" bool,"dimensionId" uuid);
    CREATE TEMP TABLE "FilterDimension" ("_id" uuid,"isActive" bool);`);
  const ng = randomUUID(),
    fr = randomUUID(),
    suspended = randomUUID(),
    file = randomUUID(),
    dimension = randomUUID(),
    casual = randomUUID();
  await client.query(
    `INSERT INTO "User" VALUES ($1,'ACTIVE'),($2,'ACTIVE'),($3,'SUSPENDED');`,
    [ng, fr, suspended],
  );
  await client.query(
    `INSERT INTO "Brand" VALUES ($1,'Nigeria'),($2,'France');`,
    [ng, fr],
  );
  await client.query(
    `INSERT INTO "FileUpload" VALUES ($1,'READY',NULL,'https://example.invalid/ready.jpg')`,
    [file],
  );
  await client.query(`INSERT INTO "FilterDimension" VALUES ($1,true)`, [
    dimension,
  ]);
  await client.query(
    `INSERT INTO "FilterValue" VALUES ($1,'casual-streetwear',true,$2)`,
    [casual, dimension],
  );
  const expectedAfrican = [],
    expectedCasual = [];
  for (const [owner, tags, taxonomy, african, isCasual, visibility] of [
    [ng, ['casual-style'], false, true, true, 'PUBLIC'],
    [fr, ['casual', 'ankara'], false, true, true, 'PUBLIC'],
    [ng, [], true, true, true, 'PUBLIC'],
    [fr, ['streetwear'], false, false, true, 'PUBLIC'],
    [fr, ['ankara', 'formal'], false, false, false, 'PUBLIC'],
    [ng, ['casual'], false, false, false, 'PRIVATE'],
    [suspended, ['casual', 'african'], false, false, false, 'PUBLIC'],
  ]) {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "Collection" VALUES ($1,$2,'DESIGN','PUBLISHED',$3,NULL,$4,NULL,NOW(),0)`,
      [id, owner, visibility, tags],
    );
    await client.query(`INSERT INTO "CollectionMedia" VALUES ($1,$2)`, [
      id,
      file,
    ]);
    if (taxonomy)
      await client.query(`INSERT INTO "EntityFilter" VALUES ($1,'DESIGN',$2)`, [
        id,
        casual,
      ]);
    if (african) expectedAfrican.push(id);
    if (isCasual) expectedCasual.push(id);
  }
  const service = new RunwayFeedService({
    $queryRaw: (query) =>
      client.query(query.text, query.values).then((result) => result.rows),
  });
  const african = await service.candidateIds({}, 120, false, {
    tags: RUNWAY_CASUAL_TERMS,
    lane: 'african-casual',
  });
  assert.deepEqual(african.map((row) => row.id).sort(), expectedAfrican.sort());
  const global = await service.candidateIds({}, 120, false, {
    tags: RUNWAY_CASUAL_TERMS,
    lane: 'casual-style',
  });
  assert.deepEqual(global.map((row) => row.id).sort(), expectedCasual.sort());
  assert.equal(
    (await service.candidateIds({ tags: { has: "' OR TRUE --" } }, 120)).length,
    0,
  );
  assert.equal((await service.candidateIds({}, 1)).length, 1);
  console.log(
    'Runway SQL passed: explicit casual tags, taxonomy-only casual, African provenance/heritage, global casual, private/suspended exclusions, literal parameters and candidate limit.',
  );
}
main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await client.query('ROLLBACK').catch(() => {});
    await client.end();
  });
