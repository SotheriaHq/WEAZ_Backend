import { BrandMemberRole, BrandMemberStatus, type Prisma } from '@prisma/client';

export function isActiveOwnerMembership(member: { role: BrandMemberRole; status: BrandMemberStatus } | null | undefined): boolean {
  return member?.role === BrandMemberRole.OWNER && member.status === BrandMemberStatus.ACTIVE;
}

/** Canonical ownership rule shared by domain checks and locked authorization. */
export async function hasBrandOwnership(client: Pick<Prisma.TransactionClient, 'brandMember'>,
  userId: string, brand: { id: string; ownerId: string }): Promise<boolean> {
  if (brand.ownerId === userId) return true;
  const member = await client.brandMember.findUnique({
    where: { brandId_userId: { brandId: brand.id, userId } }, select: { role: true, status: true },
  });
  return isActiveOwnerMembership(member);
}
