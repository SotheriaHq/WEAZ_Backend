const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { firstValueFrom, from } = require('rxjs');
const { CollectionsService } = require('../src/collections/collections.service');
const { guardContentReadResponse } = require('../src/auth/access/content-read-response');
const { readResourceContext } = require('../src/auth/access/read-resource-context');

module.exports = async ({ prisma, makeUser, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const indexes = await prisma.$queryRaw`SELECT indexname FROM pg_indexes WHERE tablename = 'Collection'
    AND indexname IN ('Collection_ownerId_status_createdAt__id_idx', 'Collection_ownerId_domain_status_createdAt__id_idx')`;
  assert.equal(indexes.length, 2, 'Fresh migrations must include both draft keyset indexes');
  const owner = await makeUser(), foreign = await makeUser();
  const at = new Date('2026-10-01T00:00:00.000Z');
  const service = Object.create(CollectionsService.prototype);
  let maximumConstraints = 0;
  Object.assign(service, { prisma, uploadService: { getBatchAuthorizedDisplayUrls: async ids => {
    assert(ids.length <= 100);
    maximumConstraints = Math.max(maximumConstraints, readResourceContext.getStore()?.resources.size ?? 0);
    return new Map(ids.map(id => [id, 'https://example.invalid/fixture-cover']));
  } } });
  const ids = Array.from({ length: 1005 }, () => randomUUID());
  await prisma.collection.createMany({ data: ids.map((id, index) => ({ id, ownerId: owner.actor.id,
    domain: 'DESIGN', title: `Bounded draft ${index}`, status: 'DRAFT', createdAt: at })) });
  const publishedTitle = 'Published title fixture';
  const hidden = randomUUID(), store = randomUUID(), foreignId = randomUUID();
  await prisma.collection.createMany({ data: [
    { id: randomUUID(), ownerId: owner.actor.id, domain: 'DESIGN', title: `\u00a0${publishedTitle}\u2009`, status: 'PUBLISHED', createdAt: at },
    { id: hidden, ownerId: owner.actor.id, domain: 'DESIGN', title: publishedTitle, status: 'DRAFT', createdAt: at },
    { id: store, ownerId: owner.actor.id, domain: 'STORE', title: 'Store draft fixture', status: 'DRAFT', createdAt: at },
    { id: foreignId, ownerId: foreign.actor.id, domain: 'DESIGN', title: 'Foreign fixture', status: 'DRAFT', createdAt: at },
  ] });
  const operation = { actor: owner.actor, method: 'GET', path: '/designs/my/drafts', route: '/designs/my/drafts', body: null,
    policy: { scope: 'SELF', sensitivity: 'ACCOUNT', action: 'account.access' }, requiredAdminPermissions: [],
    requestId: randomUUID(), operationDigest: 'draft-page-fixture' };
  const page = cursor => firstValueFrom(guardContentReadResponse(() => from(service.getMyDraftCollections(owner.actor.id,
    { cursor, limit: 100, domain: 'DESIGN' })), prisma, () => access.revalidateRead(operation), { user: owner.actor }, {}));
  const seen = [], cursors = new Set(); let cursor;
  do {
    const result = await page(cursor); assert(result.items.length <= 100);
    seen.push(...result.items.map(item => item.id));
    if (result.nextCursor) { assert(!cursors.has(result.nextCursor)); cursors.add(result.nextCursor); }
    cursor = result.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(seen.length, ids.length); assert.equal(new Set(seen).size, ids.length);
  assert.deepEqual([...seen].sort(), [...ids].sort()); assert(maximumConstraints <= 100);
  record('more than one thousand same-time drafts remain reachable across bounded owner pages without duplicates, foreign/store rows or response-witness overflow');
  record('draft pagination preserves published-title trimming/exclusion inside SQL instead of fetching an unbounded title list');

  const first = await page(); const anchor = first.items[first.items.length - 1];
  await prisma.collection.delete({ where: { id: anchor.id } });
  const following = await page(first.nextCursor);
  assert.equal(following.items.length, 100);
  assert(!following.items.some(item => first.items.some(old => old.id === item.id)));
  await assert.rejects(service.getMyDraftCollections(foreign.actor.id, { cursor: first.nextCursor }), error => error.getStatus() === 400);
  await assert.rejects(service.getMyDraftCollections(owner.actor.id, { limit: 101 }), error => error.getStatus() === 400);
  record('draft keyset pages survive deletion of their anchor and reject cross-account cursors and oversized requests');

  const coverOwner = await makeUser();
  const coverDraft = await prisma.collection.create({ data: { id: randomUUID(), ownerId: coverOwner.actor.id, domain: 'DESIGN',
    title: 'Cover fixture', status: 'DRAFT' } });
  const files = [];
  for (let index = 0; index < 2; index++) {
    const id = randomUUID();
    const file = await prisma.fileUpload.create({ data: { id, userId: coverOwner.actor.id, fileType: 'POST_IMAGE', mimeType: 'image/jpeg',
      originalName: 'cover.jpg', fileName: `${id}.jpg`, s3Key: `fixture-cover/${id}.jpg`, s3Url: 'https://example.invalid/cover', size: 100 } });
    const media = await prisma.collectionMedia.create({ data: { id: randomUUID(), collectionId: coverDraft.id, fileUploadId: file.id,
      mediaType: 'POST_IMAGE', orderIndex: index } });
    files.push({ file, media });
  }
  await prisma.collection.update({ where: { id: coverDraft.id }, data: { coverMediaId: files[1].media.id } });
  const coverPage = await service.getMyDraftCollections(coverOwner.actor.id, { domain: 'DESIGN' });
  assert.equal(coverPage.items[0].coverFileId, files[1].file.id); assert.equal(coverPage.items[0].itemCount, 2);
  assert.equal(coverPage.nextCursor, null);
  record('bounded draft cover lookup preserves an explicitly selected later photo and the full media count without hydrating every photo');
};
