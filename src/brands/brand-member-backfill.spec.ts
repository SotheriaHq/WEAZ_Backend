import { BrandMemberRole, BrandMemberStatus } from '@prisma/client';
import { runBrandMemberBackfill } from '../../scripts/backfill-brand-members';

describe('brand member backfill', () => {
  const prisma: any = {
    brand: {
      findMany: jest.fn(),
    },
    brandMember: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
  };

  beforeEach(() => {
    jest.clearAllMocks();
    prisma.brand.findMany.mockResolvedValue([
      {
        id: 'brand-1',
        ownerId: 'owner-1',
        createdAt: new Date('2026-05-01T00:00:00.000Z'),
      },
    ]);
  });

  it('dry-run does not write missing owner membership', async () => {
    prisma.brandMember.findUnique.mockResolvedValue(null);

    const counts = await runBrandMemberBackfill(prisma, { write: false });

    expect(counts.ownersMissingMembership).toBe(1);
    expect(counts.ownerMembershipsCreated).toBe(0);
    expect(prisma.brandMember.create).not.toHaveBeenCalled();
  });

  it('write creates missing owner memberships', async () => {
    prisma.brandMember.findUnique.mockResolvedValue(null);
    prisma.brandMember.create.mockResolvedValue({});

    const counts = await runBrandMemberBackfill(prisma, { write: true });

    expect(counts.ownersMissingMembership).toBe(1);
    expect(counts.ownerMembershipsCreated).toBe(1);
    expect(prisma.brandMember.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          brandId: 'brand-1',
          userId: 'owner-1',
          role: BrandMemberRole.OWNER,
          status: BrandMemberStatus.ACTIVE,
          joinedAt: new Date('2026-05-01T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('does not create duplicate BrandMember when already valid', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: BrandMemberRole.OWNER,
      status: BrandMemberStatus.ACTIVE,
    });

    const counts = await runBrandMemberBackfill(prisma, { write: true });

    expect(counts.alreadyValid).toBe(1);
    expect(prisma.brandMember.create).not.toHaveBeenCalled();
  });

  it('reports conflict if owner has non-OWNER membership', async () => {
    prisma.brandMember.findUnique.mockResolvedValue({
      id: 'member-1',
      role: BrandMemberRole.MANAGER,
      status: BrandMemberStatus.ACTIVE,
    });

    const counts = await runBrandMemberBackfill(prisma, { write: true });

    expect(counts.conflictsDetected).toBe(1);
    expect(prisma.brandMember.update).not.toHaveBeenCalled();
  });
});
