import { Injectable } from '@nestjs/common';
import {
  CollectionDomain,
  CollectionStatus,
  CollectionVisibility,
  Prisma,
  ProfileVisibility,
  TagStatus,
  UserStatus,
} from '@prisma/client';

@Injectable()
export class SearchVisibilityService {
  publicProfileIdentityWhere(): Prisma.UserWhereInput {
    return {
      status: UserStatus.ACTIVE,
      isActive: 'Active',
      userProfile: {
        profileVisibility: ProfileVisibility.UNLOCKED,
      },
    };
  }

  publicProductWhere(brandId?: string): Prisma.ProductWhereInput {
    return {
      ...(brandId ? { brandId } : {}),
      isActive: true,
      publicationStatus: CollectionStatus.PUBLISHED,
      deletedAt: null,
      archivedAt: null,
      brand: { isStoreOpen: true },
      AND: [{ OR: [{ publishAt: null }, { publishAt: { lte: new Date() } }] }],
    };
  }

  publicBrandCommerceWhere(): Prisma.BrandWhereInput {
    return {
      isStoreOpen: true,
    };
  }

  publicDesignWhere(): Prisma.CollectionWhereInput {
    return {
      domain: CollectionDomain.DESIGN,
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
    };
  }

  publicStoreCollectionWhere(
    ownerId?: string,
  ): Prisma.StoreCollectionWhereInput {
    return {
      ...(ownerId ? { ownerId } : {}),
      status: CollectionStatus.PUBLISHED,
      visibility: CollectionVisibility.PUBLIC,
      deletedAt: null,
    };
  }

  publicTagWhere(): Prisma.TagWhereInput {
    return {
      status: TagStatus.APPROVED,
      isBanned: false,
      aliasOfTagId: null,
    };
  }

  publicSuggestionTagWhere(): Prisma.TagWhereInput {
    return {
      ...this.publicTagWhere(),
      usageCount: { gt: 0 },
    };
  }
}
