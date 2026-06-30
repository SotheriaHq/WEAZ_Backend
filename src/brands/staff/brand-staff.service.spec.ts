import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  BrandMemberRole,
  BrandMemberStatus,
  BrandStaffInviteStatus,
  Role,
} from '@prisma/client';
import { createHash } from 'crypto';
import { BrandStaffService } from './brand-staff.service';

describe('BrandStaffService', () => {
  const hashToken = (token: string) =>
    createHash('sha256').update(token).digest('hex');

  const brandAccessService = {
    resolveBrandIdFromBrandOrOwnerId: jest.fn(),
    assertCanManageStaff: jest.fn(),
    assertNotLastOwner: jest.fn(),
  };
  const brandPermissionService = {
    getMemberPermissions: jest.fn(),
    setMemberPermissions: jest.fn(),
  };
  const emailService = {
    getAppName: jest.fn(),
    send: jest.fn(),
  };
  const adminAuditService = {
    safeLog: jest.fn(),
    safeLogInTransaction: jest.fn(),
  };

  const prisma: any = {
    user: {
      findUnique: jest.fn(),
    },
    brand: {
      findUnique: jest.fn(),
    },
    brandMember: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    brandStaffInvite: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn((callback) => callback(prisma)),
  };

  const service = new BrandStaffService(
    prisma,
    brandAccessService as any,
    brandPermissionService as any,
    emailService as any,
    adminAuditService as any,
  );

  beforeEach(() => {
    jest.clearAllMocks();
    brandAccessService.resolveBrandIdFromBrandOrOwnerId.mockResolvedValue(
      'brand-1',
    );
    brandAccessService.assertCanManageStaff.mockResolvedValue(undefined);
    brandAccessService.assertNotLastOwner.mockResolvedValue(undefined);
    brandPermissionService.getMemberPermissions.mockResolvedValue({
      memberId: 'member-1',
      role: BrandMemberRole.VIEWER,
      status: BrandMemberStatus.ACTIVE,
      roleDefaults: [],
      explicitPermissions: [],
      effectivePermissions: [],
    });
    brandPermissionService.setMemberPermissions.mockResolvedValue({
      memberId: 'member-1',
      role: BrandMemberRole.VIEWER,
      status: BrandMemberStatus.ACTIVE,
      roleDefaults: [],
      explicitPermissions: ['catalog.write'],
      effectivePermissions: ['catalog.read', 'catalog.write'],
    });
    emailService.getAppName.mockReturnValue('WIEZ');
    emailService.send.mockResolvedValue({
      outboxId: 'email-outbox-1',
      dispatchStatus: 'QUEUED',
      providerMessageId: null,
      errorMessage: null,
    });
    adminAuditService.safeLog.mockResolvedValue(undefined);
    adminAuditService.safeLogInTransaction.mockResolvedValue(undefined);
    prisma.user.findUnique.mockResolvedValue(null);
    prisma.brand.findUnique.mockResolvedValue({ name: 'Test Brand' });
    prisma.brandMember.findUnique.mockResolvedValue(null);
    prisma.brandStaffInvite.findFirst.mockResolvedValue(null);
  });

  it('owner can invite staff', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: Role.User,
    });
    prisma.brandStaffInvite.create.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
      }),
    );

    const result = await service.inviteStaff('owner-1', 'brand-1', {
      email: ' STAFF@example.com ',
      role: BrandMemberRole.MANAGER,
    });

    expect(brandAccessService.assertCanManageStaff).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
    );
    expect(result.email).toBe('staff@example.com');
    expect(result.role).toBe(BrandMemberRole.MANAGER);
    expect(result.status).toBe(BrandStaffInviteStatus.PENDING);
    expect(result.inviteToken).toEqual(expect.any(String));
    expect(result.emailDelivery.dispatchStatus).toBe('QUEUED');
    expect(emailService.send).toHaveBeenCalledWith(
      'staff@example.com',
      expect.stringContaining('Test Brand'),
      expect.stringContaining('/brand/staff/invite?token='),
      expect.stringContaining('/brand/staff/invite?token='),
      expect.objectContaining({
        scenarioKey: 'brand.staff.invite',
        payloadJson: expect.not.objectContaining({
          inviteToken: expect.anything(),
          token: expect.anything(),
        }),
      }),
    );
    expect(adminAuditService.safeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'BrandStaffInvite',
        targetId: expect.any(String),
        metadata: expect.not.objectContaining({
          inviteToken: expect.anything(),
          token: expect.anything(),
        }),
      }),
    );
    expect(prisma.brandStaffInvite.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          email: 'staff@example.com',
          invitedUserId: 'staff-1',
          tokenHash: expect.not.stringContaining(result.inviteToken),
        }),
      }),
    );
  });

  it('keeps pending invite when invite email queue fails', async () => {
    emailService.send.mockResolvedValue({
      outboxId: null,
      dispatchStatus: 'FAILED',
      providerMessageId: null,
      errorMessage: 'outbox unavailable',
    });
    prisma.brandStaffInvite.create.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
      }),
    );

    const result = await service.inviteStaff('owner-1', 'brand-1', {
      email: 'staff@example.com',
      role: BrandMemberRole.VIEWER,
    });

    expect(result.status).toBe(BrandStaffInviteStatus.PENDING);
    expect(result.emailDelivery.dispatchStatus).toBe('FAILED');
    expect(prisma.brandStaffInvite.create).toHaveBeenCalled();
  });

  it('non-owner cannot invite staff', async () => {
    brandAccessService.assertCanManageStaff.mockRejectedValue(
      new ForbiddenException('Only a brand owner can manage staff'),
    );

    await expect(
      service.inviteStaff('manager-1', 'brand-1', {
        email: 'staff@example.com',
        role: BrandMemberRole.MANAGER,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.brandStaffInvite.create).not.toHaveBeenCalled();
  });

  it('duplicate active member invite is rejected', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: Role.User,
    });
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      status: BrandMemberStatus.ACTIVE,
    });

    await expect(
      service.inviteStaff('owner-1', 'brand-1', {
        email: 'staff@example.com',
        role: BrandMemberRole.MANAGER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('duplicate pending invite is rejected', async () => {
    prisma.brandStaffInvite.findFirst.mockResolvedValue({ id: 'invite-1' });

    await expect(
      service.inviteStaff('owner-1', 'brand-1', {
        email: 'staff@example.com',
        role: BrandMemberRole.MANAGER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('invalid staff role is rejected', async () => {
    await expect(
      service.inviteStaff('owner-1', 'brand-1', {
        email: 'staff@example.com',
        role: BrandMemberRole.OWNER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('platform admin invite is rejected', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: Role.Admin,
    });

    await expect(
      service.inviteStaff('owner-1', 'brand-1', {
        email: 'admin@example.com',
        role: BrandMemberRole.MANAGER,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('owner can list staff', async () => {
    prisma.brandMember.findMany.mockResolvedValue([
      {
        id: 'member-1',
        userId: 'staff-1',
        role: BrandMemberRole.MANAGER,
        status: BrandMemberStatus.ACTIVE,
        joinedAt: new Date('2026-05-06T00:00:00.000Z'),
        invitedById: 'owner-1',
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        user: {
          email: 'staff@example.com',
          username: 'staff',
          firstName: 'Staff',
          lastName: 'One',
        },
      },
    ]);
    prisma.brandStaffInvite.findMany.mockResolvedValue([]);

    const result = await service.listStaff('owner-1', 'brand-1');

    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toEqual(
      expect.objectContaining({
        userId: 'staff-1',
        email: 'staff@example.com',
        role: BrandMemberRole.MANAGER,
      }),
    );
  });

  it('non-owner cannot list staff', async () => {
    brandAccessService.assertCanManageStaff.mockRejectedValue(
      new ForbiddenException('Only a brand owner can manage staff'),
    );

    await expect(
      service.listStaff('manager-1', 'brand-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('valid token accepts invite', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    prisma.brandStaffInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      brandId: 'brand-1',
      email: 'staff@example.com',
      role: BrandMemberRole.CATALOG_MANAGER,
      status: BrandStaffInviteStatus.PENDING,
      tokenHash: hashToken(token),
      invitedById: 'owner-1',
      invitedUserId: 'staff-1',
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: Role.User,
    });
    prisma.brandMember.create.mockImplementation(({ data }) =>
      Promise.resolve({
        ...data,
        createdAt: new Date('2026-05-06T00:00:00.000Z'),
        updatedAt: new Date('2026-05-06T00:00:00.000Z'),
        user: { email: 'staff@example.com', username: 'staff' },
      }),
    );
    prisma.brandStaffInvite.update.mockResolvedValue({});

    const result = await service.acceptInvite('staff-1', token);

    expect(result).toEqual(
      expect.objectContaining({
        userId: 'staff-1',
        role: BrandMemberRole.CATALOG_MANAGER,
        status: BrandMemberStatus.ACTIVE,
      }),
    );
    expect(prisma.brandMember.create).toHaveBeenCalled();
    expect(prisma.brandStaffInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: BrandStaffInviteStatus.ACCEPTED,
          invitedUserId: 'staff-1',
          acceptedAt: expect.any(Date),
        }),
      }),
    );
    expect(adminAuditService.safeLogInTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        targetType: 'BrandStaffInvite',
        targetId: 'invite-1',
        metadata: expect.objectContaining({
          memberId: expect.any(String),
        }),
      }),
    );
  });

  it('expired token is rejected', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    prisma.brandStaffInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      email: 'staff@example.com',
      status: BrandStaffInviteStatus.PENDING,
      expiresAt: new Date(Date.now() - 1_000),
      acceptedAt: null,
    });

    await expect(service.acceptInvite('staff-1', token)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.brandStaffInvite.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: BrandStaffInviteStatus.EXPIRED },
      }),
    );
  });

  it('reused token is rejected', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    prisma.brandStaffInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      status: BrandStaffInviteStatus.ACCEPTED,
      acceptedAt: new Date(),
    });

    await expect(service.acceptInvite('staff-1', token)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('wrong email cannot accept invite', async () => {
    const token = '0123456789abcdef0123456789abcdef';
    prisma.brandStaffInvite.findUnique.mockResolvedValue({
      id: 'invite-1',
      email: 'staff@example.com',
      status: BrandStaffInviteStatus.PENDING,
      expiresAt: new Date(Date.now() + 60_000),
      acceptedAt: null,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'other-1',
      email: 'other@example.com',
      role: Role.User,
    });

    await expect(service.acceptInvite('other-1', token)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('owner can update staff role', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'staff-1',
      role: BrandMemberRole.VIEWER,
      status: BrandMemberStatus.ACTIVE,
    });
    prisma.brandMember.update.mockResolvedValue({
      id: 'member-1',
      userId: 'staff-1',
      role: BrandMemberRole.MANAGER,
      status: BrandMemberStatus.ACTIVE,
      user: { email: 'staff@example.com' },
    });

    const result = await service.updateStaffRole(
      'owner-1',
      'brand-1',
      'member-1',
      BrandMemberRole.MANAGER,
    );

    expect(result.role).toBe(BrandMemberRole.MANAGER);
    expect(adminAuditService.safeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'BrandMember',
        targetId: 'member-1',
        previousState: { role: BrandMemberRole.VIEWER },
        newState: { role: BrandMemberRole.MANAGER },
      }),
    );
  });

  it('owner cannot demote last OWNER', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'owner-1',
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    });
    brandAccessService.assertNotLastOwner.mockRejectedValue(
      new ForbiddenException('A brand must have at least one active owner'),
    );

    await expect(
      service.updateStaffRole(
        'owner-1',
        'brand-1',
        'member-1',
        BrandMemberRole.MANAGER,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('owner can suspend and reactivate staff', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'staff-1',
      role: BrandMemberRole.MANAGER,
      status: BrandMemberStatus.ACTIVE,
      joinedAt: new Date('2026-05-06T00:00:00.000Z'),
    });
    prisma.brandMember.update
      .mockResolvedValueOnce({
        id: 'member-1',
        userId: 'staff-1',
        role: BrandMemberRole.MANAGER,
        status: BrandMemberStatus.SUSPENDED,
        joinedAt: new Date('2026-05-06T00:00:00.000Z'),
        user: { email: 'staff@example.com' },
      })
      .mockResolvedValueOnce({
        id: 'member-1',
        userId: 'staff-1',
        role: BrandMemberRole.MANAGER,
        status: BrandMemberStatus.ACTIVE,
        joinedAt: new Date('2026-05-06T00:00:00.000Z'),
        user: { email: 'staff@example.com' },
      });

    await expect(
      service.updateStaffStatus(
        'owner-1',
        'brand-1',
        'member-1',
        BrandMemberStatus.SUSPENDED,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ status: BrandMemberStatus.SUSPENDED }),
    );
    await expect(
      service.updateStaffStatus(
        'owner-1',
        'brand-1',
        'member-1',
        BrandMemberStatus.ACTIVE,
      ),
    ).resolves.toEqual(
      expect.objectContaining({ status: BrandMemberStatus.ACTIVE }),
    );
  });

  it('owner can remove staff', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'staff-1',
      role: BrandMemberRole.MANAGER,
      status: BrandMemberStatus.ACTIVE,
    });
    prisma.brandMember.update.mockResolvedValue({
      id: 'member-1',
      userId: 'staff-1',
      role: BrandMemberRole.MANAGER,
      status: BrandMemberStatus.REMOVED,
      user: { email: 'staff@example.com' },
    });

    await expect(
      service.removeStaff('owner-1', 'brand-1', 'member-1'),
    ).resolves.toEqual(
      expect.objectContaining({ status: BrandMemberStatus.REMOVED }),
    );
  });

  it('owner cannot remove last OWNER', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      brandId: 'brand-1',
      userId: 'owner-1',
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    });
    brandAccessService.assertNotLastOwner.mockRejectedValue(
      new ForbiddenException('A brand must have at least one active owner'),
    );

    await expect(
      service.removeStaff('owner-1', 'brand-1', 'member-1'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('owner can view member permissions', async () => {
    await expect(
      service.getStaffPermissions('owner-1', 'brand-1', 'member-1'),
    ).resolves.toEqual(
      expect.objectContaining({
        memberId: 'member-1',
        effectivePermissions: [],
      }),
    );
    expect(brandPermissionService.getMemberPermissions).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
    );
  });

  it('owner can update member permissions', async () => {
    await expect(
      service.updateStaffPermissions('owner-1', 'brand-1', 'member-1', [
        'catalog.write',
      ]),
    ).resolves.toEqual(
      expect.objectContaining({
        explicitPermissions: ['catalog.write'],
      }),
    );
    expect(brandPermissionService.setMemberPermissions).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
      ['catalog.write'],
    );
    expect(adminAuditService.safeLog).toHaveBeenCalledWith(
      expect.objectContaining({
        targetType: 'BrandMember',
        targetId: 'member-1',
        metadata: expect.objectContaining({
          permissions: ['catalog.write'],
        }),
      }),
    );
  });

  it('non-owner cannot update permissions', async () => {
    brandPermissionService.setMemberPermissions.mockRejectedValue(
      new ForbiddenException('Only a brand owner can manage staff permissions'),
    );

    await expect(
      service.updateStaffPermissions('manager-1', 'brand-1', 'member-1', [
        'catalog.write',
      ]),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
