import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { BrandStaffController } from './brand-staff.controller';

describe('BrandStaffController', () => {
  const brandStaffService = {
    listStaff: jest.fn(),
    inviteStaff: jest.fn(),
    cancelInvite: jest.fn(),
    acceptInvite: jest.fn(),
    rejectInvite: jest.fn(),
    updateStaffRole: jest.fn(),
    updateStaffStatus: jest.fn(),
    getStaffPermissions: jest.fn(),
    updateStaffPermissions: jest.fn(),
    removeStaff: jest.fn(),
  };

  const controller = new BrandStaffController(brandStaffService as any);

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('delegates owner staff listing with the authenticated user id', async () => {
    brandStaffService.listStaff.mockResolvedValue({ members: [], invites: [] });

    await expect(
      controller.listStaff('brand-1', { user: { id: 'owner-1' } }),
    ).resolves.toEqual({ members: [], invites: [] });
    expect(brandStaffService.listStaff).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
    );
  });

  it('delegates staff invitation with the authenticated owner id', async () => {
    brandStaffService.inviteStaff.mockResolvedValue({ id: 'invite-1' });

    await expect(
      controller.inviteStaff(
        'brand-1',
        { email: 'staff@example.com', role: BrandMemberRole.MANAGER },
        { user: { id: 'owner-1' } },
      ),
    ).resolves.toEqual({ id: 'invite-1' });
    expect(brandStaffService.inviteStaff).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      { email: 'staff@example.com', role: BrandMemberRole.MANAGER },
    );
  });

  it('delegates invite acceptance through token flow', async () => {
    brandStaffService.acceptInvite.mockResolvedValue({ id: 'member-1' });

    await expect(
      controller.acceptInvite(
        { token: '0123456789abcdef' },
        { user: { id: 'staff-1' } },
      ),
    ).resolves.toEqual({ id: 'member-1' });
    expect(brandStaffService.acceptInvite).toHaveBeenCalledWith(
      'staff-1',
      '0123456789abcdef',
    );
  });

  it('delegates role and status changes to the staff service', async () => {
    brandStaffService.updateStaffRole.mockResolvedValue({ id: 'member-1' });
    brandStaffService.updateStaffStatus.mockResolvedValue({ id: 'member-1' });

    await controller.updateStaffRole(
      'brand-1',
      'member-1',
      { role: BrandMemberRole.CATALOG_MANAGER },
      { user: { id: 'owner-1' } },
    );
    await controller.updateStaffStatus(
      'brand-1',
      'member-1',
      { status: BrandMemberStatus.SUSPENDED },
      { user: { id: 'owner-1' } },
    );

    expect(brandStaffService.updateStaffRole).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
      BrandMemberRole.CATALOG_MANAGER,
    );
    expect(brandStaffService.updateStaffStatus).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
      BrandMemberStatus.SUSPENDED,
    );
  });

  it('delegates staff permission view and update to the staff service', async () => {
    brandStaffService.getStaffPermissions.mockResolvedValue({
      memberId: 'member-1',
      roleDefaults: [],
      explicitPermissions: [],
      effectivePermissions: [],
    });
    brandStaffService.updateStaffPermissions.mockResolvedValue({
      memberId: 'member-1',
      explicitPermissions: ['catalog.write'],
    });

    await expect(
      controller.getStaffPermissions('brand-1', 'member-1', {
        user: { id: 'owner-1' },
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        memberId: 'member-1',
      }),
    );

    await expect(
      controller.updateStaffPermissions(
        'brand-1',
        'member-1',
        { permissions: ['catalog.write'] },
        { user: { id: 'owner-1' } },
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        explicitPermissions: ['catalog.write'],
      }),
    );

    expect(brandStaffService.getStaffPermissions).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
    );
    expect(brandStaffService.updateStaffPermissions).toHaveBeenCalledWith(
      'owner-1',
      'brand-1',
      'member-1',
      ['catalog.write'],
    );
  });
});
