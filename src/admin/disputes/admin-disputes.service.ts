import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AdminAuditAction,
  AdminDisputeStatus,
  Role,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminDisputesService {
  private readonly logger = new Logger(AdminDisputesService.name);

  constructor(private readonly prisma: PrismaService) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    status?: AdminDisputeStatus;
    type?: string;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.status) where.status = params.status;
    if (params.type) where.type = params.type;

    const items = await this.prisma.dispute.findMany({
      where,
      include: {
        reporter: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
        assignedTo: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return { items: results, nextCursor };
  }

  async create(
    dto: {
      type: string;
      reporterId: string;
      targetType: string;
      targetId: string;
      description: string;
    },
    actorId: string,
    req: Request,
  ) {
    const dispute = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dispute.create({
        data: {
          id: uuidv4(),
          type: dto.type as any,
          reporterId: dto.reporterId,
          targetType: dto.targetType,
          targetId: dto.targetId,
          description: dto.description,
          status: AdminDisputeStatus.OPEN,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_DISPUTE_CREATE,
          targetType: 'Dispute',
          targetId: result.id,
          newState: { type: dto.type, status: 'OPEN' },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return dispute;
  }

  async claim(
    disputeId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    if (
      dispute.assignedToId &&
      dispute.assignedToId !== actorId &&
      actorRole !== Role.SuperAdmin
    ) {
      throw new ConflictException('Dispute is already assigned to another admin');
    }

    const now = new Date();
    const nextStatus =
      dispute.status === AdminDisputeStatus.OPEN ||
      dispute.status === AdminDisputeStatus.REOPENED
        ? AdminDisputeStatus.ASSIGNED
        : dispute.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          assignedToId: actorId,
          assignedAt: now,
          status: nextStatus,
        },
        include: {
          reporter: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          assignedTo: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action:
            dispute.assignedToId && dispute.assignedToId !== actorId
              ? AdminAuditAction.ADMIN_DISPUTE_ASSIGN
              : AdminAuditAction.ADMIN_DISPUTE_CLAIM,
          targetType: 'Dispute',
          targetId: disputeId,
          previousState: { assignedToId: dispute.assignedToId, status: dispute.status },
          newState: { assignedToId: actorId, status: nextStatus, assignedAt: now.toISOString() },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async release(
    disputeId: string,
    actorId: string,
    actorRole: Role,
    req: Request,
    reason?: string,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    this.assertOwnership(dispute.assignedToId, actorId, actorRole);

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          assignedToId: null,
          assignedAt: null,
          status:
            dispute.status === AdminDisputeStatus.ASSIGNED
              ? AdminDisputeStatus.OPEN
              : dispute.status,
        },
        include: {
          reporter: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          assignedTo: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_DISPUTE_RELEASE,
          targetType: 'Dispute',
          targetId: disputeId,
          previousState: { assignedToId: dispute.assignedToId, status: dispute.status },
          newState: { assignedToId: null, reason: reason ?? null },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async update(
    disputeId: string,
    dto: {
      status?: AdminDisputeStatus;
      resolution?: string;
      adminNotes?: string;
      assignedToId?: string;
    },
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    if (dto.assignedToId && actorRole !== Role.SuperAdmin) {
      throw new ForbiddenException('Only SuperAdmin can reassign disputes directly');
    }

    this.assertOwnership(dispute.assignedToId, actorId, actorRole, dto.assignedToId);

    const previousState = {
      status: dispute.status,
      resolution: dispute.resolution,
      assignedToId: dispute.assignedToId,
    };

    const updateData: Record<string, unknown> = {};
    if (dto.status) updateData.status = dto.status;
    if (dto.resolution !== undefined) updateData.resolution = dto.resolution;
    if (dto.adminNotes !== undefined) updateData.adminNotes = dto.adminNotes;
    if (dto.assignedToId) {
      updateData.assignedToId = dto.assignedToId;
      updateData.assignedAt = new Date();
    }

    if (
      dto.status === AdminDisputeStatus.RESOLVED ||
      dto.status === AdminDisputeStatus.CLOSED
    ) {
      updateData.resolvedById = actorId;
      updateData.resolvedAt = new Date();
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dispute.update({
        where: { id: disputeId },
        data: updateData,
        include: {
          reporter: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
          assignedTo: {
            select: { id: true, email: true, firstName: true, lastName: true },
          },
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: dto.assignedToId
            ? AdminAuditAction.ADMIN_DISPUTE_ASSIGN
            : AdminAuditAction.ADMIN_DISPUTE_RESOLVE,
          targetType: 'Dispute',
          targetId: disputeId,
          previousState,
          newState: updateData,
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async reopen(
    disputeId: string,
    reason: string,
    actorId: string,
    actorRole: Role,
    req: Request,
  ) {
    const dispute = await this.prisma.dispute.findUnique({
      where: { id: disputeId },
    });
    if (!dispute) throw new NotFoundException('Dispute not found');

    this.assertOwnership(dispute.assignedToId, actorId, actorRole);

    if (
      dispute.status !== AdminDisputeStatus.RESOLVED &&
      dispute.status !== AdminDisputeStatus.CLOSED
    ) {
      throw new ConflictException(
        'Can only reopen resolved or closed disputes',
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.dispute.update({
        where: { id: disputeId },
        data: {
          status: AdminDisputeStatus.REOPENED,
          reopenedAt: new Date(),
          reopenReason: reason,
          resolvedAt: null,
          resolvedById: null,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_DISPUTE_REOPEN,
          targetType: 'Dispute',
          targetId: disputeId,
          previousState: { status: dispute.status },
          newState: { status: 'REOPENED', reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  private assertOwnership(
    assignedToId: string | null,
    actorId: string,
    actorRole: Role,
    nextAssignedToId?: string,
  ) {
    if (actorRole === Role.SuperAdmin) {
      return;
    }

    if (nextAssignedToId && nextAssignedToId !== actorId) {
      throw new ForbiddenException('Only SuperAdmin can assign this dispute to another admin');
    }

    if (!assignedToId) {
      throw new ForbiddenException('Dispute must be claimed before it can be updated');
    }

    if (assignedToId !== actorId) {
      throw new ForbiddenException('Dispute is assigned to another admin');
    }
  }
}
