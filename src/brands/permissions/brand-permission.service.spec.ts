import { BadRequestException } from '@nestjs/common';
import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { BrandPermissionService } from './brand-permission.service';
import { BRAND_PERMISSIONS, BRAND_PERMISSION_CODES } from './brand-permissions';

describe('BrandPermissionService', () => {
  const prisma: any = {
    brand: {
      findFirst: jest.fn(),
    },
    brandMember: {
      findUnique: jest.fn(),
    },
    brandPermissionGrant: {
      deleteMany: jest.fn(),
      createMany: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  };

  const service = new BrandPermissionService(prisma);

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.brand.findFirst.mockResolvedValue({ id: 'brand-1', ownerId: 'owner-1' });
  });

  const mockMember = (
    role: BrandMemberRole,
    status: BrandMemberStatus = BrandMemberStatus.ACTIVE,
    permissionCodes: string[] = [],
  ) => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'staff-1',
      role,
      status,
      permissionGrants: permissionCodes.map((permissionCode) => ({
        permissionCode,
      })),
    });
  };

  it('OWNER gets all permissions through active membership', async () => {
    mockMember(BrandMemberRole.OWNER);

    await expect(
      service.getEffectivePermissions('staff-1', 'brand-1'),
    ).resolves.toEqual(BRAND_PERMISSION_CODES);
  });

  it('legacy owner gets all permissions', async () => {
    await expect(
      service.getEffectivePermissions('owner-1', 'brand-1'),
    ).resolves.toEqual(BRAND_PERMISSION_CODES);
    expect(prisma.brandMember.findUnique).not.toHaveBeenCalled();
  });

  it('MANAGER gets catalog.write through role defaults', async () => {
    mockMember(BrandMemberRole.MANAGER);

    await expect(
      service.hasPermission('staff-1', 'brand-1', BRAND_PERMISSIONS.CATALOG_WRITE),
    ).resolves.toBe(true);
  });

  it('CATALOG_MANAGER gets catalog.write and catalog.delete', async () => {
    mockMember(BrandMemberRole.CATALOG_MANAGER);

    await expect(
      service.getEffectivePermissions('staff-1', 'brand-1'),
    ).resolves.toEqual([
      BRAND_PERMISSIONS.CATALOG_READ,
      BRAND_PERMISSIONS.CATALOG_WRITE,
      BRAND_PERMISSIONS.CATALOG_DELETE,
    ]);
  });

  it('VIEWER does not get catalog.write', async () => {
    mockMember(BrandMemberRole.VIEWER);

    await expect(
      service.hasPermission('staff-1', 'brand-1', BRAND_PERMISSIONS.CATALOG_WRITE),
    ).resolves.toBe(false);
  });

  it('inactive member gets no permissions', async () => {
    mockMember(BrandMemberRole.CATALOG_MANAGER, BrandMemberStatus.SUSPENDED);

    await expect(
      service.getEffectivePermissions('staff-1', 'brand-1'),
    ).resolves.toEqual([]);
  });

  it('explicit grants add permissions', async () => {
    mockMember(BrandMemberRole.VIEWER, BrandMemberStatus.ACTIVE, [
      BRAND_PERMISSIONS.CATALOG_WRITE,
    ]);

    await expect(
      service.hasPermission('staff-1', 'brand-1', BRAND_PERMISSIONS.CATALOG_WRITE),
    ).resolves.toBe(true);
  });

  it('clearing explicit grants leaves role defaults in place', async () => {
    prisma.brandMember.findUnique
      .mockResolvedValueOnce({
        role: BrandMemberRole.OWNER,
        status: BrandMemberStatus.ACTIVE,
      })
      .mockResolvedValueOnce({
        id: 'member-1',
        brandId: 'brand-1',
        userId: 'staff-1',
        role: BrandMemberRole.VIEWER,
        status: BrandMemberStatus.ACTIVE,
        permissionGrants: [{ permissionCode: BRAND_PERMISSIONS.CATALOG_WRITE }],
      })
      .mockResolvedValueOnce({
        id: 'member-1',
        brandId: 'brand-1',
        userId: 'staff-1',
        role: BrandMemberRole.VIEWER,
        status: BrandMemberStatus.ACTIVE,
        permissionGrants: [],
      });

    await expect(
      service.setMemberPermissions('owner-2', 'brand-1', 'member-1', []),
    ).resolves.toEqual(
      expect.objectContaining({
        roleDefaults: [
          BRAND_PERMISSIONS.BRAND_PROFILE_READ,
          BRAND_PERMISSIONS.CATALOG_READ,
          BRAND_PERMISSIONS.ORDERS_READ,
        ],
        explicitPermissions: [],
        effectivePermissions: [
          BRAND_PERMISSIONS.BRAND_PROFILE_READ,
          BRAND_PERMISSIONS.CATALOG_READ,
          BRAND_PERMISSIONS.ORDERS_READ,
        ],
      }),
    );
    expect(prisma.brandPermissionGrant.deleteMany).toHaveBeenCalledWith({
      where: { brandMemberId: 'member-1' },
    });
    expect(prisma.brandPermissionGrant.createMany).not.toHaveBeenCalled();
  });

  it('unknown permission is rejected', async () => {
    await expect(
      service.setMemberPermissions('owner-1', 'brand-1', 'member-1', [
        'unknown.permission',
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot set permissions on OWNER member', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'owner-1',
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
      permissionGrants: [],
    });

    await expect(
      service.setMemberPermissions('owner-1', 'brand-1', 'member-1', [
        BRAND_PERMISSIONS.CATALOG_WRITE,
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cannot set permissions on inactive member', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'staff-1',
      role: BrandMemberRole.VIEWER,
      status: BrandMemberStatus.REMOVED,
      permissionGrants: [],
    });

    await expect(
      service.setMemberPermissions('owner-1', 'brand-1', 'member-1', [
        BRAND_PERMISSIONS.CATALOG_WRITE,
      ]),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
