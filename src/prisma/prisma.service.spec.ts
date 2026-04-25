import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from './prisma.service';

describe('PrismaService', () => {
  let service: PrismaService;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(() => {
    // PrismaService hard-requires DATABASE_URL at construction time.
    // Use a dummy value for unit tests (no connections are made here).
    process.env.DATABASE_URL =
      process.env.DATABASE_URL ??
      'postgresql://user:pass@localhost:5432/threadly_test?schema=public';
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PrismaService],
    }).compile();

    service = module.get<PrismaService>(PrismaService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
