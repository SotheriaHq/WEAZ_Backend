// Only newly created loopback databases receive fixture writes.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { Client } = require('pg');
const { Prisma, PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');
require('dotenv').config({ quiet: true });
require('ts-node').register({ transpileOnly: true });
const { withUtcDatabaseUrl } = require('../src/prisma/database-connection');
const {
  RENDERABLE_COVER_FIXTURE_SQL,
} = require('./lib/market-fixture-renderable-covers.cjs');
const {
  trimSql,
  normalizeTokenSql,
} = require('../src/common/utils/sql-text-normalization');
const {
  marketFacetProductSql,
} = require('../src/market/catalog/market-facet-filters');
const { parseMarketFilters } = require('../src/market/catalog/market-filters');
const {
  marketProductFilterSql,
} = require('../src/market/catalog/market-filter.sql');

async function main() {
  const source = new URL(process.env.DATABASE_URL || '');
  assert(
    ['localhost', '127.0.0.1', '[::1]'].includes(source.hostname),
    'Loopback PostgreSQL required',
  );
  const name = 'aru_market_filters_' + randomUUID().replaceAll('-', '');
  const encodingName =
    'aru_market_encoding_' + randomUUID().replaceAll('-', '');
  assert(/^aru_market_filters_[a-f0-9]{32}$/.test(name));
  assert(/^aru_market_encoding_[a-f0-9]{32}$/.test(encodingName));
  const adminUrl = new URL(source),
    testUrl = new URL(source);
  adminUrl.pathname = '/postgres';
  testUrl.pathname = '/' + name;
  const admin = new Client({ connectionString: adminUrl.toString() });
  const db = new Client({ connectionString: testUrl.toString() });
  let created = false,
    connected = false,
    checks = 0,
    prisma,
    encodingCreated = false;
  const now = new Date('2026-11-20T12:00:00.000Z');
  await admin.connect();
  try {
    await admin.query("SET statement_timeout='30s'; SET lock_timeout='1s'");
    await admin.query('CREATE DATABASE "' + name + '"');
    created = true;
    await db.connect();
    connected = true;
    await db.query(
      "SET statement_timeout = '30s'; SET lock_timeout = '1s'; SET timezone = 'UTC'",
    );
    await db.query(`
      CREATE TABLE "User" ("_id" uuid PRIMARY KEY, status text NOT NULL);
      CREATE TABLE "Brand" ("_id" uuid PRIMARY KEY, "ownerId" uuid REFERENCES "User", "isStoreOpen" boolean);
      CREATE TABLE "CollectionCategory" ("_id" uuid PRIMARY KEY, "isActive" boolean);
      CREATE TABLE "CollectionCategoryType" ("_id" uuid PRIMARY KEY, "categoryId" uuid REFERENCES "CollectionCategory", "isActive" boolean);
      CREATE TABLE "Product" (
        "_id" uuid PRIMARY KEY, "brandId" uuid REFERENCES "Brand", "isActive" boolean DEFAULT true,
        "publicationStatus" text DEFAULT 'PUBLISHED', "deletedAt" timestamp, "archivedAt" timestamp, "publishAt" timestamp,
        price numeric(10,2) DEFAULT 100, "salePrice" numeric(10,2), "saleStartAt" timestamp(3), "saleEndAt" timestamp(3),
        thumbnail text, images text[] DEFAULT ARRAY['https://media.example/item.webp'],
        "totalStock" integer DEFAULT 5, "customOrderEnabled" boolean DEFAULT false,
        "standardCheckoutEnabled" boolean DEFAULT true, currency text DEFAULT 'NGN', gender text DEFAULT 'MALE',
        "categoryId" uuid REFERENCES "CollectionCategory", "categoryTypeId" uuid REFERENCES "CollectionCategoryType",
        colors text[] DEFAULT ARRAY['Red'], sizes text[] DEFAULT ARRAY['M'], "sizeStock" jsonb DEFAULT '{"M":5}'
      );
      CREATE TABLE "StoreCollection" ("_id" uuid PRIMARY KEY, status text, "isAvailableInStore" boolean, "deletedAt" timestamp);
      CREATE TABLE "StoreCollectionProduct" ("collectionId" uuid REFERENCES "StoreCollection", "productId" uuid REFERENCES "Product");
      CREATE TABLE "ProductVariant" ("_id" uuid PRIMARY KEY, "productId" uuid REFERENCES "Product", size text, color text, stock integer);
      CREATE INDEX "ProductVariant_productId_stock_idx" ON "ProductVariant" ("productId",stock);
      CREATE TABLE "FilterDimension" ("_id" uuid PRIMARY KEY, slug text UNIQUE, "isActive" boolean DEFAULT true, "appliesTo" text[] DEFAULT ARRAY['PRODUCT']);
      CREATE TABLE "FilterValue" ("_id" uuid PRIMARY KEY, "dimensionId" uuid REFERENCES "FilterDimension", slug text, "isActive" boolean DEFAULT true);
      CREATE TABLE "EntityFilter" ("entityType" text, "entityId" uuid, "filterValueId" uuid REFERENCES "FilterValue");
      CREATE INDEX ON "EntityFilter" ("entityType","entityId");
      CREATE TABLE "Tag" ("_id" uuid PRIMARY KEY, "normalizedName" text UNIQUE, status text DEFAULT 'APPROVED', "isBanned" boolean DEFAULT false, "aliasOfTagId" uuid REFERENCES "Tag");
      CREATE TABLE "TagBinding" ("tagId" uuid REFERENCES "Tag", "entityType" text, "entityId" uuid);
      CREATE INDEX ON "TagBinding" ("entityType","entityId");
    `);
    await db.query(RENDERABLE_COVER_FIXTURE_SQL);
    const readUrl = new URL(withUtcDatabaseUrl(testUrl.toString()));
    readUrl.searchParams.set(
      'options',
      `${readUrl.searchParams.get('options')} -c statement_timeout=1500 -c lock_timeout=250`,
    );
    prisma = new PrismaClient({
      adapter: new PrismaPg({
        connectionString: readUrl.toString(),
      }),
    });
    const owner = randomUUID(),
      brand = randomUUID(),
      otherBrand = randomUUID();
    const category = randomUUID(),
      otherCategory = randomUUID(),
      type = randomUUID(),
      otherType = randomUUID();
    await db.query('INSERT INTO "User" VALUES ($1,\'ACTIVE\')', [owner]);
    await db.query('INSERT INTO "Brand" VALUES ($1,$3,true),($2,$3,true)', [
      brand,
      otherBrand,
      owner,
    ]);
    await db.query(
      'INSERT INTO "CollectionCategory" VALUES ($1,true),($2,true)',
      [category, otherCategory],
    );
    await db.query(
      'INSERT INTO "CollectionCategoryType" VALUES ($1,$3,true),($2,$4,true)',
      [type, otherType, category, otherCategory],
    );
    const product = async (overrides = {}) => {
      const id = randomUUID();
      await db.query(
        'INSERT INTO "Product" ("_id","brandId","categoryId","categoryTypeId") VALUES ($1,$2,$3,$4)',
        [id, brand, category, type],
      );
      for (const [key, value] of Object.entries(overrides)) {
        // Only internal fixture column literals are permitted, never request keys.
        assert(
          [
            'gender',
            'currency',
            'publicationStatus',
            'isActive',
            'totalStock',
            'customOrderEnabled',
            'standardCheckoutEnabled',
            'sizeStock',
            'colors',
            'sizes',
            'categoryId',
            'categoryTypeId',
            'salePrice',
            'saleStartAt',
            'saleEndAt',
            'price',
            'publishAt',
            'thumbnail',
            'images',
          ].includes(key),
        );
        const timestamp = value instanceof Date;
        await db.query(
          'UPDATE "Product" SET "' +
            key +
            '"=' +
            (timestamp ? "($2::timestamptz AT TIME ZONE 'UTC')" : '$2') +
            ' WHERE "_id"=$1',
          [id, timestamp ? value.toISOString() : value],
        );
      }
      return id;
    };
    const match = async (id, query, expected, label = query) => {
      const predicate = marketProductFilterSql(
        parseMarketFilters(new URLSearchParams(query)),
        now,
      );
      const result = await prisma.$queryRaw(Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM "Product" p WHERE ${predicate} AND p."_id"=${id}::uuid
      ) AS ok`);
      assert.equal(result[0].ok, expected, label);
      checks++;
    };
    const basic = await product();
    const whitespaceCodes = [
      9,
      10,
      11,
      12,
      13,
      32,
      160,
      5760,
      ...Array.from({ length: 11 }, (_, n) => 8192 + n),
      8232,
      8233,
      8239,
      8287,
      12288,
      65279,
    ];
    const textCases = [
      null,
      '',
      'A\u00a0B',
      '\u180eＲｅｄ\u180e',
      '\u0085Ｒｅｄ\u0085',
      ...whitespaceCodes.map((code) => {
        const character = String.fromCodePoint(code);
        return character + 'Ｒｅｄ' + character;
      }),
    ];
    for (const value of textCases) {
      const text = Prisma.sql`${value}::text`;
      const [actual] = await prisma.$queryRaw(
        Prisma.sql`SELECT ${trimSql(text)} AS trimmed,${normalizeTokenSql(text)} AS normalized`,
      );
      assert.equal(
        actual.trimmed,
        value === null ? null : value.trim(),
        'SQL/JavaScript whitespace parity',
      );
      assert.equal(
        actual.normalized,
        value === null ? null : value.normalize('NFKC').trim(),
        'SQL/JavaScript normalize-then-trim parity',
      );
      checks++;
    }
    await match(basic, '', true);
    await match(
      await product({ thumbnail: ' \n\ufeff', images: ['\u00a0', '\u2003'] }),
      '',
      false,
      'Whitespace-only image metadata must not create cards or facet counts',
    );
    await match(
      await product({
        thumbnail: ' ',
        images: [' ', 'https://media.example/usable.webp'],
      }),
      '',
      true,
    );
    await match(basic, 'audience=MEN', true);
    await match(basic, 'audience=WOMEN', false);
    await match(basic, 'audience=UNISEX', false);
    await match(basic, 'audience=WOMEN,MEN', true);
    const unisex = await product({ gender: 'EVERYBODY' });
    for (const audience of ['MEN', 'WOMEN', 'UNISEX'])
      await match(unisex, 'audience=' + audience, true);
    await match(basic, 'brand=' + brand, true);
    await match(basic, 'brand=' + otherBrand, false);
    await match(basic, 'brand=' + otherBrand + ',' + brand, true);
    await match(basic, 'category=' + category + '&type=' + type, true);
    await match(
      basic,
      'category=' + otherCategory + '&type=' + type,
      false,
      'Contradictory category/type never broadens',
    );
    await match(basic, 'type=' + otherType, false);
    await db.query(
      'UPDATE "CollectionCategory" SET "isActive"=false WHERE "_id"=$1',
      [category],
    );
    await match(
      basic,
      '',
      true,
      'Product approval does not require taxonomy approval',
    );
    await match(basic, 'category=' + category, false);
    await match(basic, 'type=' + type, false);
    await db.query(
      'UPDATE "CollectionCategory" SET "isActive"=true WHERE "_id"=$1',
      [category],
    );
    await db.query(
      'UPDATE "CollectionCategoryType" SET "isActive"=false WHERE "_id"=$1',
      [type],
    );
    await match(basic, 'type=' + type, false);
    await db.query(
      'UPDATE "CollectionCategoryType" SET "isActive"=true WHERE "_id"=$1',
      [type],
    );
    const inconsistentType = await product({ categoryTypeId: otherType });
    await match(
      inconsistentType,
      'type=' + otherType,
      false,
      'Type must match the product category',
    );
    for (const overrides of [
      { publicationStatus: 'DRAFT' },
      { isActive: false },
      { totalStock: 0 },
      { currency: 'USD' },
      { price: 'NaN' },
      { publishAt: new Date(now.getTime() + 1) },
    ])
      await match(
        await product(overrides),
        '',
        false,
        'Canonical eligibility and NGN gate ' + JSON.stringify(overrides),
      );
    await match(basic, 'size=M', true);
    await match(basic, 'size=L', false);
    const variant = await product({ sizeStock: { M: 100, L: 100 } });
    await db.query(
      "INSERT INTO \"ProductVariant\" VALUES ($1,$3,'M','Red',0),($2,$3,'L','Red',2)",
      [randomUUID(), randomUUID(), variant],
    );
    await match(variant, 'size=M', false, 'Variants override stale sizeStock');
    await match(variant, 'size=L', true);
    await match(variant, 'size=M,L', true);
    const combination = await product({ colors: ['Red', 'Blue'] });
    await db.query(
      "INSERT INTO \"ProductVariant\" VALUES ($1,$4,'L','Red',2),($2,$4,'M','Blue',3),($3,$4,'M','Red',0)",
      [randomUUID(), randomUUID(), randomUUID(), combination],
    );
    await match(
      combination,
      'color=red&size=M',
      false,
      'The selected colour and size must belong to one stocked variant',
    );
    await match(combination, 'color=red&size=L', true);
    await match(combination, 'color=blue&size=M', true);
    await match(combination, 'color=red,blue&size=M', true);
    await match(combination, 'color=red&size=M,L', true);
    await db.query(
      'UPDATE "Product" SET "customOrderEnabled"=true WHERE "_id"=$1',
      [combination],
    );
    await match(
      combination,
      'color=red&size=M',
      true,
      'Custom-fit choices may use the product colour without stocked RTW sizing',
    );
    await match(
      combination,
      'color=red&size=M&fulfilment=READY_TO_WEAR',
      false,
    );
    await match(combination, 'color=red&size=M&inStockOnly=1', false);
    for (const [query, expected] of [
      ['size=M', false],
      ['size=L', true],
    ]) {
      const predicate = marketFacetProductSql(
        parseMarketFilters(new URLSearchParams(query)),
        'brand',
        now,
        { colors: ['red'], fulfilment: 'READY_TO_WEAR' },
      );
      const result = await prisma.$queryRaw(Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM "Product" p WHERE ${predicate} AND p."_id"=${combination}::uuid
      ) AS ok`);
      assert.equal(
        result[0].ok,
        expected,
        'Fixed section colour and user size must share one stocked SKU',
      );
      checks++;
    }
    await db.query(
      'UPDATE "ProductVariant" SET stock=0 WHERE "productId"=$1 AND color=\'Blue\'',
      [combination],
    );
    await match(
      combination,
      'color=blue&fulfilment=READY_TO_WEAR',
      false,
      'Colour-only RTW searches also require stock for that colour',
    );
    const unspecifiedColour = await product();
    await db.query('INSERT INTO "ProductVariant" VALUES ($1,$2,\'M\',NULL,2)', [
      randomUUID(),
      unspecifiedColour,
    ]);
    await match(
      unspecifiedColour,
      'color=red&size=M&fulfilment=READY_TO_WEAR',
      false,
      'Null variant colour cannot prove a selected checkout colour',
    );
    await match(unspecifiedColour, 'size=M', true);
    for (const invalid of [
      [],
      'bad',
      { M: '5' },
      { M: null },
      { M: true },
      { M: -1 },
      { M: 0 },
      { M: 0.5 },
      { M: 1.5 },
      { M: 1e100 },
    ])
      await match(
        await product({ sizeStock: JSON.stringify(invalid) }),
        'size=M',
        false,
        'Malformed/zero size stock ' + JSON.stringify(invalid),
      );
    await match(
      await product({ sizeStock: { '42,5': 2 } }),
      'size[]=42%2C5',
      true,
    );
    const custom = await product({
      totalStock: 0,
      customOrderEnabled: true,
      sizeStock: null,
    });
    await match(custom, 'size=ANY-FIT&fulfilment=MADE_TO_ORDER', true);
    await match(custom, 'fulfilment=READY_TO_WEAR', false);
    await match(custom, 'inStockOnly=1', false);
    const dual = await product({
      customOrderEnabled: true,
      sizeStock: { M: 2 },
    });
    await match(dual, 'size=L', true);
    await match(dual, 'size=L&fulfilment=READY_TO_WEAR', false);
    await match(dual, 'size=L&inStockOnly=1', false);
    await match(dual, 'size=M&fulfilment=READY_TO_WEAR', true);
    await match(
      await product({
        standardCheckoutEnabled: false,
        customOrderEnabled: true,
      }),
      'fulfilment=READY_TO_WEAR',
      false,
    );
    await match(basic, 'color=red', true);
    await match(basic, 'color=blue', false);
    await match(basic, 'color=blue,RED&size=M', true);
    for (const [facet, fixed, expected] of [
      ['color', {}, true],
      ['size', {}, false],
      ['color', { colors: ['blue'] }, false],
      ['color', { brandIds: [otherBrand] }, false],
    ]) {
      const predicate = marketFacetProductSql(
        parseMarketFilters(new URLSearchParams('color=blue&size=M')),
        facet,
        now,
        fixed,
      );
      const result = await prisma.$queryRaw(Prisma.sql`SELECT EXISTS (
        SELECT 1 FROM "Product" p WHERE ${predicate} AND p."_id"=${basic}::uuid
      ) AS ok`);
      assert.equal(
        result[0].ok,
        expected,
        'Disjunctive facet preserves fixed server scope',
      );
      checks++;
    }
    await match(
      await product({ colors: [' ＲＥＤ ', '子供'] }),
      'color=red',
      true,
    );
    await match(await product({ sizeStock: { Ｍ: 2 } }), 'size=M', true);
    await match(
      basic,
      'color=' + encodeURIComponent('red\'); DROP TABLE "Product";--'),
      false,
    );
    await match(
      await product({ colors: ['\u00a0ＲＥＤ\u00a0'] }),
      'color=red',
      true,
    );
    await match(
      await product({ sizeStock: { '\ufeffＭ\u00a0': 2 } }),
      'size=M',
      true,
    );
    const unicodeVariant = await product();
    await db.query('INSERT INTO "ProductVariant" VALUES ($1,$2,$3,$4,2)', [
      randomUUID(),
      unicodeVariant,
      '\u00a0Ｍ\u00a0',
      '\ufeffＲｅｄ\u00a0',
    ]);
    await match(
      unicodeVariant,
      'color=red&size=M&fulfilment=READY_TO_WEAR',
      true,
    );
    const style = randomUUID(),
      fabric = randomUUID(),
      minimal = randomUUID(),
      casual = randomUUID(),
      cotton = randomUUID();
    await db.query(
      'INSERT INTO "FilterDimension" ("_id",slug) VALUES ($1,\'style\'),($2,\'fabric\')',
      [style, fabric],
    );
    await db.query(
      'INSERT INTO "FilterValue" ("_id","dimensionId",slug) VALUES ($1,$4,\'minimal\'),($2,$4,\'casual\'),($3,$5,\'cotton\')',
      [minimal, casual, cotton, style, fabric],
    );
    await db.query(
      "INSERT INTO \"EntityFilter\" VALUES ('PRODUCT',$1,$2),('PRODUCT',$1,$3)",
      [basic, minimal, cotton],
    );
    await match(basic, 'dim.style=minimal,casual&dim.fabric=cotton', true);
    await match(basic, 'dim.style=casual&dim.fabric=cotton', false);
    await match(basic, 'dim.style=minimal&dim.fabric=linen', false);
    await db.query('UPDATE "FilterValue" SET "isActive"=false WHERE "_id"=$1', [
      minimal,
    ]);
    await match(basic, 'dim.style=minimal', false);
    await db.query('UPDATE "FilterValue" SET "isActive"=true WHERE "_id"=$1', [
      minimal,
    ]);
    await db.query(
      'UPDATE "FilterDimension" SET "appliesTo"=ARRAY[\'COLLECTION\'] WHERE "_id"=$1',
      [style],
    );
    await match(basic, 'dim.style=minimal', false);
    const canonical = randomUUID(),
      alias = randomUUID(),
      pending = randomUUID(),
      rejected = randomUUID(),
      cycle = randomUUID();
    await db.query(
      "INSERT INTO \"Tag\" (\"_id\",\"normalizedName\") VALUES ($1,'adire'),($2,'fabric-alias'),($3,'pending-tag'),($4,'rejected-tag'),($5,'cyclic-tag')",
      [canonical, alias, pending, rejected, cycle],
    );
    await db.query('UPDATE "Tag" SET "aliasOfTagId"=$1 WHERE "_id"=$2', [
      canonical,
      alias,
    ]);
    await db.query('UPDATE "Tag" SET "aliasOfTagId"=$1 WHERE "_id"=$1', [
      cycle,
    ]);
    await db.query('UPDATE "Tag" SET status=\'PENDING\' WHERE "_id"=$1', [
      pending,
    ]);
    await db.query('UPDATE "Tag" SET status=\'REJECTED\' WHERE "_id"=$1', [
      rejected,
    ]);
    await db.query(
      "INSERT INTO \"TagBinding\" VALUES ($2,'PRODUCT',$1),($3,'PRODUCT',$1),($4,'PRODUCT',$1),($5,'PRODUCT',$1)",
      [basic, canonical, pending, rejected, cycle],
    );
    await match(basic, 'tag=adire', true);
    await match(basic, 'tag=fabric-alias', true);
    await match(basic, 'tag=unknown,adire', true);
    for (const tag of ['pending-tag', 'rejected-tag', 'cyclic-tag', 'unknown'])
      await match(basic, 'tag=' + tag, false);
    await db.query('UPDATE "Tag" SET "isBanned"=true WHERE "_id"=$1', [
      canonical,
    ]);
    await match(basic, 'tag=adire', false);
    await match(basic, 'tag=fabric-alias', false);
    const sale = await product({
      salePrice: 80,
      saleStartAt: now,
      saleEndAt: now,
    });
    await match(sale, 'price.min=80&price.max=80&onSale=1', true);
    await match(sale, 'price.min=80.01', false);
    await match(basic, 'price.min=100&price.max=100', true);
    await match(basic, 'onSale=1', false);
    await match(await product({ salePrice: 100 }), 'onSale=1', false);
    await match(await product({ salePrice: 0 }), 'onSale=1', false);
    await match(
      await product({
        salePrice: 80,
        saleStartAt: new Date(now.getTime() + 1),
      }),
      'onSale=1',
      false,
    );
    await match(
      await product({ salePrice: 80, saleEndAt: new Date(now.getTime() - 1) }),
      'onSale=1',
      false,
    );
    assert.throws(
      () => marketProductFilterSql({}, now, 'p;DROP TABLE "Product"'),
      RangeError,
    );
    assert.throws(() => marketProductFilterSql({}, new Date(NaN)), RangeError);
    const aliasPredicate = marketProductFilterSql(
      parseMarketFilters(new URLSearchParams('size=M&color=RED')),
      now,
      'mp',
    );
    const aliasResult = await prisma.$queryRaw(
      Prisma.sql`SELECT count(*)::int AS n FROM "Product" mp WHERE ${aliasPredicate}`,
    );
    assert(aliasResult[0].n > 0);
    assert(
      (await db.query('SELECT count(*)::int AS n FROM "Product"')).rows[0].n >
        0,
    );
    await admin.query(
      'CREATE DATABASE "' +
        encodingName +
        "\" WITH TEMPLATE template0 ENCODING 'LATIN1' LC_COLLATE 'C' LC_CTYPE 'C' LOCALE_PROVIDER 'libc'",
    );
    encodingCreated = true;
    const encodingUrl = new URL(source);
    encodingUrl.pathname = '/' + encodingName;
    const preflight = spawnSync(
      process.execPath,
      [path.join(__dirname, 'market-schema-preflight.cjs')],
      {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, DATABASE_URL: encodingUrl.toString() },
        encoding: 'utf8',
        timeout: 20000,
        windowsHide: true,
      },
    );
    assert.equal(
      preflight.status,
      1,
      'Non-UTF8 preflight must fail before token normalization',
    );
    assert.match(preflight.stdout + preflight.stderr, /MARKET_UTF8_REQUIRED/);
    checks++;
    checks += await require('./lib/market-facet-assertions.cjs').runMarketFacetAssertions({ db, prisma, now });
    console.log(
      'PASS ' +
        checks +
        ' PostgreSQL filter/text/facet/capability cases, closed aliases and hostile values',
    );
  } finally {
    if (prisma) await prisma.$disconnect();
    if (connected) await db.end();
    if (encodingCreated) {
      assert(/^aru_market_encoding_[a-f0-9]{32}$/.test(encodingName));
      await admin.query('DROP DATABASE "' + encodingName + '"');
    }
    if (created) {
      assert(/^aru_market_filters_[a-f0-9]{32}$/.test(name));
      await admin.query('DROP DATABASE "' + name + '"');
    }
    await admin.end();
  }
}
main().catch((error) => {
  // Connection strings and parameter values are deliberately absent.
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
