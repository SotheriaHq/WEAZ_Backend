import {
  eligibleProductWhere,
  eligibleStoreCollectionWhere,
  eligibleBrandWhere,
} from 'src/market/eligibility/market-eligibility';
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
    return { ...eligibleProductWhere(), ...(brandId ? { brandId } : {}) };
  }

  publicBrandCommerceWhere(): Prisma.BrandWhereInput {
    return eligibleBrandWhere();
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
      ...eligibleStoreCollectionWhere(),
      ...(ownerId ? { ownerId } : {}),
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
