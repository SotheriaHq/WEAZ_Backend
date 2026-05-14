import { ForbiddenException } from '@nestjs/common';
import { CollectionsService } from './collections.service';

describe('CollectionsService brand catalog access', () => {
  const createService = (prisma: any, brandAccessService?: any) =>
    new CollectionsService(
      prisma,
      {} as any,
      { getPublicDisplayUrl: (file: any) => file?.s3Url ?? null } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      brandAccessService,
    );

  it('allows an active catalog manager to update a store collection', async () => {
    const prisma = {
      storeCollection: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'owner_1',
          deletedAt: null,
        }),
      },
    };
    const brandAccessService = {
      resolveBrandIdFromBrandOrOwnerId: jest.fn().mockResolvedValue('brand_1'),
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(prisma, brandAccessService);

    await expect(
      (service as any).assertOwner('collection_1', 'catalog_manager_1', 'STORE'),
    ).resolves.toEqual({
      ownerId: 'owner_1',
      deletedAt: null,
      domain: 'STORE',
    });
    expect(brandAccessService.assertCanManageCatalog).toHaveBeenCalledWith(
      'catalog_manager_1',
      'brand_1',
      'catalog.write',
    );
  });

  it('resolves collection creation to the brand owner for an active catalog manager', async () => {
    const prisma = {
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'catalog_manager_1',
          type: 'REGULAR',
          isEmailVerified: true,
        }),
      },
      brand: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'brand_1',
          ownerId: 'owner_1',
        }),
      },
    };
    const brandAccessService = {
      getPrimaryBrandContext: jest.fn().mockResolvedValue({
        activeBrandId: 'brand_1',
        memberships: [],
      }),
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(prisma, brandAccessService);

    await expect(
      (service as any).resolveCatalogOwnerContext('catalog_manager_1'),
    ).resolves.toEqual({
      actorUserId: 'catalog_manager_1',
      ownerId: 'owner_1',
      brandId: 'brand_1',
    });
    expect(brandAccessService.assertCanManageCatalog).toHaveBeenCalledWith(
      'catalog_manager_1',
      'brand_1',
      'catalog.write',
    );
  });

  it('requires catalog.delete to delete a store collection', async () => {
    const prisma = {
      storeCollection: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'owner_1',
          deletedAt: null,
          status: 'DRAFT',
          visibility: 'PUBLIC',
          tags: [],
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      storeCollectionProduct: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      cartItem: {
        deleteMany: jest.fn(),
      },
    };
    const brandAccessService = {
      resolveBrandIdFromBrandOrOwnerId: jest.fn().mockResolvedValue('brand_1'),
      assertCanManageCatalog: jest.fn().mockResolvedValue(undefined),
    };
    const service = createService(prisma, brandAccessService);

    await expect(
      service.deleteCollection('collection_1', 'catalog_manager_1', 'store'),
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(brandAccessService.assertCanManageCatalog).toHaveBeenCalledWith(
      'catalog_manager_1',
      'brand_1',
      'catalog.delete',
    );
  });

  it('keeps legacy ownerId collection routes working for the owner user', async () => {
    const prisma = {
      storeCollection: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'owner_1',
          deletedAt: null,
        }),
      },
    };
    const service = createService(prisma);

    await expect(
      (service as any).assertOwner('collection_1', 'owner_1', 'STORE'),
    ).resolves.toEqual({
      ownerId: 'owner_1',
      deletedAt: null,
      domain: 'STORE',
    });
  });

  it('rejects a regular user for another brand collection', async () => {
    const prisma = {
      storeCollection: {
        findUnique: jest.fn().mockResolvedValue({
          ownerId: 'owner_1',
          deletedAt: null,
        }),
      },
    };
    const service = createService(prisma);

    await expect(
      (service as any).assertOwner('collection_1', 'regular_1', 'STORE'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  describe('market feed DTO', () => {
    const readyFile = {
      id: 'file_1',
      s3Url: 'https://cdn.threadly.test/file-1.jpg',
      fileType: 'POST_IMAGE',
      mimeType: 'image/jpeg',
      processingStatus: 'READY',
      originalDeletedAt: null,
      width: 1200,
      height: 1600,
      variants: [
        {
          variantKind: 'CARD',
          format: 'WEBP',
          s3Url: 'https://cdn.threadly.test/file-1-card.webp',
        },
        {
          variantKind: 'THUMB',
          format: 'WEBP',
          s3Url: 'https://cdn.threadly.test/file-1-thumb.webp',
        },
      ],
    };

    const createCollection = (overrides: Record<string, any> = {}) => ({
      id: 'collection_1',
      title: 'Aso oke jacket',
      description: 'Editorial look',
      coverMediaId: 'media_1',
      minPrice: null,
      maxPrice: null,
      saleMinPrice: null,
      saleMaxPrice: null,
      saleStartAt: null,
      saleEndAt: null,
      sizingMode: 'NONE',
      customMeasurementKeys: [],
      customOrderEnabled: true,
      tags: ['aso-oke'],
      commentsCount: 2,
      collectionCollabsCount: 1,
      createdAt: new Date('2026-05-08T10:00:00.000Z'),
      updatedAt: new Date('2026-05-08T11:00:00.000Z'),
      owner: {
        id: 'owner_1',
        username: 'brandhandle',
        type: 'BRAND',
        userProfile: {
          firstName: 'Ada',
          lastName: 'Brand',
          profileImage: null,
          profileImageId: null,
          profileImageFile: null,
        },
        brand: { id: 'brand_1', name: 'Ada Atelier', logo: null },
      },
      medias: [
        {
          id: 'media_1',
          fileUploadId: 'file_1',
          mediaType: 'POST_IMAGE',
          orderIndex: 0,
          threadsCount: 4,
          commentsCount: 3,
          file: readyFile,
        },
      ],
      _count: { reactions: 5, comments: 2, collectionCollabs: 1 },
      ...overrides,
    });

    it('returns strict DTO media without signed URLs', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([createCollection()]),
        },
      };
      const uploadService = {
        getBatchPublicSignedUrls: jest.fn(),
        getPublicDisplayUrl: jest.fn((file: any) => file?.s3Url ?? null),
      };
      const service = new CollectionsService(
        prisma as any,
        {} as any,
        uploadService as any,
        {} as any,
      );

      const result = await service.getMarketFeed({ countsPolicy: 'combined' });

      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toEqual(
        expect.objectContaining({
          id: 'media_1',
          collectionId: 'collection_1',
          sourceType: 'DESIGN',
          primaryMedia: expect.objectContaining({
            id: 'media_1',
            fileId: 'file_1',
            status: 'READY',
            displayUrl: 'https://cdn.threadly.test/file-1-card.webp',
            thumbnailUrl: 'https://cdn.threadly.test/file-1-thumb.webp',
            aspectRatio: 0.75,
          }),
          mediaUrl: 'https://cdn.threadly.test/file-1-card.webp',
          stats: expect.objectContaining({
            likes: 5,
            comments: 5,
            threads: 4,
          }),
        }),
      );
      expect(uploadService.getBatchPublicSignedUrls).not.toHaveBeenCalled();
    });

    it('drops media that is not READY', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([
            createCollection({
              medias: [
                {
                  id: 'media_1',
                  fileUploadId: 'file_1',
                  mediaType: 'POST_IMAGE',
                  orderIndex: 0,
                  threadsCount: 0,
                  commentsCount: 0,
                  file: { ...readyFile, processingStatus: 'PENDING' },
                },
              ],
            }),
          ]),
        },
      };
      const service = createService(prisma);

      const result = await service.getMarketFeed();

      expect(result.items).toEqual([]);
      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            deletedAt: null,
            medias: expect.any(Object),
          }),
        }),
      );
    });

    it('drops media with empty display URL', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([
            createCollection({
              medias: [
                {
                  id: 'media_1',
                  fileUploadId: 'file_1',
                  mediaType: 'POST_IMAGE',
                  orderIndex: 0,
                  threadsCount: 0,
                  commentsCount: 0,
                  file: { ...readyFile, s3Url: '', variants: [] },
                },
              ],
            }),
          ]),
        },
      };
      const service = createService(prisma);

      const result = await service.getMarketFeed();

      expect(result.items).toEqual([]);
    });

    it('queries only public published non-deleted design collections', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const service = createService(prisma);

      await service.getMarketFeed();

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            domain: 'DESIGN',
            status: 'PUBLISHED',
            visibility: 'PUBLIC',
            deletedAt: null,
          }),
        }),
      );
    });

    it('keeps one feed item per collection even when a collection has duplicate media rows', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([
            createCollection({
              medias: [
                {
                  id: 'media_1',
                  fileUploadId: 'file_1',
                  mediaType: 'POST_IMAGE',
                  orderIndex: 0,
                  threadsCount: 4,
                  commentsCount: 3,
                  file: readyFile,
                },
                {
                  id: 'media_2',
                  fileUploadId: 'file_1',
                  mediaType: 'POST_IMAGE',
                  orderIndex: 1,
                  threadsCount: 0,
                  commentsCount: 0,
                  file: readyFile,
                },
              ],
            }),
          ]),
        },
      };
      const service = createService(prisma);

      const result = await service.getMarketFeed();

      expect(result.items).toHaveLength(1);
      expect(result.items[0].mediaItems).toHaveLength(2);
      expect(result.items[0]).not.toHaveProperty('s3Key');
      expect(result.items[0].primaryMedia).not.toHaveProperty('s3Key');
    });

    it('uses stable cursor ordering', async () => {
      const prisma = {
        collection: {
          findMany: jest.fn().mockResolvedValue([createCollection(), createCollection({ id: 'collection_2' })]),
        },
      };
      const service = createService(prisma);

      const result = await service.getMarketFeed({ cursor: 'collection_0', limit: 1 });

      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          cursor: { id: 'collection_0' },
          skip: 1,
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        }),
      );
      expect(result.hasNextPage).toBe(true);
      expect(result.nextCursor).toBe('collection_1');
    });
  });
});
