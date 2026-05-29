import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { BrandPermissionService } from './permissions/brand-permission.service';
import {
  BRAND_PERMISSIONS,
  BrandPermissionCode,
} from './permissions/brand-permissions';

@Injectable()
export class BrandAccessService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional()
    private readonly brandPermissionService?: BrandPermissionService,
  ) {}

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
      throw new ForbiddenException(
        'Only a brand owner can perform this action',
      );
    }
  }

  async isActiveOwner(userId: string, brandId: string): Promise<boolean> {
    return this.isBrandOwner(userId, brandId);
  }

  async getActiveOwnersCount(brandId: string): Promise<number> {
    const brand = await this.resolveBrand(brandId);
    const [ownerMemberships, legacyOwnerMembership] = await Promise.all([
      this.prisma.brandMember.count({
        where: {
          brandId: brand.id,
          role: BrandMemberRole.OWNER,
          status: BrandMemberStatus.ACTIVE,
        },
      }),
      this.prisma.brandMember.findUnique({
        where: {
          brandId_userId: {
            brandId: brand.id,
            userId: brand.ownerId,
          },
        },
        select: { role: true, status: true },
      }),
    ]);

    const legacyOwnerAlreadyCounted =
      legacyOwnerMembership?.role === BrandMemberRole.OWNER &&
      legacyOwnerMembership.status === BrandMemberStatus.ACTIVE;

    return ownerMemberships + (legacyOwnerAlreadyCounted ? 0 : 1);
  }

  async assertCanManageStaff(userId: string, brandId: string): Promise<void> {
    const canManage = await this.isActiveOwner(userId, brandId);
    if (!canManage) {
      throw new ForbiddenException('Only a brand owner can manage staff');
    }
  }

  async assertNotLastOwner(
    brandId: string,
    targetMemberId: string,
  ): Promise<void> {
    const brand = await this.resolveBrand(brandId);
    const targetMember = await this.prisma.brandMember.findUnique({
      where: { id: targetMemberId },
      select: {
        id: true,
        brandId: true,
        userId: true,
        role: true,
        status: true,
      },
    });

    if (!targetMember || targetMember.brandId !== brand.id) {
      throw new NotFoundException('Brand member not found');
    }

    const isActiveOwner =
      targetMember.role === BrandMemberRole.OWNER &&
      targetMember.status === BrandMemberStatus.ACTIVE;
    if (!isActiveOwner) {
      return;
    }

    const activeOwnersCount = await this.getActiveOwnersCount(brand.id);
    const legacyOwnerProvidesIndependentOwner =
      brand.ownerId !== targetMember.userId;

    if (activeOwnersCount <= 1 && !legacyOwnerProvidesIndependentOwner) {
      throw new ForbiddenException(
        'A brand must have at least one active owner',
      );
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
    permission: BrandPermissionCode = BRAND_PERMISSIONS.CATALOG_WRITE,
  ): Promise<void> {
    if (this.brandPermissionService) {
      await this.brandPermissionService.assertPermission(
        userId,
        brandId,
        permission,
      );
      return;
    }

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

  async assertCanUpdateBrandProfile(
    userId: string,
    brandId: string,
  ): Promise<void> {
    if (this.brandPermissionService) {
      await this.brandPermissionService.assertPermission(
        userId,
        brandId,
        BRAND_PERMISSIONS.BRAND_PROFILE_UPDATE,
      );
      return;
    }

    await this.assertBrandAccess(userId, brandId);
  }

  async assertCanSubmitVerification(
    userId: string,
    brandId: string,
  ): Promise<void> {
    if (this.brandPermissionService) {
      await this.brandPermissionService.assertPermission(
        userId,
        brandId,
        BRAND_PERMISSIONS.VERIFICATION_SUBMIT,
      );
      return;
    }

    await this.assertBrandAccess(userId, brandId);
  }

  async assertCanManageStaffWithPermission(
    userId: string,
    brandId: string,
  ): Promise<void> {
    if (await this.isActiveOwner(userId, brandId)) {
      return;
    }

    if (this.brandPermissionService) {
      await this.brandPermissionService.assertPermission(
        userId,
        brandId,
        BRAND_PERMISSIONS.BRAND_STAFF_MANAGE,
      );
      return;
    }

    throw new ForbiddenException('Only a brand owner can manage staff');
  }
}
