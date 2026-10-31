import { Test, TestingModule } from '@nestjs/testing';
import { Logger } from '@nestjs/common';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from 'src/admin/system-config/system-config.service';
import { ImageProcessingQueueService } from 'src/queue/image-processing.queue.service';
import { ThrottlerModule } from '@nestjs/throttler';
import { MediaProcessingService } from 'src/media-processing/media-processing.service';

describe('ImageController', () => {
  let controller: UploadController;
  let mediaProcessingService: { generatePreviewJpeg: jest.Mock };

  beforeEach(async () => {
    mediaProcessingService = { generatePreviewJpeg: jest.fn() };

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
        { provide: SystemConfigService, useValue: { get: jest.fn() } },
        {
          provide: ImageProcessingQueueService,
          useValue: { enqueueSingle: jest.fn() },
        },
        {
          provide: MediaProcessingService,
          useValue: mediaProcessingService,
        },
      ],
    }).compile();

    controller = module.get<UploadController>(UploadController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  it('logs preview transcode compression metrics', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation();
    const inputBuffer = Buffer.alloc(1024);
    const outputBuffer = Buffer.alloc(256);
    mediaProcessingService.generatePreviewJpeg.mockResolvedValue({
      width: 320,
      height: 240,
      buffer: outputBuffer,
      mimeType: 'image/jpeg',
    });
    const response = { setHeader: jest.fn() } as any;

    await controller.previewImage(
      {
        buffer: inputBuffer,
        mimetype: 'image/heic',
      } as Express.Multer.File,
      response,
      { requestId: 'req-123' },
      {
        maxWidth: '2048',
        quality: '82',
        maxBytes: '2097152',
        targetBytes: '1048576',
      },
    );

    expect(mediaProcessingService.generatePreviewJpeg).toHaveBeenCalledWith(
      inputBuffer,
      {
        maxWidth: 2048,
        quality: 82,
        maxBytes: 2097152,
        targetBytes: 1048576,
      },
    );
    const eventCall = logSpy.mock.calls.find(([message]) =>
      String(message).includes('upload.preview_image.transcoded'),
    );
    expect(eventCall).toBeDefined();
    const payload = JSON.parse(String(eventCall?.[0]));
    expect(payload).toMatchObject({
      event: 'upload.preview_image.transcoded',
      requestId: 'req-123',
      sourceMimeType: 'image/heic',
      originalSizeBytes: 1024,
      outputSizeBytes: 256,
      savedBytes: 768,
      reductionPercent: 75,
      outputWidth: 320,
      outputHeight: 240,
      requestedMaxWidth: 2048,
      requestedQuality: 82,
      requestedMaxBytes: 2097152,
    });
    logSpy.mockRestore();
  });
});
