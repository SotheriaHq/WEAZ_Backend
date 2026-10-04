/**
 * The dispute queue: who owns a case, and how it ends.
 *
 * Every dispute this platform raises — a rejected extension, a reported delay,
 * a complaint about what arrived — lands in `CustomOrderDispute`. None of them
 * were reachable from the admin console: the Disputes page reads the unrelated
 * generic `Dispute` table, and the one endpoint that did read this model had no
 * caller anywhere in the web app. So the queue that exists to manage disputes
 * showed none of the disputes the system actually creates.
 *
 * This is the service behind a queue that shows them, assigns them to a named
 * human, and takes them to an outcome.
 *
 * The ownership rules are deliberately strict:
 *
 *   - Claiming is atomic. Two admins opening the queue at the same moment will
 *     both see an unclaimed row and both press the button; the claim is written
 *     with a conditional update so the second one loses cleanly and is told so,
 *     rather than silently overwriting the first.
 *   - Ownership cannot be dropped, only handed over, and the handover needs a
 *     SuperAdmin. A free release turns a hard case into a hot potato and throws
 *     away the context of the one person who has read it.
 *   - The admin asking to be released cannot be the one who approves it.
 *
 * And the resolution rules follow the shape of the thing being decided: a
 * remedy that gives away someone's rights is PROPOSED to them and applied on
 * their consent; a remedy the platform is entitled to impose is simply applied.
 * `custom-order-dispute-resolution.policy.ts` holds that judgement.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CustomOrderActorType,
  CustomOrderDisputeResolution,
  CustomOrderDisputeStatus,
  CustomOrderStatus,
  DisputeConsentParty,
  NotificationType,
  Prisma,
  Role,
  UserStatus,
} from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CustomOrderRefundService } from './custom-order-refund.service';
import { CustomOrderSideEffectsService } from './custom-order-side-effects.service';
import {
  ACTIVE_DISPUTE_STATUSES,
  assertClaimAllowed,
  assertHandoverDecisionAllowed,
  assertHandoverRequestAllowed,
  assertOwnedBy,
  assertResolutionAllowed,
  consentPartyFor,
  DISPUTE_CLAIM_POLICY,
  evaluateConsent,
  MONEY_MOVING_RESOLUTIONS,
  resolutionOptionsFor,
  resolveClaimDueAt,
  resolveConsentDueAt,
  type ResolutionContext,
} from './custom-order-dispute-resolution.policy';
import { isRushOrder } from './custom-order-extension.policy';

/** A dispute row joined to the slice of its order the queue needs. */
type DisputeWithOrder = Prisma.CustomOrderDisputeGetPayload<object> & {
  customOrder: {
    id: string;
    brandId: string;
    buyerId: string;
    status: CustomOrderStatus;
    currency: string;
    sourceTitleSnapshot: string | null;
    sourceBrandNameSnapshot: string | null;
    contactInfoJson: Prisma.JsonValue | null;
    buyerPriceSummaryJson: Prisma.JsonValue | null;
    rushSelected: boolean;
    rushFeeSnapshot: Prisma.Decimal | null;
    approvedExtensionCount: number;
    totalExtensionDaysGranted: number;
    promisedProductionAt: Date | null;
    promisedDeliveryAt: Date | null;
    deliveredAt: Date | null;
    acceptedAt: Date | null;
    createdAt: Date;
  };
};

export interface DisputeQueueQuery {
  page?: number;
  limit?: number;
  status?: CustomOrderDisputeStatus;
  /** `unclaimed` | `mine` | `others` | `overdue` — how a handler triages. */
  ownership?: 'unclaimed' | 'mine' | 'others' | 'overdue';
  reasonType?: string;
  search?: string;
}

@Injectable()
export class CustomOrderDisputeService {
  private readonly logger = new Logger(CustomOrderDisputeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly refundService: CustomOrderRefundService,
    private readonly sideEffects: CustomOrderSideEffectsService,
  ) {}

  /**
   * Tell the people waiting.
   *
   * Fire-and-forget: a notification that fails to enqueue must never roll back
   * a claim or an applied resolution. The dispute record is the source of
   * truth; these are how the parties learn about it.
   */
  private async notify(params: {
    customOrderId: string;
    recipientIds: string[];
    notificationType: NotificationType;
    payload: Record<string, unknown>;
    /**
     * Where tapping the notification should land.
     *
     * An admin told a dispute is unclaimed needs the console, not the shopper's
     * order screen — sending them to a page they cannot act on is how an alert
     * becomes noise.
     */
    audience?: 'PARTIES' | 'ADMIN';
  }): Promise<void> {
    try {
      const adminAudience = params.audience === 'ADMIN';
      await this.sideEffects.enqueueNotification({
        customOrderId: params.customOrderId,
        recipientIds: params.recipientIds.filter(Boolean),
        notificationType: params.notificationType,
        target: {
          type: 'SYSTEM' as const,
          id: `${adminAudience ? 'admin-custom-order' : 'custom-order'}:${params.customOrderId}`,
          preview: adminAudience
            ? `/admin/custom-orders/${params.customOrderId}`
            : `/custom-orders/${params.customOrderId}`,
        },
        payload: params.payload,
      });
    } catch (error) {
      this.logger.warn(
        `Dispute notification ${params.notificationType} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** The brand owner behind an order, for notifications addressed to the brand. */
  private async brandOwnerId(brandId: string): Promise<string | null> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { ownerId: true },
    });
    return brand?.ownerId ?? null;
  }

  /** Everything the queue and the detail screen need about one dispute. */
  private get disputeInclude() {
    return {
      customOrder: {
        select: {
          id: true,
          brandId: true,
          buyerId: true,
          status: true,
          currency: true,
          sourceTitleSnapshot: true,
          sourceBrandNameSnapshot: true,
          contactInfoJson: true,
          buyerPriceSummaryJson: true,
          rushSelected: true,
          rushFeeSnapshot: true,
          approvedExtensionCount: true,
          totalExtensionDaysGranted: true,
          promisedProductionAt: true,
          promisedDeliveryAt: true,
          deliveredAt: true,
          acceptedAt: true,
          createdAt: true,
        },
      },
    } satisfies Prisma.CustomOrderDisputeInclude;
  }

  private resolutionContext(order: {
    rushSelected: boolean;
    rushFeeSnapshot: Prisma.Decimal | null;
    approvedExtensionCount: number;
    totalExtensionDaysGranted: number;
    deliveredAt: Date | null;
    status: CustomOrderStatus;
  }, reasonType: ResolutionContext['reasonType']): ResolutionContext {
    return {
      reasonType,
      approvedExtensionCount: order.approvedExtensionCount ?? 0,
      totalExtensionDaysGranted: order.totalExtensionDaysGranted ?? 0,
      isRushOrder: isRushOrder(order),
      hasBeenDelivered:
        Boolean(order.deliveredAt) ||
        order.status === CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION ||
        order.status === CustomOrderStatus.COMPLETED,
    };
  }

  /**
   * The queue.
   *
   * Ordered by claim deadline rather than by age: the row that is closest to
   * breaching — or has already breached — is the one a handler should see
   * first, and that is not always the oldest one.
   */
  async listQueue(query: DisputeQueueQuery, adminId: string) {
    const page = Math.max(1, query.page ?? 1);
    const take = Math.min(100, Math.max(1, query.limit ?? 20));
    const now = new Date();

    const where: Prisma.CustomOrderDisputeWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.reasonType ? { reasonType: query.reasonType as never } : {}),
    };

    switch (query.ownership) {
      case 'unclaimed':
        where.claimedByAdminId = null;
        where.status = where.status ?? { in: [...ACTIVE_DISPUTE_STATUSES] };
        break;
      case 'mine':
        where.claimedByAdminId = adminId;
        break;
      case 'others':
        where.claimedByAdminId = { not: null, notIn: [adminId] };
        break;
      case 'overdue':
        // Past its claim deadline and still owned by nobody.
        where.claimedByAdminId = null;
        where.claimDueAt = { lt: now };
        where.status = where.status ?? { in: [...ACTIVE_DISPUTE_STATUSES] };
        break;
      default:
        break;
    }

    if (query.search?.trim()) {
      const term = query.search.trim();
      where.customOrder = {
        OR: [
          { sourceTitleSnapshot: { contains: term, mode: 'insensitive' } },
          { sourceBrandNameSnapshot: { contains: term, mode: 'insensitive' } },
        ],
      };
    }

    const [items, total, unclaimedCount, mineCount, overdueCount] =
      await this.prisma.$transaction([
        this.prisma.customOrderDispute.findMany({
          where,
          include: this.disputeInclude,
          orderBy: [{ claimDueAt: 'asc' }, { openedAt: 'asc' }],
          skip: (page - 1) * take,
          take,
        }),
        this.prisma.customOrderDispute.count({ where }),
        this.prisma.customOrderDispute.count({
          where: {
            claimedByAdminId: null,
            status: { in: [...ACTIVE_DISPUTE_STATUSES] },
          },
        }),
        this.prisma.customOrderDispute.count({
          where: {
            claimedByAdminId: adminId,
            status: { in: [...ACTIVE_DISPUTE_STATUSES] },
          },
        }),
        this.prisma.customOrderDispute.count({
          where: {
            claimedByAdminId: null,
            claimDueAt: { lt: now },
            status: { in: [...ACTIVE_DISPUTE_STATUSES] },
          },
        }),
      ]);

    return {
      statusCode: 200,
      message: 'Dispute queue retrieved',
      data: {
        items: items.map((dispute) => this.mapQueueRow(dispute, now)),
        page,
        limit: take,
        total,
        // The counts the queue's own filter chips need, so the console does not
        // have to issue three more requests to label its own tabs.
        counts: {
          unclaimed: unclaimedCount,
          mine: mineCount,
          overdue: overdueCount,
        },
      },
    };
  }

  /**
   * Structural rather than the generated payload type: this reads a fixed set
   * of scalars plus the selected order, and naming the full `include` here
   * would tie the mapper to whatever that select happens to list today.
   */
  private mapQueueRow(dispute: DisputeWithOrder, now: Date) {
    const order = dispute.customOrder;
    const contact = (order?.contactInfoJson ?? {}) as Record<string, unknown>;
    const claimOverdue =
      !dispute.claimedByAdminId &&
      dispute.claimDueAt != null &&
      dispute.claimDueAt.getTime() < now.getTime();

    return {
      id: dispute.id,
      status: dispute.status,
      reasonType: dispute.reasonType,
      buyerStatement: dispute.buyerStatement,
      brandResponse: dispute.brandResponse,
      openedAt: dispute.openedAt,
      resolvedAt: dispute.resolvedAt,
      resolution: dispute.resolution,

      claimedByAdminId: dispute.claimedByAdminId,
      claimedAt: dispute.claimedAt,
      claimDueAt: dispute.claimDueAt,
      claimOverdue,
      escalatedAt: dispute.escalatedAt,
      escalationCount: dispute.escalationCount,

      handover: dispute.handoverRequestedAt
        ? {
            toAdminId: dispute.handoverToAdminId,
            requestedAt: dispute.handoverRequestedAt,
            reason: dispute.handoverReason,
            approvedAt: dispute.handoverApprovedAt,
            rejectedAt: dispute.handoverRejectedAt,
            pending: Boolean(
              dispute.handoverRequestedAt &&
                !dispute.handoverApprovedAt &&
                !dispute.handoverRejectedAt,
            ),
          }
        : null,

      proposal: dispute.proposedResolution
        ? {
            resolution: dispute.proposedResolution,
            note: dispute.proposalNote,
            extraDays: dispute.proposalExtraDays,
            refundAmount: dispute.proposalRefundAmount,
            consentBy: dispute.proposalConsentBy,
            respondByAt: dispute.proposalRespondByAt,
            buyerConsentAt: dispute.buyerConsentAt,
            buyerDeclinedAt: dispute.buyerDeclinedAt,
            brandConsentAt: dispute.brandConsentAt,
            brandDeclinedAt: dispute.brandDeclinedAt,
          }
        : null,

      order: order
        ? {
            id: order.id,
            brandId: order.brandId,
            buyerId: order.buyerId,
            status: order.status,
            title: order.sourceTitleSnapshot ?? 'Custom order',
            brandName: order.sourceBrandNameSnapshot ?? 'Brand',
            // Admin cannot act on a dispute without knowing whose it is. The
            // buyer's name was the first thing missing from every admin screen.
            buyerName:
              typeof contact.customerName === 'string' ? contact.customerName : null,
            buyerEmail: typeof contact.email === 'string' ? contact.email : null,
            currency: order.currency,
            amount:
              (order.buyerPriceSummaryJson as Record<string, unknown> | null)
                ?.grandTotal ?? null,
          }
        : null,
    };
  }

  async getDispute(disputeId: string) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
      include: this.disputeInclude,
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    const context = this.resolutionContext(
      dispute.customOrder,
      dispute.reasonType,
    );

    return {
      statusCode: 200,
      message: 'Dispute retrieved',
      data: {
        ...this.mapQueueRow(dispute, new Date()),
        adminNotes: dispute.adminNotes,
        /*
          The options, with their blocked reasons rather than filtered out.

          An admin who cannot see that "shopper agrees to more time" exists —
          and that it is unavailable because this order carries a rush fee —
          will go looking for it, or assume the console is broken.
        */
        resolutionOptions: resolutionOptionsFor(context),
        policy: {
          claimWithinHours: DISPUTE_CLAIM_POLICY.claimWithinHours,
          consentWithinHours: DISPUTE_CLAIM_POLICY.consentWithinHours,
        },
      },
    };
  }

  /**
   * Take ownership.
   *
   * The `claimedByAdminId: null` in the WHERE clause is what makes two admins
   * pressing Claim at the same moment safe: the second update matches no rows
   * and we tell that admin the case is already taken, rather than silently
   * reassigning a dispute somebody else has started reading.
   */
  async claim(disputeId: string, adminId: string) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    assertClaimAllowed(dispute, adminId);

    const now = new Date();
    const updated = await this.prisma.customOrderDispute.updateMany({
      where: { id: disputeId, claimedByAdminId: null },
      data: {
        claimedByAdminId: adminId,
        claimedAt: now,
        assignedAdminId: adminId,
        status:
          dispute.status === CustomOrderDisputeStatus.OPEN
            ? CustomOrderDisputeStatus.ADMIN_REVIEW
            : dispute.status,
      },
    });

    if (updated.count === 0) {
      throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_CLAIMED_BY_ANOTHER_ADMIN');
    }

    // Both sides learn that a named human now holds this, which is the entire
    // point of requiring a claim rather than letting disputes sit in a pool.
    const order = await this.prisma.customOrder.findUnique({
      where: { id: dispute.customOrderId },
      select: { id: true, buyerId: true, brandId: true },
    });
    if (order) {
      const brandOwner = await this.brandOwnerId(order.brandId);
      await this.notify({
        customOrderId: order.id,
        recipientIds: [order.buyerId, brandOwner].filter(
          (id): id is string => Boolean(id),
        ),
        notificationType: NotificationType.CUSTOM_ORDER_DISPUTE_CLAIMED,
        payload: { customOrderId: order.id, disputeId },
      });
    }

    return this.getDispute(disputeId);
  }

  /**
   * Ask to be let go, naming who takes over.
   *
   * There is no "release" that puts a dispute back in the pool anonymously.
   * Leaving means handing to a named colleague and having a SuperAdmin agree,
   * so accountability moves from one person to another and is never simply
   * discharged.
   */
  async requestHandover(
    disputeId: string,
    adminId: string,
    successorAdminId: string,
    reason: string,
  ) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    assertHandoverRequestAllowed(dispute, adminId, successorAdminId);

    const successor = await this.prisma.user.findUnique({
      where: { id: successorAdminId },
      select: { id: true, role: true },
    });
    if (!successor || !String(successor.role).toUpperCase().includes('ADMIN')) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_HANDOVER_INVALID_SUCCESSOR');
    }

    await this.prisma.customOrderDispute.update({
      where: { id: disputeId },
      data: {
        handoverToAdminId: successorAdminId,
        handoverRequestedAt: new Date(),
        handoverReason: reason,
        handoverApprovedAt: null,
        handoverApprovedById: null,
        handoverRejectedAt: null,
        handoverRejectReason: null,
      },
    });

    // SuperAdmins decide this, so SuperAdmins have to hear about it. Without
    // the notification a handover request waits on someone noticing it.
    const superAdmins = await this.prisma.user.findMany({
      where: { role: Role.SuperAdmin, status: UserStatus.ACTIVE },
      select: { id: true },
    });
    await this.notify({
      customOrderId: dispute.customOrderId,
      recipientIds: superAdmins.map((admin) => admin.id),
      notificationType: NotificationType.CUSTOM_ORDER_DISPUTE_HANDOVER_REQUESTED,
      payload: {
        customOrderId: dispute.customOrderId,
        disputeId,
        successorAdminId,
        reason,
      },
      audience: 'ADMIN',
    });

    return this.getDispute(disputeId);
  }

  async decideHandover(
    disputeId: string,
    approverAdminId: string,
    decision: { approve: boolean; reason?: string },
  ) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    assertHandoverDecisionAllowed(dispute, approverAdminId);

    const now = new Date();
    if (decision.approve) {
      await this.prisma.customOrderDispute.update({
        where: { id: disputeId },
        data: {
          claimedByAdminId: dispute.handoverToAdminId,
          assignedAdminId: dispute.handoverToAdminId,
          // The successor's clock starts now; they have not been reading it.
          claimedAt: now,
          handoverApprovedById: approverAdminId,
          handoverApprovedAt: now,
          handoverToAdminId: null,
          handoverRequestedAt: null,
        },
      });
    } else {
      // Refused: the dispute stays exactly where it was, with the original
      // owner, and the refusal is on the record.
      await this.prisma.customOrderDispute.update({
        where: { id: disputeId },
        data: {
          handoverRejectedAt: now,
          handoverRejectReason: decision.reason ?? null,
          handoverToAdminId: null,
          handoverRequestedAt: null,
        },
      });
    }

    return this.getDispute(disputeId);
  }

  /**
   * Put a resolution to the parties, or apply it directly.
   *
   * Which of the two happens is not the admin's choice — it is a property of
   * the remedy. More time is the shopper's to give and they already said no
   * once, so it goes to them as a proposal. A refund costs the brand money they
   * have not earned, which the platform is entitled to impose and the debt
   * ledger exists to carry, so it applies at once.
   */
  async proposeResolution(
    disputeId: string,
    adminId: string,
    dto: {
      resolution: CustomOrderDisputeResolution;
      note?: string;
      extraDays?: number;
      refundAmount?: number;
    },
    permissions: { canRefund: boolean },
  ) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
      include: this.disputeInclude,
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    assertOwnedBy(dispute, adminId);
    if (!ACTIVE_DISPUTE_STATUSES.has(dispute.status)) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_NOT_ACTIVE');
    }

    if (MONEY_MOVING_RESOLUTIONS.has(dto.resolution) && !permissions.canRefund) {
      throw new ForbiddenException('MISSING_PERMISSION_DISPUTES_REFUND');
    }

    const context = this.resolutionContext(dispute.customOrder, dispute.reasonType);
    assertResolutionAllowed({
      resolution: dto.resolution,
      context,
      extraDays: dto.extraDays,
      refundAmount: dto.refundAmount,
    });

    const consentBy = consentPartyFor(dto.resolution);
    const now = new Date();

    if (!consentBy) {
      return this.applyResolution(disputeId, adminId, dto, now);
    }

    await this.prisma.customOrderDispute.update({
      where: { id: disputeId },
      data: {
        status: CustomOrderDisputeStatus.AWAITING_PARTY_CONSENT,
        proposedResolution: dto.resolution,
        proposedByAdminId: adminId,
        proposedAt: now,
        proposalNote: dto.note ?? null,
        proposalExtraDays: dto.extraDays ?? null,
        proposalRefundAmount:
          dto.refundAmount != null ? new Prisma.Decimal(dto.refundAmount) : null,
        proposalConsentBy: consentBy,
        proposalRespondByAt: resolveConsentDueAt(now),
        // A fresh proposal clears any previous round of answers, or a shopper
        // who declined once would be recorded as having declined this too.
        buyerConsentAt: null,
        buyerDeclinedAt: null,
        brandConsentAt: null,
        brandDeclinedAt: null,
      },
    });

    // Ask the party it binds. Without this the proposal sits in the console
    // and the person who has to agree to it never learns it exists.
    const brandOwner = await this.brandOwnerId(dispute.customOrder.brandId);
    const recipients: string[] = [];
    if (
      consentBy === DisputeConsentParty.BUYER ||
      consentBy === DisputeConsentParty.BOTH
    ) {
      recipients.push(dispute.customOrder.buyerId);
    }
    if (
      (consentBy === DisputeConsentParty.BRAND ||
        consentBy === DisputeConsentParty.BOTH) &&
      brandOwner
    ) {
      recipients.push(brandOwner);
    }

    await this.notify({
      customOrderId: dispute.customOrderId,
      recipientIds: recipients,
      notificationType: NotificationType.CUSTOM_ORDER_DISPUTE_PROPOSAL,
      payload: {
        customOrderId: dispute.customOrderId,
        disputeId,
        resolution: dto.resolution,
        ...(dto.extraDays != null ? { extraDays: dto.extraDays } : {}),
        respondByAt: resolveConsentDueAt(now).toISOString(),
      },
    });

    return this.getDispute(disputeId);
  }

  /**
   * A party answers the proposal.
   *
   * Called from the buyer and brand endpoints, not from the console — this is
   * the half of mediation that is not the admin's to press.
   */
  async recordConsent(
    disputeId: string,
    party: 'BUYER' | 'BRAND',
    accept: boolean,
    actorId: string,
  ) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id: disputeId },
      include: this.disputeInclude,
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    if (dispute.status !== CustomOrderDisputeStatus.AWAITING_PARTY_CONSENT) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_NO_OPEN_PROPOSAL');
    }

    // Only the party the proposal actually binds, and only the right person.
    if (party === 'BUYER' && dispute.customOrder.buyerId !== actorId) {
      throw new ForbiddenException('CUSTOM_ORDER_DISPUTE_NOT_YOUR_ORDER');
    }

    const required = dispute.proposalConsentBy;
    const partyIsRequired =
      required === DisputeConsentParty.BOTH ||
      (party === 'BUYER' && required === DisputeConsentParty.BUYER) ||
      (party === 'BRAND' && required === DisputeConsentParty.BRAND);
    if (!partyIsRequired) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_CONSENT_NOT_REQUIRED');
    }

    if (dispute.proposalRespondByAt && dispute.proposalRespondByAt < new Date()) {
      throw new BadRequestException('CUSTOM_ORDER_DISPUTE_PROPOSAL_EXPIRED');
    }

    const now = new Date();
    const patch: Prisma.CustomOrderDisputeUpdateInput =
      party === 'BUYER'
        ? accept
          ? { buyerConsentAt: now }
          : { buyerDeclinedAt: now }
        : accept
          ? { brandConsentAt: now }
          : { brandDeclinedAt: now };

    const updated = await this.prisma.customOrderDispute.update({
      where: { id: disputeId },
      data: patch,
    });

    const verdict = evaluateConsent({
      consentBy: required!,
      buyerConsentAt: updated.buyerConsentAt,
      buyerDeclinedAt: updated.buyerDeclinedAt,
      brandConsentAt: updated.brandConsentAt,
      brandDeclinedAt: updated.brandDeclinedAt,
    });

    if (verdict === 'ACCEPTED') {
      return this.applyResolution(
        disputeId,
        dispute.proposedByAdminId ?? dispute.claimedByAdminId ?? actorId,
        {
          resolution: updated.proposedResolution!,
          note: updated.proposalNote ?? undefined,
          extraDays: updated.proposalExtraDays ?? undefined,
          refundAmount: updated.proposalRefundAmount
            ? Number(updated.proposalRefundAmount)
            : undefined,
        },
        now,
      );
    }

    if (verdict === 'DECLINED') {
      // Back to the admin, with the refusal recorded. The dispute does NOT
      // close: a rejected proposal means the disagreement is still live, which
      // is exactly the case that most needs a human.
      await this.prisma.customOrderDispute.update({
        where: { id: disputeId },
        data: { status: CustomOrderDisputeStatus.ADMIN_REVIEW },
      });
    }

    return this.getDispute(disputeId);
  }

  /** Carry out an agreed or imposed outcome, and close the case. */
  private async applyResolution(
    disputeId: string,
    adminId: string,
    dto: {
      resolution: CustomOrderDisputeResolution;
      note?: string;
      extraDays?: number;
      refundAmount?: number;
    },
    now: Date,
  ) {
    let resolvedOrderId = '';

    await this.prisma.$transaction(async (tx) => {
      const dispute = await tx.customOrderDispute.findUnique({
        where: { id: disputeId },
        select: { id: true, customOrderId: true },
      });
      if (!dispute) throw new NotFoundException('Dispute not found');
      resolvedOrderId = dispute.customOrderId;

      switch (dto.resolution) {
        case CustomOrderDisputeResolution.MEDIATED_EXTENSION:
          // Deliberately routed through the extension counters rather than by
          // writing the dates here: the budget is audited on what was APPLIED,
          // and a mediated grant that skipped the counters would be invisible
          // to every later check.
          await this.applyMediatedExtension(
            tx,
            dispute.customOrderId,
            dto.extraDays ?? 0,
            now,
          );
          break;

        case CustomOrderDisputeResolution.CANCEL_AND_REFUND:
        case CustomOrderDisputeResolution.FULL_REFUND:
          await this.refundService.initiateRefund(tx, {
            customOrderId: dispute.customOrderId,
            reason: dto.note ?? 'Dispute resolved in the buyer’s favour',
            actorType: CustomOrderActorType.ADMIN,
            actorId: adminId,
          });
          if (dto.resolution === CustomOrderDisputeResolution.CANCEL_AND_REFUND) {
            await tx.customOrder.update({
              where: { id: dispute.customOrderId },
              data: { status: CustomOrderStatus.REFUND_IN_PROGRESS },
            });
          }
          break;

        case CustomOrderDisputeResolution.PARTIAL_REFUND:
          await this.refundService.initiateRefund(tx, {
            customOrderId: dispute.customOrderId,
            reason:
              dto.note ??
              `Partial refund agreed in dispute resolution (${dto.refundAmount})`,
            actorType: CustomOrderActorType.ADMIN,
            actorId: adminId,
          });
          break;

        case CustomOrderDisputeResolution.UPHOLD_BRAND:
        case CustomOrderDisputeResolution.NO_ACTION:
        case CustomOrderDisputeResolution.REMAKE:
        default:
          // No money and no dates move. The order carries on as it was, which
          // for a delay dispute means the maker simply keeps making.
          break;
      }

      await tx.customOrderDispute.update({
        where: { id: disputeId },
        data: {
          status: CustomOrderDisputeStatus.RESOLVED,
          resolution: dto.resolution,
          resolvedAt: now,
          resolvedByAdminId: adminId,
          adminNotes: dto.note ?? undefined,
        },
      });

      // Clearing the intervention is what lets the order leave the "WIEZ is
      // reviewing this" state on both clients.
      await tx.customOrder.update({
        where: { id: dispute.customOrderId },
        data: {
          adminInterventionResolvedAt: now,
          adminInterventionResolvedById: adminId,
        },
      });
    });

    // Everyone involved learns how it ended, outside the transaction so a
    // notification failure cannot undo an applied resolution.
    const order = await this.prisma.customOrder.findUnique({
      where: { id: resolvedOrderId },
      select: { id: true, buyerId: true, brandId: true },
    });
    if (order) {
      const brandOwner = await this.brandOwnerId(order.brandId);
      await this.notify({
        customOrderId: order.id,
        recipientIds: [order.buyerId, brandOwner].filter(
          (id): id is string => Boolean(id),
        ),
        notificationType: NotificationType.CUSTOM_ORDER_DISPUTE_RESOLVED,
        payload: {
          customOrderId: order.id,
          disputeId,
          resolution: dto.resolution,
        },
      });
    }

    return this.getDispute(disputeId);
  }

  /**
   * Apply agreed extra days through the same counters the normal flow uses.
   *
   * Kept here rather than reaching into `CustomOrdersService` to avoid a
   * circular dependency between the admin module and the order module; the
   * arithmetic is small and the counters are the part that matters.
   */
  private async applyMediatedExtension(
    tx: Prisma.TransactionClient,
    customOrderId: string,
    extraDays: number,
    now: Date,
  ) {
    const order = await tx.customOrder.findUnique({ where: { id: customOrderId } });
    if (!order) throw new NotFoundException('Custom order not found');

    const shiftMs = extraDays * 24 * 60 * 60 * 1000;
    const shift = (value: Date | null) =>
      value ? new Date(value.getTime() + shiftMs) : value;

    await tx.customOrder.update({
      where: { id: customOrderId },
      data: {
        // Snapshot the original commitment once, exactly as the normal flow
        // does, so "originally promised" survives every later extension.
        originalPromisedProductionAt:
          order.originalPromisedProductionAt ?? order.promisedProductionAt,
        originalPromisedDispatchAt:
          order.originalPromisedDispatchAt ?? order.promisedDispatchAt,
        originalPromisedDeliveryAt:
          order.originalPromisedDeliveryAt ?? order.promisedDeliveryAt,
        promisedProductionAt: shift(order.promisedProductionAt),
        promisedDispatchAt: shift(order.promisedDispatchAt),
        promisedDeliveryAt: shift(order.promisedDeliveryAt),
        // The acceptance window moves too. Leaving it put is how an order can
        // auto-complete and release the brand's money while still in production.
        buyerAcceptanceWindowEndsAt: shift(order.buyerAcceptanceWindowEndsAt),
        measurementRetentionUntil: shift(order.measurementRetentionUntil),
        totalExtensionDaysGranted:
          (order.totalExtensionDaysGranted ?? 0) + extraDays,
        approvedExtensionCount: (order.approvedExtensionCount ?? 0) + 1,
        // The order comes back out of DISPUTED: the parties have agreed and the
        // maker is working to a new date.
        status:
          order.status === CustomOrderStatus.DISPUTED
            ? CustomOrderStatus.IN_PRODUCTION
            : order.status,
        timelineEvents: {
          create: {
            actorType: CustomOrderActorType.ADMIN,
            // `EXTENSION_RESOLVED` is the existing event for "a request for
            // more time reached an outcome". A mediated grant is that same
            // fact, reached by a different route, so it reuses the type and
            // says which route in the payload.
            eventType: 'EXTENSION_RESOLVED',
            payloadJson: {
              source: 'DISPUTE_MEDIATION',
              extraDays,
              appliedAt: now.toISOString(),
            },
          },
        },
      },
    });
  }

  /** Set the claim deadline on a dispute as it is created. */
  static claimDeadlineFor(openedAt: Date): Date {
    return resolveClaimDueAt(openedAt);
  }
}
