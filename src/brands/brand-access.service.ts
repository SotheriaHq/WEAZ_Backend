import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

@Injectable()
export class BrandAccessService {
  constructor(private readonly prisma: PrismaService) {}

  private async resolveBrand(brandIdOrOwnerId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: {
        OR: [{ id: brandIdOrOwnerId }, { ownerId: brandIdOrOwnerId }],
      },
      select: { id: true, ownerId: true },
    });

    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    return brand;
  }

  async resolveBrandIdFromBrandOrOwnerId(
    brandIdOrOwnerId: string,
  ): Promise<string> {
    return (await this.resolveBrand(brandIdOrOwnerId)).id;
  }

  async getOwnedBrandIds(userId: string): Promise<string[]> {
    const [ownedBrands, ownerMemberships] = await Promise.all([
      this.prisma.brand.findMany({
        where: { ownerId: userId },
        select: { id: true },
      }),
      this.prisma.brandMember.findMany({
        where: {
          userId,
          role: BrandMemberRole.OWNER,
          status: BrandMemberStatus.ACTIVE,
        },
        select: { brandId: true },
      }),
    ]);

    return Array.from(
      new Set([
        ...ownedBrands.map((brand) => brand.id),
        ...ownerMemberships.map((membership) => membership.brandId),
      ]),
    );
  }

  async getAccessibleBrandIds(userId: string): Promise<string[]> {
    const [ownedBrands, memberships] = await Promise.all([
      this.prisma.brand.findMany({
        where: { ownerId: userId },
        select: { id: true },
      }),
      this.prisma.brandMember.findMany({
        where: {
          userId,
          status: BrandMemberStatus.ACTIVE,
        },
        select: { brandId: true },
      }),
    ]);

    return Array.from(
      new Set([
        ...ownedBrands.map((brand) => brand.id),
        ...memberships.map((membership) => membership.brandId),
      ]),
    );
  }

  async getMembership(userId: string, brandId: string) {
    const brand = await this.resolveBrand(brandId);
    return this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId,
        },
      },
    });
  }

  async isBrandOwner(userId: string, brandId: string): Promise<boolean> {
    const brand = await this.resolveBrand(brandId);
    if (brand.ownerId === userId) {
      return true;
    }

    const membership = await this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId,
        },
      },
      select: { role: true, status: true },
    });

    return (
      membership?.role === BrandMemberRole.OWNER &&
      membership.status === BrandMemberStatus.ACTIVE
    );
  }

  async canAccessBrand(userId: string, brandId: string): Promise<boolean> {
    const brand = await this.resolveBrand(brandId);
    if (brand.ownerId === userId) {
      return true;
    }

    const membership = await this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId,
        },
      },
      select: { status: true },
    });

    return membership?.status === BrandMemberStatus.ACTIVE;
  }

  async assertBrandAccess(userId: string, brandId: string): Promise<void> {
    const canAccess = await this.canAccessBrand(userId, brandId);
    if (!canAccess) {
      throw new ForbiddenException('Not authorized for this brand');
    }
  }

  async assertBrandOwnerOrActiveMember(
    userId: string,
    brandId: string,
  ): Promise<void> {
    await this.assertBrandAccess(userId, brandId);
  }

  async assertBrandOwner(userId: string, brandId: string): Promise<void> {
    const isOwner = await this.isBrandOwner(userId, brandId);
    if (!isOwner) {
      throw new ForbiddenException('Only a brand owner can perform this action');
    }
  }

  async getPrimaryBrandContext(userId: string): Promise<{
    activeBrandId: string | null;
    memberships: Array<{
      brandId: string;
      brandName: string;
      role: BrandMemberRole;
      status: BrandMemberStatus;
      isOwner: boolean;
    }>;
  }> {
    const [ownedBrands, brandMemberships] = await Promise.all([
      this.prisma.brand.findMany({
        where: { ownerId: userId },
        select: { id: true, name: true },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.brandMember.findMany({
        where: { userId },
        select: {
          brandId: true,
          role: true,
          status: true,
          brand: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    const membershipByBrandId = new Map<
      string,
      {
        brandId: string;
        brandName: string;
        role: BrandMemberRole;
        status: BrandMemberStatus;
        isOwner: boolean;
      }
    >();

    for (const brand of ownedBrands) {
      membershipByBrandId.set(brand.id, {
        brandId: brand.id,
        brandName: brand.name,
        role: BrandMemberRole.OWNER,
        status: BrandMemberStatus.ACTIVE,
        isOwner: true,
      });
    }

    for (const membership of brandMemberships) {
      if (membershipByBrandId.has(membership.brandId)) {
        continue;
      }
      membershipByBrandId.set(membership.brandId, {
        brandId: membership.brandId,
        brandName: membership.brand?.name ?? '',
        role: membership.role,
        status: membership.status,
        isOwner: membership.role === BrandMemberRole.OWNER,
      });
    }

    const memberships = Array.from(membershipByBrandId.values());
    const activeOwner = memberships.find(
      (membership) =>
        membership.status === BrandMemberStatus.ACTIVE &&
        membership.role === BrandMemberRole.OWNER,
    );
    const activeMembership = memberships.find(
      (membership) => membership.status === BrandMemberStatus.ACTIVE,
    );

    return {
      activeBrandId:
        ownedBrands[0]?.id ??
        activeOwner?.brandId ??
        activeMembership?.brandId ??
        null,
      memberships,
    };
  }

  async assertCanManageCatalog(
    userId: string,
    brandId: string,
  ): Promise<void> {
    const brand = await this.resolveBrand(brandId);
    if (brand.ownerId === userId) {
      return;
    }

    const membership = await this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId,
        },
      },
      select: { role: true, status: true },
    });
    const allowedRoles = new Set<BrandMemberRole>([
      BrandMemberRole.OWNER,
      BrandMemberRole.MANAGER,
      BrandMemberRole.CATALOG_MANAGER,
    ]);

    if (
      membership?.status === BrandMemberStatus.ACTIVE &&
      allowedRoles.has(membership.role)
    ) {
      return;
    }

    throw new ForbiddenException('You cannot manage this brand catalog');
  }
}
