const assert = require('node:assert/strict');
const { randomUUID, randomBytes } = require('node:crypto');
const { Prisma } = require('@prisma/client');
const { ConfigService } = require('@nestjs/config');
const {
  MarketCatalogService,
} = require('../../src/market/catalog/market-catalog.service');
const {
  MarketCatalogReadService,
} = require('../../src/market/catalog/market-catalog-read.service');
const {
  MarketPublicMediaService,
} = require('../../src/market/catalog/market-public-media.service');
const {
  mapLegacyMarketPage,
} = require('../../src/market/catalog/market-legacy-facade');
const {
  marketSnapshotPageSql,
} = require('../../src/market/catalog/market-snapshot-order.sql');
const {
  createMarketCatalogScope,
  marketCatalogSourceContext,
} = require('../../src/market/catalog/market-catalog-scope');
const {
  marketProductSourceSql,
} = require('../../src/market/catalog/market-product-source.sql');
const {
  marketProductFiltersSql,
} = require('../../src/market/catalog/market-filter.sql');
const {
  marketNewestPageSql,
} = require('../../src/market/catalog/market-newest-order.sql');
const {
  marketPricePageSql,
} = require('../../src/market/catalog/market-price-order.sql');
const { readMarketFacets } = require('../../src/market/catalog/market-facets');
const { MarketCursorCodec } = require('../../src/market/catalog/market-cursor');
const { marketFilterHash } = require('../../src/market/catalog/market-filters');
const { runMarketCatalogBatchAssertions } = require('./market-catalog-batch-assertions.cjs');

async function runMarketCatalogSourceScopeAssertions({ db, prisma, now, queryCount, queryStats }) {
  assert(
    /^aru_market_pipeline_[a-f0-9]{32}$/.test(db.connectionParameters.database),
  );
  let checks = 0;
  const equal = (actual, expected, label) => {
    assert.deepEqual(actual, expected, label);
    checks++;
  };
  const sorted = (rows) => rows.map((row) => row.id).sort();
  const query = (sql) => prisma.$queryRaw(sql);
  const owner = await prisma.user.create({
    data: {
      id: randomUUID(),
      username: 'scope-owner',
      email: 'scope@fixture.invalid',
      status: 'ACTIVE',
    },
  });
  const viewer = await prisma.user.create({
    data: {
      id: randomUUID(),
      username: 'scope-viewer',
      email: 'scope-viewer@fixture.invalid',
      status: 'ACTIVE',
    },
  });
  const brand = await prisma.brand.create({
    data: {
      id: randomUUID(),
      ownerId: owner.id,
      name: 'Source scope fixture',
      isStoreOpen: true,
    },
  });
  const category = await prisma.collectionCategory.create({
    data: { id: randomUUID(), slug: 'scope-a', name: 'Scope A' },
  });
  const otherCategory = await prisma.collectionCategory.create({
    data: { id: randomUUID(), slug: 'scope-b', name: 'Scope B' },
  });
  // Published products carry an approved, ready cover, as real catalogue rows
  // must to render. The catalogue only lists products whose cover can render.
  const sharedCover = await prisma.fileUpload.create({
    data: {
      id: randomUUID(),
      userId: owner.id,
      originalName: 'Shared cover',
      fileName: 'shared-cover.webp',
      s3Key: 'scope/shared-cover.webp',
      s3Url: 'https://media.fixture.invalid/source.webp',
      fileType: 'POST_IMAGE',
      mimeType: 'image/webp',
      size: 100,
      processingStatus: 'READY',
      assetVersion: 1,
      width: 1200,
      height: 1800,
    },
  });
  const add = async (data) => {
    const product = await prisma.product.create({
      data: {
        id: randomUUID(),
        brandId: brand.id,
        categoryId: category.id,
        name: 'Scope product',
        price: 10000,
        effectivePrice: 10000,
        effectivePriceComputedAt: new Date(now.getTime() - 1000),
        isActive: true,
        publicationStatus: 'PUBLISHED',
        firstPublishedAt: new Date(now.getTime() - 7200000),
        thumbnail: 'https://media.fixture.invalid/source.webp',
        images: ['https://media.fixture.invalid/source.webp'],
        totalStock: 5,
        trackInventory: true,
        standardCheckoutEnabled: true,
        colors: ['Red'],
        sizes: ['M'],
        sizeStock: { M: 5 },
        ...data,
      },
    });
    await prisma.productMedia.create({
      data: {
        productId: product.id,
        fileUploadId: sharedCover.id,
        brandId: brand.id,
        createdById: owner.id,
        viewSlot: 'OTHER',
        reviewStatus: 'APPROVED',
        orderIndex: 9,
      },
    });
    return product;
  };
  const anchor = await add({});
  const chosen = await add({
    price: 9000,
    effectivePrice: 9000,
    totalStock: 1,
    firstPublishedAt: new Date(now.getTime() - 3600000),
  });
  const split = await add({ price: 9500, effectivePrice: 9500, totalStock: 2 });
  const other = await add({
    price: 8000,
    effectivePrice: 8000,
    totalStock: 1,
    categoryId: otherCategory.id,
    colors: ['Blue'],
  });
  const decoy = await add({
    price: 100,
    effectivePrice: 100,
    totalStock: 1,
    firstPublishedAt: now,
    colors: ['Blue'],
  });
  const older = await add({
    price: 7000,
    effectivePrice: 7000,
    firstPublishedAt: new Date(now.getTime() - 60 * 86400000),
  });
  await prisma.productVariant.createMany({
    data: [
      {
        id: randomUUID(),
        productId: chosen.id,
        color: 'Red',
        size: 'M',
        stock: 1,
      },
      {
        id: randomUUID(),
        productId: split.id,
        color: 'Red',
        size: 'L',
        stock: 1,
      },
      {
        id: randomUUID(),
        productId: split.id,
        color: 'Blue',
        size: 'M',
        stock: 1,
      },
    ],
  });
  const feature = (entityId, placementKey) =>
    prisma.featuredItem.create({
      data: {
        id: randomUUID(),
        entityType: 'PRODUCT',
        entityId,
        brandId: brand.id,
        placementKey,
        position: 0,
        startsAt: now,
        expiresAt: new Date(now.getTime() + 60000),
        isActive: true,
        featuredById: owner.id,
      },
    });
  await feature(chosen.id, 'SCOPE_CHOSEN');
  await feature(chosen.id, 'SCOPE_PAIR');
  await feature(split.id, 'SCOPE_PAIR');
  await prisma.productComplement.create({
    data: { productId: anchor.id, complementId: other.id, status: 'APPROVED' },
  });
  const fixed = { brandIds: [brand.id] };
  const base = {
    key: 'source-scope',
    version: '1',
    viewer: {},
    productIds: [anchor.id, chosen.id, split.id, other.id, decoy.id, older.id],
  };
  const scope = (extra) => createMarketCatalogScope({ ...base, ...extra });
  const select = async (
    alias,
    source,
    user = {},
    fixedFilters = fixed,
    extra = {},
  ) => {
    const table = alias === 'p' ? Prisma.sql`p` : Prisma.sql`mp`;
    const predicate = marketProductFiltersSql(
      [user, fixedFilters],
      now,
      alias,
      scope({ source, ...extra }),
    );
    return query(
      Prisma.sql`SELECT ${table}."_id" AS id FROM "Product" ${table} WHERE ${predicate}`,
    );
  };
  const cases = [
    [
      {
        kind: 'catalog',
        sort: 'newest',
        firstPublishedAfter: new Date(now.getTime() - 5400000).toISOString(),
      },
      [chosen.id, decoy.id],
    ],
    [
      { kind: 'low_stock', threshold: 1 },
      [chosen.id, split.id, other.id, decoy.id],
    ],
    [{ kind: 'curated', placementKey: 'SCOPE_CHOSEN' }, [chosen.id]],
    [
      { kind: 'similar', productId: anchor.id },
      [chosen.id, split.id, older.id],
    ],
    [{ kind: 'complements', productId: anchor.id }, [other.id]],
  ];
  for (const alias of ['p', 'mp']) {
    for (const [source, expected] of cases) {
      equal(
        sorted(await select(alias, source)),
        [...expected].sort(),
        `${alias} ${source.kind} exact source membership`,
      );
      equal(
        (await select(alias, source, {}, fixed, { productIds: [] })).length,
        0,
        `${alias} ${source.kind} cannot escape empty product scope`,
      );
      equal(
        (
          await select(
            alias,
            source,
            { categoryIds: [category.id] },
            { ...fixed, categoryIds: [otherCategory.id] },
          )
        ).length,
        0,
        `${alias} ${source.kind} cannot broaden conflicting fixed and caller filters`,
      );
    }
    equal(
      sorted(
        await select(
          alias,
          { kind: 'curated', placementKey: 'SCOPE_PAIR' },
          {},
          fixed,
          { filterLayers: [{ colors: ['red'] }, { sizes: ['M'] }] },
        ),
      ),
      [chosen.id],
      `${alias} original/fallback scopes describe one SKU`,
    );
    equal(
      (
        await select(
          alias,
          { kind: 'curated', placementKey: 'SCOPE_PAIR' },
          { sizes: ['L'] },
          fixed,
          { filterLayers: [{ colors: ['red'] }, { sizes: ['M'] }] },
        )
      ).length,
      0,
      `${alias} caller size cannot override fallback size`,
    );
    for (const kind of ['similar', 'complements']) {
      equal(
        (await select(alias, { kind, productId: randomUUID() })).length,
        0,
        `${alias} missing ${kind} context fails closed`,
      );
    }
  }
  const chosenScope = scope({
    source: { kind: 'curated', placementKey: 'SCOPE_CHOSEN' },
  });
  equal(
    (
      await query(
        marketNewestPageSql({
          filters: {},
          fixedFilters: fixed,
          scope: chosenScope,
          now,
          limit: 1,
        }),
      )
    ).map((row) => row.id),
    [chosen.id],
    'Newest applies source before LIMIT despite newer out-of-source decoy',
  );
  for (const sort of ['price_asc', 'price_desc']) {
    equal(
      (
        await query(
          marketPricePageSql({
            filters: {},
            fixedFilters: fixed,
            scope: chosenScope,
            now,
            limit: 1,
            dirty: [],
            sort,
          }),
        )
      ).map((row) => row.id),
      [chosen.id],
      `${sort} cached branch applies source before LIMIT`,
    );
    await prisma.product.update({
      where: { id: chosen.id },
      data: { effectivePriceComputedAt: new Date(now.getTime() + 1000) },
    });
    equal(
      (
        await query(
          marketPricePageSql({
            filters: {},
            fixedFilters: fixed,
            scope: chosenScope,
            now,
            limit: 1,
            dirty: base.productIds,
            sort,
          }),
        )
      ).map((row) => row.id),
      [chosen.id],
      `${sort} dirty mp branch applies source before LIMIT`,
    );
    await prisma.product.update({
      where: { id: chosen.id },
      data: { effectivePriceComputedAt: new Date(now.getTime() - 1000) },
    });
  }
  const stockScope = scope({
    source: { kind: 'curated', placementKey: 'SCOPE_PAIR' },
    filterLayers: [{ colors: ['red'] }, { sizes: ['M'] }],
  });
  const facet = (filters, selectedScope = stockScope, fixedFilters = fixed) =>
    readMarketFacets(prisma, {
      filters,
      fixedFilters,
      scope: selectedScope,
      now,
    });
  const option = (response, field, value) =>
    response[field]?.find((item) => item.value === value);
  const colors = await facet({ colors: ['blue'], sizes: ['M'] });
  equal(
    option(colors, 'colors', 'red')?.count,
    1,
    'Color disjunction preserves original Red and fallback M together',
  );
  equal(
    option(colors, 'colors', 'blue')?.count,
    0,
    'Color facet cannot broaden fixed color through split SKU',
  );
  const sizes = await facet({ colors: ['red'], sizes: ['L'] });
  equal(
    option(sizes, 'sizes', 'M')?.count,
    1,
    'Size disjunction preserves fallback M and original Red',
  );
  equal(
    option(sizes, 'sizes', 'L')?.count,
    0,
    'Size facet cannot broaden fallback size',
  );
  const all = await facet({});
  equal(
    all.price?.count,
    1,
    'Price facets preserve both original and fallback SKU restrictions',
  );
  equal(
    [all.price?.min, all.price?.max],
    [9000, 9000],
    'Price facet excludes cheaper out-of-source decoy',
  );
  equal(
    option(all, 'categories', category.id)?.count,
    1,
    'Taxonomy facets retain curated source membership',
  );
  const dimension = await prisma.filterDimension.create({
    data: {
      id: randomUUID(),
      slug: 'scope-fabric',
      name: 'Scope fabric',
      appliesTo: ['PRODUCT'],
    },
  });
  const cotton = await prisma.filterValue.create({
    data: {
      id: randomUUID(),
      dimensionId: dimension.id,
      slug: 'cotton',
      name: 'Cotton',
    },
  });
  const silk = await prisma.filterValue.create({
    data: {
      id: randomUUID(),
      dimensionId: dimension.id,
      slug: 'silk',
      name: 'Silk',
    },
  });
  await prisma.entityFilter.createMany({
    data: [
      {
        id: randomUUID(),
        productId: chosen.id,
        entityType: 'PRODUCT',
        entityId: chosen.id,
        filterValueId: cotton.id,
      },
      {
        id: randomUUID(),
        productId: split.id,
        entityType: 'PRODUCT',
        entityId: split.id,
        filterValueId: silk.id,
      },
    ],
  });
  const dimensionScope = scope({
    source: { kind: 'curated', placementKey: 'SCOPE_PAIR' },
    filterLayers: [
      { dimensions: { 'scope-fabric': ['cotton'] } },
      { price: { min: 8500 } },
    ],
  });
  const dimensions = await facet(
    { dimensions: { 'scope-fabric': ['silk'] } },
    dimensionScope,
  );
  equal(
    dimensions.dimensions?.['scope-fabric'].values.find(
      (value) => value.value === 'cotton',
    )?.count,
    1,
    'Dimension disjunction removes only caller choice while retaining original cotton',
  );
  equal(
    dimensions.dimensions?.['scope-fabric'].values.find(
      (value) => value.value === 'silk',
    )?.count,
    0,
    'Selected incompatible dimension remains zero rather than broadening original scope',
  );
  const conflict = await facet(
    {},
    scope({
      source: { kind: 'curated', placementKey: 'SCOPE_PAIR' },
      filterLayers: [{ colors: ['red'] }, { colors: ['blue'] }],
    }),
  );
  equal(
    Object.keys(conflict),
    [],
    'Every facet hides an impossible original/fallback SKU intersection',
  );

  const hiddenSection = await prisma.userContentSuppression.create({
    data: {
      userId: viewer.id,
      targetType: 'SECTION',
      targetId: base.key,
      sectionKey: null,
      suppressionType: 'HIDE_SECTION',
    },
  });
  equal(
    (
      await select('p', chosenScope.source, {}, fixed, {
        viewer: { userId: viewer.id },
      })
    ).length,
    0,
    'Section suppression resolves targetId when sectionKey is null',
  );
  equal(
    sorted(
      await select('mp', chosenScope.source, {}, fixed, {
        viewer: { userId: owner.id },
      }),
    ),
    [chosen.id],
    'Section suppression never crosses caller identity',
  );
  await prisma.userContentSuppression.update({
    where: { id: hiddenSection.id },
    data: { expiresAt: now },
  });
  equal(
    sorted(
      await select('p', chosenScope.source, {}, fixed, {
        viewer: { userId: viewer.id },
      }),
    ),
    [chosen.id],
    'Section suppression expires at exact captured instant',
  );
  await prisma.userContentSuppression.delete({
    where: { id: hiddenSection.id },
  });

  const sourceHash = marketCatalogSourceContext(stockScope);
  const otherSource = scope({
    source: { kind: 'curated', placementKey: 'SCOPE_CHOSEN' },
    filterLayers: stockScope.filterLayers,
  });
  const otherLayers = scope({
    source: stockScope.source,
    filterLayers: [{ colors: ['blue'] }, { sizes: ['M'] }],
  });
  equal(
    sourceHash === marketCatalogSourceContext(otherSource),
    false,
    'Source hash binds source definition',
  );
  equal(
    sourceHash === marketCatalogSourceContext(otherLayers),
    false,
    'Source hash binds original and fallback layers',
  );
  equal(
    sourceHash,
    marketCatalogSourceContext(
      scope({
        source: stockScope.source,
        filterLayers: stockScope.filterLayers,
        viewer: { userId: viewer.id },
      }),
    ),
    'Source hash stays separate from caller identity',
  );
  const namespace = randomUUID(),
    codec = new MarketCursorCodec(randomBytes(32).toString('hex'), namespace);
  const cursor = codec.encode({
    v: 1,
    namespace,
    requestedSort: 'newest',
    sort: 'newest',
    filterHash: marketFilterHash({}),
    scopeHash: codec.contextHash('scope', sourceHash),
    viewerHash: codec.contextHash('viewer', 'fixture'),
    asOf: now.getTime(),
    expiresAt: now.getTime() + 60000,
    key: [chosen.firstPublishedAt.toISOString(), chosen.id],
    epoch: null,
    price: null,
  });
  const expected = {
    requestedSort: 'newest',
    filterHash: marketFilterHash({}),
    scopeContext: sourceHash,
    viewerContext: 'fixture',
  };
  equal(
    codec.decode(cursor, expected, now.getTime()).kind,
    'valid',
    'Original source cursor remains valid',
  );
  for (const changed of [otherSource, otherLayers]) {
    assert.throws(
      () =>
        codec.decode(
          cursor,
          { ...expected, scopeContext: marketCatalogSourceContext(changed) },
          now.getTime(),
        ),
      'Signed cursor cannot move to another source or fallback scope',
    );
    checks++;
  }
  assert.throws(
    () =>
      marketProductSourceSql(
        { kind: 'curated', placementKey: 'X' },
        now,
        'unsafe',
      ),
    RangeError,
  );
  checks++;
  // Exercise the actual public capture + current-parent media resolver, rather
  // than testing only a mapper with fabricated gallery/option values.
  const firstFile = await prisma.fileUpload.create({
    data: {
      id: randomUUID(),
      userId: owner.id,
      originalName: 'Front',
      fileName: 'front.webp',
      s3Key: 'scope/front.webp',
      s3Url: chosen.thumbnail,
      fileType: 'POST_IMAGE',
      mimeType: 'image/webp',
      size: 100,
      processingStatus: 'READY',
      assetVersion: 1,
      width: 1200,
      height: 1800,
    },
  });
  const backFile = await prisma.fileUpload.create({
    data: {
      id: randomUUID(),
      userId: owner.id,
      originalName: 'Back',
      fileName: 'back.webp',
      s3Key: 'scope/back.webp',
      s3Url: 'https://private.fixture.invalid/scope-back.webp',
      fileType: 'POST_IMAGE',
      mimeType: 'image/webp',
      size: 100,
      processingStatus: 'READY',
      assetVersion: 1,
      width: 1200,
      height: 1800,
    },
  });
  await prisma.product.update({
    where: { id: chosen.id },
    data: { images: [firstFile.s3Url, backFile.s3Url] },
  });
  // The media-association stage owns this product's gallery from here on.
  await prisma.productMedia.deleteMany({ where: { productId: chosen.id } });
  await prisma.productMedia.createMany({
    data: [
      {
        productId: chosen.id,
        fileUploadId: firstFile.id,
        brandId: brand.id,
        createdById: owner.id,
        viewSlot: 'FRONT',
        reviewStatus: 'APPROVED',
        orderIndex: 0,
      },
      {
        productId: chosen.id,
        fileUploadId: backFile.id,
        brandId: brand.id,
        createdById: owner.id,
        viewSlot: 'BACK',
        reviewStatus: 'APPROVED',
        orderIndex: 1,
      },
    ],
  });
  const garment = await prisma.collectionCategoryType.create({
    data: {
      id: randomUUID(),
      categoryId: category.id,
      name: 'Source garment',
      slug: 'source-garment',
    },
  });
  await prisma.product.update({
    where: { id: chosen.id },
    data: { categoryTypeId: garment.id },
  });
  const config = new ConfigService({
    MARKET_CURSOR_SECRET: 'fixture-catalogue-secret-at-least-thirty-two-bytes',
    MARKET_CATALOG_NAMESPACE: randomUUID(),
    STORAGE_PROVIDER: 'R2',
    R2_BUCKET: 'scope-test-media',
    R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
    R2_ACCESS_KEY_ID: 'fixture-only-access',
    R2_SECRET_ACCESS_KEY: 'fixture-only-secret',
    MEDIA_GATEWAY_BASE_URL: 'https://gateway.fixture.invalid/media',
    MEDIA_GATEWAY_SECRET: 'fixture-gateway-secret-at-least-thirty-two-bytes',
    MEDIA_GATEWAY_ENVIRONMENT: 'test',
    MEDIA_GATEWAY_TTL_SECONDS: '300',
  });
  config.skipProcessEnv = true;
  const reads = new MarketCatalogReadService(prisma);
  const catalogue = new MarketCatalogService(
    reads,
    new MarketPublicMediaService(reads, config),
    config,
  );
  const legacy = await catalogue.getPage(
    new URLSearchParams('sort=newest&limit=1'),
    {},
    {
      scope: createMarketCatalogScope({ ...base, productIds: [chosen.id] }),
      fixedFilters: fixed,
      includeTotal: true,
      includeLegacyOptions: true,
    },
  );
  const flat = mapLegacyMarketPage(legacy);
  equal(flat.total, 1, 'Legacy total counts the actual complete scoped set');
  equal(
    flat.items.map((row) => row.id),
    [chosen.id],
    'Legacy mapper retains canonical identity',
  );
  equal(
    flat.items[0].images.length,
    2,
    'Legacy gallery preserves both approved product views',
  );
  equal(
    flat.items[0].media.map((row) => row.fileId),
    [firstFile.id, backFile.id],
    'Legacy gallery retains every approved managed file identity',
  );
  equal(
    flat.items[0].images.every((url) =>
      url.startsWith('https://gateway.fixture.invalid/media/'),
    ),
    true,
    'Every legacy gallery image is gateway signed',
  );
  equal(
    flat.items[0].variants.map((row) => [row.size, row.color, row.stock]),
    [['M', 'Red', 1]],
    'Legacy selectors retain real same-SKU inventory',
  );
  equal(
    flat.items[0].filters.map((row) => row.valueId),
    [cotton.id],
    'Legacy style metadata comes from active public bindings',
  );
  equal(
    flat.items[0].categoryType.id,
    garment.id,
    'Legacy garment metadata retains its approved parent',
  );
  const serialized = JSON.stringify(flat);
  equal(
    serialized.includes(firstFile.s3Url) ||
      serialized.includes(backFile.s3Url) ||
      serialized.includes('"s3Key"') ||
      serialized.includes('"s3Url"'),
    false,
    'Legacy payload exposes no raw storage address or provider field',
  );
  const batchProof=await runMarketCatalogBatchAssertions({db,prisma,now,queryCount,queryStats,chosen,owner,brand,category,firstFile,backFile,config});
  checks+=batchProof.checks;
  const manifest = await prisma.marketFeatureEpoch.findFirst({
    where: { status: 'READY' },
  });
  assert(manifest, 'Frozen count fixture requires an epoch');
  for (const sort of ['popular', 'trending']) {
    const input = { epochId: manifest.id, sort, filters: {}, now, limit: 61 };
    const rows = await query(marketSnapshotPageSql(input));
    const count = await query(
      marketSnapshotPageSql({ ...input, countOnly: true }),
    );
    equal(
      Number(count[0].count),
      rows.length,
      `${sort} exact total shares the covered snapshot membership`,
    );
  }
  console.log(
    `PASS ${checks} PostgreSQL catalogue source/facet/cursor scope proofs`,
  );
  return { checks };
}
module.exports = { runMarketCatalogSourceScopeAssertions };
