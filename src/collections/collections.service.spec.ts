import { ForbiddenException } from '@nestjs/common';
import { CollectionsService } from './collections.service';

describe('CollectionsService brand catalog access', () => {
  const createService = (prisma: any, brandAccessService?: any) =>
    new CollectionsService(
      prisma,
      {} as any,
      {} as any,
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
});
