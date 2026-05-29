import { Test, TestingModule } from '@nestjs/testing';
import { FeatureFlagsService } from './feature-flags.service';
import { PrismaService } from 'src/prisma/prisma.service';

describe('FeatureFlagsService', () => {
  let service: FeatureFlagsService;

  const mockPrisma = {
    featureFlag: {
      findMany: jest.fn(),
    },
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        FeatureFlagsService,
        { provide: PrismaService, useValue: mockPrisma },
      ],
    }).compile();

    service = module.get<FeatureFlagsService>(FeatureFlagsService);
  });

  it('returns disabled defaults for missing keys when loading runtime states', async () => {
    mockPrisma.featureFlag.findMany.mockResolvedValue([
      { key: 'reviews.v1.read', isEnabled: true },
    ]);

    await expect(
      service.getStates(['reviews.v1.read', 'reviews.v1.write']),
    ).resolves.toEqual({
      'reviews.v1.read': true,
      'reviews.v1.write': false,
    });

    expect(mockPrisma.featureFlag.findMany).toHaveBeenCalledWith({
      where: {
        key: {
          in: ['reviews.v1.read', 'reviews.v1.write'],
        },
      },
      select: {
        key: true,
        isEnabled: true,
      },
    });
  });
});
