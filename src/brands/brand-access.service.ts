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

  async assertBrandOwner(userId: string, brandId: string): Promise<void> {
    const isOwner = await this.isBrandOwner(userId, brandId);
    if (!isOwner) {
      throw new ForbiddenException('Only a brand owner can perform this action');
    }
  }
}
