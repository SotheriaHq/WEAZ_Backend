import { ConflictException, ForbiddenException } from '@nestjs/common';
import { AdminDisputeStatus, Role } from '@prisma/client';
import { AdminDisputesService } from './admin-disputes.service';

describe('AdminDisputesService', () => {
  const prisma = {
    dispute: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(),
  } as any;

  const service = new AdminDisputesService(prisma);
  const req = {
    socket: { remoteAddress: '127.0.0.1' },
    headers: { 'user-agent': 'jest' },
  } as any;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('blocks non-superadmin claim when dispute is assigned to another admin', async () => {
    prisma.dispute.findUnique.mockResolvedValue({
      id: 'd_1',
      status: AdminDisputeStatus.OPEN,
      assignedToId: 'admin_1',
    });

    await expect(
      service.claim('d_1', 'admin_2', Role.Admin, req),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('requires ownership before non-superadmin update', async () => {
    prisma.dispute.findUnique.mockResolvedValue({
      id: 'd_1',
      status: AdminDisputeStatus.OPEN,
      assignedToId: null,
      resolution: null,
    });

    await expect(
      service.update(
        'd_1',
        { status: AdminDisputeStatus.IN_PROGRESS },
        'admin_1',
        Role.Admin,
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('claims an open dispute and moves it to assigned', async () => {
    prisma.dispute.findUnique.mockResolvedValue({
      id: 'd_1',
      status: AdminDisputeStatus.OPEN,
      assignedToId: null,
    });

    prisma.$transaction.mockImplementation(async (callback: any) =>
      callback({
        dispute: {
          update: jest.fn().mockResolvedValue({
            id: 'd_1',
            status: AdminDisputeStatus.ASSIGNED,
            assignedToId: 'admin_1',
          }),
        },
        adminAuditLog: {
          create: jest.fn().mockResolvedValue(undefined),
        },
      }),
    );

    const result = await service.claim('d_1', 'admin_1', Role.Admin, req);

    expect(result).toEqual({
      id: 'd_1',
      status: AdminDisputeStatus.ASSIGNED,
      assignedToId: 'admin_1',
    });
  });
});
