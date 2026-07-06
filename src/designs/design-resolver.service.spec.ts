import { CollectionVisibility } from '@prisma/client';

import { DesignResolverService } from './design-resolver.service';

const DESIGN_ID = '11111111-1111-4111-8111-111111111111';
const LEGACY_COLLECTION_ID = '33333333-3333-4333-8333-333333333333';

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
      id: DESIGN_ID,
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      visibility: CollectionVisibility.PUBLIC,
      legacyCollectionId: LEGACY_COLLECTION_ID,
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

    const result = await service.resolveExplicitDesign(DESIGN_ID);

    expect(result).toEqual(
      expect.objectContaining({
        designId: DESIGN_ID,
        legacyCollectionId: LEGACY_COLLECTION_ID,
        entityType: 'DESIGN',
      }),
    );
  });

  it('hides private explicit Design records without owner or legacy access', async () => {
    prisma.design.findFirst.mockResolvedValueOnce({
      id: DESIGN_ID,
      ownerId: 'owner-1',
      status: 'PUBLISHED',
      visibility: CollectionVisibility.PRIVATE,
      legacyCollectionId: LEGACY_COLLECTION_ID,
    });
    prisma.collectionAccess.findUnique.mockResolvedValueOnce(null);

    await expect(
      service.resolveExplicitDesign(DESIGN_ID, 'viewer-1'),
    ).resolves.toBeNull();
  });

  it('syncs a legacy collection into an explicit Design record', async () => {
    prisma.brand.findUnique.mockResolvedValueOnce({ id: 'brand-1' });
    prisma.design.upsert.mockResolvedValueOnce({ id: DESIGN_ID });

    const result = await service.syncFromLegacyCollection({
      id: LEGACY_COLLECTION_ID,
      ownerId: 'owner-1',
      title: 'Legacy design',
      status: 'DRAFT',
      visibility: 'PUBLIC',
      type: 'EVERYBODY',
      tags: [],
      medias: [],
      draftSessions: [],
    });

    expect(result).toEqual({ id: DESIGN_ID });
    expect(prisma.design.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { legacyCollectionId: LEGACY_COLLECTION_ID },
      }),
    );
  });

  it('rejects local publish task ids before querying UUID columns', async () => {
    await expect(
      service.resolveExplicitDesign('publish_1783327468928_r1mee6'),
    ).rejects.toThrow('Invalid design id');
    expect(prisma.design.findFirst).not.toHaveBeenCalled();
  });
});
