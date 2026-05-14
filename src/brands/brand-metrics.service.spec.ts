import { BrandVerificationStatus, UserStatus } from '@prisma/client';

import { BrandMetricsService } from './brand-metrics.service';

describe('BrandMetricsService', () => {
  const mockPrisma = {
    collection: {
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    collectionMedia: {
      aggregate: jest.fn(),
    },
    product: {
      count: jest.fn(),
    },
    patchConnection: {
      count: jest.fn(),
    },
  };

  let service: BrandMetricsService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new BrandMetricsService(mockPrisma as any);
    mockPrisma.collection.count.mockResolvedValue(0);
    mockPrisma.product.count.mockResolvedValue(0);
    mockPrisma.patchConnection.count.mockResolvedValue(0);
    mockPrisma.collection.aggregate.mockResolvedValue({
      _sum: { threadsCount: null },
    });
    mockPrisma.collectionMedia.aggregate.mockResolvedValue({
      _sum: { threadsCount: null },
    });
  });

  it('returns zeroed public metrics for a brand with no content', async () => {
    const metrics = await service.getPublicProfileMetrics({
      ownerId: 'owner-1',
      brand: {
        id: 'brand-1',
        isStoreOpen: false,
        verificationStatus: BrandVerificationStatus.NOT_SUBMITTED,
        avgRating: 0,
        totalReviews: 0,
      },
      ownerStatus: UserStatus.ACTIVE,
      emailVerified: false,
    });

    expect(metrics.collectionsCount).toBe(0);
    expect(metrics.designsCount).toBe(0);
    expect(metrics.productsCount).toBe(0);
    expect(metrics.patchesCount).toBe(0);
    expect(metrics.followersCount).toBe(0);
    expect(metrics.totalThreads).toBe(0);
    expect(metrics.totalLikes).toBe(0);
    expect(metrics.totalShares).toBeNull();
    expect(metrics.storeStatus).toBe('CLOSED');
    expect(metrics.verificationBadgeVisible).toBe(false);
  });

  it('aggregates public collection and media thread counts', async () => {
    mockPrisma.collection.count.mockResolvedValue(3);
    mockPrisma.product.count.mockResolvedValue(2);
    mockPrisma.patchConnection.count.mockResolvedValue(40);
    mockPrisma.collection.aggregate.mockResolvedValue({
      _sum: { threadsCount: 14 },
    });
    mockPrisma.collectionMedia.aggregate.mockResolvedValue({
      _sum: { threadsCount: 26 },
    });

    const metrics = await service.getPublicProfileMetrics({
      ownerId: 'owner-1',
      brand: {
        id: 'brand-1',
        isStoreOpen: true,
        verificationStatus: BrandVerificationStatus.APPROVED,
        avgRating: 4.9,
        totalReviews: 12,
      },
      ownerStatus: UserStatus.ACTIVE,
      emailVerified: true,
    });

    expect(metrics.collectionsCount).toBe(3);
    expect(metrics.designsCount).toBe(3);
    expect(metrics.productsCount).toBe(2);
    expect(metrics.followersCount).toBe(40);
    expect(metrics.totalThreads).toBe(40);
    expect(metrics.totalLikes).toBe(40);
    expect(metrics.totalShares).toBeNull();
    expect(metrics.averageRating).toBe(4.9);
    expect(metrics.totalReviews).toBe(12);
    expect(metrics.storeStatus).toBe('OPEN');
    expect(metrics.verified).toBe(true);
    expect(metrics.verificationBadgeVisible).toBe(true);
  });

  it('uses public-only collection filters for counts and media aggregation', async () => {
    await service.getPublicProfileMetrics({
      ownerId: 'owner-1',
      brand: { id: 'brand-1' },
      ownerStatus: UserStatus.ACTIVE,
    });

    const expectedPublicCollectionWhere = expect.objectContaining({
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      visibility: 'PUBLIC',
      deletedAt: null,
    });

    expect(mockPrisma.collection.count).toHaveBeenCalledWith({
      where: expectedPublicCollectionWhere,
    });
    expect(mockPrisma.collection.aggregate).toHaveBeenCalledWith({
      where: expectedPublicCollectionWhere,
      _sum: { threadsCount: true },
    });
    expect(mockPrisma.collectionMedia.aggregate).toHaveBeenCalledWith({
      where: { collection: expectedPublicCollectionWhere },
      _sum: { threadsCount: true },
    });
  });

  it('counts only public storefront products', async () => {
    await service.getPublicProfileMetrics({
      ownerId: 'owner-1',
      brand: { id: 'brand-1' },
      ownerStatus: UserStatus.ACTIVE,
    });

    expect(mockPrisma.product.count).toHaveBeenCalledWith({
      where: expect.objectContaining({
        brandId: 'brand-1',
        isActive: true,
        deletedAt: null,
        archivedAt: null,
        OR: [{ publishAt: null }, { publishAt: expect.any(Object) }],
      }),
    });
  });

  it.each([
    [BrandVerificationStatus.PENDING, true, 'PENDING_VERIFICATION'],
    [BrandVerificationStatus.IN_REVIEW, true, 'PENDING_VERIFICATION'],
    [
      BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
      false,
      'PENDING_VERIFICATION',
    ],
    [BrandVerificationStatus.APPROVED, true, 'OPEN'],
    [BrandVerificationStatus.APPROVED, false, 'CLOSED'],
    [BrandVerificationStatus.NOT_SUBMITTED, false, 'CLOSED'],
  ] as const)(
    'resolves store status for verification=%s and open=%s',
    async (verificationStatus, isStoreOpen, expectedStoreStatus) => {
      const metrics = await service.getPublicProfileMetrics({
        ownerId: 'owner-1',
        brand: {
          id: 'brand-1',
          isStoreOpen,
          verificationStatus,
        },
        ownerStatus: UserStatus.ACTIVE,
      });

      expect(metrics.storeStatus).toBe(expectedStoreStatus);
    },
  );

  it('does not count products when the brand record is missing', async () => {
    const metrics = await service.getPublicProfileMetrics({
      ownerId: 'owner-1',
      brand: null,
      ownerStatus: UserStatus.ACTIVE,
    });

    expect(metrics.productsCount).toBe(0);
    expect(mockPrisma.product.count).not.toHaveBeenCalled();
  });
});
