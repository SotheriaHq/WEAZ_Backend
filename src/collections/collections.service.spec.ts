import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { CollectionStatus } from '@prisma/client';
import { CollectionsService } from './collections.service';

describe('CollectionsService brand catalog access', () => {
  const createService = (
    prisma: any,
    brandAccessService?: any,
    categoriesService?: any,
  ) =>
    new CollectionsService(
      prisma,
      {} as any,
      {
        getPublicDisplayUrl: (file: any) => file?.s3Url ?? null,
        getBatchPublicSignedUrls: jest.fn().mockResolvedValue(new Map()),
      } as any,
      {} as any,
      undefined,
      undefined,
      undefined,
      undefined,
      categoriesService,
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
      (service as any).assertOwner(
        'collection_1',
        'catalog_manager_1',
        'STORE',
      ),
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

  it('includes owner-visible review statuses in the brand content list', async () => {
    const prisma = {
      collection: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      collectionReaction: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = createService(prisma);

    await service.getUserCollections('owner_1', 'owner_1', {
      visibility: 'all',
      scope: 'design',
    });

    expect(prisma.collection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId: 'owner_1',
          domain: 'DESIGN',
          deletedAt: null,
          status: {
            in: [
              CollectionStatus.PUBLISHED,
              CollectionStatus.IN_REVIEW,
              CollectionStatus.CHANGES_REQUESTED,
              CollectionStatus.REJECTED,
              CollectionStatus.FAILED,
            ],
          },
        }),
      }),
    );
  });

  it('keeps visitor brand content reads published-only', async () => {
    const prisma = {
      collection: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = createService(prisma);

    await service.getUserCollections('owner_1', 'viewer_1', {
      visibility: 'all',
      scope: 'design',
    });

    expect(prisma.collection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          ownerId: 'owner_1',
          domain: 'DESIGN',
          deletedAt: null,
          status: 'PUBLISHED',
        }),
      }),
    );
  });

  describe('taxonomy metadata validation', () => {
    const categoryId = '11111111-1111-4111-8111-111111111111';
    const otherCategoryId = '22222222-2222-4222-8222-222222222222';
    const categoryTypeId = '33333333-3333-4333-8333-333333333333';

    it('rejects a garment type that does not belong to the selected category', async () => {
      const prisma = {
        collectionCategoryType: {
          findUnique: jest.fn().mockResolvedValue({
            id: categoryTypeId,
            categoryId: otherCategoryId,
            isActive: true,
          }),
        },
      };
      const service = createService(prisma);

      await expect(
        (service as any).assertCategoryTypeMatchesCategory(
          categoryId,
          categoryTypeId,
        ),
      ).rejects.toThrow('Sub-category does not belong to selected category');
    });

    it('allows draft helpers to remain flexible but rejects publish without structured filters', async () => {
      const prisma = {
        entityFilter: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      };
      const categoriesService = {
        validateEntityFilterValues: jest.fn().mockResolvedValue([]),
      };
      const service = createService(prisma, undefined, categoriesService);

      await expect(
        (service as any).assertStructuredFiltersForPublish(
          'COLLECTION',
          'collection-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('accepts complete structured filters for publish validation', async () => {
      const prisma = {};
      const categoriesService = {
        validateEntityFilterValues: jest
          .fn()
          .mockResolvedValue(['filter-style']),
      };
      const service = createService(prisma, undefined, categoriesService);

      await expect(
        (service as any).assertStructuredFiltersForPublish(
          'COLLECTION',
          'collection-1',
          ['filter-style'],
        ),
      ).resolves.toEqual(['filter-style']);
      expect(categoriesService.validateEntityFilterValues).toHaveBeenCalledWith(
        'COLLECTION',
        ['filter-style'],
      );
    });
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
          designId: 'collection_1',
          legacyCollectionId: 'collection_1',
          entityType: 'DESIGN',
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
          findMany: jest
            .fn()
            .mockResolvedValue([
              createCollection(),
              createCollection({ id: 'collection_2' }),
            ]),
        },
      };
      const service = createService(prisma);

      const result = await service.getMarketFeed({
        cursor: 'collection_0',
        limit: 1,
      });

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

  describe('runway pinned search feed', () => {
    const buildPrisma = (rows: any[], anchorRow: any = null) => ({
      collection: {
        findFirst: jest.fn().mockResolvedValue(anchorRow),
        findMany: jest.fn().mockResolvedValue(rows),
      },
    });

    it('requires a non-empty query and returns a clean EMPTY_QUERY state', async () => {
      const prisma = buildPrisma([]);
      const service = createService(prisma);

      const result = await service.getRunwayPinnedFeed({ query: '   ' });

      expect(result.feedMode).toBe('searchPinned');
      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.exhaustedReason).toBe('EMPTY_QUERY');
      expect(prisma.collection.findMany).not.toHaveBeenCalled();
    });

    it('returns only public published non-deleted design content with ready media', async () => {
      const prisma = buildPrisma([createCollection({ id: 'm_col' })]);
      const service = createService(prisma);

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        limit: 10,
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].collectionId).toBe('m_col');
      expect(result.hasMore).toBe(false);
      expect(result.exhaustedReason).toBe('NO_MORE_MATCHES');
      expect(prisma.collection.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            AND: expect.arrayContaining([
              expect.objectContaining({
                domain: 'DESIGN',
                status: 'PUBLISHED',
                visibility: 'PUBLIC',
                deletedAt: null,
              }),
            ]),
          }),
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        }),
      );
    });

    it('places a visible anchor first and excludes it from the matched query', async () => {
      const anchorRow = createCollection({ id: 'anchor_col' });
      const prisma = buildPrisma(
        [createCollection({ id: 'm_col' })],
        anchorRow,
      );
      const service = createService(prisma);
      const anchorId = '11111111-1111-4111-8111-111111111111';

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        anchorDesignId: anchorId,
        limit: 10,
      });

      expect(result.anchorIncluded).toBe(true);
      expect(result.items[0].collectionId).toBe('anchor_col');
      expect(result.items[1].collectionId).toBe('m_col');
      // Anchor must never be re-queried in the matched set.
      const matchedWhere = prisma.collection.findMany.mock.calls[0][0].where;
      expect(matchedWhere.AND).toEqual(
        expect.arrayContaining([{ id: { not: anchorId } }]),
      );
    });

    it('does not leak an anchor that is not visible', async () => {
      const prisma = buildPrisma([], null);
      const service = createService(prisma);
      const anchorId = '22222222-2222-4222-8222-222222222222';

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        anchorDesignId: anchorId,
        limit: 10,
      });

      expect(result.anchorIncluded).toBe(false);
      expect(result.items).toEqual([]);
      expect(result.exhaustedReason).toBe('ANCHOR_NOT_VISIBLE');
    });

    it('never adds a non-uuid anchor to the matched filter (avoids uuid cast errors)', async () => {
      const prisma = buildPrisma([createCollection({ id: 'm_col' })]);
      const service = createService(prisma);

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        anchorDesignId: 'not-a-uuid',
        limit: 10,
      });

      expect(result.anchorIncluded).toBe(false);
      // findFirst must not be called for a malformed anchor id.
      expect(prisma.collection.findFirst).not.toHaveBeenCalled();
      const matchedWhere = prisma.collection.findMany.mock.calls[0][0].where;
      const hasIdExclusion = matchedWhere.AND.some(
        (clause: any) => clause?.id?.not !== undefined,
      );
      expect(hasIdExclusion).toBe(false);
    });

    it('emits a keyset nextCursor and hasMore when more rows exist', async () => {
      const rows = Array.from({ length: 3 }, (_, index) =>
        createCollection({ id: `m_col_${index}` }),
      );
      const prisma = buildPrisma(rows);
      const service = createService(prisma);

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        limit: 2,
      });

      expect(result.items).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(typeof result.nextCursor).toBe('string');
      expect(result.exhaustedReason).toBe('NONE');
    });

    it('rejects a malformed cursor safely', async () => {
      const prisma = buildPrisma([]);
      const service = createService(prisma);

      const result = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        cursor: 'not-a-valid-cursor',
        limit: 10,
      });

      expect(result.items).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.exhaustedReason).toBe('INVALID_CURSOR');
      expect(prisma.collection.findMany).not.toHaveBeenCalled();
    });

    it('round-trips a keyset cursor into a forward keyset filter', async () => {
      const rows = Array.from({ length: 3 }, (_, index) =>
        createCollection({ id: `m_col_${index}` }),
      );
      const prisma = buildPrisma(rows);
      const service = createService(prisma);

      const first = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        limit: 2,
      });
      expect(first.nextCursor).toBeTruthy();

      const second = await service.getRunwayPinnedFeed({
        query: 'aso oke',
        cursor: first.nextCursor as string,
        limit: 2,
      });

      // Second page must use a keyset OR(updatedAt<,id<) filter, never OFFSET.
      const secondWhere = prisma.collection.findMany.mock.calls[1][0].where;
      const hasKeyset = secondWhere.AND.some(
        (clause: any) => Array.isArray(clause.OR) && clause.OR.length === 2,
      );
      expect(hasKeyset).toBe(true);
      expect(prisma.collection.findMany.mock.calls[1][0]).not.toHaveProperty(
        'skip',
      );
      expect(second).toBeDefined();
    });
  });
  });
});
