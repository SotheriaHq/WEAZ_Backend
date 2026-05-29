import { Test, TestingModule } from '@nestjs/testing';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { ThrottlerModule } from '@nestjs/throttler';

describe('ImageController', () => {
  let controller: UploadController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      imports: [ThrottlerModule.forRoot([{ ttl: 60000, limit: 120 }])],
      controllers: [UploadController],
      providers: [
        UploadService,
        { provide: PrismaService, useValue: {} },
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
        {
          provide: ImageProcessingQueueService,
          useValue: { enqueueSingle: jest.fn() },
        },
      ],
    }).compile();

    controller = module.get<UploadController>(UploadController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
