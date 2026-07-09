import { Injectable, NotFoundException } from '@nestjs/common';
import {
  AdminAuditAction,
  CollectionStatus,
  NotificationType,
} from '@prisma/client';
import { Request } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { getDesignDomainWriteMode } from 'src/designs/design-domain-write-mode';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';
import {
  emptyAdminCatalogFilterMetadata,
  loadAdminCatalogFilters,
} from '../catalog-metadata.helper';

@Injectable()
export class AdminDesignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications?: NotificationsService,
  ) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    ownerId?: string;
    status?: CollectionStatus;
    visibility?: 'PUBLIC' | 'PRIVATE';
    sortBy?: 'recent' | 'oldest' | 'views' | 'orders';
  }) {
    // While DESIGN_DOMAIN_WRITE_MODE is legacy/dual, designs are persisted as
    // legacy DESIGN-domain collections and explicit Design rows are synced
    // copies (missing entirely for content that predates the sync). Reading
    // only the Design table left this tab empty against live data, so in
    // those modes the canonical list source is the legacy collection table.
    if (getDesignDomainWriteMode() !== 'design') {
      return this.listFromLegacyDesignCollections(params);
    }
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      deletedAt: null,
    };

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.ownerId) where.ownerId = params.ownerId;
    if (params.status) where.status = params.status;
    if (params.visibility) where.visibility = params.visibility;

    let orderBy: Record<string, string> = { createdAt: 'desc' };
    if (params.sortBy === 'oldest') orderBy = { createdAt: 'asc' };
    else if (params.sortBy === 'views') orderBy = { viewsCount: 'desc' };

    const items = await this.prisma.design.findMany({
      where,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        type: true,
        categoryId: true,
        categoryTypeId: true,
        tags: true,
        viewsCount: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        coverMedia: {
          select: {
            fileUploadId: true,
            file: {
              select: {
                s3Url: true,
              },
            },
          },
        },
        medias: {
          orderBy: { orderIndex: 'asc' },
          take: 1,
          select: {
            fileUploadId: true,
            file: {
              select: {
                s3Url: true,
              },
            },
          },
        },
        owner: {
          select: adminUserDisplaySelect,
        },
        category: {
          select: {
            id: true,
            slug: true,
            name: true,
          },
        },
        categoryType: {
          select: {
            id: true,
            categoryId: true,
            slug: true,
            name: true,
          },
        },
      },
      orderBy,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;
    const filterMetadata = await loadAdminCatalogFilters(
      this.prisma,
      'DESIGN',
      results.map((item) => item.id),
    );
    const designIds = results.map((item) => item.id);
    const groupedOrders =
      designIds.length > 0
        ? await this.prisma.customOrder.groupBy({
            by: ['sourceId'],
            where: {
              sourceType: 'DESIGN',
              sourceId: { in: designIds },
            },
            _count: {
              _all: true,
            },
          })
        : [];
    const orderCountByDesignId = new Map(
      groupedOrders.map((entry) => [entry.sourceId, entry._count._all]),
    );

    // If sorting by orders, re-sort in memory since it's a computed field
    let sortedResults = results;
    if (params.sortBy === 'orders') {
      sortedResults = [...results].sort(
        (a, b) =>
          (orderCountByDesignId.get(b.id) ?? 0) -
          (orderCountByDesignId.get(a.id) ?? 0),
      );
    }

    return {
      items: sortedResults.map((item: any) => ({
        ...item,
        entityType: 'DESIGN',
        owner: mapAdminUserDisplay(item.owner),
        taxonomy: {
          garmentCategory: item.category ?? null,
          garmentSubcategory: item.categoryType ?? null,
          audience: item.type ?? null,
          hashtags: item.tags ?? [],
          discoveryMetadata:
            filterMetadata.get(item.id) ?? emptyAdminCatalogFilterMetadata(),
        },
        coverImage:
          item.coverMedia?.file?.s3Url ?? item.medias?.[0]?.file?.s3Url ?? null,
        coverImageFileId:
          item.coverMedia?.fileUploadId ??
          item.medias?.[0]?.fileUploadId ??
          null,
        orderCount: orderCountByDesignId.get(item.id) ?? 0,
        viewCount: item.viewsCount ?? 0,
      })),
      nextCursor,
    };
  }

  private async listFromLegacyDesignCollections(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    ownerId?: string;
    status?: CollectionStatus;
    visibility?: 'PUBLIC' | 'PRIVATE';
    sortBy?: 'recent' | 'oldest' | 'views' | 'orders';
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {
      domain: 'DESIGN',
      deletedAt: null,
    };

    if (params.search) {
      where.OR = [
        { title: { contains: params.search, mode: 'insensitive' } },
        { description: { contains: params.search, mode: 'insensitive' } },
      ];
    }
    if (params.ownerId) where.ownerId = params.ownerId;
    if (params.status) where.status = params.status;
    if (params.visibility) where.visibility = params.visibility;

    let orderBy: Record<string, string> = { createdAt: 'desc' };
    if (params.sortBy === 'oldest') orderBy = { createdAt: 'asc' };
    else if (params.sortBy === 'views') orderBy = { viewsCount: 'desc' };

    const items = await this.prisma.collection.findMany({
      where: where as any,
      select: {
        id: true,
        title: true,
        description: true,
        status: true,
        visibility: true,
        categoryId: true,
        categoryTypeId: true,
        tags: true,
        viewsCount: true,
        ownerId: true,
        createdAt: true,
        updatedAt: true,
        coverMedia: {
          select: {
            fileUploadId: true,
            file: { select: { s3Url: true } },
          },
        },
        medias: {
          orderBy: { orderIndex: 'asc' },
          take: 1,
          select: {
            fileUploadId: true,
            file: { select: { s3Url: true } },
          },
        },
        owner: { select: adminUserDisplaySelect },
        category: { select: { id: true, slug: true, name: true } },
        categoryType: {
          select: { id: true, categoryId: true, slug: true, name: true },
        },
      },
      orderBy,
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;
    // Legacy rows store their taxonomy filters under entityType COLLECTION.
    const filterMetadata = await loadAdminCatalogFilters(
      this.prisma,
      'COLLECTION',
      results.map((item) => item.id),
    );
    const designIds = results.map((item) => item.id);
    const groupedOrders =
      designIds.length > 0
        ? await this.prisma.customOrder.groupBy({
            by: ['sourceId'],
            where: {
              sourceType: 'DESIGN',
              sourceId: { in: designIds },
            },
            _count: { _all: true },
          })
        : [];
    const orderCountByDesignId = new Map(
      groupedOrders.map((entry) => [entry.sourceId, entry._count._all]),
    );

    let sortedResults = results;
    if (params.sortBy === 'orders') {
      sortedResults = [...results].sort(
        (a, b) =>
          (orderCountByDesignId.get(b.id) ?? 0) -
          (orderCountByDesignId.get(a.id) ?? 0),
      );
    }

    return {
      items: sortedResults.map((item: any) => ({
        ...item,
        entityType: 'DESIGN',
        owner: mapAdminUserDisplay(item.owner),
        taxonomy: {
          garmentCategory: item.category ?? null,
          garmentSubcategory: item.categoryType ?? null,
          audience: null,
          hashtags: item.tags ?? [],
          discoveryMetadata:
            filterMetadata.get(item.id) ?? emptyAdminCatalogFilterMetadata(),
        },
        coverImage:
          item.coverMedia?.file?.s3Url ?? item.medias?.[0]?.file?.s3Url ?? null,
        coverImageFileId:
          item.coverMedia?.fileUploadId ??
          item.medias?.[0]?.fileUploadId ??
          null,
        orderCount: orderCountByDesignId.get(item.id) ?? 0,
        viewCount: item.viewsCount ?? 0,
      })),
      nextCursor,
    };
  }

  async moderate(
    designId: string,
    dto: {
      status?: CollectionStatus;
      action?: 'UNPUBLISH' | 'REPUBLISH' | 'HARD_DELETE';
      reason?: string;
    },
    actorId: string,
    req: Request,
  ) {
    // The id may be an explicit Design id OR a legacy DESIGN-domain
    // collection id (the legacy list above serves collection ids). Resolve
    // both so moderation reaches whichever rows exist, and mirror status to
    // the legacy collection — in legacy write mode that row is what brand
    // catalogs and buyers actually read.
    const explicit = await this.prisma.design.findFirst({
      where: { OR: [{ id: designId }, { legacyCollectionId: designId }] },
      select: {
        id: true,
        title: true,
        ownerId: true,
        status: true,
        legacyCollectionId: true,
      },
    });
    const legacyCollectionId = explicit?.legacyCollectionId ?? designId;
    const legacy = await this.prisma.collection.findFirst({
      where: { id: legacyCollectionId, domain: 'DESIGN' as any, deletedAt: null },
      select: { id: true, title: true, ownerId: true, status: true },
    });

    const existing = explicit ?? legacy;
    if (!existing) {
      throw new NotFoundException('Design not found');
    }

    const action =
      dto.action ??
      (dto.status === 'ARCHIVED'
        ? 'UNPUBLISH'
        : dto.status === 'PUBLISHED'
          ? 'REPUBLISH'
          : undefined);
    const updateData: Record<string, unknown> = {};
    if (action === 'UNPUBLISH') {
      updateData.status = 'ARCHIVED';
      updateData.archivedFromStatus = existing.status;
    }
    if (action === 'REPUBLISH') {
      updateData.status = 'PUBLISHED';
      updateData.archivedFromStatus = null;
    }
    if (!action && dto.status !== undefined) updateData.status = dto.status;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (action === 'HARD_DELETE') {
        let deleted: { id: string; title: string | null } = {
          id: existing.id,
          title: existing.title ?? null,
        };
        if (explicit) {
          deleted = await tx.design.delete({
            where: { id: explicit.id },
            select: {
              id: true,
              title: true,
            },
          });
        }
        if (legacy) {
          // Legacy rows carry the live storefront relations; soft-delete so
          // buyer-facing reads stop serving it without cascading data loss.
          await tx.collection.update({
            where: { id: legacy.id },
            data: { deletedAt: new Date() },
          });
        }

        await (tx as any).adminAuditLog.create({
          data: {
            id: uuidv4(),
            actorUserId: actorId,
            action: AdminAuditAction.ADMIN_COLLECTION_MODERATE,
            targetType: 'Design',
            targetId: designId,
            previousState: {
              status: existing.status,
            },
            newState: {
              action: 'HARD_DELETE',
              reason: dto.reason?.trim() || null,
            },
            metadata: {
              reason: dto.reason?.trim() || null,
            },
            ipAddress: req.socket?.remoteAddress ?? null,
            userAgent: req.headers['user-agent'] ?? null,
          },
        });

        return {
          ...deleted,
          deleted: true,
          updatedAt: new Date(),
        };
      }

      let design: {
        id: string;
        title: string | null;
        status: CollectionStatus;
        updatedAt: Date;
      } = {
        id: existing.id,
        title: existing.title ?? null,
        status: (updateData.status as CollectionStatus) ?? existing.status,
        updatedAt: new Date(),
      };
      if (explicit) {
        design = await tx.design.update({
          where: { id: explicit.id },
          data: updateData,
          select: {
            id: true,
            title: true,
            status: true,
            updatedAt: true,
          },
        });
      }
      if (legacy) {
        const legacyUpdated = await tx.collection.update({
          where: { id: legacy.id },
          data: updateData as any,
          select: {
            id: true,
            title: true,
            status: true,
            updatedAt: true,
          },
        });
        if (!explicit) {
          design = legacyUpdated;
        }
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_COLLECTION_MODERATE,
          targetType: 'Design',
          targetId: designId,
          previousState: {
            status: existing.status,
          },
          newState: {
            ...updateData,
            action: action ?? null,
            reason: dto.reason?.trim() || null,
          },
          metadata: {
            reason: dto.reason?.trim() || null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return design;
    });

    if (
      this.notifications &&
      existing.ownerId &&
      existing.ownerId !== actorId &&
      (action === 'UNPUBLISH' || action === 'HARD_DELETE')
    ) {
      try {
        const reasonText = dto.reason?.trim();
        const verb = action === 'HARD_DELETE' ? 'deleted' : 'unpublished';
        const reasonSuffix = reasonText ? ` Reason: ${reasonText}` : '';
        await this.notifications.create(
          existing.ownerId,
          NotificationType.ADMIN_ACTION,
          {
            actorId,
            payload: {
              targetType: 'DESIGN',
              targetId: designId,
              message: `Admin ${verb} your design "${existing.title ?? 'Untitled'}".${reasonSuffix}`,
              reason: reasonText,
            },
          },
        );
      } catch {}
    }

    return updated;
  }
}
