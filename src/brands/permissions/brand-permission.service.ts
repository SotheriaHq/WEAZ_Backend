import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BrandMemberRole, BrandMemberStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  BRAND_PERMISSION_CODES,
  BRAND_PERMISSIONS,
  BrandPermissionCode,
  KNOWN_BRAND_PERMISSION_CODES,
  ROLE_DEFAULT_PERMISSIONS,
} from './brand-permissions';

type PermissionSummaryMember = {
  id: string;
  brandId: string;
  userId: string;
  role: BrandMemberRole;
  status: BrandMemberStatus;
  permissionGrants?: Array<{ permissionCode: string }>;
};

@Injectable()
export class BrandPermissionService {
  constructor(private readonly prisma: PrismaService) {}

  validatePermissionCode(permission: string): BrandPermissionCode {
    const normalized = String(permission ?? '').trim();
    if (!KNOWN_BRAND_PERMISSION_CODES.has(normalized as BrandPermissionCode)) {
      throw new BadRequestException(
        `Unknown brand permission code: ${normalized}`,
      );
    }
    return normalized as BrandPermissionCode;
  }

  validatePermissionCodes(permissions: string[]): BrandPermissionCode[] {
    if (!Array.isArray(permissions)) {
      throw new BadRequestException('permissions must be an array');
    }

    return Array.from(
      new Set(
        permissions.map((permission) =>
          this.validatePermissionCode(permission),
        ),
      ),
    );
  }

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

  private sortPermissions(
    permissions: Iterable<BrandPermissionCode>,
  ): BrandPermissionCode[] {
    const permissionSet = new Set(permissions);
    return BRAND_PERMISSION_CODES.filter((code) => permissionSet.has(code));
  }

  private getRoleDefaults(role: BrandMemberRole): BrandPermissionCode[] {
    return [...ROLE_DEFAULT_PERMISSIONS[role]];
  }

  private summarizeMember(member: PermissionSummaryMember) {
    const roleDefaults = this.getRoleDefaults(member.role);
    const explicitPermissions = this.sortPermissions(
      (member.permissionGrants ?? [])
        .map((grant) => grant.permissionCode)
        .filter((code): code is BrandPermissionCode =>
          KNOWN_BRAND_PERMISSION_CODES.has(code as BrandPermissionCode),
        ),
    );
    const effectivePermissions =
      member.status === BrandMemberStatus.ACTIVE
        ? member.role === BrandMemberRole.OWNER
          ? [...BRAND_PERMISSION_CODES]
          : this.sortPermissions([...roleDefaults, ...explicitPermissions])
        : [];

    return {
      memberId: member.id,
      role: member.role,
      status: member.status,
      roleDefaults,
      explicitPermissions,
      effectivePermissions,
    };
  }

  private async getTargetMemberOrThrow(brandId: string, memberId: string) {
    const member = await this.prisma.brandMember.findUnique({
      where: { id: memberId },
      select: {
        id: true,
        brandId: true,
        userId: true,
        role: true,
        status: true,
        permissionGrants: {
          select: { permissionCode: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!member || member.brandId !== brandId) {
      throw new NotFoundException('Brand member not found');
    }

    return member;
  }

  private async assertCanConfigureMemberPermissions(
    actorUserId: string,
    brandId: string,
  ): Promise<void> {
    const brand = await this.resolveBrand(brandId);
    if (brand.ownerId === actorUserId) {
      return;
    }

    const actorMembership = await this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId: actorUserId,
        },
      },
      select: { role: true, status: true },
    });

    if (
      actorMembership?.role === BrandMemberRole.OWNER &&
      actorMembership.status === BrandMemberStatus.ACTIVE
    ) {
      return;
    }

    throw new ForbiddenException(
      'Only a brand owner can manage staff permissions',
    );
  }

  async getEffectivePermissions(
    userId: string,
    brandId: string,
  ): Promise<string[]> {
    const brand = await this.resolveBrand(brandId);
    if (brand.ownerId === userId) {
      return [...BRAND_PERMISSION_CODES];
    }

    const membership = await this.prisma.brandMember.findUnique({
      where: {
        brandId_userId: {
          brandId: brand.id,
          userId,
        },
      },
      select: {
        id: true,
        brandId: true,
        userId: true,
        role: true,
        status: true,
        permissionGrants: {
          select: { permissionCode: true },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    if (!membership || membership.status !== BrandMemberStatus.ACTIVE) {
      return [];
    }

    if (membership.role === BrandMemberRole.OWNER) {
      return [...BRAND_PERMISSION_CODES];
    }

    const explicitPermissions = membership.permissionGrants
      .map((grant) => grant.permissionCode)
      .filter((code): code is BrandPermissionCode =>
        KNOWN_BRAND_PERMISSION_CODES.has(code as BrandPermissionCode),
      );

    return this.sortPermissions([
      ...ROLE_DEFAULT_PERMISSIONS[membership.role],
      ...explicitPermissions,
    ]);
  }

  /** SQL counterpart of getEffectivePermissions for bounded, joined resource reads. */
  buildPermissionPredicate(userId: string, permission: BrandPermissionCode, brandId: Prisma.Sql, ownerId: Prisma.Sql): Prisma.Sql {
    const validated = this.validatePermissionCode(permission);
    const roles = [...new Set<BrandMemberRole>([
      BrandMemberRole.OWNER,
      ...Object.entries(ROLE_DEFAULT_PERMISSIONS)
        .filter(([, permissions]) => permissions.some((permission) => permission === validated))
        .map(([role]) => role as BrandMemberRole),
    ])];
    return Prisma.sql`(${ownerId} = ${userId}::uuid OR EXISTS (
      SELECT 1 FROM "BrandMember" permission_member
      WHERE permission_member."brandId" = ${brandId} AND permission_member."userId" = ${userId}::uuid
        AND permission_member.status = 'ACTIVE'
        AND (permission_member.role IN (${Prisma.join(roles.map((role) => Prisma.sql`${role}::"BrandMemberRole"`))})
          OR EXISTS (SELECT 1 FROM "BrandPermissionGrant" permission_grant
            WHERE permission_grant."brandMemberId" = permission_member.id AND permission_grant."permissionCode" = ${validated}))
    ))`;
  }

  async getBrandIdsWithPermission(userId: string, permission: BrandPermissionCode): Promise<string[]> {
    const validated = this.validatePermissionCode(permission);
    const [owned, members] = await Promise.all([
      this.prisma.brand.findMany({ where: { ownerId: userId }, select: { id: true } }),
      this.prisma.brandMember.findMany({
        where: { userId, status: BrandMemberStatus.ACTIVE },
        select: {
          id: true, brandId: true, userId: true, role: true, status: true,
          permissionGrants: { select: { permissionCode: true } },
        },
      }),
    ]);
    return [...new Set([
      ...owned.map((brand) => brand.id),
      ...members.filter((member) => this.summarizeMember(member).effectivePermissions.includes(validated)).map((member) => member.brandId),
    ])];
  }

  async hasPermission(
    userId: string,
    brandId: string,
    permission: BrandPermissionCode,
  ): Promise<boolean> {
    const validatedPermission = this.validatePermissionCode(permission);
    const permissions = await this.getEffectivePermissions(userId, brandId);
    return permissions.includes(validatedPermission);
  }

  /** Canonical role/grant predicate, scoped to the resource IDs already requested. */
  async getPermittedBrandIds(
    userId: string,
    brandIds: readonly string[],
    permission: BrandPermissionCode,
  ): Promise<Set<string>> {
    const ids = [...new Set(brandIds)].sort();
    const allowed = new Set<string>();
    const predicate = this.buildPermissionPredicate(userId, permission, Prisma.sql`brand."_id"`, Prisma.sql`brand."ownerId"`);
    for (let offset = 0; offset < ids.length; offset += 500) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT brand."_id" AS id FROM "Brand" brand
        WHERE brand."_id" = ANY(${ids.slice(offset, offset + 500)}::uuid[]) AND ${predicate}
      `);
      for (const row of rows) allowed.add(row.id);
    }
    return allowed;
  }

  async assertPermission(
    userId: string,
    brandId: string,
    permission: BrandPermissionCode,
  ): Promise<void> {
    const hasPermission = await this.hasPermission(userId, brandId, permission);
    if (!hasPermission) {
      throw new ForbiddenException(
        'You do not have permission for this brand action',
      );
    }
  }

  async getMemberPermissions(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
  ) {
    const brand = await this.resolveBrand(brandIdOrOwnerId);
    await this.assertCanConfigureMemberPermissions(actorUserId, brand.id);

    const member = await this.getTargetMemberOrThrow(brand.id, memberId);
    return this.summarizeMember(member);
  }

  async setMemberPermissions(
    actorUserId: string,
    brandIdOrOwnerId: string,
    memberId: string,
    permissions: string[],
  ) {
    const brand = await this.resolveBrand(brandIdOrOwnerId);
    await this.assertCanConfigureMemberPermissions(actorUserId, brand.id);
    const normalizedPermissions = this.validatePermissionCodes(permissions);

    const member = await this.getTargetMemberOrThrow(brand.id, memberId);
    if (member.role === BrandMemberRole.OWNER) {
      throw new BadRequestException('Owner permissions cannot be modified');
    }
    if (member.status !== BrandMemberStatus.ACTIVE) {
      throw new BadRequestException(
        'Inactive member permissions cannot be modified',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.brandPermissionGrant.deleteMany({
        where: { brandMemberId: member.id },
      });

      if (normalizedPermissions.length > 0) {
        await tx.brandPermissionGrant.createMany({
          data: normalizedPermissions.map((permissionCode) => ({
            brandMemberId: member.id,
            permissionCode,
          })),
          skipDuplicates: true,
        });
      }
    });

    const updatedMember = await this.getTargetMemberOrThrow(
      brand.id,
      member.id,
    );
    return this.summarizeMember(updatedMember);
  }

  async assertCanManageStaffWithGrant(
    userId: string,
    brandId: string,
  ): Promise<void> {
    await this.assertPermission(
      userId,
      brandId,
      BRAND_PERMISSIONS.BRAND_STAFF_MANAGE,
    );
  }
}
