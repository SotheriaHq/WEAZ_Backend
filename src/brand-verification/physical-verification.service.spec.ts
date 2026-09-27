import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import {
  BrandVerificationStatus,
  NotificationType,
  PhysicalVerificationBrandResponse,
  PhysicalVerificationStatus,
} from '@prisma/client';

import {
  MAX_RESCHEDULES,
  MIN_PROOFS_FOR_DECISION,
  PhysicalVerificationService,
} from './physical-verification.service';

/**
 * The rules that make the visit step trustworthy, pinned.
 *
 * Three of them carry the whole design:
 *  - a brand may only choose a time the agent actually offered;
 *  - refusing the visit fails the attempt outright;
 *  - a verdict cannot be recorded without evidence behind it.
 */
describe('PhysicalVerificationService', () => {
  const futureSlot = (days: number) =>
    new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  const buildService = (overrides: Record<string, any> = {}) => {
    const prisma: any = {
      brandPhysicalVerification: {
        findUnique: jest.fn(),
        findUniqueOrThrow: jest.fn(),
        findFirst: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(async () => ({
          id: 'pv_1',
          brandId: 'brand_1',
          assignedAgentId: 'agent_1',
          brand: { id: 'brand_1', name: 'Nuel', ownerId: 'owner_1' },
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
        create: jest.fn(),
      },
      physicalVerificationProof: {
        count: jest.fn(async () => MIN_PROOFS_FOR_DECISION),
        create: jest.fn(),
        deleteMany: jest.fn(),
      },
      brand: { update: jest.fn() },
      brandVerificationAttempt: { update: jest.fn() },
      user: {
        findUnique: jest.fn(async () => ({
          id: 'agent_1',
          status: 'ACTIVE',
          role: 'Admin',
        })),
      },
      $transaction: jest.fn(async (cb: any) => cb(prisma)),
      ...overrides,
    };
    const notifications = { create: jest.fn() };
    const service = new PhysicalVerificationService(
      prisma as any,
      notifications as any,
    );
    // Every mutating path ends by re-reading the row for its response.
    jest
      .spyOn(service, 'getDetail')
      .mockResolvedValue({ id: 'pv_1' } as any);
    return { service, prisma, notifications };
  };

  const proposedRow = (extra: Record<string, any> = {}) => ({
    id: 'pv_1',
    brandId: 'brand_1',
    attemptId: 'attempt_1',
    status: PhysicalVerificationStatus.SCHEDULE_PROPOSED,
    assignedAgentId: 'agent_1',
    proposedSlots: [futureSlot(3), futureSlot(5)],
    rescheduleCount: 0,
    brand: { id: 'brand_1', name: 'Nuel', ownerId: 'owner_1' },
    ...extra,
  });

  it('refuses a time the agent never offered', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue(
      proposedRow(),
    );

    await expect(
      service.submitBrandReply('owner_1', 'pv_1', {
        response: PhysicalVerificationBrandResponse.AGREED,
        // A real, parseable time — just not one on the table.
        selectedSlot: futureSlot(9),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.brandPhysicalVerification.update).not.toHaveBeenCalled();
  });

  it('accepts a time that was offered and confirms the schedule', async () => {
    const { service, prisma, notifications } = buildService();
    const row = proposedRow();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue(row);

    await service.submitBrandReply('owner_1', 'pv_1', {
      response: PhysicalVerificationBrandResponse.AGREED,
      selectedSlot: (row.proposedSlots as string[])[1],
    });

    const data = prisma.brandPhysicalVerification.update.mock.calls[0][0].data;
    expect(data.status).toBe(PhysicalVerificationStatus.SCHEDULE_CONFIRMED);
    expect(notifications.create).toHaveBeenCalledWith(
      'agent_1',
      NotificationType.VERIFICATION_VISIT_CONFIRMED,
      expect.anything(),
    );
  });

  it('counts a reschedule and stops at the budget', async () => {
    const { service, prisma } = buildService();
    const row = proposedRow({ rescheduleCount: MAX_RESCHEDULES });
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue(row);

    await expect(
      service.submitBrandReply('owner_1', 'pv_1', {
        response: PhysicalVerificationBrandResponse.RESCHEDULE_REQUESTED,
        selectedSlot: (row.proposedSlots as string[])[0],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('declining the visit fails the whole attempt', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue(
      proposedRow(),
    );

    await service.submitBrandReply('owner_1', 'pv_1', {
      response: PhysicalVerificationBrandResponse.DECLINED,
      note: 'Not interested',
    });

    // The brand is rejected, not merely left unscheduled: refusing the visit
    // is refusing verification, and a new attempt starts from the beginning.
    const brandUpdate = prisma.brand.update.mock.calls[0][0];
    expect(brandUpdate.data.verificationStatus).toBe(
      BrandVerificationStatus.REJECTED,
    );
  });

  it('refuses a reply from another brand’s owner', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue(
      proposedRow(),
    );

    await expect(
      service.submitBrandReply('someone_else', 'pv_1', {
        response: PhysicalVerificationBrandResponse.AGREED,
        selectedSlot: futureSlot(3),
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('will not record a verdict without enough evidence', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.VISIT_COMPLETED,
      assignedAgentId: 'agent_1',
    });
    prisma.physicalVerificationProof.count.mockResolvedValue(
      MIN_PROOFS_FOR_DECISION - 1,
    );

    await expect(
      service.decide('pv_1', 'agent_1', { outcome: 'PASSED' }),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.brand.update).not.toHaveBeenCalled();
  });

  it('a passed visit is what grants the badge', async () => {
    const { service, prisma, notifications } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.VISIT_COMPLETED,
      assignedAgentId: 'agent_1',
    });
    prisma.brandPhysicalVerification.findUniqueOrThrow.mockResolvedValue({
      id: 'pv_1',
      brandId: 'brand_1',
      attemptId: 'attempt_1',
      brand: { id: 'brand_1', name: 'Nuel', ownerId: 'owner_1' },
    });

    await service.decide('pv_1', 'agent_1', { outcome: 'PASSED' });

    expect(prisma.brand.update.mock.calls[0][0].data.verificationStatus).toBe(
      BrandVerificationStatus.APPROVED,
    );
    expect(notifications.create).toHaveBeenCalledWith(
      'owner_1',
      NotificationType.VERIFICATION_PHYSICAL_PASSED,
      expect.anything(),
    );
  });

  it('a failed visit needs a reason the brand can read', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.VISIT_COMPLETED,
      assignedAgentId: 'agent_1',
    });

    await expect(
      service.decide('pv_1', 'agent_1', { outcome: 'FAILED' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('only the assigned agent may work on a visit', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.VISIT_COMPLETED,
      assignedAgentId: 'agent_1',
    });

    await expect(
      service.decide('pv_1', 'a_different_agent', { outcome: 'PASSED' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('two agents cannot both claim the same visit', async () => {
    const { service, prisma } = buildService();
    // The conditional update matches nothing because someone else won.
    prisma.brandPhysicalVerification.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.claim('pv_1', 'agent_2')).rejects.toBeInstanceOf(
      ConflictException,
    );

    // The guard is in the WHERE clause, not a read-then-write.
    const where = prisma.brandPhysicalVerification.updateMany.mock.calls[0][0]
      .where;
    expect(where.status).toBe(PhysicalVerificationStatus.PENDING_ASSIGNMENT);
  });

  /*
    The reschedule loop, closed.

    A brand asking for another time is a question. Before these three, the
    agent could only re-propose — there was no way to simply take the slot the
    brand picked, and no way to postpone honestly — and either way the brand
    heard nothing back.
  */
  describe('answering a reschedule request', () => {
    const rescheduleRow = () => ({
      id: 'pv_1',
      brandId: 'brand_1',
      status: PhysicalVerificationStatus.RESCHEDULE_REQUESTED,
      assignedAgentId: 'agent_1',
      selectedSlotAt: new Date(Date.now() + 3 * 86400000),
      proposedSlots: [futureSlot(3), futureSlot(5)],
      decisionNotes: null,
    });

    it('accepting takes the slot the brand picked and tells them', async () => {
      const { service, prisma, notifications } = buildService();
      prisma.brandPhysicalVerification.findUnique.mockResolvedValue(
        rescheduleRow(),
      );

      await service.respondToReschedule('pv_1', 'agent_1', {
        decision: 'ACCEPTED',
      });

      const data = prisma.brandPhysicalVerification.update.mock.calls[0][0].data;
      expect(data.status).toBe(PhysicalVerificationStatus.SCHEDULE_CONFIRMED);
      expect(notifications.create).toHaveBeenCalledWith(
        'owner_1',
        NotificationType.VERIFICATION_VISIT_RESCHEDULE_ACCEPTED,
        expect.anything(),
      );
    });

    it('declining postpones with NO date rather than leaving a fake appointment', async () => {
      const { service, prisma, notifications } = buildService();
      prisma.brandPhysicalVerification.findUnique.mockResolvedValue(
        rescheduleRow(),
      );

      await service.respondToReschedule('pv_1', 'agent_1', {
        decision: 'DECLINED',
        note: 'Team travelling',
      });

      const data = prisma.brandPhysicalVerification.update.mock.calls[0][0].data;
      expect(data.status).toBe(PhysicalVerificationStatus.ON_HOLD);
      // Keeping the brand's pick here would show a confirmed appointment
      // nobody is coming to.
      expect(data.selectedSlotAt).toBeNull();
      expect(notifications.create).toHaveBeenCalledWith(
        'owner_1',
        NotificationType.VERIFICATION_VISIT_RESCHEDULE_DECLINED,
        expect.anything(),
      );
    });

    it('only answers a request that is actually open', async () => {
      const { service, prisma } = buildService();
      prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
        ...rescheduleRow(),
        status: PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
      });

      await expect(
        service.respondToReschedule('pv_1', 'agent_1', { decision: 'ACCEPTED' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('a postponed visit can be revived by proposing again', async () => {
      const { service, prisma } = buildService();
      prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
        id: 'pv_1',
        status: PhysicalVerificationStatus.ON_HOLD,
        assignedAgentId: 'agent_1',
      });

      await expect(
        service.proposeVisit('pv_1', 'agent_1', {
          slots: [futureSlot(6), futureSlot(7)],
        }),
      ).resolves.toBeDefined();
    });
  });

  it('offers must give the brand something to choose between', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.ASSIGNED,
      assignedAgentId: 'agent_1',
    });

    await expect(
      service.proposeVisit('pv_1', 'agent_1', { slots: [futureSlot(2)] }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drops times that have already passed from an offer', async () => {
    const { service, prisma } = buildService();
    prisma.brandPhysicalVerification.findUnique.mockResolvedValue({
      id: 'pv_1',
      status: PhysicalVerificationStatus.ASSIGNED,
      assignedAgentId: 'agent_1',
    });

    await expect(
      service.proposeVisit('pv_1', 'agent_1', {
        slots: [futureSlot(-2), futureSlot(-1), futureSlot(4)],
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
