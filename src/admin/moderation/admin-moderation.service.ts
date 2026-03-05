import {
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Get the moderation queue (pending items: freeform measurement points, size charts).
   */
  async getQueue(params: {
    cursor?: string;
    limit?: number;
    status?: string;
    type?: string;
  }) {
    const take = Math.min(params.limit ?? 20, 50);

    // Freeform points pending review
    const freeformWhere: Record<string, unknown> = {
      source: 'BRAND_FREEFORM',
    };
    if (params.status) {
      freeformWhere.status = params.status;
    } else {
      freeformWhere.status = 'BRAND_ONLY'; // Default to pending
    }

    const points = await this.prisma.measurementPoint.findMany({
      where: freeformWhere,
      orderBy: { createdAt: 'desc' },
      take,
      ...(params.cursor && params.type === 'freeform'
        ? { cursor: { id: params.cursor }, skip: 1 }
        : {}),
    });

    // Brand size charts pending review
    const chartWhere: Record<string, unknown> = {};
    if (params.status === 'PENDING') {
      chartWhere.status = 'PENDING';
    } else if (!params.status) {
      chartWhere.status = 'PENDING';
    }

    const charts = await this.prisma.brandSizeChart.findMany({
      where: chartWhere,
      orderBy: { createdAt: 'desc' },
      take,
    });

    return {
      freeformPoints: points,
      sizeCharts: charts,
    };
  }

  /**
   * Review a moderation item (approve/reject freeform point or size chart).
   */
  async reviewItem(
    itemId: string,
    decision: { action: string; reason?: string },
    actorId: string,
    req: Request,
  ) {
    // Try as measurement point first
    const point = await this.prisma.measurementPoint.findUnique({
      where: { id: itemId },
    });

    if (point) {
      return this.reviewMeasurementPoint(point.id, decision, actorId, req);
    }

    // Try as size chart
    const chart = await this.prisma.brandSizeChart.findUnique({
      where: { id: itemId },
    });

    if (chart) {
      return this.reviewSizeChart(chart.id, decision, actorId, req);
    }

    throw new NotFoundException('Moderation item not found');
  }

  private async reviewMeasurementPoint(
    pointId: string,
    decision: { action: string; reason?: string },
    actorId: string,
    req: Request,
  ) {
    const newStatus =
      decision.action === 'approve' ? 'APPROVED_GLOBAL' : 'REJECTED';

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.measurementPoint.update({
        where: { id: pointId },
        data: {
          status: newStatus as any,
          reviewedAt: new Date(),
          reviewedById: actorId,
          rejectionReason: decision.reason ?? null,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MEASUREMENT_REVIEW,
          targetType: 'MeasurementPoint',
          targetId: pointId,
          newState: { status: newStatus, reason: decision.reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  private async reviewSizeChart(
    chartId: string,
    decision: { action: string; reason?: string },
    actorId: string,
    req: Request,
  ) {
    const newStatus =
      decision.action === 'approve' ? 'PUBLISHED' : 'SENT_BACK';

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brandSizeChart.update({
        where: { id: chartId },
        data: { status: newStatus as any },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MODERATION_ITEM_UPDATE,
          targetType: 'BrandSizeChart',
          targetId: chartId,
          newState: { status: newStatus, reason: decision.reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }
}
