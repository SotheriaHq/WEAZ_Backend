const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { Module, Controller, Get, Req, UseGuards } = require('@nestjs/common');
const { NestFactory, Reflector } = require('@nestjs/core');
const { S3Client } = require('@aws-sdk/client-s3');
const { UploadController } = require('../src/upload/upload.controller');
const { UploadService } = require('../src/upload/upload.service');
const { MediaProcessingService } = require('../src/media-processing/media-processing.service');
const { BrandPermissionService } = require('../src/brands/permissions/brand-permission.service');
const { JwtAuthGuard } = require('../src/auth/guard/jwt-auth.guard');
const { JwtStrategy } = require('../src/auth/strategy/jwt.strategy');
const { AdaptiveAccessInterceptor } = require('../src/auth/access/adaptive-access.interceptor');
const { SessionRiskService } = require('../src/auth/access/session-risk.service');
const { RequirePermissions } = require('../src/admin/decorators/require-permissions.decorator');
const { CollectionsService } = require('../src/collections/collections.service');
const { IsPublic } = require('../src/auth/decorator/is-public.decorator');
const { OptionalJwtAuthGuard } = require('../src/auth/guard/optional-jwt-auth.guard');

module.exports = async ({ prisma, makeUser, tokenService, access, record }) => {
  assert(/^wiez_adaptive_test_[a-f0-9]{32}$/.test((await prisma.$queryRaw`SELECT current_database() AS name`)[0].name));
  const owner = await makeUser(), viewer = await makeUser();
  // Presigning uses static fixture credentials and a non-routable endpoint;
  // it is local signature computation. No object/provider HTTP is performed.
  const s3 = new S3Client({ region: 'auto', endpoint: 'https://storage.example.invalid',
    forcePathStyle: true, credentials: { accessKeyId: 'fixture', secretAccessKey: 'fixture' },
    requestHandler: { async handle() { throw Error('Provider HTTP is prohibited in file signing fixtures'); }, destroy() {} } });
  let gate = null;
  const service = Object.create(UploadService.prototype);
  Object.assign(service, { prisma, configService: tokenService.configService, s3,
    bucketName: 'fixture', brandPermissions: new BrandPermissionService(prisma),
    logger: { warn() {} }, getStablePublicDisplayUrl: () => null });
  for (const method of ['getPublicSignedUrl', 'getSignedUrl', 'getBatchPublicSignedUrls', 'getSignedUrlByKeyForUser', 'getFileVariants',
    'getVerificationReviewSignedUrlsByKey', 'getBatchAuthorizedDisplayUrls', 'getBatchVariantDisplayUrls', 'getBatchSignedUrlsBySource']) {
    service[method] = async (...args) => {
      const result = await UploadService.prototype[method].apply(service, args);
      if (gate && (!gate.method || gate.method === method)) { const current = gate; current.enter(); await current.release; }
      return result;
    };
  }
  // A minimal permission-decorated HTTP host for the real review signer.
  // This does not stand in for full brand-verification controller acceptance.
  class ReviewFixture {
    async evidence(request) { return { urls: [...await service.getVerificationReviewSignedUrlsByKey([request.query.key])] }; }
    async variants(request) { return { urls: [...await service.getBatchVariantDisplayUrls([request.query.fileId], 'CARD')] }; }
  }
  Controller('admin/fixture-file-review')(ReviewFixture);
  const reviewDescriptor = Object.getOwnPropertyDescriptor(ReviewFixture.prototype, 'evidence');
  Get()(ReviewFixture.prototype, 'evidence', reviewDescriptor);
  RequirePermissions('brands.verify')(ReviewFixture.prototype, 'evidence', reviewDescriptor);
  Req()(ReviewFixture.prototype, 'evidence', 0);
  const reviewVariantDescriptor = Object.getOwnPropertyDescriptor(ReviewFixture.prototype, 'variants');
  Get('variants')(ReviewFixture.prototype, 'variants', reviewVariantDescriptor);
  RequirePermissions('brands.verify')(ReviewFixture.prototype, 'variants', reviewVariantDescriptor);
  Req()(ReviewFixture.prototype, 'variants', 0);
  const catalog = Object.create(CollectionsService.prototype);
  Object.assign(catalog, { prisma, uploadService: service });
  class CatalogFixture {
    drafts(request) { return catalog.getMyDraftCollections(request.user.id); }
    async draftVariants(request) {
      const { items } = await catalog.getMyDraftCollections(request.user.id);
      return { urls: [...await service.getBatchVariantDisplayUrls(items.map(item => item.coverFileId).filter(Boolean), 'CARD')] };
    }
    async variants(request) { return { urls: [...await service.getBatchVariantDisplayUrls([request.params.fileId], 'CARD')] }; }
  }
  Controller('fixture-owned-catalog')(CatalogFixture);
  const draftDescriptor = Object.getOwnPropertyDescriptor(CatalogFixture.prototype, 'drafts');
  Get('drafts')(CatalogFixture.prototype, 'drafts', draftDescriptor);
  Req()(CatalogFixture.prototype, 'drafts', 0);
  const draftVariantDescriptor = Object.getOwnPropertyDescriptor(CatalogFixture.prototype, 'draftVariants');
  Get('draft-variants')(CatalogFixture.prototype, 'draftVariants', draftVariantDescriptor);
  Req()(CatalogFixture.prototype, 'draftVariants', 0);
  const variantDescriptor = Object.getOwnPropertyDescriptor(CatalogFixture.prototype, 'variants');
  Get('variants/:fileId')(CatalogFixture.prototype, 'variants', variantDescriptor);
  IsPublic()(CatalogFixture.prototype, 'variants', variantDescriptor);
  UseGuards(OptionalJwtAuthGuard)(CatalogFixture.prototype, 'variants', variantDescriptor);
  Req()(CatalogFixture.prototype, 'variants', 0);
  class FixtureModule {}
  Module({ controllers: [UploadController, ReviewFixture, CatalogFixture], providers: [
    { provide: UploadService, useValue: service }, { provide: MediaProcessingService, useValue: {} },
  ] })(FixtureModule);
  const risk = new SessionRiskService(prisma, tokenService.configService);
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.useGlobalGuards(new JwtAuthGuard(new Reflector()));
  app.useGlobalInterceptors(new AdaptiveAccessInterceptor(new Reflector(), prisma, risk, access));
  new JwtStrategy(prisma, tokenService.configService);
  const makeFile = (isPublic = false) => {
    const id = randomUUID(), s3Key = `POST_IMAGE/${owner.actor.id}/${id}.jpg`;
    return prisma.fileUpload.create({ data: { id, userId: owner.actor.id, originalName: 'fixture.jpg', fileName: `${id}.jpg`,
      s3Key, s3Url: `https://storage.example.invalid/fixture/${s3Key}`, fileType: 'POST_IMAGE',
      mimeType: 'image/jpeg', size: 100, processingStatus: 'READY', assetVersion: 1, isPublic } });
  };
  try {
    await app.listen(0, '127.0.0.1');
    const base = `http://127.0.0.1:${app.getHttpServer().address().port}/uploads`;
    const get = (path, token) => fetch(`${base}/${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000) });
    const during = async (request, change, method) => {
      let enter, release;
      const entered = new Promise(resolve => { enter = resolve; });
      gate = { enter, method, release: new Promise(resolve => { release = resolve; }) };
      const response = request(); let timer;
      try {
        await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('File response barrier not reached')), 10000); })]);
        await change();
      } finally { clearTimeout(timer); gate = null; release(); }
      return response;
    };
    const withheld = async response => { assert.equal(response.status, 403); assert(!(await response.text()).includes('storage.example.invalid')); };
    const publicFile = await makeFile(true);
    assert.equal((await get(`public-url/${publicFile.id}`)).status, 200);
    await withheld(await during(() => get(`public-url/${publicFile.id}`),
      () => prisma.fileUpload.update({ where: { id: publicFile.id }, data: { isPublic: false } })));
    record('actual public upload URL controller refuses a file made private during local signature computation');
    const linkedFile = await makeFile();
    const design = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
      status: 'PUBLISHED', visibility: 'PUBLIC' } });
    await prisma.collectionMedia.create({ data: { id: randomUUID(), collectionId: design.id, fileUploadId: linkedFile.id,
      orderIndex: 0, viewSlot: 'FRONT', mediaType: 'POST_IMAGE' } });
    assert.equal((await get(`public-url/${linkedFile.id}`)).status, 200);
    await withheld(await during(() => get(`public-url/${linkedFile.id}`),
      () => prisma.collection.update({ where: { id: design.id }, data: { visibility: 'PRIVATE' } })));
    const grant = await prisma.collectionAccess.create({ data: { id: randomUUID(), collectionId: design.id,
      viewerId: viewer.actor.id, state: 'APPROVED' } });
    assert.equal((await get(`signed-url/${linkedFile.id}`, viewer.tokens.accessToken)).status, 200);
    await withheld(await during(() => get(`signed-url/${linkedFile.id}`, viewer.tokens.accessToken),
      () => prisma.collectionAccess.update({ where: { id: grant.id }, data: { state: 'REVOKED' } })));
    assert.equal((await get(`signed-url/${linkedFile.id}`, owner.tokens.accessToken)).status, 200);
    record('actual file signer rechecks publication and approved private-view grants with real SQL while owner access remains available');
    const variant = await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: linkedFile.id,
      variantKind: 'CARD', format: 'WEBP', width: 100, height: 100, sizeBytes: 80, quality: 95,
      s3Key: `${linkedFile.s3Key}/card`, s3Url: 'https://storage.example.invalid/variant', assetVersion: 1 } });
    await withheld(await during(() => get(`signed-url-by-key?key=${encodeURIComponent(variant.s3Key)}`, owner.tokens.accessToken),
      () => prisma.fileVariant.delete({ where: { id: variant.id } })));
    record('actual authenticated key signer withholds a variant deleted after parent-file authorization');
    const previewVariant = await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: linkedFile.id,
      variantKind: 'CARD', format: 'WEBP', width: 100, height: 100, sizeBytes: 80, quality: 95,
      s3Key: `${linkedFile.s3Key}/preview`, s3Url: 'https://storage.example.invalid/variant', assetVersion: 1 } });
    const preview = await get(`${linkedFile.id}/variants`, owner.tokens.accessToken);
    assert.equal(preview.status, 200); assert((await preview.json()).variants.card.url);
    await withheld(await during(() => get(`${linkedFile.id}/variants`, owner.tokens.accessToken),
      () => prisma.fileVariant.delete({ where: { id: previewVariant.id } })));
    record('actual owner variant endpoint preserves previews and withholds a variant removed before response delivery');
    const admin = await makeUser('SuperAdmin');
    assert.equal((await get(`signed-url/${linkedFile.id}`, admin.tokens.accessToken)).status, 428);
    await prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: {
      strongAuthenticatedAt: new Date(), strongAuthVersion: admin.actor.authVersion,
    } });
    assert.equal((await get(`signed-url/${linkedFile.id}`, admin.tokens.accessToken)).status, 200);
    const expiredAdmin = await during(() => get(`signed-url/${linkedFile.id}`, admin.tokens.accessToken),
      () => prisma.refreshToken.update({ where: { id: admin.actor.sid }, data: {
        strongAuthenticatedAt: new Date(Date.now() - 301_000),
      } }));
    assert.equal(expiredAdmin.status, 428); assert(!(await expiredAdmin.text()).includes('storage.example.invalid'));
    record('actual admin file lookup requires strong authentication and rechecks its five-minute viewing window before delivering the link');
    const reviewer = await makeUser('Admin'), evidenceFile = await makeFile();
    await prisma.fileUpload.update({ where: { id: evidenceFile.id }, data: { fileType: 'BRAND_VERIFICATION' } });
    await prisma.brandVerificationAttempt.create({ data: { id: randomUUID(), brandId: owner.brandId,
      attemptNumber: 1, status: 'IN_REVIEW', ownerPhotoKey: evidenceFile.s3Key } });
    const review = token => fetch(`${base.replace(/\/uploads$/, '')}/admin/fixture-file-review?key=${encodeURIComponent(evidenceFile.s3Key)}`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000) });
    assert.equal((await review(owner.tokens.accessToken)).status, 403);
    assert.equal((await review(reviewer.tokens.accessToken)).status, 403);
    const permission = await prisma.adminPermissionGrant.create({ data: { id: randomUUID(), userId: reviewer.actor.id,
      permissionCode: 'brands.verify', grantedById: admin.actor.id } });
    assert.equal((await review(reviewer.tokens.accessToken)).status, 428);
    await prisma.refreshToken.update({ where: { id: reviewer.actor.sid }, data: {
      strongAuthenticatedAt: new Date(), strongAuthVersion: reviewer.actor.authVersion,
    } });
    assert.equal((await review(reviewer.tokens.accessToken)).status, 200);
    const evidenceVariant = await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: evidenceFile.id,
      variantKind: 'CARD', format: 'WEBP', width: 100, height: 100, sizeBytes: 80, quality: 95,
      s3Key: `${evidenceFile.s3Key}/evidence-preview`, s3Url: 'https://storage.example.invalid/variant', assetVersion: 1 } });
    const reviewVariants = () => fetch(`${base.replace(/\/uploads$/, '')}/admin/fixture-file-review/variants?fileId=${evidenceFile.id}`,
      { headers: { authorization: `Bearer ${reviewer.tokens.accessToken}` }, signal: AbortSignal.timeout(15000) });
    const reviewedVariant = await reviewVariants(); assert.equal(reviewedVariant.status, 200);
    assert.equal((await reviewedVariant.json()).urls.length, 1);
    await withheld(await during(reviewVariants,
      () => prisma.adminPermissionGrant.delete({ where: { id: permission.id } }), 'getBatchVariantDisplayUrls'));
    await prisma.adminPermissionGrant.create({ data: permission });
    await prisma.fileVariant.delete({ where: { id: evidenceVariant.id } });
    record('real standalone review variants require the guarded administrator operation and current review permission at delivery');
    await withheld(await during(() => review(reviewer.tokens.accessToken),
      () => prisma.fileUpload.update({ where: { id: evidenceFile.id }, data: { processingStatus: 'FAILED' } })));
    await prisma.fileUpload.update({ where: { id: evidenceFile.id }, data: { processingStatus: 'READY' } });
    await withheld(await during(() => review(reviewer.tokens.accessToken),
      () => prisma.fileUpload.update({ where: { id: evidenceFile.id }, data: { fileType: 'MESSAGE_DOCUMENT' } })));
    await prisma.fileUpload.update({ where: { id: evidenceFile.id }, data: { fileType: 'BRAND_VERIFICATION' } });
    await withheld(await during(() => review(reviewer.tokens.accessToken),
      () => prisma.adminPermissionGrant.delete({ where: { id: permission.id } })));
    record('real verification-document signer rechecks file availability, evidence type and current review permission in a permission-decorated HTTP fixture');
    await require('./adaptive-admin-file-scenarios.cjs')({ prisma, makeUser, record, service, base, get, during, withheld, owner, admin, makeFile });
    const draftFile = await makeFile();
    await prisma.fileUpload.update({ where: { id: draftFile.id }, data: { userId: viewer.actor.id } });
    const draft = await prisma.collection.create({ data: { id: randomUUID(), ownerId: owner.actor.id,
      status: 'DRAFT', visibility: 'PRIVATE' } });
    const draftMedia = await prisma.collectionMedia.create({ data: { id: randomUUID(), collectionId: draft.id,
      fileUploadId: draftFile.id, orderIndex: 0, viewSlot: 'FRONT', mediaType: 'POST_IMAGE' } });
    const ownDrafts = () => fetch(`${base.replace(/\/uploads$/, '')}/fixture-owned-catalog/drafts`,
      { headers: { authorization: `Bearer ${owner.tokens.accessToken}` }, signal: AbortSignal.timeout(15000) });
    const draftResponse = await ownDrafts(); assert.equal(draftResponse.status, 200);
    assert((await draftResponse.json()).items.find(item => item.id === draft.id).coverImage);
    await withheld(await during(ownDrafts,
      () => prisma.collection.update({ where: { id: draft.id }, data: { ownerId: viewer.actor.id } })));
    await prisma.collection.update({ where: { id: draft.id }, data: { ownerId: owner.actor.id } });
    await withheld(await during(ownDrafts, () => prisma.collectionMedia.delete({ where: { id: draftMedia.id } })));
    record('actual owned draft-list service preserves another uploader while rechecking current design ownership and file association');
    await prisma.collectionMedia.create({ data: draftMedia });
    const staffVariant = await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: draftFile.id,
      variantKind: 'CARD', format: 'WEBP', width: 100, height: 100, sizeBytes: 80, quality: 95,
      s3Key: `${draftFile.s3Key}/staff-preview`, s3Url: 'https://storage.example.invalid/variant', assetVersion: 1 } });
    const ownVariant = () => fetch(`${base.replace(/\/uploads$/, '')}/fixture-owned-catalog/draft-variants`,
      { headers: { authorization: `Bearer ${owner.tokens.accessToken}` }, signal: AbortSignal.timeout(15000) });
    const staffPreview = await ownVariant(); assert.equal(staffPreview.status, 200);
    assert.equal((await staffPreview.json()).urls.length, 1);
    await withheld(await during(ownVariant,
      () => prisma.fileVariant.delete({ where: { id: staffVariant.id } }), 'getBatchVariantDisplayUrls'));
    record('real catalogue variants inherit current draft ownership rather than uploader identity and reject a removed variant before delivery');
    const standalone = await makeFile(true);
    await prisma.fileVariant.create({ data: { id: randomUUID(), fileUploadId: standalone.id,
      variantKind: 'CARD', format: 'WEBP', width: 100, height: 100, sizeBytes: 80, quality: 95,
      s3Key: `${standalone.s3Key}/public-card`, s3Url: 'https://storage.example.invalid/variant', assetVersion: 1 } });
    const variantRead = token => fetch(`${base.replace(/\/uploads$/, '')}/fixture-owned-catalog/variants/${standalone.id}`,
      { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(15000) });
    const publicPreview = await variantRead(); assert.equal(publicPreview.status, 200);
    assert.equal((await publicPreview.json()).urls.length, 1);
    await withheld(await during(variantRead,
      () => prisma.fileUpload.update({ where: { id: standalone.id }, data: { isPublic: false } }), 'getBatchVariantDisplayUrls'));
    for (const token of [undefined, admin.tokens.accessToken]) {
      const deniedVariant = await variantRead(token); assert.equal(deniedVariant.status, 200);
      assert.deepEqual((await deniedVariant.json()).urls, []);
    }
    record('real optional-auth standalone variants recheck public withdrawal and never grant a private file to an anonymous viewer or a bare admin role');
    const files = await Promise.all([makeFile(true), makeFile(true)]);
    const post = () => fetch(`${base}/public-urls`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ fileIds: files.map(file => file.id) }), signal: AbortSignal.timeout(15000) });
    assert.equal((await post()).status, 200);
    await withheld(await during(post, () => prisma.fileUpload.update({ where: { id: files[1].id }, data: { processingStatus: 'FAILED' } })));
    record('actual public batch POST signer rechecks all file availability decisions and returns no signed URLs when one is revoked');
    const versioned = await makeFile(true);
    await withheld(await during(() => get(`public-url/${versioned.id}`),
      () => prisma.fileUpload.update({ where: { id: versioned.id }, data: { assetVersion: { increment: 1 } } })));
    record('actual file signer rejects an asset replaced while the old version URL is being prepared');
    const owned = await makeFile();
    const revoked = await during(() => get(`signed-url/${owned.id}`, owner.tokens.accessToken),
      () => prisma.refreshToken.delete({ where: { id: owner.actor.sid } }));
    assert.equal(revoked.status, 401); assert(!(await revoked.text()).includes('storage.example.invalid'));
    record('actual private file signer still checks current session authority after revalidating file access');
  } finally { gate?.enter(); gate = null; await app.close(); await risk.onModuleDestroy(); s3.destroy(); }
};
