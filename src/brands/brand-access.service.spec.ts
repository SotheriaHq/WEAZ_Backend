import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { BrandAccessService } from './brand-access.service';

describe('BrandAccessService', () => {
  const prisma: any = {
    brand: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    brandMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
    },
  };

  const service = new BrandAccessService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('owner can access own brand', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });

    await expect(service.canAccessBrand('owner-1', 'brand-1')).resolves.toBe(true);
  });

  it('active member can access brand', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue({
      status: BrandMemberStatus.ACTIVE,
    });

    await expect(service.canAccessBrand('staff-1', 'brand-1')).resolves.toBe(true);
  });

  it.each([
    BrandMemberStatus.INVITED,
    BrandMemberStatus.SUSPENDED,
    BrandMemberStatus.REMOVED,
  ])('%s member cannot access protected operations', async (status) => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue({ status });

    await expect(service.canAccessBrand('staff-1', 'brand-1')).resolves.toBe(false);
    await expect(service.assertBrandAccess('staff-1', 'brand-1')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('unrelated user cannot access brand', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue(null);

    await expect(service.canAccessBrand('user-1', 'brand-1')).resolves.toBe(false);
  });

  it('missing brand throws clean error', async () => {
    prisma.brand.findFirst.mockResolvedValue(null);

    await expect(service.canAccessBrand('user-1', 'missing-brand')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('BrandMember OWNER is treated as brand owner', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'legacy-owner' });
    prisma.brandMember.findUnique.mockResolvedValue({
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    });

    await expect(service.isBrandOwner('owner-1', 'brand-1')).resolves.toBe(true);
  });

  it.each([
    BrandMemberRole.OWNER,
    BrandMemberRole.MANAGER,
    BrandMemberRole.CATALOG_MANAGER,
  ])('%s can manage catalog when active', async (role) => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue({
      role,
      status: BrandMemberStatus.ACTIVE,
    });

    await expect(
      service.assertCanManageCatalog('staff-1', 'brand-1'),
    ).resolves.toBeUndefined();
  });

  it('legacy owner can manage catalog', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });

    await expect(
      service.assertCanManageCatalog('owner-1', 'brand-1'),
    ).resolves.toBeUndefined();
    expect(prisma.brandMember.findUnique).not.toHaveBeenCalled();
  });

  it.each([
    BrandMemberRole.VIEWER,
    BrandMemberRole.ORDER_MANAGER,
    BrandMemberRole.SUPPORT_AGENT,
  ])('%s cannot manage catalog', async (role) => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue({
      role,
      status: BrandMemberStatus.ACTIVE,
    });

    await expect(
      service.assertCanManageCatalog('staff-1', 'brand-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it.each([
    BrandMemberStatus.INVITED,
    BrandMemberStatus.SUSPENDED,
    BrandMemberStatus.REMOVED,
  ])('%s member cannot manage catalog', async (status) => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue({
      role: BrandMemberRole.CATALOG_MANAGER,
      status,
    });

    await expect(
      service.assertCanManageCatalog('staff-1', 'brand-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('unrelated user cannot manage another brand catalog', async () => {
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
    prisma.brandMember.findUnique.mockResolvedValue(null);

    await expect(
      service.assertCanManageCatalog('user-1', 'brand-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
