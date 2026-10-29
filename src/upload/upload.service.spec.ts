import * as fs from 'node:fs';
import * as path from 'node:path';
import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { FileType } from './upload.enums';
import { MonitoringService } from 'src/monitoring/monitoring.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('signed-url'),
}));

describe('ImageService', () => {
  let service: UploadService;
  let monitoring: { emitAlert: jest.Mock };

  beforeEach(async () => {
    (getSignedUrl as jest.Mock).mockClear();
    monitoring = { emitAlert: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UploadService,
        {
          provide: PrismaService,
          useValue: {},
        },
        {
          provide: ConfigService,
          useValue: {
            get: jest.fn((key: string) => {
              const values: Record<string, string> = {
                R2_BUCKET: 'test-bucket',
                R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
                R2_ACCESS_KEY_ID: 'dummy',
                R2_SECRET_ACCESS_KEY: 'dummy',
              };
              if (values[key]) return values[key];
              return undefined;
            }),
          },
        },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn(),
            getMaxFileSize: jest.fn().mockResolvedValue(2 * 1024 * 1024),
          },
        },
        {
          provide: ImageProcessingQueueService,
          useValue: { enqueueSingle: jest.fn() },
        },
        {
          provide: MonitoringService,
          useValue: monitoring,
        },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('never lets an oversized configured value weaken the endpoint hard limit', async () => {
    (service as any).systemConfigService.getMaxFileSize.mockResolvedValue(
      500 * 1024 * 1024,
    );
    await expect(
      (service as any).getMaxFileSize(FileType.POST_IMAGE),
    ).resolves.toBe(8 * 1024 * 1024);
    await expect(
      (service as any).getMaxFileSize(FileType.POST_IMAGE, {
        hardMaxSizeBytes: 16 * 1024 * 1024,
      }),
    ).resolves.toBe(8 * 1024 * 1024);
    await expect(
      (service as any).getMaxFileSize(FileType.POST_IMAGE, {
        hardMaxSizeBytes: Number.NaN,
      }),
    ).rejects.toThrow('Upload size policy is unavailable');
  });

  it('never signs private document and message media anonymously even if a public flag is set', () => {
    for (const fileType of [
      'DOCUMENT',
      'MESSAGE_IMAGE',
      'MESSAGE_DOCUMENT',
      'BRAND_VERIFICATION',
    ]) {
      expect(
        (service as any).canReturnPublicFileUrl({
          fileType,
          isPublic: true,
          s3Key: 'private/file.pdf',
          processingStatus: 'READY',
        }),
      ).toBe(false);
    }
  });

  it('uses the dedicated product-media setting while retaining the 8MB endpoint ceiling', async () => {
    const systemConfig = (service as any).systemConfigService;
    systemConfig.getMaxFileSize.mockResolvedValue(8 * 1024 * 1024);
    const productImage = {
      originalname: 'product.jpg',
      mimetype: 'image/jpeg',
      size: 3 * 1024 * 1024,
    } as Express.Multer.File;

    await expect(
      (service as any).validateFile(productImage, FileType.POST_IMAGE, {
        maxSizeConfigKey: 'upload.maxSize.productMedia',
        hardMaxSizeBytes: 8 * 1024 * 1024,
      }),
    ).resolves.toBeUndefined();
    expect(systemConfig.getMaxFileSize).toHaveBeenCalledWith(
      'upload.maxSize.productMedia',
    );

    systemConfig.getMaxFileSize.mockResolvedValue(20 * 1024 * 1024);
    const oversizedProductImage = { ...productImage, size: 9 * 1024 * 1024 };
    await expect(
      (service as any).validateFile(
        oversizedProductImage,
        FileType.POST_IMAGE,
        {
          maxSizeConfigKey: 'upload.maxSize.productMedia',
          hardMaxSizeBytes: 8 * 1024 * 1024,
        },
      ),
    ).rejects.toThrow('8MB');
  });

  /**
   * The only guard that can catch a stale Prisma `include`.
   *
   * Prisma validates includes at CALL time, not compile time, so `tsc` is blind
   * to a relation name that does not exist and every mocked test happily returns
   * whatever key the mock invents. That combination let a `designMedias` include
   * survive the 2026-07-24 removal of the Design models and return 500 from every
   * media URL, the owner catalog and the drafts tab for two days
   * (2026-07-28 17:52 → 2026-07-30), while this suite stayed green.
   *
   * So: read schema.prisma and assert the include only names fields that really
   * exist. This is schema-driven, not a hardcoded denylist — when the physical
   * DesignMedia table is modelled, adding `designMedias` back starts passing on
   * its own, which is exactly the behaviour we want from a guard.
   */
  describe('publicFileAccessInclude schema agreement', () => {
    const schemaPath = path.join(
      __dirname,
      '..',
      '..',
      'prisma',
      'schema.prisma',
    );

    const fieldNamesOf = (model: string): string[] => {
      const schema = fs.readFileSync(schemaPath, 'utf8');
      const start = schema.indexOf(`model ${model} {`);
      expect(start).toBeGreaterThan(-1);
      // Model blocks close on a line that is exactly `}`.
      const end = schema.indexOf('\n}', start);
      const body = schema.slice(start, end).split('\n').slice(1);
      const names: string[] = [];
      for (const raw of body) {
        const line = raw.trim();
        // Skip blanks, comments and block attributes (@@index/@@unique/@@map).
        if (!line || line.startsWith('//') || line.startsWith('@@')) continue;
        const name = line.split(/\s+/)[0];
        if (name) names.push(name);
      }
      expect(names.length).toBeGreaterThan(0);
      return names;
    };

    it('names only relations that exist on FileUpload', () => {
      const include = (service as any).publicFileAccessInclude();
      const fileUploadFields = fieldNamesOf('FileUpload');
      const keys = Object.keys(include);
      expect(keys.length).toBeGreaterThan(0);
      for (const key of keys) {
        expect(fileUploadFields).toContain(key);
      }
    });

    it('selects only columns that exist on the joined Collection and Product', () => {
      const include = (service as any).publicFileAccessInclude();

      const collectionSelect = Object.keys(
        include.collectionMedias.include.collection.select,
      );
      const collectionFields = fieldNamesOf('Collection');
      for (const key of collectionSelect) {
        expect(collectionFields).toContain(key);
      }

      const productSelect = Object.keys(
        include.productMedias.include.product.select,
      );
      const productFields = fieldNamesOf('Product');
      for (const key of productSelect) {
        expect(productFields).toContain(key);
      }
    });

    it('loads the discriminator the design/store split depends on', () => {
      // isPublicDesignFile / isPublicStoreCollectionFile filter on
      // collection.domain and fail closed when it is absent, so dropping it from
      // the select would silently deny every design and store media URL rather
      // than erroring. Assert it is fetched.
      const include = (service as any).publicFileAccessInclude();
      expect(include.collectionMedias.include.collection.select.domain).toBe(
        true,
      );
    });
  });

  it('denies public URL fallback for private collection media', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'private/file.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [
            {
              collection: {
                domain: 'STORE',
                status: 'PUBLISHED',
                visibility: 'PRIVATE',
                deletedAt: null,
              },
            },
          ],
        }),
      },
    };

    await expect(service.getPublicSignedUrl('file_1')).resolves.toBeNull();
  });

  it('denies signed URLs for deleted or failed owned media', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'media/file.jpg',
          processingStatus: 'FAILED',
          originalDeletedAt: null,
          userId: 'user_1',
        }),
      },
    };

    await expect(service.getSignedUrl('file_1', 'user_1')).rejects.toThrow(
      'File not available',
    );
  });

  it('emits a safe alert when presigned upload finalization is attempted by the wrong owner', async () => {
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'presign_1',
          userId: 'owner_1',
          s3Key: 'POST_IMAGE/owner_1/file.png',
          fileType: FileType.POST_IMAGE,
        }),
      },
    };

    await expect(
      service.createFileRecordFromPresign(
        'presign_1',
        'attacker_1',
        'POST_IMAGE/owner_1/file.png',
        'image/png',
        100,
      ),
    ).rejects.toThrow('Presign record does not belong to user');

    expect(monitoring.emitAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'UPLOAD',
        severity: 'warning',
        event: 'upload_finalize_owner_mismatch',
        actorId: 'attacker_1',
        metadata: expect.objectContaining({
          presignId: 'presign_1',
          ownerId: 'owner_1',
        }),
      }),
    );
    expect(JSON.stringify(monitoring.emitAlert.mock.calls)).not.toContain(
      'POST_IMAGE/owner_1/file.png',
    );
  });

  it('always issues an owner-gated storage capability rather than returning a persisted local URL', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'POST_IMAGE/user_1/file_1.png',
          s3Url: 'http://localhost:3040/uploads/POST_IMAGE/user_1/file_1.png',
          processingStatus: 'READY',
          originalDeletedAt: null,
          userId: 'user_1',
        }),
      },
    };

    await expect(service.getSignedUrl('file_1', 'user_1')).resolves.toBe(
      'signed-url',
    );
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('keeps production signed media on the R2 presigned URL path', async () => {
    const existingConfigService = (service as any).configService;
    (service as any).configService = {
      get: jest.fn((key: string) => {
        if (key === 'NODE_ENV') return 'production';
        return existingConfigService.get(key);
      }),
    };
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'POST_IMAGE/user_1/file_1.png',
          s3Url: 'http://localhost:3040/uploads/POST_IMAGE/user_1/file_1.png',
          processingStatus: 'READY',
          originalDeletedAt: null,
          userId: 'user_1',
        }),
      },
    };

    await expect(service.getSignedUrl('file_1', 'user_1')).resolves.toBe(
      'signed-url',
    );
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('allows admin to sign another users display media by file id', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_other',
          s3Key: 'POST_IMAGE/owner_1/file.png',
          processingStatus: 'READY',
          originalDeletedAt: null,
          userId: 'owner_1',
          isPublic: false,
          collectionMedias: [],
          productMedias: [],
          userProfileImages: [],
          userProfileBanners: [],
        }),
      },
    };

    await expect(
      service.getSignedUrl('file_other', 'admin_1', 'SuperAdmin'),
    ).resolves.toBe('signed-url');
  });

  it('allows public URL fallback for public published ready collection media', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'public/file.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [
            {
              collection: {
                domain: 'STORE',
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
              },
            },
          ],
        }),
      },
    };

    await expect(service.getPublicSignedUrl('file_1')).resolves.toBe(
      'signed-url',
    );
  });

  it('ignores persisted external public URLs and signs the current R2 object key', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          s3Key: 'e2e/bagging/custom-design.jpg',
          s3Url: 'https://images.example/look.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: true,
          collectionMedias: [
            {
              collection: {
                domain: 'STORE',
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
              },
            },
          ],
        }),
      },
    };

    await expect(service.getPublicSignedUrl('file_1')).resolves.toBe(
      'signed-url',
    );
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('allows public URL fallback for ready profile identity media', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'avatar_1',
          s3Key: 'PROFILE_IMAGE/user/avatar.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [],
          userProfileImages: [{ id: 'profile_1' }],
          userProfileBanners: [],
        }),
      },
    };

    await expect(service.getPublicSignedUrl('avatar_1')).resolves.toBe(
      'signed-url',
    );
  });

  it('denies public URL fallback for unreferenced profile upload files', async () => {
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'old_avatar_1',
          s3Key: 'PROFILE_IMAGE/user/old-avatar.jpg',
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [],
          userProfileImages: [],
          userProfileBanners: [],
        }),
      },
    };

    await expect(
      service.getPublicSignedUrl('old_avatar_1'),
    ).resolves.toBeNull();
  });

  it('public-url-by-key denies unattached POST_IMAGE keys (no public join)', async () => {
    const key =
      'POST_IMAGE/356db4ba-548b-465e-81f9-98d4df3fbd24/1783765982379-40efa895-603d-4ebd-b20f-a0c0db5398ff.jpg';
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_post_1',
          s3Key: key,
          s3Url: `https://bucket.s3.amazonaws.com/${key}`,
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [],
          productMedias: [],
          userProfileImages: [],
          userProfileBanners: [],
        }),
      },
      fileVariant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(service.getPublicSignedUrlByKey(key)).resolves.toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  // A design is `Collection(domain = DESIGN)` and its media are CollectionMedia
  // rows, so these two cases must be expressed through `collectionMedias`. They
  // previously used a `designMedias` key, which is not a relation on FileUpload
  // at all — the mock happily returned it, the assertions passed, and the real
  // Prisma include that named the same key threw PrismaClientValidationError in
  // production for two days. Do not reintroduce it here.
  it('public-url-by-key signs POST_IMAGE only when joined to a published public design', async () => {
    const key =
      'POST_IMAGE/356db4ba-548b-465e-81f9-98d4df3fbd24/1783765982379-40efa895-603d-4ebd-b20f-a0c0db5398ff.jpg';
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_post_1',
          s3Key: key,
          s3Url: `https://bucket.s3.amazonaws.com/${key}`,
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [
            {
              collection: {
                id: 'design_1',
                domain: 'DESIGN',
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
              },
            },
          ],
          productMedias: [],
          userProfileImages: [],
          userProfileBanners: [],
        }),
      },
      fileVariant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(service.getPublicSignedUrlByKey(key)).resolves.toBe(
      'signed-url',
    );
    expect(getSignedUrl).toHaveBeenCalled();
  });

  it('public-url-by-key denies in-review design media', async () => {
    const key = 'POST_IMAGE/user/in-review.jpg';
    (service as any).prisma = {
      fileUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_review_1',
          s3Key: key,
          s3Url: `https://bucket.s3.amazonaws.com/${key}`,
          processingStatus: 'READY',
          originalDeletedAt: null,
          isPublic: false,
          collectionMedias: [
            {
              collection: {
                id: 'design_review',
                domain: 'DESIGN',
                status: 'IN_REVIEW',
                visibility: 'PUBLIC',
                deletedAt: null,
              },
            },
          ],
          productMedias: [],
          userProfileImages: [],
          userProfileBanners: [],
        }),
      },
      fileVariant: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await expect(service.getPublicSignedUrlByKey(key)).resolves.toBeNull();
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('batch public URL resolution skips non-public files and signs current R2 object keys', async () => {
    (service as any).prisma = {
      fileUpload: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'file_1',
            s3Key: 'e2e/bagging/custom-design.jpg',
            s3Url: 'https://images.example/look.jpg',
            processingStatus: 'READY',
            originalDeletedAt: null,
            isPublic: true,
            collectionMedias: [],
            productMedias: [],
            userProfileImages: [],
            userProfileBanners: [],
          },
          {
            id: 'file_2',
            s3Key: 'POST_IMAGE/user/draft.jpg',
            s3Url:
              'https://test-bucket.s3.us-east-1.amazonaws.com/POST_IMAGE/user/draft.jpg',
            processingStatus: 'READY',
            originalDeletedAt: null,
            isPublic: false,
            collectionMedias: [],
            productMedias: [],
            userProfileImages: [],
            userProfileBanners: [],
          },
        ]),
      },
    };

    const result = await service.getBatchPublicSignedUrls(['file_1', 'file_2']);

    expect(result.get('file_1')).toBe('signed-url');
    expect(result.has('file_2')).toBe(false);
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  describe('getBatchAuthorizedDisplayUrls', () => {
    const draftCoverFile = {
      id: 'file_draft',
      s3Key: 'POST_IMAGE/owner_1/draft-cover.jpg',
      s3Url:
        'https://test-bucket.s3.us-east-1.amazonaws.com/POST_IMAGE/owner_1/draft-cover.jpg',
      processingStatus: 'READY',
      originalDeletedAt: null,
      isPublic: false,
      userId: 'owner_1',
      collectionMedias: [
        {
          collection: {
            id: 'design_draft',
            domain: 'DESIGN',
            status: 'DRAFT',
            visibility: 'PRIVATE',
            deletedAt: null,
          },
        },
      ],
      productMedias: [],
      userProfileImages: [],
      userProfileBanners: [],
    };

    const stubFiles = (files: any[]) => {
      (service as any).prisma = {
        fileUpload: { findMany: jest.fn().mockResolvedValue(files) },
      };
    };

    it('resolves a DRAFT cover that the anonymous batch drops', async () => {
      // The exact production bug: `getMyDraftCollections` / owner catalog rows
      // are authorized by their own query, but the anonymous gate wants
      // PUBLISHED + PUBLIC, so it returned an empty map and every draft card
      // rendered a broken image.
      stubFiles([draftCoverFile]);
      await expect(
        service.getBatchPublicSignedUrls(['file_draft']),
      ).resolves.toEqual(new Map());

      stubFiles([draftCoverFile]);
      const authorized = await service.getBatchAuthorizedDisplayUrls([
        'file_draft',
      ]);

      expect(authorized.get('file_draft')).toBe('signed-url');
    });

    it('signs non-public files even when a public CDN base is configured', async () => {
      // Trusting the caller's row-level authorization must not turn draft or
      // private media into an anonymously fetchable CDN object URL.
      (service as any).configService = {
        get: jest.fn((key: string) =>
          key === 'MEDIA_PUBLIC_BASE_URL' ? 'https://cdn.example' : undefined,
        ),
      };
      stubFiles([draftCoverFile]);

      const authorized = await service.getBatchAuthorizedDisplayUrls([
        'file_draft',
      ]);

      expect(authorized.get('file_draft')).toBe('signed-url');
      expect(getSignedUrl).toHaveBeenCalledTimes(1);
    });

    it('still refuses a file that is not displayable', async () => {
      // The caller vouches for authorization, never for availability.
      stubFiles([
        { ...draftCoverFile, processingStatus: 'FAILED' },
        { ...draftCoverFile, id: 'file_no_key', s3Key: '' },
      ]);

      const authorized = await service.getBatchAuthorizedDisplayUrls([
        'file_draft',
        'file_no_key',
      ]);

      expect(authorized.size).toBe(0);
      expect(getSignedUrl).not.toHaveBeenCalled();
    });
  });

  it('marks verified presigned uploads READY and enqueues variant generation without blocking display', async () => {
    const enqueueSingle = jest.fn().mockResolvedValue(undefined);
    const createdRecord = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/file_1.jpg',
      s3Url:
        'https://test-bucket.s3.us-east-1.amazonaws.com/POST_IMAGE/user_1/file_1.jpg',
      fileType: 'POST_IMAGE',
      mimeType: 'image/jpeg',
      processingStatus: 'READY',
    };

    (service as any).configService = {
      get: jest.fn((key: string) => {
        if (key === 'IMAGE_OPTIMIZATION_ENABLED') return 'true';
        return undefined;
      }),
    };
    (service as any).imageQueue = { enqueueSingle };
    (service as any).s3 = {
      send: jest.fn().mockResolvedValue({
        ContentLength: 1234,
        ContentType: 'image/jpeg',
        ETag: '"stored-version"',
      }),
    };
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          userId: 'user_1',
          s3Key: 'POST_IMAGE/user_1/file_1.jpg',
          originalName: 'look.jpg',
          fileType: 'POST_IMAGE',
          status: 'PENDING',
          expiresAt: new Date(Date.now() + 60_000),
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fileUpload: {
        findUnique: jest.fn(),
        create: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...createdRecord, ...data }),
          ),
      },
      storageObjectDeletion: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'file_1' }]),
    };
    (service as any).prisma.$transaction = jest.fn((callback) =>
      callback((service as any).prisma),
    );
    jest
      .spyOn(service as any, 'assertStoredUploadSignature')
      .mockResolvedValue(undefined);

    const result = await service.createFileRecordFromPresign(
      'file_1',
      'user_1',
      'POST_IMAGE/user_1/file_1.jpg',
      'image/jpeg',
      1234,
    );

    expect(result.processingStatus).toBe('READY');
    expect(result.s3Key).toMatch(/^POST_IMAGE\/user_1\/final\/file_1\//);
    expect((service as any).s3.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          CopySourceIfMatch: '"stored-version"',
        }),
      }),
    );
    expect((service as any).prisma.fileUpload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mimeType: 'image/jpeg',
          size: 1234,
          processingStatus: 'READY',
        }),
      }),
    );
    expect(enqueueSingle).toHaveBeenCalledWith('file_1', true);
  });

  it('fails presigning when the endpoint size policy is unavailable', async () => {
    (service as any).prisma = { presignedUpload: { create: jest.fn() } };
    (service as any).systemConfigService.getMaxFileSize.mockResolvedValue(0);
    await expect(
      service.createPresignedUpload(
        'user_1',
        'look.jpg',
        FileType.POST_IMAGE,
        'image/jpeg',
      ),
    ).rejects.toThrow('Upload size policy is unavailable');
    expect(getSignedUrl).not.toHaveBeenCalled();
    expect(
      (service as any).prisma.presignedUpload.create,
    ).not.toHaveBeenCalled();
  });

  it('uses a private signed PUT with exact headers for R2', async () => {
    (service as any).prisma = { presignedUpload: { create: jest.fn() } };
    const result = await service.createPresignedUpload(
      'user_1',
      'look.jpg',
      FileType.POST_IMAGE,
      'image/jpeg',
    );
    expect(result.method).toBe('PUT');
    expect(result.key).toContain('/pending/');
    expect(result.uploadHeaders).toEqual({
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=0, no-store',
    });
    expect(getSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        input: expect.objectContaining({
          Key: result.key,
          ContentType: 'image/jpeg',
        }),
      }),
      expect.objectContaining({ signableHeaders: new Set(['content-type']) }),
    );
  });

  it('retains a recoverable staging intent and fails visibly when server storage is unavailable', async () => {
    const intents: unknown[] = [];
    const createFile = jest.fn();
    (service as any).prisma = {
      presignedUpload: {
        create: jest.fn(async ({ data }) => {
          intents.push(data);
          return data;
        }),
      },
      fileUpload: { create: createFile },
    };
    (service as any).s3 = {
      send: jest.fn(async () => {
        expect(intents).toHaveLength(1);
        throw new Error('Storage unavailable');
      }),
    };
    await expect(
      service.uploadFile(
        {
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: 3,
          buffer: Buffer.from('img'),
        } as Express.Multer.File,
        'user_1',
        FileType.POST_IMAGE,
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(intents[0]).toMatchObject({
      s3Key: expect.stringContaining('/pending/'),
      userId: 'user_1',
    });
    expect(createFile).not.toHaveBeenCalled();
  });

  it('keeps the endpoint-specific product limit when server uploads enter common finalization', async () => {
    (service as any).systemConfigService.getMaxFileSize.mockResolvedValue(
      8 * 1024 * 1024,
    );
    (service as any).prisma = { presignedUpload: { create: jest.fn() } };
    (service as any).s3 = { send: jest.fn().mockResolvedValue({}) };
    const record = {
      id: 'file_1',
      s3Key: 'immutable.jpg',
      s3Url: 'storage-url',
      fileName: 'immutable.jpg',
      originalName: 'photo.jpg',
      size: 3 * 1024 * 1024,
      mimeType: 'image/jpeg',
      fileType: 'POST_IMAGE',
      processingStatus: 'READY',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const finalize = jest
      .spyOn(service, 'createFileRecordFromPresign')
      .mockResolvedValue(record as any);
    const options = {
      maxSizeConfigKey: 'upload.maxSize.productMedia',
      hardMaxSizeBytes: 8 * 1024 * 1024,
    };
    await expect(
      service.uploadFile(
        {
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: record.size,
          buffer: Buffer.alloc(record.size),
        } as Express.Multer.File,
        'user_1',
        FileType.POST_IMAGE,
        options,
      ),
    ).resolves.toMatchObject({ id: 'file_1', url: 'storage-url' });
    expect(finalize).toHaveBeenCalledWith(
      expect.any(String),
      'user_1',
      expect.stringContaining('/pending/'),
      'image/jpeg',
      record.size,
      undefined,
      options,
    );
  });

  it('replays a committed upload after its original capability expires without reading storage', async () => {
    const committed = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'immutable/file.jpg',
    };
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'file_1',
          userId: 'user_1',
          s3Key: 'staging/file.jpg',
          status: 'USED',
          expiresAt: new Date(0),
        }),
      },
      fileUpload: { findUnique: jest.fn().mockResolvedValue(committed) },
    };
    const storage = jest.fn();
    (service as any).s3 = { send: storage };
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        'staging/file.jpg',
        'image/jpeg',
        1234,
      ),
    ).resolves.toBe(committed);
    expect(storage).not.toHaveBeenCalled();
  });

  it('reuses operation-local presign metadata without skipping canonical storage validation', async () => {
    const presign: any = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/pending/look.jpg',
      originalName: 'look.jpg',
      fileType: 'POST_IMAGE',
      contentType: 'image/jpeg',
      status: 'READY',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const find = jest.fn().mockRejectedValue(Error('Repeated metadata read'));
    (service as any).prisma = { presignedUpload: { findUnique: find } };
    const metadata = {
      exists: true,
      contentLength: 1234,
      contentType: 'image/jpeg',
      etag: 'object-version',
    };
    const head = jest
      .spyOn(service as any, 'headObjectMetadata')
      .mockResolvedValue(metadata);
    const committed = { id: 'file_1', userId: 'user_1' };
    const finalize = jest
      .spyOn(service as any, 'finalizeStoredUpload')
      .mockResolvedValue(committed);
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
        undefined,
        { presignSnapshot: presign },
      ),
    ).resolves.toBe(committed);
    expect(find).not.toHaveBeenCalled();
    expect(head).toHaveBeenCalledWith(presign.s3Key);
    expect(finalize).toHaveBeenCalledWith(
      presign,
      'user_1',
      metadata,
      'image/jpeg',
      undefined,
    );
  });

  it('does not accept a mismatched snapshot, owner, key, or expired pending capability', async () => {
    const presign: any = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/pending/look.jpg',
      status: 'PENDING',
      expiresAt: new Date(0),
    };
    const storage = jest.fn();
    (service as any).s3 = { send: storage };
    (service as any).prisma = { presignedUpload: { findUnique: jest.fn() } };
    await expect(
      service.createFileRecordFromPresign(
        'other',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
        undefined,
        { presignSnapshot: presign },
      ),
    ).rejects.toThrow('snapshot does not match');
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'other',
        presign.s3Key,
        'image/jpeg',
        1234,
        undefined,
        { presignSnapshot: presign },
      ),
    ).rejects.toThrow('does not belong');
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        'wrong-key',
        'image/jpeg',
        1234,
        undefined,
        { presignSnapshot: presign },
      ),
    ).rejects.toThrow('key mismatch');
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
        undefined,
        { presignSnapshot: presign },
      ),
    ).rejects.toThrow('expired');
    expect(storage).not.toHaveBeenCalled();
  });

  it('retains durable cleanup and never publishes when a source changes during copy', async () => {
    const intent = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/pending/look.jpg',
      originalName: 'look.jpg',
      fileType: 'POST_IMAGE',
      expiresAt: new Date(Date.now() + 60_000),
    };
    const prisma = {
      presignedUpload: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      storageObjectDeletion: {
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
        deleteMany: jest.fn(),
      },
      $transaction: jest.fn(),
    };
    (service as any).prisma = prisma;
    (service as any).s3 = {
      send: jest.fn().mockRejectedValue({ $metadata: { httpStatusCode: 412 } }),
    };
    jest
      .spyOn(service as any, 'assertStoredUploadSignature')
      .mockResolvedValue(undefined);
    await expect(
      (service as any).finalizeStoredUpload(
        intent,
        'user_1',
        { etag: '"etag"', contentLength: 1234 },
        'image/jpeg',
      ),
    ).rejects.toMatchObject({ response: { code: 'UPLOAD_CHANGED' } });
    expect(prisma.storageObjectDeletion.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.storageObjectDeletion.deleteMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.presignedUpload.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'file_1',
          finalizeLeaseToken: expect.any(String),
        }),
      }),
    );
  });

  it('rejects oversized, spoofed, expired, and missing presigned uploads using trusted S3 metadata', async () => {
    const presign = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/file_1.jpg',
      originalName: 'look.jpg',
      contentType: 'image/jpeg',
      fileType: 'POST_IMAGE',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    };
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue(presign),
        update: jest.fn(),
      },
      fileUpload: { findUnique: jest.fn(), create: jest.fn() },
    };

    (service as any).s3 = {
      send: jest.fn().mockResolvedValue({
        ContentLength: 3 * 1024 * 1024,
        ContentType: 'image/jpeg',
      }),
    };
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        3 * 1024 * 1024,
      ),
    ).rejects.toThrow('Uploaded object exceeds size limit');

    (service as any).s3.send.mockResolvedValue({
      ContentLength: 1234,
      ContentType: 'text/plain',
    });
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
      ),
    ).rejects.toThrow('Uploaded object content type mismatch');

    (service as any).prisma.presignedUpload.findUnique.mockResolvedValue({
      ...presign,
      expiresAt: new Date(Date.now() - 60_000),
    });
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
      ),
    ).rejects.toThrow('Presign has expired');

    (service as any).prisma.presignedUpload.findUnique.mockResolvedValue(
      presign,
    );
    (service as any).s3.send.mockRejectedValue({
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
      ),
    ).rejects.toThrow('Uploaded object was not found');
  });

  it('rejects cross-user and wrong-prefix presigned upload finalization attempts', async () => {
    const presign = {
      id: 'file_1',
      userId: 'user_2',
      s3Key: 'POST_IMAGE/user_2/file_1.jpg',
      originalName: 'look.jpg',
      contentType: 'image/jpeg',
      fileType: 'POST_IMAGE',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    };
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue(presign),
        update: jest.fn(),
      },
      fileUpload: { findUnique: jest.fn(), create: jest.fn() },
    };

    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        1234,
      ),
    ).rejects.toThrow('Presign record does not belong to user');

    (service as any).prisma.presignedUpload.findUnique.mockResolvedValue({
      ...presign,
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_2/file_1.jpg',
    });

    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        'POST_IMAGE/user_2/file_1.jpg',
        'image/jpeg',
        1234,
      ),
    ).rejects.toThrow('S3 key does not match expected user prefix');
  });

  it('rejects client-reported MIME type and size that differ from trusted S3 metadata', async () => {
    const presign = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/file_1.jpg',
      originalName: 'look.jpg',
      contentType: 'image/jpeg',
      fileType: 'POST_IMAGE',
      status: 'PENDING',
      expiresAt: new Date(Date.now() + 60_000),
    };
    (service as any).prisma = {
      presignedUpload: {
        findUnique: jest.fn().mockResolvedValue(presign),
        update: jest.fn(),
      },
      fileUpload: { findUnique: jest.fn(), create: jest.fn() },
    };
    (service as any).s3 = {
      send: jest.fn().mockResolvedValue({
        ContentLength: 1234,
        ContentType: 'image/jpeg',
      }),
    };

    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/png',
        1234,
      ),
    ).rejects.toThrow('Reported file type does not match storage metadata');

    await expect(
      service.createFileRecordFromPresign(
        'file_1',
        'user_1',
        presign.s3Key,
        'image/jpeg',
        4321,
      ),
    ).rejects.toThrow('Reported file size does not match storage metadata');
  });
});
