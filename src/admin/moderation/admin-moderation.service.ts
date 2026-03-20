import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, ContentTarget } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';

@Injectable()
export class AdminModerationService {
  private readonly logger = new Logger(AdminModerationService.name);

  private normalizeMeasurementDisplayLabel(rawLabel: string): string {
    return String(rawLabel ?? '')
      .trim()
      .replace(/^BRAND[_\-\s]+[^_\-\s]+[_\-\s]+/i, '')
      .replace(/^(MEN|WOMEN|WOMAN|UNISEX)[_\-\s]+/i, '')
      .replace(/[_\-\s]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private normalizeMeasurementPointRow<T extends { label?: string | null }>(point: T): T {
    if (typeof point.label !== 'string') {
      return point;
    }
    return {
      ...point,
      label: this.normalizeMeasurementDisplayLabel(point.label),
    };
  }

  constructor(private readonly prisma: PrismaService) {}

  async quarantineThreads(
    body: {
      userId: string;
      contentId: string;
      contentType: ContentTarget;
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    await this.prisma.$transaction(async (tx) => {
      await tx.quarantinedThread.create({
        data: {
          userId: body.userId,
          contentId: body.contentId,
          contentType: body.contentType,
          reason: body.reason ?? null,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MODERATION_QUARANTINE,
          targetType: body.contentType,
          targetId: body.contentId,
          metadata: {
            userId: body.userId,
            reason: body.reason ?? null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return { success: true };
  }

  async bulkRemoveThreads(
    entries: Array<{
      userId: string;
      contentId: string;
      contentType: ContentTarget;
    }>,
    actorId: string,
    req: Request,
  ) {
    if (!Array.isArray(entries) || entries.length === 0) {
      return { success: true, removed: 0 };
    }
    if (entries.length > 1000) {
      throw new BadRequestException('Bulk removal limit exceeded (max 1000 entries)');
    }

    const chunk = <T>(input: T[], size: number): T[][] => {
      const result: T[][] = [];
      for (let i = 0; i < input.length; i += size) {
        result.push(input.slice(i, i + size));
      }
      return result;
    };

    const dedupeMap = new Map<string, { userId: string; contentId: string; contentType: ContentTarget }>();
    for (const entry of entries) {
      const key = `${entry.contentType}:${entry.userId}:${entry.contentId}`;
      if (!dedupeMap.has(key)) {
        dedupeMap.set(key, entry);
      }
    }
    const dedupedEntries = Array.from(dedupeMap.values());
    const collectionEntries = dedupedEntries.filter((e) => e.contentType === 'COLLECTION');
    const postEntries = dedupedEntries.filter((e) => e.contentType === 'POST');

    let removedCount = 0;
    await this.prisma.$transaction(async (tx) => {
      for (const batch of chunk(collectionEntries, 200)) {
        const result = await tx.collectionReaction.deleteMany({
          where: {
            OR: batch.map((entry) => ({
              userId: entry.userId,
              collectionId: entry.contentId,
            })),
          },
        });
        removedCount += result.count;
      }

      for (const batch of chunk(postEntries, 200)) {
        const result = await tx.thread.deleteMany({
          where: {
            OR: batch.map((entry) => ({
              userId: entry.userId,
              postId: entry.contentId,
            })),
          },
        });
        removedCount += result.count;
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_MODERATION_BULK_REMOVE,
          targetType: 'BulkModeration',
          metadata: {
            requestedCount: entries.length,
            dedupedCount: dedupedEntries.length,
            removedCount,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });
    });

    return {
      success: true,
      removed: removedCount,
      requested: entries.length,
      deduped: dedupedEntries.length,
    };
  }

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
      freeformPoints: points.map((point) => this.normalizeMeasurementPointRow(point)),
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

    return this.normalizeMeasurementPointRow(updated);
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
