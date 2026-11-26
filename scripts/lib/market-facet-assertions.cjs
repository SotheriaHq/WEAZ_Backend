const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { readMarketFacets } = require('../../src/market/catalog/market-facets');
const {
  createMarketCatalogScope,
} = require('../../src/market/catalog/market-catalog-scope');

/** Invoked only by the guarded disposable database harness, never by app code. */
async function runMarketFacetAssertions({ db, prisma, now }) {
  assert(
    /^aru_market_filters_[a-f0-9]{32}$/.test(db.connectionParameters.database),
    'Disposable filter fixture required',
  );
  await db.query(`
    ALTER TABLE "Brand" ADD COLUMN IF NOT EXISTS name text DEFAULT 'Public brand';
    ALTER TABLE "CollectionCategory" ADD COLUMN IF NOT EXISTS name text DEFAULT 'Category';
    ALTER TABLE "CollectionCategoryType" ADD COLUMN IF NOT EXISTS name text DEFAULT 'Type';
    ALTER TABLE "FilterDimension" ADD COLUMN IF NOT EXISTS name text DEFAULT 'Dimension';
    ALTER TABLE "FilterDimension" ADD COLUMN IF NOT EXISTS "isMulti" boolean DEFAULT true;
    ALTER TABLE "FilterValue" ADD COLUMN IF NOT EXISTS name text DEFAULT 'Value';
    ALTER TABLE "Tag" ADD COLUMN IF NOT EXISTS "displayName" text DEFAULT 'Tag';
  `);
  let checks = 0;
  const owner = randomUUID(),
    brand = randomUUID(),
    category = randomUUID(),
    categoryB = randomUUID(),
    type = randomUUID(),
    typeB = randomUUID(),
    inactive = randomUUID(),
    dimension = randomUUID(),
    occasion = randomUUID(),
    classic = randomUUID(),
    modern = randomUUID(),
    formal = randomUUID(),
    casual = randomUUID(),
    canonicalTag = randomUUID(),
    aliasTag = randomUUID(),
    singletonTag = randomUUID(),
    pendingTag = randomUUID();
  await db.query('INSERT INTO "User" ("_id",status) VALUES ($1,\'ACTIVE\')', [
    owner,
  ]);
  await db.query(
    'INSERT INTO "Brand" ("_id","ownerId","isStoreOpen",name) VALUES ($1,$2,true,\'Facet brand\')',
    [brand, owner],
  );
  await db.query(
    'INSERT INTO "CollectionCategory" ("_id","isActive",name) VALUES ($1,true,\'A\'),($2,true,\'B\'),($3,false,\'Inactive\')',
    [category, categoryB, inactive],
  );
  await db.query(
    'INSERT INTO "CollectionCategoryType" ("_id","categoryId","isActive",name) VALUES ($1,$2,true,\'Type A\'),($3,$4,true,\'Type B\')',
    [type, category, typeB, categoryB],
  );
  const add = async ({
    price,
    custom = false,
    colors = ['Red'],
    sizes = ['M'],
    stock = 5,
    cat = category,
    garment = type,
    gender = 'MALE',
    status = 'PUBLISHED',
    json = { M: 5 },
  }) => {
    const id = randomUUID();
    await db.query(
      `INSERT INTO "Product" ("_id","brandId","categoryId","categoryTypeId",price,
      "customOrderEnabled",colors,sizes,"totalStock",gender,"publicationStatus","sizeStock")
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
      [
        id,
        brand,
        cat,
        garment,
        price,
        custom,
        colors,
        sizes,
        stock,
        gender,
        status,
        JSON.stringify(json),
      ],
    );
    return id;
  };
  const a = await add({
    price: 10000,
    colors: ['Red', 'Blue'],
    sizes: ['L', 'M'],
    stock: 8,
  });
  const b = await add({
    price: 30000,
    cat: categoryB,
    garment: typeB,
    gender: 'FEMALE',
  });
  const c = await add({
    price: 60000,
    custom: true,
    sizes: [],
    stock: 0,
    gender: 'EVERYBODY',
    json: {},
  });
  const d = await add({ price: 100000, custom: true, stock: 3 });
  await add({ price: 1, status: 'DRAFT' });
  await db.query(
    "INSERT INTO \"ProductVariant\" (\"_id\",\"productId\",size,color,stock) VALUES ($1,$2,'L','Red',4),($3,$2,'M','Blue',4),($4,$5,'M','Red',3)",
    [randomUUID(), a, randomUUID(), randomUUID(), d],
  );
  await db.query(
    "INSERT INTO \"FilterDimension\" (\"_id\",slug,name,\"isMulti\") VALUES ($1,'facet-style','Style',true),($2,'facet-occasion','Occasion',false)",
    [dimension, occasion],
  );
  await db.query(
    "INSERT INTO \"FilterValue\" (\"_id\",\"dimensionId\",slug,name) VALUES ($1,$2,'classic','Classic'),($3,$2,'modern','Modern'),($4,$5,'formal','Formal'),($6,$5,'casual','Casual')",
    [classic, dimension, modern, formal, occasion, casual],
  );
  for (const [product, style, event] of [
    [a, classic, formal],
    [b, classic, casual],
    [c, modern, formal],
    [d, modern, casual],
  ]) {
    await db.query(
      'INSERT INTO "EntityFilter" ("entityType","entityId","filterValueId") VALUES (\'PRODUCT\',$1,$2),(\'PRODUCT\',$1,$3)',
      [product, style, event],
    );
  }
  await db.query(
    `INSERT INTO "Tag" ("_id","normalizedName","displayName",status,"aliasOfTagId")
    VALUES ($1,'facet-canonical','Canonical','APPROVED',NULL),($2,'facet-alias','Alias','APPROVED',$1),
      ($3,'facet-singleton','Singleton','APPROVED',NULL),($4,'facet-pending','Pending','PENDING',NULL)`,
    [canonicalTag, aliasTag, singletonTag, pendingTag],
  );
  await db.query(
    'INSERT INTO "TagBinding" ("tagId","entityType","entityId") VALUES ($1,\'PRODUCT\',$2),($1,\'PRODUCT\',$3),($4,\'PRODUCT\',$5),($6,\'PRODUCT\',$2)',
    [canonicalTag, a, b, singletonTag, c, pendingTag],
  );
  const read = (filters = {}, fixedFilters = { brandIds: [brand] }, scope) =>
    prisma.$transaction(
      (tx) => readMarketFacets(tx, { filters, fixedFilters, now, scope }),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 10000,
      },
    );
  const get = (result, key, value) =>
    result[key]?.find((option) => option.value === value);
  const check = (actual, expected, message) => {
    assert.deepEqual(actual, expected, message);
    checks++;
  };
  const all = await read();
  check(
    all.price && [all.price.min, all.price.max, all.price.count],
    [10000, 100000, 4],
    'Actual eligible effective prices',
  );
  check(
    all.price.percentiles,
    { p30: 28000, p60: 54000, p85: 82000 },
    'Real interpolated percentiles',
  );
  check(
    all.price.bands.reduce((sum, band) => sum + band.count, 0),
    4,
    'Price bands cover every eligible product once',
  );
  for (let index = 1; index < all.price.bands.length; index++)
    assert(all.price.bands[index].min > all.price.bands[index - 1].max);
  checks++;
  check(
    get(all, 'tags', 'facet-canonical')?.count,
    2,
    'Canonical tag bindings',
  );
  check(
    get(all, 'tags', 'facet-singleton'),
    undefined,
    'Unselected tag floor two',
  );
  check(get(all, 'tags', 'facet-pending'), undefined, 'Pending tags private');
  check(
    get(all, 'categories', inactive),
    undefined,
    'Inactive categories private',
  );
  const selectedAlias = await read({
    tags: ['facet-alias', 'facet-singleton'],
  });
  check(
    get(selectedAlias, 'tags', 'facet-alias')?.count,
    2,
    'Approved alias resolves canonical binding',
  );
  check(
    get(selectedAlias, 'tags', 'facet-singleton')?.count,
    1,
    'Selected singleton survives floor',
  );
  const redSize = await read({ sizes: ['M'] });
  check(
    get(redSize, 'colors', 'red')?.count,
    3,
    'Red/L plus Blue/M does not count Red/M',
  );
  check(get(redSize, 'colors', 'blue')?.count, 1, 'Blue/M actual SKU');
  const blue = await read({ colors: ['blue'], sizes: ['M', 'L'] });
  check(get(blue, 'sizes', 'M')?.count, 1, 'Size facet same Blue/M SKU');
  check(
    get(blue, 'sizes', 'L'),
    { value: 'L', label: 'L', count: 0, disabled: true },
    'Selected known zero kept disabled',
  );
  const fixedBlue = await read(
    { colors: ['red'], sizes: ['M'] },
    { brandIds: [brand], colors: ['blue'] },
  );
  check(
    get(fixedBlue, 'colors', 'red')?.count,
    0,
    'Fixed and candidate colours must describe same SKU',
  );
  check(
    get(fixedBlue, 'colors', 'blue')?.count,
    1,
    'Removing shopper colour preserves fixed Blue',
  );
  const stock = await read({ inStockOnly: true, sizes: ['L'] });
  check(
    get(stock, 'sizes', 'M')?.count,
    3,
    'Stock-only excludes shared custom count',
  );
  check(stock.sizeSupport, undefined, 'Stock-only has no custom-fit claim');
  const custom = await read({ sizes: ['Unlisted fit 42,5'] });
  check(
    get(custom, 'sizes', 'Unlisted fit 42,5')?.count,
    2,
    'Custom fit matches any requested size',
  );
  check(
    custom.sizeSupport,
    { customFitAnySize: true, customFitCount: 2 },
    'Explicit open-ended custom size support',
  );
  const dimensions = await read({
    dimensions: { 'facet-style': ['classic'], 'facet-occasion': ['formal'] },
  });
  check(
    dimensions.dimensions['facet-style'].values.map((option) => [
      option.value,
      option.count,
    ]),
    [
      ['classic', 1],
      ['modern', 1],
    ],
    'Only own dimension removed',
  );
  check(
    dimensions.dimensions['facet-occasion'].values.map((option) => [
      option.value,
      option.count,
    ]),
    [
      ['casual', 1],
      ['formal', 1],
    ],
    'Other dimension retained',
  );
  const fixedDimension = await read(
    { dimensions: { 'facet-style': ['modern'] } },
    { brandIds: [brand], dimensions: { 'facet-style': ['classic'] } },
  );
  check(
    fixedDimension.dimensions['facet-style'].values.find(
      (option) => option.value === 'modern',
    )?.count,
    0,
    'Fixed own dimension retained',
  );
  const narrow = await read({ categoryIds: [categoryB] });
  check(get(narrow, 'categories', category)?.count, 3, 'Own category removed');
  check(narrow.price.count, 1, 'Other facet retains category');
  const scoped = await read(
    {},
    { brandIds: [brand] },
    createMarketCatalogScope({
      key: 'facet-proof',
      version: '1',
      viewer: {},
      productIds: [a],
    }),
  );
  check(scoped.price.count, 1, 'Trusted scope before grouped aggregation');
  check(
    get(scoped, 'colors', 'blue')?.count,
    1,
    'Scope reaches colour aggregate',
  );
  const empty = await read({}, { brandIds: [randomUUID()] });
  check(empty, {}, 'Empty results have no invented whole-zero keys/bands');
  const unknown = await read({ colors: ['facet-unknown-colour'] });
  check(
    get(unknown, 'colors', 'facet-unknown-colour'),
    undefined,
    'Unknown selected colour never becomes a public dictionary option',
  );
  const unknownTag = await read({ tags: ['facet-pending'] });
  check(
    get(unknownTag, 'tags', 'facet-pending'),
    undefined,
    'Selected pending tag remains private',
  );
  const audience = await read({ audience: ['WOMEN'] });
  check(
    get(audience, 'audience', 'MEN')?.count,
    3,
    'Audience disjunction removes only its own key',
  );
  check(
    get(audience, 'audience', 'UNISEX')?.count,
    1,
    'Unisex counts only EVERYBODY',
  );
  const made = await read({ fulfilment: 'MADE_TO_ORDER' });
  check(
    get(made, 'fulfilment', 'READY_TO_WEAR')?.count,
    3,
    'Ready-to-wear option uses stock and checkout flags',
  );
  check(
    get(made, 'fulfilment', 'MADE_TO_ORDER')?.count,
    2,
    'Made-to-order option counts actual custom channel',
  );
  await db.query(
    'UPDATE "Product" SET "salePrice"=5000,"saleStartAt"=($2::timestamptz AT TIME ZONE \'UTC\'),"saleEndAt"=($2::timestamptz AT TIME ZONE \'UTC\') WHERE "_id"=$1',
    [a, now.toISOString()],
  );
  check((await read()).price.min, 5000, 'Captured inclusive sale boundary');
  check(
    get(await read({ onSale: true }), 'onSale', 'true')?.count,
    1,
    'On-sale facet uses captured effective-price comparison',
  );
  const normalized = await add({
    price: 25000,
    colors: ['\u00a0ＧＲＥＥＮ\ufeff'],
    sizes: ['\u00a0４２,５\ufeff'],
    json: { '\u00a0４２,５\ufeff': 2 },
  });
  const normalizedResult = await read({
    colors: ['green'],
    fulfilment: 'READY_TO_WEAR',
  });
  check(
    get(normalizedResult, 'sizes', '42,5')?.count,
    1,
    'Size facet shares NFKC and ECMAScript trimming, preserving comma',
  );
  check(
    get(
      await read({ sizes: ['42,5'], fulfilment: 'READY_TO_WEAR' }),
      'colors',
      'green',
    )?.count,
    1,
    'Colour facet normalizes public vocabulary and candidate stock consistently',
  );
  await db.query('UPDATE "Product" SET "isActive"=false WHERE "_id"=$1', [
    normalized,
  ]);
  // Malformed quantities cannot prove ready-to-wear stock, even when a public
  // product advertises the same label in its declared size vocabulary.
  const invalidStock = await add({
    price: 25000,
    colors: ['Green'],
    sizes: ['Bad'],
    json: { Bad: 1.5 },
  });
  check(
    get(
      await read({ colors: ['green'], fulfilment: 'READY_TO_WEAR' }),
      'sizes',
      'Bad',
    ),
    undefined,
    'Fractional JSON stock excluded',
  );
  await db.query(
    'UPDATE "Product" SET "sizeStock"=\'{"Bad":2147483648}\'::jsonb WHERE "_id"=$1',
    [invalidStock],
  );
  check(
    get(
      await read({ colors: ['green'], fulfilment: 'READY_TO_WEAR' }),
      'sizes',
      'Bad',
    ),
    undefined,
    'Overflow JSON stock excluded',
  );
  await db.query(
    'UPDATE "Product" SET "sizeStock"=\'{"Bad":"2"}\'::jsonb WHERE "_id"=$1',
    [invalidStock],
  );
  check(
    get(
      await read({ colors: ['green'], fulfilment: 'READY_TO_WEAR' }),
      'sizes',
      'Bad',
    ),
    undefined,
    'String JSON stock excluded',
  );
  // More than twelve public brands prove deterministic top-N plus applied
  // option retention and honest pre-limit cardinality.
  const capCategory = randomUUID(),
    extraBrands = [];
  await db.query(
    'INSERT INTO "CollectionCategory" ("_id","isActive",name) VALUES ($1,true,\'Cap\')',
    [capCategory],
  );
  for (let index = 0; index < 14; index++) {
    const nextOwner = randomUUID(),
      nextBrand = randomUUID();
    extraBrands.push(nextBrand);
    await db.query('INSERT INTO "User" ("_id",status) VALUES ($1,\'ACTIVE\')', [
      nextOwner,
    ]);
    await db.query(
      'INSERT INTO "Brand" ("_id","ownerId","isStoreOpen",name) VALUES ($1,$2,true,$3)',
      [nextBrand, nextOwner, 'Brand ' + index],
    );
    await db.query(
      'INSERT INTO "Product" ("_id","brandId","categoryId") VALUES ($1,$2,$3)',
      [randomUUID(), nextBrand, capCategory],
    );
  }
  const caps = await read({}, { categoryIds: [capCategory] });
  check(caps.brands.length, 12, 'Top twelve brands');
  check(
    caps.truncation.brand,
    { limit: 12, returned: 12, available: 14 },
    'Honest brand truncation',
  );
  const selectedBrand = extraBrands.sort().at(-1);
  const selectedCaps = await read(
    { brandIds: [selectedBrand] },
    { categoryIds: [capCategory] },
  );
  check(
    get(selectedCaps, 'brands', selectedBrand)?.count,
    1,
    'Applied brand retained beyond top twelve',
  );
  return checks;
}

module.exports = { runMarketFacetAssertions };
