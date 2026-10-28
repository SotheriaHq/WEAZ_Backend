const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { StoreService } = require('../src/store/store.service');
const { retryProductCreation, isProductSlugConflict } = require('../src/store/product-creation-transaction');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

module.exports = async function verifyProductCreation({ prisma }) {
  const [database] = await prisma.$queryRaw`SELECT current_database() AS name`;
  assert(/^wiez_checkout_media_[a-f0-9]{32}$/.test(database.name));
  const cases = [], ownerId = randomUUID(), brandId = randomUUID();
  await prisma.user.create({ data: { id: ownerId, username: ownerId, email: `${ownerId}@example.invalid`, type: 'BRAND' } });
  await prisma.brand.create({ data: { id: brandId, ownerId, name: 'Product collision fixture' } });
  const collection = () => prisma.storeCollection.create({ data: { id: randomUUID(), ownerId, title: 'Creation fixture' } });
  const product = (tx, slug, collectionId, name = 'Draft collision fixture') => tx.product.create({ data: { id: randomUUID(), brandId, collectionId, name, slug, price: '100', isActive: false } });
  const membership = (tx, productId, collectionId) => tx.storeCollectionProduct.create({ data: { id: randomUUID(), productId, collectionId, isPrimary: true } });
  const firstCollection = await collection(), firstSlug = `collision-${randomUUID()}`;
  await product(prisma, firstSlug, null);
  let attempts = 0;
  const recovered = await retryProductCreation(attempt => prisma.$transaction(async tx => {
    attempts++;
    const side = await product(tx, `side-${firstSlug}-${attempt}`, firstCollection.id);
    await membership(tx, side.id, firstCollection.id);
    const result = await product(tx, attempt ? `${firstSlug}-${randomUUID()}` : firstSlug, firstCollection.id);
    await membership(tx, result.id, firstCollection.id);
    return result;
  }));
  assert.equal(attempts, 2);
  assert.equal(await prisma.product.count({ where: { slug: `side-${firstSlug}-0` } }), 0);
  assert.equal(await prisma.product.count({ where: { slug: `side-${firstSlug}-1` } }), 1);
  assert.equal(await prisma.storeCollectionProduct.count({ where: { collectionId: firstCollection.id } }), 2);
  assert.equal(recovered.collectionId, firstCollection.id);
  cases.push('a real Product.slug violation rolls back the entire attempt, including an earlier product and primary membership; a fresh transaction then commits a consistent retry');

  const parallelCollection = await collection(), parallelName = `Parallel ${randomUUID()}`, store = Object.create(StoreService.prototype);
  const ready = deferred(); let entered = 0, transactions = 0;
  const concurrent = await Promise.all(Array.from({ length: 5 }, (_, writer) => retryProductCreation(attempt => prisma.$transaction(async tx => {
    transactions++;
    const slug = attempt ? `${store.normalizeSlugBase(parallelName)}-${randomUUID()}` : await store.ensureUniqueProductSlug(tx, parallelName);
    if (!attempt) { if (++entered === 5) ready.resolve(); await ready.promise; }
    const side = await product(tx, `parallel-side-${parallelCollection.id}-${writer}-${attempt}`, parallelCollection.id, 'Parallel side effect');
    await membership(tx, side.id, parallelCollection.id);
    const created = await product(tx, slug, parallelCollection.id, parallelName);
    await membership(tx, created.id, parallelCollection.id);
    return created;
  }, { timeout: 10000 }))));
  assert.equal(new Set(concurrent.map(row => row.slug)).size, 5);
  assert.equal(await prisma.product.count({ where: { name: parallelName } }), 5);
  assert.equal(await prisma.storeCollectionProduct.count({ where: { collectionId: parallelCollection.id } }), 10);
  assert.equal(transactions, 9);
  cases.push('five real concurrent first attempts select the same available slug; four losers restart with UUID suffixes and commit five products with exactly ten intended memberships');

  let unrelatedAttempts = 0;
  await assert.rejects(retryProductCreation(() => prisma.$transaction(async tx => {
    unrelatedAttempts++;
    await product(tx, `unrelated-side-${firstSlug}`, null);
    await tx.product.create({ data: { id: recovered.id, brandId, name: 'Duplicate identity', price: '100' } });
  })), error => error.code === 'P2002' && !isProductSlugConflict(error));
  assert.equal(unrelatedAttempts, 1); assert.equal(await prisma.product.count({ where: { slug: `unrelated-side-${firstSlug}` } }), 0);
  cases.push('an unrelated Product primary-key conflict is not mistaken for a slug race and is not retried; its earlier write rolls back');

  let exhaustedAttempts = 0;
  await assert.rejects(retryProductCreation(() => prisma.$transaction(async tx => {
    exhaustedAttempts++;
    await product(tx, `exhausted-side-${firstSlug}-${exhaustedAttempts}`, null);
    await product(tx, firstSlug, null);
  })), error => isProductSlugConflict(error));
  assert.equal(exhaustedAttempts, 3);
  assert.equal(await prisma.product.count({ where: { slug: { startsWith: `exhausted-side-${firstSlug}` } } }), 0);
  cases.push('repeated real slug collisions stop after three complete attempts and leave no partial records');
  const invalidId = randomUUID();
  await assert.rejects(prisma.$transaction(tx => tx.product.create({ data: {
    id: invalidId, brandId, collectionId: firstCollection.id, name: 'Invalid primary projection', price: '100', isActive: false,
  } })), error => JSON.stringify([error.message, error.meta]).includes('PRODUCT_PRIMARY_COLLECTION_PROJECTION_MISMATCH'));
  assert.equal(await prisma.product.count({ where: { id: invalidId } }), 0);
  cases.push('valid product and membership inserts no longer access a wrong-table trigger field, while an inconsistent primary pointer is still rejected and rolled back');
  return { cases, externalProviderCalls: 0 };
};
