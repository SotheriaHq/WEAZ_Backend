import { CollectionVisibility } from '@prisma/client';

import { DesignResolverService } from './design-resolver.service';

describe('DesignResolverService', () => {
  let prisma: any;
  let service: DesignResolverService;

  beforeEach(() => {
    prisma = {
      design: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
        update: jest.fn(),
      },
      collectionAccess: {
        findUnique: jest.fn(),
      },
      brand: {
        findUnique: jest.fn(),
      },
      entityFilter: {
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn(),
      },
      designMedia: {
        upsert: jest.fn(),
        findUnique: jest.fn(),
      },
      $transaction: jest.fn(async (callback: any) => callback(prisma)),
    };
    service = new DesignResolverService(prisma);
  });

  it('returns explicit Design records before legacy fallback is needed', async () => {
    prisma.design.findFirst.mockResolvedValueOnce({
      id: 'design-1',
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      visibility: CollectionVisibility.PUBLIC,
      legacyCollectionId: 'legacy-1',
      title: 'Explicit design',
      owner: {
        id: 'owner-1',
        username: 'brand',
        userProfile: { firstName: 'Thread', lastName: 'Brand' },
        brand: { name: 'Thread Brand' },
      },
      medias: [],
      entityFilters: [],
    });

    const result = await service.resolveExplicitDesign('design-1');

    expect(result).toEqual(
      expect.objectContaining({
        designId: 'design-1',
        legacyCollectionId: 'legacy-1',
        entityType: 'DESIGN',
      }),
    );
  });

  it('hides private explicit Design records without owner or legacy access', async () => {
    prisma.design.findFirst.mockResolvedValueOnce({
      id: 'design-1',
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      visibility: CollectionVisibility.PRIVATE,
      legacyCollectionId: 'legacy-1',
    });
    prisma.collectionAccess.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.resolveExplicitDesign('design-1', 'viewer-1'),
    ).resolves.toBeNull();
  });

  it('syncs a legacy collection into an explicit Design record', async () => {
    prisma.brand.findUnique.mockResolvedValueOnce({ id: 'brand-1' });
    prisma.design.upsert.mockResolvedValueOnce({ id: 'design-1' });

    const result = await service.syncFromLegacyCollection({
      id: 'legacy-1',
      ownerId: 'owner-1',
      title: 'Legacy design',
      status: 'DRAFT',
      visibility: 'PUBLIC',
      type: 'EVERYBODY',
      tags: [],
      medias: [],
      draftSessions: [],
    });

    expect(result).toEqual({ id: 'design-1' });
    expect(prisma.design.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { legacyCollectionId: 'legacy-1' },
      }),
    );
  });
});
