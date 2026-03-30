import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AdminAuditAction,
  CustomOrderLedgerAllocationStatus,
  PayoutStatus,
  Role,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { LedgerService } from 'src/finance/ledger.service';
import { FinancialDocumentsService } from 'src/finance/financial-documents.service';

const VALID_TRANSITIONS: Record<PayoutStatus, PayoutStatus[]> = {
  [PayoutStatus.PENDING_APPROVAL]: [
    PayoutStatus.APPROVED,
    PayoutStatus.REJECTED,
    PayoutStatus.ON_HOLD,
  ],
  [PayoutStatus.APPROVED]: [
    PayoutStatus.PROCESSING,
    PayoutStatus.ON_HOLD,
    PayoutStatus.REJECTED,
  ],
  [PayoutStatus.PROCESSING]: [
    PayoutStatus.PAID,
    PayoutStatus.FAILED,
    PayoutStatus.RECONCILIATION_REVIEW,
  ],
  [PayoutStatus.FAILED]: [
    PayoutStatus.APPROVED,
    PayoutStatus.ON_HOLD,
    PayoutStatus.REJECTED,
  ],
  [PayoutStatus.REJECTED]: [],
  [PayoutStatus.ON_HOLD]: [PayoutStatus.APPROVED, PayoutStatus.REJECTED],
  [PayoutStatus.RECONCILIATION_REVIEW]: [
    PayoutStatus.APPROVED,
    PayoutStatus.PAID,
    PayoutStatus.FAILED,
    PayoutStatus.ON_HOLD,
  ],
  [PayoutStatus.PAID]: [],
};

@Injectable()
export class AdminPayoutsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ledgerService: LedgerService,
    private readonly financialDocumentsService: FinancialDocumentsService,
  ) {}

  async list(params: {
    status?: PayoutStatus;
    brandId?: string;
    cursor?: string;
    take?: number;
  }) {
    const take = Math.min(params.take ?? 20, 100);
    const where: Record<string, unknown> = {};
    if (params.status) where.status = params.status;
    if (params.brandId) where.brandId = params.brandId;

    const rows = await this.prisma.payout.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        brand: { select: { id: true, name: true } },
        assignedAdmin: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
        approvedBy: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;

    return {
      items,
      nextCursor: hasMore ? items[items.length - 1]?.id : undefined,
    };
  }

  async claim(
    payoutId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        status: true,
        assignedAdminId: true,
      },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    if (
      payout.assignedAdminId &&
      payout.assignedAdminId !== actorId &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ConflictException('Payout is already claimed by another admin');
    }

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data: {
          assignedAdminId: actorId,
          assignedAt: payout.assignedAdminId ? undefined : now,
          claimedAt: now,
          releasedAt: null,
        },
        include: {
          brand: { select: { id: true, name: true } },
          assignedAdmin: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action:
            payout.assignedAdminId && payout.assignedAdminId !== actorId
              ? AdminAuditAction.ADMIN_PAYOUT_ASSIGN
              : AdminAuditAction.ADMIN_PAYOUT_CLAIM,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: { assignedAdminId: payout.assignedAdminId },
          newState: { assignedAdminId: actorId, claimedAt: now.toISOString() },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async release(
    payoutId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
    reason?: string,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
      select: {
        id: true,
        assignedAdminId: true,
      },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    this.assertOwnership(payout.assignedAdminId, actorId, actorRole);

    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data: {
          assignedAdminId: null,
          claimedAt: null,
          releasedAt: now,
        },
        include: {
          brand: { select: { id: true, name: true } },
          assignedAdmin: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_RELEASE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: { assignedAdminId: payout.assignedAdminId },
          newState: { assignedAdminId: null, releasedAt: now.toISOString(), reason: reason ?? null },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async updateStatus(
    payoutId: string,
    params: { status: PayoutStatus; reason?: string },
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    this.assertOwnership(payout.assignedAdminId, actorId, actorRole);

    const allowed = VALID_TRANSITIONS[payout.status];
    if (!allowed || !allowed.includes(params.status)) {
      throw new ConflictException(
        `Cannot transition payout from ${payout.status} to ${params.status}`,
      );
    }

    const now = new Date();
    const data: Record<string, unknown> = {
      status: params.status,
      statusReason: params.reason?.trim() || null,
    };

    if (params.status === PayoutStatus.APPROVED) {
      data.approvedById = actorId;
      data.approvedAt = now;
    }
    if (params.status === PayoutStatus.PROCESSING) {
      data.processedAt = now;
    }
    if (params.status === PayoutStatus.PAID) {
      data.paidAt = now;
    }
    if (params.status === PayoutStatus.FAILED) {
      data.failureReason =
        params.reason?.trim() || 'Payout processing failed';
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data,
        include: {
          brand: { select: { id: true, name: true } },
          assignedAdmin: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
          approvedBy: {
            select: { id: true, firstName: true, lastName: true, email: true },
          },
        },
      });

      if (params.status === PayoutStatus.PAID) {
        const linkedAllocationSummary = await tx.customOrderLedgerAllocation.aggregate({
          where: {
            payoutId: result.id,
            status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            paidOutAt: null,
          },
          _sum: { netBrandAmount: true },
          _count: { id: true },
        });

        if ((linkedAllocationSummary._count?.id ?? 0) > 0) {
          const expectedNetAmount = this.roundMoney(
            Number(linkedAllocationSummary._sum.netBrandAmount ?? 0),
          );
          const payoutAmount = this.roundMoney(Number(result.amount ?? 0));
          if (Math.abs(expectedNetAmount - payoutAmount) >= 0.01) {
            throw new ConflictException(
              'Payout amount no longer matches the linked custom-order allocations',
            );
          }
        }

        await tx.customOrderLedgerAllocation.updateMany({
          where: {
            payoutId: result.id,
            status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            paidOutAt: null,
          },
          data: {
            status: CustomOrderLedgerAllocationStatus.PAID_OUT,
            paidOutAt: now,
          },
        });
        await this.ledgerService.postPayoutDisbursed(tx, result);
        await this.financialDocumentsService.issuePayoutSettlementStatement(tx, {
          payoutId: result.id,
          brandId: result.brandId,
          brandName: result.brand?.name ?? null,
          currency: result.currency,
          amount: Number(result.amount),
        });
        await this.financialDocumentsService.issueCommissionInvoice(tx, {
          payoutId: result.id,
          brandId: result.brandId,
          brandName: result.brand?.name ?? null,
          currency: result.currency,
          amount: Number(result.amount),
        });
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_STATUS_UPDATE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: {
            status: payout.status,
            statusReason: payout.statusReason,
          },
          newState: {
            status: params.status,
            statusReason: params.reason?.trim() || null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  private roundMoney(value: number) {
    return Math.round((value + Number.EPSILON) * 100) / 100;
  }

  private assertOwnership(
    assignedAdminId: string | null,
    actorId: string,
    actorRole: Role,
  ) {
    if (actorRole === Role.SuperAdmin) {
      return;
    }

    if (!assignedAdminId) {
      throw new ForbiddenException('Payout must be claimed before it can be updated');
    }

    if (assignedAdminId !== actorId) {
      throw new ForbiddenException('Payout is assigned to another admin');
    }
  }
}
