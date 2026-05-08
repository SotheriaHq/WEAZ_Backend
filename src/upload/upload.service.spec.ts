import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn().mockResolvedValue('signed-url'),
}));

describe('ImageService', () => {
  let service: UploadService;

  beforeEach(async () => {
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
        { provide: SystemConfigService, useValue: { get: jest.fn() } },
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
});
