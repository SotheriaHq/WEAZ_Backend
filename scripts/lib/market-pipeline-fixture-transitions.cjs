const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { pipelineBatchSourcesSql } = require('../../src/market/pipeline/market-pipeline.database.sql');
const { pipelineRequestKey, readCurrentPipelineSources } = require('../../src/market/pipeline/market-pipeline.database');
const { captureMarketCatalogCards } = require('../../src/market/catalog/market-catalog-cards');

async function runPipelineTransitions(f) {
  const { db, prisma, now, equal, read, request, sources, user, viewer, brand, category, categoryB,
    a, b, c, draft, design, designFile, publicLook, featured, tag, dimension, cotton, addProduct, capture } = f;
  assert(/^aru_market_pipeline_[a-f0-9]{32}$/.test(db.connectionParameters.database));
  const ids = rows => rows.map(row => row.candidate.id);
  const has = (rows, id) => ids(rows).includes(id);
  let plans = 0;

  // Each source must retain the intersection of caller filters and all fixed layers.
  for (const source of sources) {
    equal((await read(source, { filters: { categoryIds: [category.id] },
      fixedFilterLayers: [{ categoryIds: [categoryB.id] }] })).length, 0,
    `${source.kind}:${source.sort || ''} ANDs fixed and user filters`);
  }
  equal(has(await read(sources[3], { filters: { colors: ['red'] },
    fixedFilterLayers: [{ sizes: ['M'] }] }), b.p.id), false, 'SKU intersection spans fixed and user layers');
  equal((await read({ ...sources[0], firstPublishedAfter: new Date(now.getTime() + 1).toISOString() })).length,
    0, 'New-release window remains a source restriction');
  equal((await read({ kind: 'curated', placementKey: 'MISSING' })).length, 0, 'Missing placement fails closed');
  equal((await read({ kind: 'complements', productId: randomUUID() })).length, 0, 'Missing complement target fails closed');
  equal((await read({ kind: 'complements', productId: draft.p.id })).length, 0, 'Draft complement target fails closed');
  equal((await read(sources[5])).some(row => row.candidate.id === a.p.id), false, 'Similarity excludes its target');

  // Exact scheduled interval [startsAt, expiresAt), activity and removal gates.
  await prisma.featuredItem.update({ where: { id: featured.id }, data: { startsAt: now,
    expiresAt: new Date(now.getTime() + 1000), isActive: true, removedAt: null } });
  equal(ids(await read(sources[4])), [a.p.id], 'Curated includes exact start');
  for (const data of [{ isActive: false }, { removedAt: now }]) {
    await prisma.featuredItem.update({ where: { id: featured.id }, data });
    equal((await read(sources[4])).length, 0, 'Inactive or removed curated item excluded');
    await prisma.featuredItem.update({ where: { id: featured.id }, data: { isActive: true, removedAt: null } });
  }

  // Approved canonical tags and active dimensions are the sole public evidence.
  await prisma.tagBinding.create({ data: { id: randomUUID(), tagId: tag.id,
    entityType: 'COLLECTION', entityId: design.id } });
  equal(ids(await read(sources[7], { filters: { tags: ['fixture-tag'] } })), [design.id], 'Runway approved tag filter');
  for (const data of [{ status: 'PENDING' }, { isBanned: true }]) {
    await prisma.tag.update({ where: { id: tag.id }, data });
    equal((await read(sources[0], { filters: { tags: ['fixture-tag'] } })).length, 0, 'Nonapproved tag cannot select products');
    equal((await read(sources[7], { filters: { tags: ['fixture-tag'] } })).length, 0, 'Nonapproved tag cannot select designs');
    equal((await read(sources[0])).find(row => row.candidate.id === a.p.id).candidate.tags, [], 'Nonapproved tag never projected');
    await prisma.tag.update({ where: { id: tag.id }, data: { status: 'APPROVED', isBanned: false } });
  }
  equal(ids(await read(sources[0], { filters: { dimensions: { fabric: ['cotton'] } } })), [a.p.id], 'Active dimension matches actual binding');
  await prisma.filterValue.update({ where: { id: cotton.id }, data: { isActive: false } });
  equal((await read(sources[0], { filters: { dimensions: { fabric: ['cotton'] } } })).length, 0, 'Inactive dimension value cannot match');
  equal((await read(sources[0])).find(row => row.candidate.id === a.p.id).candidate.dimensions, [], 'Inactive value not projected');
  await prisma.filterValue.update({ where: { id: cotton.id }, data: { isActive: true } });
  await prisma.filterDimension.update({ where: { id: dimension.id }, data: { isActive: false } });
  equal((await read(sources[0], { filters: { dimensions: { fabric: ['cotton'] } } })).length, 0, 'Inactive dimension cannot match');
  await prisma.filterDimension.update({ where: { id: dimension.id }, data: { isActive: true } });
  equal((await read(sources[7], { filters: { dimensions: { fabric: ['cotton'] } } })).length, 0,
    'Runway dimension filter excludes unbound design');
  await prisma.entityFilter.create({ data: { id: randomUUID(), entityType: 'COLLECTION',
    entityId: design.id, filterValueId: cotton.id } });
  equal(ids(await read(sources[7], { filters: { dimensions: { fabric: ['cotton'] } } })), [design.id],
    'Runway dimension selects bound design');
  const silk = await prisma.filterValue.create({ data: { id: randomUUID(), dimensionId: dimension.id,
    slug: 'silk', name: 'Silk' } });
  equal((await read(sources[7], { filters: { dimensions: { fabric: ['cotton'] } },
    fixedFilterLayers: [{ dimensions: { fabric: [silk.slug] } }] })).length, 0,
  'Runway dimensions AND caller and fixed layers');
  await prisma.filterValue.update({ where: { id: cotton.id }, data: { isActive: false } });
  equal((await read(sources[7], { filters: { dimensions: { fabric: ['cotton'] } } })).length, 0,
    'Runway dimension excludes inactive value');
  await prisma.filterValue.update({ where: { id: cotton.id }, data: { isActive: true } });

  for (const filters of [{ price: { max: 11000 } }, { colors: ['red'] }, { sizes: ['M'] },
    { fulfilment: 'READY_TO_WEAR' }, { inStockOnly: true }, { onSale: true }]) {
    equal((await read(sources[7], { filters })).length, 0,
      'Runway fails closed for product-only filter ' + Object.keys(filters)[0]);
  }

  // Product eligibility and hydration exercise separate authority gates.
  for (const data of [{ isActive: false }, { archivedAt: now }, { deletedAt: now },
    { publishAt: new Date(now.getTime() + 1) }, { price: 0 }, { totalStock: 0 },
    { thumbnail: null, images: [] }]) {
    await prisma.product.update({ where: { id: a.p.id }, data });
    equal(has(await read(sources[0]), a.p.id), false, 'Canonical product eligibility rejects ' + Object.keys(data).join(','));
    equal((await read({ kind: 'similar', productId: a.p.id })).length, 0, 'Ineligible similarity target rejected');
    await prisma.product.update({ where: { id: a.p.id }, data: { isActive: true, archivedAt: null,
      deletedAt: null, publishAt: null, price: 10000, totalStock: 2, thumbnail: a.file.s3Url, images: [a.file.s3Url] } });
  }
  const card = () => captureMarketCatalogCards(prisma, { rows: [{ id: a.p.id, amount: '10000',
    firstPublishedAt: now.toISOString() }], asOf: now });
  equal((await card()).length, 1, 'Approved ready product media hydrates');
  for (const data of [{ processingStatus: 'PENDING' }, { originalDeletedAt: now }, { mimeType: 'application/pdf' }]) {
    await prisma.fileUpload.update({ where: { id: a.file.id }, data });
    equal((await card()).length, 0, 'Product media rejects ' + Object.keys(data).join(','));
    await prisma.fileUpload.update({ where: { id: a.file.id }, data: { processingStatus: 'READY', originalDeletedAt: null, mimeType: 'image/webp' } });
  }
  await prisma.productMedia.updateMany({ where: { productId: a.p.id }, data: { reviewStatus: 'PENDING' } });
  equal((await card()).length, 0, 'Unapproved product media cannot hydrate');
  await prisma.productMedia.updateMany({ where: { productId: a.p.id }, data: { reviewStatus: 'APPROVED' } });
  for (const data of [{ processingStatus: 'FAILED' }, { originalDeletedAt: now }, { mimeType: 'application/pdf' }]) {
    await prisma.fileUpload.update({ where: { id: designFile.id }, data });
    equal((await read(sources[7])).length, 0, 'Runway media rejects ' + Object.keys(data).join(','));
    await prisma.fileUpload.update({ where: { id: designFile.id }, data: { processingStatus: 'READY', originalDeletedAt: null, mimeType: 'image/webp' } });
  }
  await prisma.collectionMedia.updateMany({ where: { collectionId: design.id }, data: { reviewStatus: 'PENDING' } });
  equal((await read(sources[7])).length, 0, 'Runway requires approved media');
  await prisma.collectionMedia.updateMany({ where: { collectionId: design.id }, data: { reviewStatus: 'APPROVED' } });

  // Stock scarcity uses positive live SKU stock; custom-only stock is never scarcity.
  equal(has(await read(sources[3]), c.p.id), false, 'Custom-only product not low-stock');
  await prisma.productVariant.updateMany({ where: { productId: b.p.id }, data: { stock: 0 } });
  equal(has(await read(sources[3]), b.p.id), false, 'Zero variants never fall back to aggregate stock');
  await prisma.productVariant.updateMany({ where: { productId: b.p.id }, data: { stock: 2 } });

  // Nonproduct metadata must never disclose profile, account or private content fields.
  const nonproductRows = [];
  for (const source of sources.slice(7)) nonproductRows.push(...await read(source));
  equal(/PRIVATE|owner@fixture|viewer@fixture|phoneNumber|contactEmail|address/.test(JSON.stringify(nonproductRows)), false,
    'Nonproduct projections exclude account and private metadata');
  for (const data of [{ logo: null }, { createdAt: new Date(now.getTime() - 181 * 86400000) }]) {
    await prisma.brand.update({ where: { id: brand.id }, data });
    equal((await read(sources[9])).length, 0, 'New-designer source requires logo and 180-day age');
    await prisma.brand.update({ where: { id: brand.id }, data: { logo: 'https://media.fixture.invalid/logo', createdAt: now } });
  }
  equal((await read(sources[9], { filters: { categoryIds: [category.id] } })).length, 0, 'New designer requires three matching eligible products');
  equal((await read(sources[10], { filters: { price: { max: 11000 }, categoryIds: [category.id] } })).length, 0,
    'Category tile requires two matching eligible products');
  await prisma.storeCollectionProduct.deleteMany({ where: { collectionId: publicLook.id, productId: { in: [b.p.id, c.p.id] } } });
  equal((await read(sources[8])).length, 0, 'Look requires at least two eligible products');
  await prisma.storeCollectionProduct.createMany({ data: [b, c].map(({ p }) => ({ id: randomUUID(), collectionId: publicLook.id, productId: p.id })) });

  // A 7/10 look includes the exact 70-percent boundary, and 6/10 is rejected.
  const boundary = await prisma.storeCollection.create({ data: { id: randomUUID(), ownerId: user.id,
    title: 'Seventy-percent boundary', status: 'PUBLISHED', visibility: 'PUBLIC', isAvailableInStore: true } });
  const seven = [a, b, c];
  for (let i = 0; i < 4; i++) seven.push(await addProduct());
  const excluded = [draft];
  for (let i = 0; i < 2; i++) excluded.push(await addProduct({ publicationStatus: 'DRAFT' }));
  await prisma.storeCollectionProduct.createMany({ data: [...seven, ...excluded].map(({ p }) => ({ id: randomUUID(), collectionId: boundary.id, productId: p.id })) });
  equal(has(await read(sources[8]), boundary.id), true, 'Look exact 70-percent boundary accepted');
  await prisma.product.update({ where: { id: seven[6].p.id }, data: { publicationStatus: 'DRAFT' } });
  equal(has(await read(sources[8]), boundary.id), false, 'Look below 70 percent rejected');
  await prisma.product.update({ where: { id: seven[6].p.id }, data: { publicationStatus: 'PUBLISHED' } });
  equal(ids(await read(sources[8]))[0], publicLook.id, 'Unpinned looks order by completeness before creation date');
  const pin = await prisma.featuredItem.create({ data: { id: randomUUID(), entityType: 'COLLECTION',
    entityId: boundary.id, brandId: brand.id, placementKey: 'LOOK', position: 0,
    startsAt: now, expiresAt: new Date(now.getTime() + 1000), isActive: true, featuredById: user.id } });
  const pinnedLooks = await read(sources[8]);
  equal(ids(pinnedLooks)[0], boundary.id, 'Scheduled curator pin precedes look completeness');
  equal(pinnedLooks[0].candidate.features.sourceOrder < pinnedLooks[1].candidate.features.sourceOrder,
    true, 'Look order survives candidate projection for composer');
  await prisma.featuredItem.delete({ where: { id: pin.id } });

  // Caller identities are isolated for both account and anonymous suppressions.
  const anon = 'fixture_anonymous_viewer_0001';
  const suppression = await prisma.userContentSuppression.create({ data: { anonymousSessionId: anon,
    targetType: 'DESIGN', targetId: design.id, sectionKey: 'fixture', suppressionType: 'HIDE_ITEM' } });
  equal((await read(sources[7], {}, { anonymousSessionId: anon })).length, 0, 'Anonymous owner suppression applied');
  equal(ids(await read(sources[7], {}, { userId: viewer.id })), [design.id], 'Anonymous suppression cannot affect account viewer');
  equal(ids(await read(sources[7], { suppressionMode: 'public_pool' }, { anonymousSessionId: anon })), [design.id], 'Public pool is viewer independent');
  await prisma.userContentSuppression.delete({ where: { id: suppression.id } });
  const hidden = await prisma.userContentSuppression.create({ data: { userId: viewer.id, targetType: 'PRODUCT',
    targetId: a.p.id, sectionKey: 'fixture', suppressionType: 'HIDE_ITEM' } });
  const current = await prisma.$transaction(tx => readCurrentPipelineSources(tx, capture), { isolationLevel: 'RepeatableRead', timeout: 10000 });
  equal(has(current, a.p.id), false, 'Final source gate applies new viewer suppression');
  equal(has(current, b.p.id), true, 'Final source gate preserves unrelated items in the section');
  await prisma.userContentSuppression.delete({ where: { id: hidden.id } });

  const alias = await prisma.tag.create({ data: { id: randomUUID(), normalizedName: 'fixture-alias',
    displayName: 'Fixture alias', status: 'APPROVED', aliasOfTagId: tag.id, createdById: user.id } });
  equal(has(await read(sources[0], { filters: { tags: ['fixture-alias'] } }), a.p.id), true, 'Approved product alias resolves canonical binding');
  equal(ids(await read(sources[7], { filters: { tags: ['fixture-alias'] } })), [design.id], 'Approved design alias resolves canonical binding');
  await prisma.tag.update({ where: { id: alias.id }, data: { isBanned: true } });
  equal((await read(sources[7], { filters: { tags: ['fixture-alias'] } })).length, 0, 'Banned alias fails closed');
  await prisma.tag.update({ where: { id: alias.id }, data: { isBanned: false } });
  await prisma.tag.update({ where: { id: tag.id }, data: { aliasOfTagId: alias.id } });
  equal((await read(sources[7], { filters: { tags: ['fixture-alias'] } })).length, 0, 'Alias cycle fails closed');
  await prisma.tag.update({ where: { id: tag.id }, data: { aliasOfTagId: null } });

  const alternateType = await prisma.collectionCategoryType.create({ data: { id: randomUUID(),
    categoryId: category.id, slug: 'alternate-garment', name: 'Alternate garment' } });
  const alternate = await addProduct({ categoryTypeId: alternateType.id });
  await prisma.productComplement.deleteMany({ where: { productId: a.p.id } });
  const fallback = await read({ kind: 'complements', productId: a.p.id });
  equal(has(fallback, alternate.p.id), true, 'Complement fallback includes same-category different garment type');
  equal(has(fallback, b.p.id), false, 'Complement fallback excludes same category and garment type');

  const batch = sources.map(source => { const input = request(source); return { key: pipelineRequestKey(input), request: input }; });
  const sql = pipelineBatchSourcesSql(batch, {});
  const parameters = sql.values.map(value => value instanceof Date ? value.toISOString() : value);
  const combined = await db.query(sql.text, parameters);
  equal(new Set(combined.rows.map(row => row.requestKey)).size, sources.length, 'All eleven source shapes execute as one batch');
  equal(combined.rows.every(row => batch.some(entry => entry.key === row.requestKey)), true, 'Batch rows retain caller request isolation');
  const plan = await db.query('EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + sql.text, parameters);
  assert(plan.rows[0]['QUERY PLAN'][0].Plan);
  plans++;
  console.log(`PLAN combined sources=${sources.length} rows=${combined.rows.length} executionMs=${plan.rows[0]['QUERY PLAN'][0]['Execution Time']}`);
  return { plans };
}
module.exports = { runPipelineTransitions };
