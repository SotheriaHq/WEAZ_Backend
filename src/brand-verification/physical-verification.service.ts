import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  BrandVerificationStatus,
  NotificationType,
  PhysicalVerificationBrandResponse,
  PhysicalVerificationProofKind,
  PhysicalVerificationStatus,
  Prisma,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

/**
 * The visit: the last step of brand verification.
 *
 * Documents prove a brand exists on paper. This step proves there is a real
 * workspace, real packaging and real branding behind the paperwork, and it is
 * carried out by a person who goes and looks. The lifecycle:
 *
 *   PENDING_ASSIGNMENT  documents passed; nobody owns the visit yet
 *   ASSIGNED            a SuperAdmin handed it over, or an agent claimed it
 *   SCHEDULE_PROPOSED   the agent offered times; the brand must answer
 *   SCHEDULE_CONFIRMED  the brand took one of them
 *   RESCHEDULE_REQUESTED the brand took a different one of them
 *   VISIT_COMPLETED     the agent has been, and is attaching evidence
 *   PASSED / FAILED     the verdict
 *   DECLINED            the brand refused; the whole attempt fails
 *
 * Two rules shape the whole design.
 *
 * The brand's reply is CONSTRAINED. A brand may agree, ask for one of the
 * other times the agent offered, or decline — and nothing else. Free text
 * cannot move the state machine, and a reschedule cannot invent a time that
 * was never on the table, because a scheduling negotiation that accepts
 * arbitrary input is one an agent cannot plan a day around.
 *
 * A verdict requires EVIDENCE. A pass with no proof attached is an assertion,
 * not a verification, so `MIN_PROOFS_FOR_DECISION` is enforced at the decision
 * rather than left to the reviewer to remember.
 */

/** A verdict needs to be shown, not just stated. */
export const MIN_PROOFS_FOR_DECISION = 3;
/** Beyond this the brand is not scheduling, it is avoiding. */
export const MAX_RESCHEDULES = 2;

export interface ProposeVisitInput {
  /** ISO datetimes the agent can attend. The brand may pick only from these. */
  slots: string[];
  note?: string;
}

export interface BrandVisitReplyInput {
  response: PhysicalVerificationBrandResponse;
  /** Required for AGREED and RESCHEDULE_REQUESTED: must be one of the offered slots. */
  selectedSlot?: string;
  note?: string;
}

export interface RecordProofInput {
  kind?: PhysicalVerificationProofKind;
  fileKey: string;
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  caption?: string;
}

@Injectable()
export class PhysicalVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Open the visit step for an attempt whose documents just passed.
   *
   * Called from inside the document-review transaction, so it takes the
   * transaction client: a brand must never be left in `PHYSICAL_PENDING` with
   * no visit record to act on, which is what a separate write could produce if
   * the request died between the two.
   */
  async openForAttempt(
    tx: Prisma.TransactionClient,
    input: { brandId: string; attemptId: string },
  ): Promise<string> {
    const existing = await tx.brandPhysicalVerification.findUnique({
      where: { attemptId: input.attemptId },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await tx.brandPhysicalVerification.create({
      data: {
        id: randomUUID(),
        attemptId: input.attemptId,
        brandId: input.brandId,
        status: PhysicalVerificationStatus.PENDING_ASSIGNMENT,
      },
      select: { id: true },
    });
    return created.id;
  }

  /** The queue a SuperAdmin assigns from and an agent claims from. */
  async listQueue(params: {
    status?: PhysicalVerificationStatus;
    assignedAgentId?: string;
    limit?: number;
  }) {
    const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);
    const rows = await this.prisma.brandPhysicalVerification.findMany({
      where: {
        ...(params.status ? { status: params.status } : {}),
        ...(params.assignedAgentId
          ? { assignedAgentId: params.assignedAgentId }
          : {}),
      },
      orderBy: [{ createdAt: 'asc' }],
      take: limit,
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
        _count: { select: { proofs: true } },
      },
    });
    return rows.map((row) => this.toSummary(row));
  }

  async getDetail(id: string) {
    const row = await this.prisma.brandPhysicalVerification.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
        proofs: { orderBy: { createdAt: 'asc' } },
        _count: { select: { proofs: true } },
      },
    });
    if (!row) throw new NotFoundException('Physical verification not found');
    return { ...this.toSummary(row), proofs: row.proofs };
  }

  /** What the brand sees: their own visit, and what they may do about it. */
  async getForBrandOwner(ownerId: string) {
    const row = await this.prisma.brandPhysicalVerification.findFirst({
      where: { brand: { ownerId } },
      orderBy: { createdAt: 'desc' },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
        _count: { select: { proofs: true } },
      },
    });
    if (!row) return null;
    const summary = this.toSummary(row);
    return {
      ...summary,
      // The brand never sees the evidence or who is carrying out the visit.
      assignedAgentId: undefined,
      canRespond: row.status === PhysicalVerificationStatus.SCHEDULE_PROPOSED,
      remainingReschedules: Math.max(0, MAX_RESCHEDULES - row.rescheduleCount),
    };
  }

  /**
   * A SuperAdmin hands the visit to an agent.
   *
   * Separate from `claim` because assigning someone else's day is a different
   * act from picking up your own work, and they carry different permissions.
   */
  async assign(id: string, agentId: string, assignedById: string) {
    const current = await this.mustBeInStatus(id, [
      PhysicalVerificationStatus.PENDING_ASSIGNMENT,
      PhysicalVerificationStatus.ASSIGNED,
    ]);

    const agent = await this.prisma.user.findUnique({
      where: { id: agentId },
      select: { id: true, status: true, role: true },
    });
    if (!agent) throw new NotFoundException('Agent not found');
    if (agent.status !== 'ACTIVE') {
      throw new ForbiddenException('Cannot assign a visit to an inactive account');
    }

    const updated = await this.prisma.brandPhysicalVerification.update({
      where: { id },
      data: {
        assignedAgentId: agentId,
        assignedById,
        assignedAt: new Date(),
        claimedAt: null,
        status: PhysicalVerificationStatus.ASSIGNED,
      },
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    await this.notifications.create(
      agentId,
      NotificationType.VERIFICATION_VISIT_ASSIGNED,
      {
        actorId: assignedById,
        payload: {
          physicalVerificationId: id,
          brandId: updated.brandId,
          brandName: updated.brand.name,
          targetUrl: `/admin/verification/visits/${id}`,
        },
      },
    );

    void current;
    return this.getDetail(id);
  }

  /**
   * An agent takes an unowned visit off the queue.
   *
   * This exists so a visit nobody happened to notice does not sit unowned: the
   * queue is visible to every agent, and any of them can pick it up without
   * waiting to be handed it.
   */
  async claim(id: string, agentId: string) {
    // Conditional update, so two agents claiming at once cannot both win.
    const result = await this.prisma.brandPhysicalVerification.updateMany({
      where: { id, status: PhysicalVerificationStatus.PENDING_ASSIGNMENT },
      data: {
        assignedAgentId: agentId,
        assignedById: null,
        claimedAt: new Date(),
        assignedAt: new Date(),
        status: PhysicalVerificationStatus.ASSIGNED,
      },
    });
    if (result.count !== 1) {
      throw new ConflictException(
        'This visit has already been assigned to someone else',
      );
    }
    return this.getDetail(id);
  }

  /**
   * The agent offers times, and the brand is told to choose.
   *
   * Offering a LIST rather than a single appointment is what makes the brand's
   * reply constrained: a reschedule is a second pick from this same list, so
   * the agent knows every possible outcome the moment they propose.
   */
  async proposeVisit(id: string, agentId: string, input: ProposeVisitInput) {
    const current = await this.mustBeInStatus(id, [
      PhysicalVerificationStatus.ASSIGNED,
      PhysicalVerificationStatus.SCHEDULE_PROPOSED,
      PhysicalVerificationStatus.RESCHEDULE_REQUESTED,
      PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
    ]);
    this.mustOwnVisit(current, agentId);

    const slots = this.normalizeSlots(input.slots);
    if (slots.length < 2) {
      throw new BadRequestException(
        'Offer at least two times so the brand has something to choose between',
      );
    }

    const updated = await this.prisma.brandPhysicalVerification.update({
      where: { id },
      data: {
        proposedSlots: slots,
        scheduleProposedAt: new Date(),
        scheduleProposedById: agentId,
        status: PhysicalVerificationStatus.SCHEDULE_PROPOSED,
        // A fresh offer clears the previous answer; the brand answers again.
        brandResponse: null,
        brandRespondedAt: null,
        selectedSlotAt: null,
      },
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    await this.notifications.create(
      updated.brand.ownerId,
      NotificationType.VERIFICATION_VISIT_PROPOSED,
      {
        actorId: agentId,
        payload: {
          physicalVerificationId: id,
          brandId: updated.brandId,
          slots,
          note: input.note ?? null,
          targetUrl: '/studio/verification',
        },
      },
    );

    return this.getDetail(id);
  }

  /**
   * The brand's answer. Three outcomes, and only three.
   *
   * `AGREED` and `RESCHEDULE_REQUESTED` both have to name one of the offered
   * slots — the difference is only whether it is the first answer or a change
   * of mind, which matters for the reschedule budget. `DECLINED` ends the
   * attempt outright: refusing the visit is refusing verification, and the
   * brand starts a new attempt from the beginning if they change their mind.
   */
  async submitBrandReply(
    ownerId: string,
    id: string,
    input: BrandVisitReplyInput,
  ) {
    const row = await this.prisma.brandPhysicalVerification.findUnique({
      where: { id },
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });
    if (!row) throw new NotFoundException('Physical verification not found');
    if (row.brand.ownerId !== ownerId) {
      throw new ForbiddenException('This visit belongs to another brand');
    }
    if (row.status !== PhysicalVerificationStatus.SCHEDULE_PROPOSED) {
      throw new ConflictException(
        'There is no visit request waiting for an answer right now',
      );
    }

    const now = new Date();

    if (input.response === PhysicalVerificationBrandResponse.DECLINED) {
      return this.declineVisit(row, input.note ?? null, now);
    }

    const offered = this.normalizeSlots(
      Array.isArray(row.proposedSlots) ? (row.proposedSlots as string[]) : [],
    );
    const picked = String(input.selectedSlot ?? '').trim();
    if (!picked) {
      throw new BadRequestException('Choose one of the times offered');
    }
    /*
      The chosen slot must be one that was actually offered. Without this the
      brand could name any time at all and an agent would be committed to a
      day they never said they were free.
    */
    if (!offered.includes(picked)) {
      throw new BadRequestException(
        'That time was not one of the options offered. Choose from the list.',
      );
    }

    const isReschedule =
      input.response === PhysicalVerificationBrandResponse.RESCHEDULE_REQUESTED;
    if (isReschedule && row.rescheduleCount >= MAX_RESCHEDULES) {
      throw new ConflictException(
        'No reschedules remain on this visit. Contact the reviewer.',
      );
    }

    const updated = await this.prisma.brandPhysicalVerification.update({
      where: { id },
      data: {
        brandResponse: input.response,
        brandRespondedAt: now,
        brandResponseNote: input.note ?? null,
        selectedSlotAt: new Date(picked),
        rescheduleCount: isReschedule ? { increment: 1 } : undefined,
        status: isReschedule
          ? PhysicalVerificationStatus.RESCHEDULE_REQUESTED
          : PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
      },
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    if (updated.assignedAgentId) {
      await this.notifications.create(
        updated.assignedAgentId,
        isReschedule
          ? NotificationType.VERIFICATION_VISIT_RESCHEDULE_REQUESTED
          : NotificationType.VERIFICATION_VISIT_CONFIRMED,
        {
          actorId: ownerId,
          payload: {
            physicalVerificationId: id,
            brandId: updated.brandId,
            brandName: updated.brand.name,
            selectedSlot: picked,
            targetUrl: `/admin/verification/visits/${id}`,
          },
        },
      );
    }

    return this.getDetail(id);
  }

  /** Refusing the visit fails the attempt. */
  private async declineVisit(
    row: { id: string; brandId: string; brand: { ownerId: string } },
    note: string | null,
    now: Date,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.brandPhysicalVerification.update({
        where: { id: row.id },
        data: {
          brandResponse: PhysicalVerificationBrandResponse.DECLINED,
          brandRespondedAt: now,
          declineReason: note,
          status: PhysicalVerificationStatus.DECLINED,
          decidedAt: now,
        },
      });
      await tx.brand.update({
        where: { id: row.brandId },
        data: {
          verificationStatus: BrandVerificationStatus.REJECTED,
          verificationReviewedAt: now,
          verificationRejectionReason: 'Physical verification declined',
          verificationRejectionCount: { increment: 1 },
        },
      });
    });

    if (row.brand.ownerId) {
      await this.notifications.create(
        row.brand.ownerId,
        NotificationType.VERIFICATION_VISIT_DECLINED,
        {
          payload: {
            physicalVerificationId: row.id,
            brandId: row.brandId,
            targetUrl: '/studio/verification',
          },
        },
      );
    }

    return this.getDetail(row.id);
  }

  /** Evidence from the visit. */
  async addProof(id: string, agentId: string, input: RecordProofInput) {
    const current = await this.mustBeInStatus(id, [
      PhysicalVerificationStatus.SCHEDULE_CONFIRMED,
      PhysicalVerificationStatus.RESCHEDULE_REQUESTED,
      PhysicalVerificationStatus.ASSIGNED,
      PhysicalVerificationStatus.VISIT_COMPLETED,
    ]);
    this.mustOwnVisit(current, agentId);

    const fileKey = String(input.fileKey ?? '').trim();
    if (!fileKey) throw new BadRequestException('A file is required');

    await this.prisma.$transaction(async (tx) => {
      await tx.physicalVerificationProof.create({
        data: {
          id: randomUUID(),
          physicalVerificationId: id,
          kind: input.kind ?? PhysicalVerificationProofKind.OTHER,
          fileKey,
          fileName: input.fileName ?? null,
          mimeType: input.mimeType ?? null,
          sizeBytes: input.sizeBytes ?? null,
          caption: input.caption ?? null,
          uploadedById: agentId,
        },
      });
      if (current.status !== PhysicalVerificationStatus.VISIT_COMPLETED) {
        await tx.brandPhysicalVerification.update({
          where: { id },
          data: {
            status: PhysicalVerificationStatus.VISIT_COMPLETED,
            visitCompletedAt: current.visitCompletedAt ?? new Date(),
          },
        });
      }
    });

    return this.getDetail(id);
  }

  async removeProof(id: string, proofId: string, agentId: string) {
    const current = await this.mustBeInStatus(id, [
      PhysicalVerificationStatus.VISIT_COMPLETED,
    ]);
    this.mustOwnVisit(current, agentId);
    await this.prisma.physicalVerificationProof.deleteMany({
      where: { id: proofId, physicalVerificationId: id },
    });
    return this.getDetail(id);
  }

  /**
   * The verdict.
   *
   * A pass writes the brand through to APPROVED — this is the step that
   * actually verifies, so it is the step that grants the badge. A fail rejects
   * the attempt. Either way the evidence floor is enforced here rather than
   * left to the reviewer, because "approved, no photographs" is indistinguishable
   * afterwards from a visit that never happened.
   */
  async decide(
    id: string,
    agentId: string,
    input: { outcome: 'PASSED' | 'FAILED'; notes?: string; failureReason?: string },
  ) {
    const current = await this.mustBeInStatus(id, [
      PhysicalVerificationStatus.VISIT_COMPLETED,
    ]);
    this.mustOwnVisit(current, agentId);

    const proofCount = await this.prisma.physicalVerificationProof.count({
      where: { physicalVerificationId: id },
    });
    if (proofCount < MIN_PROOFS_FOR_DECISION) {
      throw new BadRequestException(
        `Attach at least ${MIN_PROOFS_FOR_DECISION} pieces of proof before recording a verdict`,
      );
    }
    if (input.outcome === 'FAILED' && !String(input.failureReason ?? '').trim()) {
      throw new BadRequestException('A failed visit needs a reason');
    }

    const now = new Date();
    const passed = input.outcome === 'PASSED';

    const row = await this.prisma.brandPhysicalVerification.findUniqueOrThrow({
      where: { id },
      include: { brand: { select: { id: true, name: true, ownerId: true } } },
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.brandPhysicalVerification.update({
        where: { id },
        data: {
          status: passed
            ? PhysicalVerificationStatus.PASSED
            : PhysicalVerificationStatus.FAILED,
          decidedAt: now,
          decidedById: agentId,
          decisionNotes: input.notes ?? null,
          failureReason: passed ? null : (input.failureReason ?? null),
        },
      });

      await tx.brand.update({
        where: { id: row.brandId },
        data: passed
          ? {
              verificationStatus: BrandVerificationStatus.APPROVED,
              verificationReviewedAt: now,
              verificationBrandNameAtApproval: row.brand.name,
              verificationRejectionReason: null,
            }
          : {
              verificationStatus: BrandVerificationStatus.REJECTED,
              verificationReviewedAt: now,
              verificationRejectionReason:
                input.failureReason ?? 'Physical verification failed',
              verificationRejectionCount: { increment: 1 },
            },
      });

      await tx.brandVerificationAttempt.update({
        where: { id: row.attemptId },
        data: {
          status: passed
            ? BrandVerificationStatus.APPROVED
            : BrandVerificationStatus.REJECTED,
          reviewedAt: now,
          reviewedById: agentId,
        },
      });
    });

    await this.notifications.create(
      row.brand.ownerId,
      passed
        ? NotificationType.VERIFICATION_PHYSICAL_PASSED
        : NotificationType.VERIFICATION_PHYSICAL_FAILED,
      {
        actorId: agentId,
        payload: {
          physicalVerificationId: id,
          brandId: row.brandId,
          decidedAt: now.toISOString(),
          reason: passed ? null : (input.failureReason ?? null),
          targetUrl: '/studio/verification',
        },
      },
    );

    return this.getDetail(id);
  }

  /* ── helpers ─────────────────────────────────────────────────────────── */

  private async mustBeInStatus(
    id: string,
    allowed: PhysicalVerificationStatus[],
  ) {
    const row = await this.prisma.brandPhysicalVerification.findUnique({
      where: { id },
    });
    if (!row) throw new NotFoundException('Physical verification not found');
    if (!allowed.includes(row.status)) {
      throw new ConflictException(
        `This visit is ${row.status.toLowerCase().replace(/_/g, ' ')} and cannot take that action`,
      );
    }
    return row;
  }

  /** An agent acts on their OWN visits. Unassigned ones must be claimed first. */
  private mustOwnVisit(
    row: { assignedAgentId: string | null },
    agentId: string,
  ) {
    if (!row.assignedAgentId) {
      throw new ConflictException('Claim this visit before working on it');
    }
    if (row.assignedAgentId !== agentId) {
      throw new ForbiddenException('This visit is assigned to another agent');
    }
  }

  /** Sorted, de-duplicated, future-only ISO strings. */
  private normalizeSlots(slots: unknown): string[] {
    if (!Array.isArray(slots)) return [];
    const now = Date.now();
    const seen = new Set<string>();
    for (const raw of slots) {
      const parsed = new Date(String(raw ?? '').trim());
      if (Number.isNaN(parsed.getTime())) continue;
      // A time that has already passed is not an option.
      if (parsed.getTime() <= now) continue;
      seen.add(parsed.toISOString());
    }
    return Array.from(seen).sort();
  }

  private toSummary(row: {
    id: string;
    brandId: string;
    attemptId: string;
    status: PhysicalVerificationStatus;
    assignedAgentId: string | null;
    assignedAt: Date | null;
    claimedAt: Date | null;
    proposedSlots: Prisma.JsonValue | null;
    selectedSlotAt: Date | null;
    brandResponse: PhysicalVerificationBrandResponse | null;
    brandRespondedAt: Date | null;
    brandResponseNote: string | null;
    rescheduleCount: number;
    visitCompletedAt: Date | null;
    decidedAt: Date | null;
    decisionNotes: string | null;
    failureReason: string | null;
    declineReason: string | null;
    createdAt: Date;
    brand: { id: string; name: string; ownerId: string };
    _count?: { proofs: number };
  }) {
    return {
      id: row.id,
      brandId: row.brandId,
      brandName: row.brand.name,
      attemptId: row.attemptId,
      status: row.status,
      assignedAgentId: row.assignedAgentId,
      assignedAt: row.assignedAt?.toISOString() ?? null,
      claimedAt: row.claimedAt?.toISOString() ?? null,
      proposedSlots: Array.isArray(row.proposedSlots)
        ? (row.proposedSlots as string[])
        : [],
      selectedSlotAt: row.selectedSlotAt?.toISOString() ?? null,
      brandResponse: row.brandResponse,
      brandRespondedAt: row.brandRespondedAt?.toISOString() ?? null,
      brandResponseNote: row.brandResponseNote,
      rescheduleCount: row.rescheduleCount,
      visitCompletedAt: row.visitCompletedAt?.toISOString() ?? null,
      decidedAt: row.decidedAt?.toISOString() ?? null,
      decisionNotes: row.decisionNotes,
      failureReason: row.failureReason,
      declineReason: row.declineReason,
      proofCount: row._count?.proofs ?? 0,
      minProofsForDecision: MIN_PROOFS_FOR_DECISION,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
