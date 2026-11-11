import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { defer, firstValueFrom } from 'rxjs';
import { UploadService } from './upload.service';
import { guardContentReadResponse } from 'src/auth/access/content-read-response';
import { assertCurrentFileReads } from 'src/common/file-read-response-access';
import { readResourceContext, rememberReadResource, type FileReadResource } from 'src/auth/access/read-resource-context';
import { classifyAdaptiveAction } from 'src/auth/access/adaptive-action-policy';
import { securityRequestContext, createSecurityLease } from 'src/auth/access/security-request-context';
import type { AdaptiveOperation } from 'src/auth/access/adaptive-access.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn().mockResolvedValue('https://fixture.invalid/private') }));

describe('file read authorization at response delivery', () => {
  it.each(['Admin', 'SuperAdmin'])('requires current strong authentication for %s media lookups', actorRole => {
    for (const [method, route] of [['GET', '/uploads/signed-url/:fileId'], ['HEAD', '/uploads/signed-url-by-key'],
      ['GET', '/uploads/:fileId/variants'], ['POST', '/uploads/signed-urls-by-source']]) {
      expect(classifyAdaptiveAction(method, route, {}, { enrolledMfa: false, actorRole }))
        .toEqual({ scope: 'ADMIN', action: 'admin.media.read', sensitivity: 'SENSITIVE_READ' });
      expect(classifyAdaptiveAction(method, route).sensitivity).toBe('ACCOUNT');
    }
    expect(classifyAdaptiveAction('GET', '/uploads/public-url/:fileId', {}, { enrolledMfa: false, actorRole })
      .sensitivity).toBe('ACCOUNT');
  });
  const fixture = () => {
    const file = { id: randomUUID(), userId: randomUUID(), s3Key: 'POST_IMAGE/fixture/photo.jpg', assetVersion: 1,
      processingStatus: 'READY', originalDeletedAt: null as Date | null, fileType: 'POST_IMAGE', isPublic: true,
      collectionMedias: [], productMedias: [], userProfileImages: [], userProfileBanners: [] };
    const prisma = { fileUpload: { findUnique: jest.fn(async () => ({ ...file })),
      findFirst: jest.fn(async () => ({ ...file })), findMany: jest.fn(async () => [{ ...file }]) },
      fileVariant: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) }, $queryRaw: jest.fn().mockResolvedValue([]) };
    const service = Object.create(UploadService.prototype) as UploadService;
    Object.assign(service, { prisma, configService: new ConfigService({ FEATURE_PRIVATE_COLLECTIONS: 'true' }),
      bucketName: 'fixture', s3: {}, logger: { warn: jest.fn() },
      getStablePublicDisplayUrl: () => 'https://fixture.invalid/public' });
    const actor = jest.fn(async () => undefined);
    const read = (load: () => Promise<unknown>, change = () => undefined, user?: { id: string; role?: string }) =>
      firstValueFrom(guardContentReadResponse(() => defer(async () => {
        const value = await load(); change(); return value;
      }), prisma as any, actor, { user }, {}));
    return { file, prisma, service, actor, read };
  };

  it('registers actual public URL reads and denies a public file made private before delivery', async () => {
    const { file, service, actor, read } = fixture();
    await expect(read(() => service.getPublicSignedUrl(file.id), () => { file.isPublic = false; }))
      .rejects.toMatchObject({ status: 403 });
    expect(actor).not.toHaveBeenCalled();
  });

  it.each(['deleted', 'failed', 'replaced'] as const)('denies a stored file %s after signing', async change => {
    const { file, service, read } = fixture();
    await expect(read(() => service.getPublicSignedUrl(file.id), () => {
      if (change === 'deleted') file.originalDeletedAt = new Date();
      if (change === 'failed') file.processingStatus = 'FAILED';
      if (change === 'replaced') file.assetVersion++;
    })).rejects.toMatchObject({ status: 403 });
  });

  it('preserves owner access to private drafts and checks the actor last', async () => {
    const { file, service, actor, read, prisma } = fixture(); file.isPublic = false;
    await expect(read(() => service.getSignedUrl(file.id, file.userId, 'User'))).resolves.toBe('https://fixture.invalid/private');
    expect(actor).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(['Admin', 'SuperAdmin'])('does not trust a supplied %s role as a private-file grant', async role => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    await expect(read(() => service.getSignedUrl(file.id, randomUUID(), role)))
      .rejects.toMatchObject({ status: 400 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw.mock.calls[1][0].text).toContain('"AdminPermissionGrant"');
  });

  it('withholds an administrator file if its specific grant is withdrawn during signing', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    let permitted = true;
    prisma.$queryRaw.mockImplementation(async (query: any) =>
      query.text.includes('WITH rights') && permitted ? [{ id: file.id }] : []);
    await expect(read(() => service.getSignedUrl(file.id, randomUUID(), 'Admin'), () => { permitted = false; }))
      .rejects.toMatchObject({ status: 403 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('rechecks shared private-file grants through the same SQL policy before emission', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    prisma.$queryRaw.mockResolvedValueOnce([{ id: file.id }]);
    await expect(read(() => service.getSignedUrl(file.id, randomUUID(), 'User'))).rejects.toMatchObject({ status: 403 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('denies a variant removed after its parent was authorized', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    prisma.fileUpload.findUnique.mockResolvedValue(null as never);
    prisma.fileVariant.findFirst.mockResolvedValue({ s3Key: 'variant/thumb.webp', assetVersion: 1, file });
    await expect(read(() => service.getSignedUrlByKeyForUser('variant/thumb.webp', { id: file.userId })))
      .rejects.toMatchObject({ status: 403 });
    expect(prisma.fileVariant.findMany).toHaveBeenCalledTimes(1);
  });

  it('batch public URL delivery uses two file reads, not one query per returned photo', async () => {
    const { file, service, read, prisma } = fixture();
    const files = Array.from({ length: 50 }, () => ({ ...file, id: randomUUID() }));
    prisma.fileUpload.findMany.mockImplementation(async () => files);
    const result = await read(() => service.getBatchPublicSignedUrls(files.map(entry => entry.id)));
    expect((result as Map<string, string>).size).toBe(50);
    expect(prisma.fileUpload.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.fileUpload.findUnique).not.toHaveBeenCalled();
  });

  it('preserves owner variant previews while rechecking the selected variant and original', async () => {
    const { file, service, prisma, read, actor } = fixture(); file.isPublic = false;
    prisma.fileVariant.findMany.mockResolvedValue([{ fileUploadId: file.id, s3Key: 'variant/card.webp',
      assetVersion: 1, variantKind: 'CARD', format: 'WEBP', width: 640, height: 800 }] as never);
    Object.assign(service, { getTemporarySignedDisplayUrl: jest.fn(async () => 'https://fixture.invalid/variant') });
    await expect(read(() => service.getFileVariants(file.id, file.userId)))
      .resolves.toMatchObject({ fileId: file.id, variants: { card: { url: 'https://fixture.invalid/variant' } } });
    expect(prisma.fileVariant.findMany).toHaveBeenCalledTimes(2);
    expect(actor).toHaveBeenCalledTimes(1);
  });

  it('denies owner variant previews when their active variant is removed during signing', async () => {
    const { file, service, prisma, read } = fixture(); file.isPublic = false;
    prisma.fileVariant.findMany.mockResolvedValueOnce([{ fileUploadId: file.id, s3Key: 'variant/card.webp',
      assetVersion: 1, variantKind: 'CARD', format: 'WEBP', width: 640, height: 800 }] as never);
    Object.assign(service, { getTemporarySignedDisplayUrl: jest.fn(async () => 'https://fixture.invalid/variant') });
    await expect(read(() => service.getFileVariants(file.id, file.userId))).rejects.toMatchObject({ status: 403 });
  });

  it('returns failed owner-file processing metadata without attempting to sign a link', async () => {
    const { file, service, prisma, read } = fixture(); file.processingStatus = 'FAILED';
    const sign = jest.fn(); Object.assign(service, { getTemporarySignedDisplayUrl: sign });
    await expect(read(() => service.getFileVariants(file.id, file.userId)))
      .resolves.toMatchObject({ processingStatus: 'FAILED', variants: {}, fallbackUrl: null });
    expect(sign).not.toHaveBeenCalled();
    expect(prisma.fileVariant.findMany).not.toHaveBeenCalled();
  });

  it('rechecks private verification evidence using the actual review actor', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false; file.fileType = 'BRAND_VERIFICATION';
    prisma.$queryRaw.mockImplementation(async (query: any) => query.text.includes('WITH rights') ? [{ id: file.id }] : []);
    const operation: AdaptiveOperation = { actor: { id: randomUUID(), sid: randomUUID(), authVersion: 1, role: 'Admin' },
      policy: { scope: 'ADMIN', sensitivity: 'SENSITIVE_READ', action: 'admin.access' },
      method: 'GET', path: '/admin/brands/fixture/verification', route: '/admin/brands/:id/verification',
      body: null, requiredAdminPermissions: ['brands.verify'], requestId: randomUUID(), operationDigest: 'fixture' };
    await securityRequestContext.run({ operation, request: createSecurityLease() }, async () => {
      await expect(read(() => service.getVerificationReviewSignedUrlByKey(file.s3Key)))
        .resolves.toBe('https://fixture.invalid/private');
      await expect(read(() => service.getVerificationReviewSignedUrlsByKey([file.s3Key]),
        () => { file.processingStatus = 'FAILED'; })).rejects.toMatchObject({ status: 403 });
      file.processingStatus = 'READY';
      await expect(read(() => service.getVerificationReviewSignedUrlsByKey([file.s3Key]),
        () => { file.fileType = 'MESSAGE_DOCUMENT'; })).rejects.toMatchObject({ status: 403 });
    });
  });

  it('preserves a draft owner preview when its media was uploaded by another user', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    const id = randomUUID(), viewer = randomUUID();
    file.collectionMedias = [{ collection: { id } }] as never;
    Object.assign(prisma, { collection: { findMany: jest.fn().mockResolvedValue([
      { id, ownerId: viewer, status: 'DRAFT', visibility: 'PRIVATE', deletedAt: null },
    ]) } });
    await expect(read(() => service.getBatchAuthorizedDisplayUrls([file.id], [
      { fileId: file.id, source: { type: 'COLLECTION', id, viewer } },
    ]))).resolves.toBeInstanceOf(Map);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('withholds a trusted list file detached from the authorized design during signing', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    const id = randomUUID(); file.collectionMedias = [{ collection: { id } }] as never;
    Object.assign(prisma, { collection: { findMany: jest.fn().mockResolvedValue([
      { id, ownerId: file.userId, status: 'DRAFT', visibility: 'PRIVATE', deletedAt: null },
    ]) } });
    await expect(read(() => service.getBatchAuthorizedDisplayUrls([file.id], [
      { fileId: file.id, source: { type: 'COLLECTION', id, viewer: file.userId } },
    ]), () => { file.collectionMedias = []; })).rejects.toMatchObject({ status: 403 });
  });

  it('does not treat a trusted private batch as unrestricted file signing inside a read', async () => {
    const { file, service, read } = fixture(); file.isPublic = false;
    await expect(read(() => service.getBatchAuthorizedDisplayUrls([file.id])))
      .rejects.toMatchObject({ status: 403 });
  });

  it('checks product file-ID references in batches while preserving a different uploader', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    const productId = randomUUID(), viewer = randomUUID();
    const files = Array.from({ length: 50 }, () => ({ ...file, id: randomUUID() }));
    prisma.fileUpload.findMany.mockImplementation(async () => files);
    const product = { id: productId, thumbnail: null, images: files.map(entry => entry.id),
      brand: { ownerId: viewer }, isActive: true, archivedAt: null, deletedAt: null, publishAt: null };
    const productRead = jest.fn(async () => [{ ...product }]);
    Object.assign(prisma, { product: { findMany: productRead } });
    const authorizations = files.map(entry => ({ fileId: entry.id,
      source: { type: 'PRODUCT' as const, id: productId, viewer } }));
    await expect(read(() => service.getBatchAuthorizedDisplayUrls(files.map(entry => entry.id), authorizations)))
      .resolves.toHaveProperty('size', 50);
    expect(prisma.fileUpload.findMany).toHaveBeenCalledTimes(2);
    expect(productRead).toHaveBeenCalledTimes(2);
    productRead.mockClear();
    await expect(read(() => service.getBatchAuthorizedDisplayUrls(files.map(entry => entry.id), authorizations),
      () => { product.images = []; })).rejects.toMatchObject({ status: 403 });
  });

  it('rechecks the private design viewer grant instead of trusting a retained list row', async () => {
    const { file, service, read, prisma } = fixture(); file.isPublic = false;
    const id = randomUUID(), viewer = randomUUID(); file.collectionMedias = [{ collection: { id } }] as never;
    Object.assign(prisma, { collection: { findMany: jest.fn().mockResolvedValue([
      { id, ownerId: file.userId, status: 'PUBLISHED', visibility: 'PRIVATE', deletedAt: null },
    ]) } });
    await expect(read(() => service.getBatchAuthorizedDisplayUrls([file.id], [
      { fileId: file.id, source: { type: 'COLLECTION', id, viewer } },
    ]))).rejects.toMatchObject({ status: 403 });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('snapshots content provenance instead of retaining a mutable caller reference', () => {
    const scope = { open: true, resources: new Map<string, FileReadResource>() };
    const source = { type: 'COLLECTION' as const, id: randomUUID(), viewer: randomUUID() };
    const id = source.id;
    readResourceContext.run(scope, () => rememberReadResource({ type: 'FILE', id: randomUUID(), key: 'file',
      assetVersion: 1, publicOnly: false, privateCollectionsEnabled: true, source }));
    source.id = randomUUID();
    expect([...scope.resources.values()][0].source?.id).toBe(id);
  });

  it('authorizes standalone public variants against the current parent and variant', async () => {
    const { file, service, prisma, read } = fixture();
    const variant = { fileUploadId: file.id, s3Key: 'variant/card.webp', assetVersion: 1, format: 'WEBP' };
    prisma.$queryRaw.mockResolvedValue([variant] as never);
    prisma.fileVariant.findMany.mockResolvedValue([variant] as never);
    await expect(read(() => service.getBatchVariantDisplayUrls([file.id], 'CARD'))).resolves.toHaveProperty('size', 1);
    await expect(read(() => service.getBatchVariantDisplayUrls([file.id], 'CARD'),
      () => { file.isPublic = false; })).rejects.toMatchObject({ status: 403 });
  });

  it('does not grant a private variant to an anonymous viewer or a bare administrator role', async () => {
    for (const role of [undefined, 'SuperAdmin']) {
      const { file, service, prisma, read } = fixture(); file.isPublic = false;
      const variant = { fileUploadId: file.id, s3Key: 'variant/private.webp', assetVersion: 1, format: 'WEBP' };
      if (role) prisma.$queryRaw.mockResolvedValueOnce([]).mockResolvedValueOnce([variant] as never);
      else prisma.$queryRaw.mockResolvedValue([variant] as never);
      const sign = jest.fn(); Object.assign(service, { getTemporarySignedDisplayUrl: sign });
      await expect(read(() => service.getBatchVariantDisplayUrls([file.id], 'CARD'), undefined,
        role ? { id: randomUUID(), role } : undefined)).resolves.toHaveProperty('size', 0);
      expect(sign).not.toHaveBeenCalled();
    }
  });

  it('inherits private catalogue provenance for staff-uploaded variants', async () => {
    const { file, service, prisma, read } = fixture(); file.isPublic = false;
    const id = randomUUID(), viewer = randomUUID(); file.collectionMedias = [{ collection: { id } }] as never;
    const variant = { fileUploadId: file.id, s3Key: 'variant/staff.webp', assetVersion: 1, format: 'WEBP' };
    prisma.$queryRaw.mockResolvedValue([variant] as never);
    prisma.fileVariant.findMany.mockResolvedValue([variant] as never);
    Object.assign(prisma, { collection: { findMany: jest.fn().mockResolvedValue([
      { id, ownerId: viewer, status: 'DRAFT', visibility: 'PRIVATE', deletedAt: null },
    ]) } });
    await expect(read(async () => {
      await service.getBatchAuthorizedDisplayUrls([file.id], [{ fileId: file.id,
        source: { type: 'COLLECTION', id, viewer } }]);
      return service.getBatchVariantDisplayUrls([file.id], 'CARD');
    }, undefined, { id: viewer })).resolves.toHaveProperty('size', 1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('checks shared standalone variants in batches instead of per image', async () => {
    const { file, service, prisma, read } = fixture(); file.isPublic = false;
    const viewer = randomUUID(), files = Array.from({ length: 50 }, () => ({ ...file, id: randomUUID() }));
    const variants = files.map(entry => ({ fileUploadId: entry.id, s3Key: `variant/${entry.id}.webp`, assetVersion: 1, format: 'WEBP' }));
    const grants = files.map(entry => ({ id: entry.id }));
    prisma.fileUpload.findMany.mockImplementation(async () => files);
    prisma.fileVariant.findMany.mockResolvedValue(variants as never);
    prisma.$queryRaw.mockResolvedValueOnce(grants).mockResolvedValueOnce(variants as never).mockResolvedValueOnce(grants);
    await expect(read(() => service.getBatchVariantDisplayUrls(files.map(entry => entry.id), 'CARD'),
      undefined, { id: viewer })).resolves.toHaveProperty('size', 50);
    expect(prisma.fileUpload.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('groups shared-file completion checks by viewer instead of per image', async () => {
    const { file, prisma } = fixture(); file.isPublic = false;
    const viewer = randomUUID();
    const files = Array.from({ length: 50 }, () => ({ ...file, id: randomUUID() }));
    prisma.fileUpload.findMany.mockImplementation(async () => files);
    prisma.$queryRaw.mockResolvedValue(files.map(entry => ({ id: entry.id })));
    await assertCurrentFileReads(prisma as any, files.map(entry => ({ type: 'FILE', id: entry.id,
      key: entry.s3Key, assetVersion: 1, publicOnly: false, viewer, privateCollectionsEnabled: true })));
    expect(prisma.fileUpload.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('keeps strict public and authenticated witnesses distinct for the same file', () => {
    const scope = { open: true, resources: new Map() };
    const file: FileReadResource = { type: 'FILE', id: randomUUID(), key: 'file', assetVersion: 1,
      publicOnly: true, privateCollectionsEnabled: true };
    readResourceContext.run(scope, () => {
      rememberReadResource(file);
      rememberReadResource({ ...file, publicOnly: false, viewer: randomUUID() });
      rememberReadResource({ ...file, expectedFileType: 'BRAND_VERIFICATION' });
    });
    expect(scope.resources.size).toBe(3);
  });
});
