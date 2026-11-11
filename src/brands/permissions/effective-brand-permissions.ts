import type { Prisma } from '@prisma/client';
import { BRAND_PERMISSION_CODES, KNOWN_BRAND_PERMISSION_CODES, ROLE_DEFAULT_PERMISSIONS, type BrandPermissionCode } from './brand-permissions';
import { NotFoundException } from '@nestjs/common';
import { isActiveOwnerMembership } from '../brand-ownership';

/** Canonical permission calculation, usable with the active transaction client. */
export async function effectiveBrandPermissions(client: Pick<Prisma.TransactionClient, 'brand' | 'brandMember'>, userId: string, brandIdOrOwnerId: string): Promise<string[]> {
  const brand = await client.brand.findFirst({ where: { OR: [{ id: brandIdOrOwnerId }, { ownerId: brandIdOrOwnerId }] }, select: { id: true, ownerId: true } });
  if (!brand) throw new NotFoundException('Brand not found');
  if (brand.ownerId === userId) return [...BRAND_PERMISSION_CODES];
  const member = await client.brandMember.findUnique({ where: { brandId_userId: { brandId: brand.id, userId } },
    select: { id: true, brandId: true, userId: true, role: true, status: true,
      permissionGrants: { select: { permissionCode: true }, orderBy: { createdAt: 'asc' } } } });
  if (!member || member.status !== 'ACTIVE') return [];
  if (isActiveOwnerMembership(member)) return [...BRAND_PERMISSION_CODES];
  const permissions = new Set<BrandPermissionCode>([...ROLE_DEFAULT_PERMISSIONS[member.role],
    ...member.permissionGrants.map((grant) => grant.permissionCode).filter((code): code is BrandPermissionCode => KNOWN_BRAND_PERMISSION_CODES.has(code as BrandPermissionCode))]);
  return BRAND_PERMISSION_CODES.filter((code) => permissions.has(code));
}
