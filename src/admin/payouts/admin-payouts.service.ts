import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, PayoutStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

const VALID_TRANSITIONS: Record<string, PayoutStatus[]> = {
  [PayoutStatus.PENDING]: [PayoutStatus.PROCESSING],
  [PayoutStatus.PROCESSING]: [PayoutStatus.PAID, PayoutStatus.FAILED],
};

@Injectable()
export class AdminPayoutsService {
  constructor(private readonly prisma: PrismaService) {}

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

    return this.prisma.payout.findMany({
      where,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      orderBy: { createdAt: 'desc' },
      include: {
        brand: { select: { id: true, name: true } },
      },
    });
  }

  async updateStatus(
    payoutId: string,
    newStatus: PayoutStatus,
    actorId: string,
    req: Request,
  ) {
    const payout = await this.prisma.payout.findUnique({
      where: { id: payoutId },
    });
    if (!payout) throw new NotFoundException('Payout not found');

    const allowed = VALID_TRANSITIONS[payout.status];
    if (!allowed || !allowed.includes(newStatus)) {
      throw new ConflictException(
        `Cannot transition payout from ${payout.status} to ${newStatus}`,
      );
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.payout.update({
        where: { id: payoutId },
        data: { status: newStatus },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_PAYOUT_STATUS_UPDATE,
          targetType: 'Payout',
          targetId: payoutId,
          previousState: { status: payout.status },
          newState: { status: newStatus },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }
}
