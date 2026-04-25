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

  async listMeasurementPoints(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    status?: string;
    source?: string;
    category?: string;
    isActive?: string;
    sort?: string;
  }) {
    const take = Math.min(Math.max(params.limit ?? 30, 1), 100);
    const where: Record<string, unknown> = {};

    const normalizedSearch = String(params.search ?? '').trim();
    if (normalizedSearch) {
      where.OR = [
        { label: { contains: normalizedSearch, mode: 'insensitive' } },
        { key: { contains: normalizedSearch, mode: 'insensitive' } },
        { description: { contains: normalizedSearch, mode: 'insensitive' } },
      ];
    }

    const normalizedStatus = String(params.status ?? '').trim().toUpperCase();
    if (normalizedStatus && normalizedStatus !== 'ALL') {
      where.status = normalizedStatus;
    }

    const normalizedSource = String(params.source ?? '').trim().toUpperCase();
    if (normalizedSource && normalizedSource !== 'ALL') {
      where.source = normalizedSource;
    }

    const normalizedCategory = String(params.category ?? '').trim().toUpperCase();
    if (normalizedCategory && normalizedCategory !== 'ALL') {
      where.category = normalizedCategory;
    }

    const normalizedActive = String(params.isActive ?? 'all').trim().toLowerCase();
    if (normalizedActive === 'active') {
      where.isActive = true;
    } else if (normalizedActive === 'inactive') {
      where.isActive = false;
    }

    const sort = String(params.sort ?? 'recent').trim().toLowerCase();
    const orderBy =
      sort === 'oldest'
        ? [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
        : sort === 'label'
          ? [{ label: 'asc' as const }, { createdAt: 'desc' as const }]
          : sort === 'updated'
            ? [{ updatedAt: 'desc' as const }, { createdAt: 'desc' as const }]
            : [{ createdAt: 'desc' as const }, { id: 'desc' as const }];

    const rows = await this.prisma.measurementPoint.findMany({
      where,
      orderBy,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
      take: take + 1,
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
              },
            },
          },
        },
      },
    });

    const hasMore = rows.length > take;
    const pageRows = hasMore ? rows.slice(0, take) : rows;

    const reviewerIds = Array.from(
      new Set(pageRows.map((row) => row.reviewedById).filter(Boolean) as string[]),
    );
    const reviewers = reviewerIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: reviewerIds } },
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        })
      : [];
    const reviewerMap = new Map(reviewers.map((row) => [row.id, row]));

    const items = pageRows.map((row) => {
      const reviewer = row.reviewedById ? reviewerMap.get(row.reviewedById) : null;
      return {
        id: row.id,
        key: row.key,
        label: this.normalizeMeasurementDisplayLabel(row.label),
        description: row.description,
        category: row.category,
        gender: row.gender,
        source: row.source,
        status: row.status,
        brandId: row.brandId,
        brand: row.brand
          ? {
              id: row.brand.id,
              name: row.brand.name,
              ownerId: row.brand.ownerId,
              owner: row.brand.owner,
            }
          : null,
        minValueCm: row.minValueCm == null ? null : Number(row.minValueCm),
        maxValueCm: row.maxValueCm == null ? null : Number(row.maxValueCm),
        sortOrder: row.sortOrder,
        isActive: row.isActive,
        submittedAt: row.submittedAt ? row.submittedAt.toISOString() : null,
        reviewedAt: row.reviewedAt ? row.reviewedAt.toISOString() : null,
        reviewedBy: reviewer
          ? {
              id: reviewer.id,
              username: reviewer.username,
              brandFullName: reviewer.brandFullName,
              profileImage: reviewer.profileImage,
            }
          : null,
        rejectionReason: row.rejectionReason,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    return {
      items,
      nextCursor: hasMore ? pageRows[pageRows.length - 1]?.id ?? null : null,
    };
  }

  async getMeasurementPointLifecycle(pointId: string) {
    const point = await this.prisma.measurementPoint.findUnique({
      where: { id: pointId },
      include: {
        brand: {
          select: {
            id: true,
            name: true,
            ownerId: true,
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
              },
            },
          },
        },
      },
    });

    if (!point) {
      throw new NotFoundException('Measurement point not found');
    }

    const [
      collectionUsageByIdCount,
      collectionUsageByKeyCount,
      productUsageByIdCount,
      productUsageByKeyCount,
      collectionsUsingId,
      collectionsUsingKey,
      productsUsingId,
      productsUsingKey,
      reviewer,
    ] = await Promise.all([
      this.prisma.collection.count({
        where: {
          customFreeformPointIds: { has: point.id },
          deletedAt: null,
        },
      }),
      this.prisma.collection.count({
        where: {
          customMeasurementKeys: { has: point.key },
          deletedAt: null,
        },
      }),
      this.prisma.product.count({
        where: {
          customFreeformPointIds: { has: point.id },
          deletedAt: null,
          archivedAt: null,
        },
      }),
      this.prisma.product.count({
        where: {
          customMeasurementKeys: { has: point.key },
          deletedAt: null,
          archivedAt: null,
        },
      }),
      this.prisma.collection.findMany({
        where: {
          customFreeformPointIds: { has: point.id },
          deletedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 60,
        select: {
          id: true,
          title: true,
          ownerId: true,
          status: true,
          visibility: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.collection.findMany({
        where: {
          customMeasurementKeys: { has: point.key },
          deletedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 60,
        select: {
          id: true,
          title: true,
          ownerId: true,
          status: true,
          visibility: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      this.prisma.product.findMany({
        where: {
          customFreeformPointIds: { has: point.id },
          deletedAt: null,
          archivedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 60,
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
          isActive: true,
          brand: {
            select: {
              id: true,
              name: true,
              ownerId: true,
            },
          },
        },
      }),
      this.prisma.product.findMany({
        where: {
          customMeasurementKeys: { has: point.key },
          deletedAt: null,
          archivedAt: null,
        },
        orderBy: [{ updatedAt: 'desc' }],
        take: 60,
        select: {
          id: true,
          name: true,
          createdAt: true,
          updatedAt: true,
          isActive: true,
          brand: {
            select: {
              id: true,
              name: true,
              ownerId: true,
            },
          },
        },
      }),
      point.reviewedById
        ? this.prisma.user.findUnique({
            where: { id: point.reviewedById },
            select: {
              id: true,
              username: true,
              brandFullName: true,
              profileImage: true,
            },
          })
        : Promise.resolve(null),
    ]);

    const collectionMap = new Map<string, (typeof collectionsUsingId)[number]>();
    for (const row of [...collectionsUsingId, ...collectionsUsingKey]) {
      if (!collectionMap.has(row.id)) {
        collectionMap.set(row.id, row);
      }
    }

    const productMap = new Map<string, (typeof productsUsingId)[number]>();
    for (const row of [...productsUsingId, ...productsUsingKey]) {
      if (!productMap.has(row.id)) {
        productMap.set(row.id, row);
      }
    }

    const usageByUser = new Map<
      string,
      {
        usageCount: number;
        latestUsedAt: Date | null;
      }
    >();

    const referencesCollections = Array.from(collectionMap.values()).map((row) => {
      const prev = usageByUser.get(row.ownerId) ?? {
        usageCount: 0,
        latestUsedAt: null,
      };
      const latestUsedAt =
        prev.latestUsedAt && row.updatedAt
          ? prev.latestUsedAt > row.updatedAt
            ? prev.latestUsedAt
            : row.updatedAt
          : prev.latestUsedAt ?? row.updatedAt;
      usageByUser.set(row.ownerId, {
        usageCount: prev.usageCount + 1,
        latestUsedAt,
      });

      return {
        id: row.id,
        title: row.title,
        ownerId: row.ownerId,
        status: row.status,
        visibility: row.visibility,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    const referencesProducts = Array.from(productMap.values()).map((row) => {
      const ownerId = row.brand.ownerId;
      const prev = usageByUser.get(ownerId) ?? {
        usageCount: 0,
        latestUsedAt: null,
      };
      const latestUsedAt =
        prev.latestUsedAt && row.updatedAt
          ? prev.latestUsedAt > row.updatedAt
            ? prev.latestUsedAt
            : row.updatedAt
          : prev.latestUsedAt ?? row.updatedAt;
      usageByUser.set(ownerId, {
        usageCount: prev.usageCount + 1,
        latestUsedAt,
      });

      return {
        id: row.id,
        name: row.name,
        isActive: row.isActive,
        brandId: row.brand.id,
        brandName: row.brand.name,
        ownerId,
        createdAt: row.createdAt.toISOString(),
        updatedAt: row.updatedAt.toISOString(),
      };
    });

    const usageUserIds = Array.from(usageByUser.keys());
    const usageUsers = usageUserIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: usageUserIds } },
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        })
      : [];
    const usageUsersMap = new Map(usageUsers.map((row) => [row.id, row]));

    const usageActors = usageUserIds
      .map((userId) => {
        const stats = usageByUser.get(userId);
        const user = usageUsersMap.get(userId);
        if (!stats || !user) return null;
        return {
          userId,
          username: user.username,
          brandFullName: user.brandFullName,
          profileImage: user.profileImage,
          usageCount: stats.usageCount,
          latestUsedAt: stats.latestUsedAt
            ? stats.latestUsedAt.toISOString()
            : null,
        };
      })
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .sort((a, b) => {
        if (b.usageCount !== a.usageCount) return b.usageCount - a.usageCount;
        const aDate = a.latestUsedAt ? new Date(a.latestUsedAt).getTime() : 0;
        const bDate = b.latestUsedAt ? new Date(b.latestUsedAt).getTime() : 0;
        return bDate - aDate;
      })
      .slice(0, 60);

    const firstUsageAt = [...referencesCollections, ...referencesProducts]
      .map((entry) => new Date(entry.createdAt))
      .sort((a, b) => a.getTime() - b.getTime())[0];
    const latestUsageAt = [...referencesCollections, ...referencesProducts]
      .map((entry) => new Date(entry.updatedAt))
      .sort((a, b) => b.getTime() - a.getTime())[0];

    const timeline = [
      {
        id: `created:${point.id}`,
        type: 'POINT_CREATED',
        at: point.createdAt.toISOString(),
        summary: 'Measurement point record created.',
      },
      ...(point.submittedAt
        ? [
            {
              id: `submitted:${point.id}`,
              type: 'POINT_SUBMITTED',
              at: point.submittedAt.toISOString(),
              summary: 'Submitted for moderation by a brand.',
            },
          ]
        : []),
      ...(point.reviewedAt
        ? [
            {
              id: `reviewed:${point.id}`,
              type: point.status === 'REJECTED' ? 'POINT_REJECTED' : 'POINT_APPROVED',
              at: point.reviewedAt.toISOString(),
              summary:
                point.status === 'REJECTED'
                  ? 'Rejected during moderation.'
                  : 'Approved for broader usage.',
            },
          ]
        : []),
      ...(firstUsageAt
        ? [
            {
              id: `first-usage:${point.id}`,
              type: 'POINT_FIRST_USAGE',
              at: firstUsageAt.toISOString(),
              summary: 'First detected usage in collection/product sizing.',
            },
          ]
        : []),
      ...(latestUsageAt
        ? [
            {
              id: `latest-usage:${point.id}`,
              type: 'POINT_LATEST_USAGE',
              at: latestUsageAt.toISOString(),
              summary: 'Most recent detected usage.',
            },
          ]
        : []),
      {
        id: `updated:${point.id}`,
        type: 'POINT_UPDATED',
        at: point.updatedAt.toISOString(),
        summary: point.isActive
          ? 'Point is currently active in the library.'
          : 'Point is currently inactive in the library.',
      },
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    return {
      point: {
        id: point.id,
        key: point.key,
        label: this.normalizeMeasurementDisplayLabel(point.label),
        description: point.description,
        category: point.category,
        gender: point.gender,
        source: point.source,
        status: point.status,
        brandId: point.brandId,
        brand: point.brand
          ? {
              id: point.brand.id,
              name: point.brand.name,
              ownerId: point.brand.ownerId,
              owner: point.brand.owner,
            }
          : null,
        minValueCm: point.minValueCm == null ? null : Number(point.minValueCm),
        maxValueCm: point.maxValueCm == null ? null : Number(point.maxValueCm),
        minValueChildCm:
          point.minValueChildCm == null ? null : Number(point.minValueChildCm),
        maxValueChildCm:
          point.maxValueChildCm == null ? null : Number(point.maxValueChildCm),
        sortOrder: point.sortOrder,
        isActive: point.isActive,
        submittedAt: point.submittedAt ? point.submittedAt.toISOString() : null,
        reviewedAt: point.reviewedAt ? point.reviewedAt.toISOString() : null,
        reviewedBy: reviewer
          ? {
              id: reviewer.id,
              username: reviewer.username,
              brandFullName: reviewer.brandFullName,
              profileImage: reviewer.profileImage,
            }
          : null,
        rejectionReason: point.rejectionReason,
        createdAt: point.createdAt.toISOString(),
        updatedAt: point.updatedAt.toISOString(),
      },
      usage: {
        collectionUsageCountById: collectionUsageByIdCount,
        collectionUsageCountByKey: collectionUsageByKeyCount,
        productUsageCountById: productUsageByIdCount,
        productUsageCountByKey: productUsageByKeyCount,
        distinctUsersCount: usageActors.length,
        users: usageActors,
      },
      references: {
        collections: referencesCollections,
        products: referencesProducts,
      },
      timeline,
    };
  }

  async updateMeasurementPointLifecycle(
    pointId: string,
    decision: { action: string; reason?: string },
    actorId: string,
    req: Request,
  ) {
    const action = String(decision?.action ?? '').trim().toLowerCase();
    if (!['approve', 'reject', 'activate', 'deactivate'].includes(action)) {
      throw new BadRequestException(
        'Invalid action. Supported actions: approve, reject, activate, deactivate',
      );
    }

    if (action === 'reject' && !String(decision.reason ?? '').trim()) {
      throw new BadRequestException('Rejection reason is required when rejecting a point');
    }

    const point = await this.prisma.measurementPoint.findUnique({
      where: { id: pointId },
      select: { id: true, status: true, isActive: true },
    });

    if (!point) {
      throw new NotFoundException('Measurement point not found');
    }

    const now = new Date();
    const updateData: Record<string, unknown> = {};
    if (action === 'approve') {
      updateData.status = 'APPROVED_GLOBAL';
      updateData.isActive = true;
      updateData.reviewedAt = now;
      updateData.reviewedById = actorId;
      updateData.rejectionReason = null;
    } else if (action === 'reject') {
      updateData.status = 'REJECTED';
      updateData.reviewedAt = now;
      updateData.reviewedById = actorId;
      updateData.rejectionReason = String(decision.reason ?? '').trim();
    } else if (action === 'activate') {
      updateData.isActive = true;
    } else if (action === 'deactivate') {
      updateData.isActive = false;
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.measurementPoint.update({
        where: { id: pointId },
        data: updateData as any,
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action:
            action === 'activate' || action === 'deactivate'
              ? AdminAuditAction.ADMIN_MODERATION_ITEM_UPDATE
              : AdminAuditAction.ADMIN_MEASUREMENT_REVIEW,
          targetType: 'MeasurementPoint',
          targetId: pointId,
          previousState: {
            status: point.status,
            isActive: point.isActive,
          },
          newState: {
            status: (updateData.status as string | undefined) ?? point.status,
            isActive:
              (updateData.isActive as boolean | undefined) ?? point.isActive,
            reason: action === 'reject' ? String(decision.reason ?? '').trim() : null,
          },
          metadata: {
            action,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return this.normalizeMeasurementPointRow(updated);
  }

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
