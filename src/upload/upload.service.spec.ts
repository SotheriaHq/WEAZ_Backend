import { Test, TestingModule } from '@nestjs/testing';
import { UploadService } from './upload.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { ConfigService } from '@nestjs/config';

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
      ],
    }).compile();

    service = module.get<UploadService>(UploadService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
