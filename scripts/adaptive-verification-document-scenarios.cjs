const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { BrandVerificationService } = require('../src/brand-verification/brand-verification.service');
const { deleteOwnedFile } = require('../src/upload/file-deletion-query');

module.exports = async function verifyVerificationDocuments({ prisma, makeUser, record }) {
  const owner = await makeUser(), other = await makeUser();
  const events = [];
  const createService = (client = prisma) => new BrandVerificationService(client, {},
    { create: async (...args) => { events.push(args); } }, {}, {}, {});
  const service = createService();
  const setPending = () => prisma.brand.update({ where: { id: owner.brandId }, data: {
    verificationStatus: 'ADDITIONAL_INFO_REQUESTED', verificationReviewedById: other.actor.id,
  } });
  await setPending();
  async function file(overrides = {}) {
    const id = randomUUID();
    return prisma.fileUpload.create({ data: { id, userId: owner.actor.id, originalName: 'evidence.jpg',
      fileName: `${id}.jpg`, s3Key: `verification-document/${id}.jpg`, s3Url: `https://example.invalid/${id}`,
      fileType: 'BRAND_VERIFICATION', mimeType: 'image/jpeg', size: 100, processingStatus: 'READY', ...overrides } });
  }
  const originalEvidence = await Promise.all(Array.from({ length: 4 }, () => file()));
  await prisma.brandVerificationAttempt.create({ data: { id: randomUUID(), brandId: owner.brandId,
    attemptNumber: 1, status: 'ADDITIONAL_INFO_REQUESTED', authorityType: 'LEGAL_OWNER',
    idDocumentType: 'INTERNATIONAL_PASSPORT', ownerPhotoKey: originalEvidence[0].s3Key,
    idDocumentFrontKey: originalEvidence[1].s3Key, cacCertificateKey: originalEvidence[2].s3Key,
    letterOfConfirmationKey: originalEvidence[3].s3Key } });
  for (const correction of [{ ownerPhotoKey: '' }, { letterKey: null }, { idDocumentFrontKey: '  ' },
    { cacCertificateKey: null }, { idDocumentType: 'NATIONAL_ID' },
    { authorityType: 'AUTHORIZED_REPRESENTATIVE' }, { idDocumentType: null }, { authorityType: null }]) {
    await assert.rejects(() => service.resubmitInfo(owner.actor.id, correction), error => error.getStatus?.() === 400);
  }
  assert.equal(await prisma.brandVerificationAttempt.count({ where: { brandId: owner.brandId } }), 1);
  assert.equal(events.length, 0);
  record('corrections cannot clear required evidence or add a back-image/authority-proof requirement without the corresponding upload');
  const unavailable = [await file({ userId: other.actor.id }), await file({ fileType: 'POST_IMAGE' }),
    await file({ processingStatus: 'FAILED' }), await file({ originalDeletedAt: new Date() })];
  for (const upload of unavailable) {
    await assert.rejects(() => service.resubmitInfo(owner.actor.id, { letterKey: upload.s3Key }),
      error => error.getStatus?.() === 400);
  }
  assert.equal(await prisma.brandVerificationAttempt.count({ where: { brandId: owner.brandId } }), 1);
  assert.equal(events.length, 0);
  record('verification corrections reject foreign, wrong-type, failed and removed-original uploads without appending an attempt or sending notices');

  const pending = await file({ processingStatus: 'PENDING' });
  await service.resubmitInfo(owner.actor.id, { letterKey: pending.s3Key });
  const latest = await prisma.brandVerificationAttempt.findFirstOrThrow({ where: { brandId: owner.brandId }, orderBy: { attemptNumber: 'desc' } });
  assert.equal(latest.attemptNumber, 2);
  assert.equal(latest.letterOfConfirmationKey, pending.s3Key);
  assert(latest.evidenceManifest.some(entry => entry.fileId === pending.id));
  assert.equal(events.length, 1);
  await assert.rejects(() => prisma.$transaction(tx => deleteOwnedFile(tx, pending.id, owner.actor.id)),
    error => error.getStatus?.() === 400 && error.message === 'File is still in use');
  record('a correction snapshots validated evidence and retains an available original while asynchronous processing is pending');

  // Historical evidence remains valid after a genuine ownership transfer; an
  // arbitrary foreign replacement must not acquire that historical authority.
  await prisma.brand.delete({ where: { id: other.brandId } });
  await prisma.brand.update({ where: { id: owner.brandId }, data: { ownerId: other.actor.id,
    verificationStatus: 'ADDITIONAL_INFO_REQUESTED' } });
  await service.resubmitInfo(owner.brandId, { cacNumber: 'fixture-correction' });
  const carried = await prisma.brandVerificationAttempt.findFirstOrThrow({ where: { brandId: owner.brandId }, orderBy: { attemptNumber: 'desc' } });
  assert(carried.evidenceManifest.some(entry => entry.fileId === pending.id));
  await assert.rejects(() => prisma.$transaction(tx => deleteOwnedFile(tx, pending.id, owner.actor.id)),
    error => error.getStatus?.() === 400);
  record('a correction preserves exact previously validated evidence identity after brand ownership changes');
  await prisma.brand.update({ where: { id: owner.brandId }, data: { ownerId: owner.actor.id,
    verificationStatus: 'ADDITIONAL_INFO_REQUESTED' } });

  function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
  const settled = promise => promise.then(value => ({ value }), error => ({ error }));
  const reached = (barrier, work) => Promise.race([barrier.promise, work.then(outcome => {
    if (outcome.error) throw outcome.error;
    assert.fail('Document fixture completed before its barrier');
  })]);
  async function waiting(label) {
    const until = Date.now() + 10000;
    while (Date.now() < until) {
      const rows = await prisma.$queryRaw`SELECT 1 FROM pg_stat_activity WHERE application_name = ${label} AND wait_event_type = 'Lock'`;
      if (rows.length) return;
      await new Promise(done => setTimeout(done, 20));
    }
    assert.fail('Document operation did not reach the expected row lock');
  }
  function scoped(label, afterCreate) {
    return new Proxy(prisma, { get(target, name) {
      if (name === '$transaction') return (work, options) => target.$transaction(async tx => {
        await tx.$queryRaw`SELECT set_config('application_name', ${label}, true)`;
        return work(new Proxy(tx, { get(client, field) {
          if (field === 'brandVerificationAttempt' && afterCreate) return new Proxy(client.brandVerificationAttempt, { get(model, method) {
            if (method === 'create') return async args => { const value = await model.create(args); await afterCreate(); return value; };
            const value = Reflect.get(model, method); return typeof value === 'function' ? value.bind(model) : value;
          } });
          const value = Reflect.get(client, field); return typeof value === 'function' ? value.bind(client) : value;
        } }));
      }, { ...options, timeout: 20000 });
      const value = Reflect.get(target, name); return typeof value === 'function' ? value.bind(target) : value;
    } });
  }
  const attachFirst = await file(), entered = deferred(), release = deferred();
  const attachment = settled(createService(scoped('wiez-document-attach', async () => {
    entered.resolve(); await release.promise;
  })).resubmitInfo(owner.actor.id, { ownerPhotoKey: attachFirst.s3Key }));
  let deletion;
  try {
    await reached(entered, attachment);
    deletion = settled(prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT set_config('application_name', 'wiez-document-delete-second', true)`;
      return deleteOwnedFile(tx, attachFirst.id, owner.actor.id);
    }, { timeout: 20000 }));
    await waiting('wiez-document-delete-second');
  } finally { release.resolve(); }
  assert.equal((await attachment).error, undefined);
  assert.equal((await deletion).error?.getStatus?.(), 400);
  record('a verification attachment that wins the upload lock prevents concurrent owned-file deletion');

  await setPending();
  const deleteFirst = await file(), deleted = deferred(), allowDelete = deferred();
  const removal = settled(prisma.$transaction(async tx => {
    await deleteOwnedFile(tx, deleteFirst.id, owner.actor.id); deleted.resolve(); await allowDelete.promise;
  }, { timeout: 20000 }));
  let laterAttachment;
  try {
    await reached(deleted, removal);
    laterAttachment = settled(createService(scoped('wiez-document-attach-second')).resubmitInfo(owner.actor.id, { ownerPhotoKey: deleteFirst.s3Key }));
    await waiting('wiez-document-attach-second');
  } finally { allowDelete.resolve(); }
  assert.equal((await removal).error, undefined);
  assert.equal((await laterAttachment).error?.getStatus?.(), 400);
  assert.equal(await prisma.brandVerificationAttempt.count({ where: { ownerPhotoKey: deleteFirst.s3Key } }), 0);
  record('owned deletion that wins the upload lock prevents a later correction from referencing the removed document');

  const start = deferred(); let arrivals = 0;
  const concurrent = createService();
  const load = concurrent.getBrandByOwnerOrThrow.bind(concurrent);
  concurrent.getBrandByOwnerOrThrow = async id => {
    const brand = await load(id); if (++arrivals === 2) start.resolve(); await start.promise; return brand;
  };
  const before = await prisma.brandVerificationAttempt.count({ where: { brandId: owner.brandId } });
  const notices = events.length;
  const outcomes = await Promise.allSettled([concurrent.resubmitInfo(owner.actor.id, { cacNumber: 'A' }),
    concurrent.resubmitInfo(owner.actor.id, { cacNumber: 'B' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(outcomes.find(result => result.status === 'rejected').reason.getStatus(), 409);
  assert.equal(await prisma.brandVerificationAttempt.count({ where: { brandId: owner.brandId } }), before + 1);
  assert.equal(events.length, notices + 1);
  record('concurrent corrections append one attempt and one notice instead of overwriting review state');
};
