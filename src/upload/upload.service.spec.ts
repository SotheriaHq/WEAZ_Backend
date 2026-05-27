import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { FileType } from './upload.enums';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('signed-url'),
}));

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn().mockResolvedValue({
    url: 'https://s3-upload.example',
    fields: {},
  }),
}));

describe('ImageService', () => {
  let service: UploadService;

  beforeEach(async () => {
    (getSignedUrl as jest.Mock).mockClear();
    (createPresignedPost as jest.Mock).mockClear();

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
              if (key === 'AWS_S3_BUCKET' || key === 'S3_BUCKET')
                return 'test-bucket';
              if (key === 'AWS_REGION' || key === 'REGION') return 'us-east-1';
              if (key === 'AWS_ACCESS_KEY_ID' || key === 'ACCESS_KEY_ID')
                return 'dummy';
              if (
                key === 'AWS_SECRET_ACCESS_KEY' ||
                key === 'SECRET_ACCESS_KEY'
              )
                return 'dummy';
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
        { provide: ImageProcessingQueueService, useValue: { enqueueSingle: jest.fn() } },
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
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
        findFirst: jest.fn().mockResolvedValue({
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

  it('returns owner-gated local disk upload URLs for non-production signed media validation', async () => {
    (service as any).prisma = {
      fileUpload: {
        findFirst: jest.fn().mockResolvedValue({
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
      'http://localhost:3040/uploads/POST_IMAGE/user_1/file_1.png',
    );
    expect(getSignedUrl).not.toHaveBeenCalled();
  });

  it('keeps production signed media on the S3 presigned URL path', async () => {
    const existingConfigService = (service as any).configService;
    (service as any).configService = {
      get: jest.fn((key: string) => {
        if (key === 'NODE_ENV') return 'production';
        return existingConfigService.get(key);
      }),
    };
    (service as any).prisma = {
      fileUpload: {
        findFirst: jest.fn().mockResolvedValue({
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
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
              },
            },
          ],
        }),
      },
    };

    await expect(service.getPublicSignedUrl('file_1')).resolves.toBe('signed-url');
  });

  it('returns stable external public URLs without signing missing S3 fixture keys', async () => {
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
      'https://images.example/look.jpg',
    );
    expect(getSignedUrl).not.toHaveBeenCalled();
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

    await expect(service.getPublicSignedUrl('avatar_1')).resolves.toBe('signed-url');
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

    await expect(service.getPublicSignedUrl('old_avatar_1')).resolves.toBeNull();
  });

  it('batch public URL resolution prefers stable external URLs before signing', async () => {
    (service as any).prisma = {
      fileUpload: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'file_1',
            s3Key: 'e2e/bagging/custom-design.jpg',
            s3Url: 'https://images.example/look.jpg',
          },
          {
            id: 'file_2',
            s3Key: 'POST_IMAGE/user/file.jpg',
            s3Url: 'https://test-bucket.s3.us-east-1.amazonaws.com/POST_IMAGE/user/file.jpg',
          },
        ]),
      },
    };

    const result = await service.getBatchPublicSignedUrls(['file_1', 'file_2']);

    expect(result.get('file_1')).toBe('https://images.example/look.jpg');
    expect(result.get('file_2')).toBe('signed-url');
    expect(getSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('marks verified presigned uploads READY and enqueues variant generation without blocking display', async () => {
    const enqueueSingle = jest.fn().mockResolvedValue(undefined);
    const createdRecord = {
      id: 'file_1',
      userId: 'user_1',
      s3Key: 'POST_IMAGE/user_1/file_1.jpg',
      s3Url: 'https://test-bucket.s3.us-east-1.amazonaws.com/POST_IMAGE/user_1/file_1.jpg',
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
      },
      fileUpload: {
        findUnique: jest.fn(),
        create: jest.fn().mockResolvedValue(createdRecord),
      },
    };

    const result = await service.createFileRecordFromPresign(
      'file_1',
      'user_1',
      'POST_IMAGE/user_1/file_1.jpg',
      'image/jpeg',
      1234,
    );

    expect(result.processingStatus).toBe('READY');
    expect((service as any).prisma.fileUpload.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          processingStatus: 'READY',
        }),
      }),
    );
    expect(enqueueSingle).toHaveBeenCalledWith('file_1', true);
  });

  it('adds content-length-range and exact content type to presigned POST policies', async () => {
    (service as any).prisma = {
      presignedUpload: { create: jest.fn().mockResolvedValue({}) },
    };

    await service.createPresignedPost(
      'user_1',
      'look.jpg',
      FileType.POST_IMAGE,
      'image/jpeg',
    );

    expect(createPresignedPost).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        Fields: expect.objectContaining({ 'Content-Type': 'image/jpeg' }),
        Conditions: expect.arrayContaining([
          ['eq', '$Content-Type', 'image/jpeg'],
          ['content-length-range', 1, 2 * 1024 * 1024],
        ]),
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

    (service as any).prisma.presignedUpload.findUnique.mockResolvedValue(presign);
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
});
