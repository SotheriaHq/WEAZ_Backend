import { Injectable, Logger } from '@nestjs/common';
import { Prisma, CollectionVisibility } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';

import { PrismaService } from 'src/prisma/prisma.service';
import {
  canonicalBrandProfileSelect,
  resolveRequiredBrandField,
} from 'src/common/brand-profile-source.helper';
import {
  canonicalUserProfileSelect,
  resolveProfileImage,
  resolveRequiredProfileField,
} from 'src/common/user-profile-source.helper';
import { DesignResponseMapper } from './mappers/design-response.mapper';

@Injectable()
export class DesignResolverService {
  private readonly logger = new Logger(DesignResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  private selectOwnerDisplay() {
    return {
      id: true,
      username: true,
      type: true,
      userProfile: { select: canonicalUserProfileSelect },
      brand: { select: canonicalBrandProfileSelect },
    } as const;
  }

  private mapOwner(owner: any) {
    if (!owner) return null;
    const profileImage = resolveProfileImage(owner);
    return {
      id: owner.id,
      username: owner.username,
      firstName: resolveRequiredProfileField(owner, 'firstName'),
      lastName: resolveRequiredProfileField(owner, 'lastName'),
      brandFullName: resolveRequiredBrandField(owner, 'brandFullName') || null,
      profileImage: owner.brand?.logo ?? profileImage.url,
      profileImageId: profileImage.fileId,
      profileImageFile: profileImage.file,
      brand: owner.brand ?? null,
    };
  }

  private explicitDesignInclude() {
    return {
      owner: { select: this.selectOwnerDisplay() },
      medias: {
        include: { file: true },
        orderBy: { orderIndex: 'asc' as const },
      },
      entityFilters: {
        include: { filterValue: true },
      },
    };
  }

  private async canViewExplicitDesign(design: any, requesterId?: string) {
    if (!design || design.deletedAt) return false;
    if (requesterId && requesterId === design.ownerId) return true;
    if (design.status !== 'PUBLISHED') return false;
    if (design.visibility === CollectionVisibility.PUBLIC) return true;
    if (!requesterId || !design.legacyCollectionId) return false;

    const access = await this.prisma.collectionAccess.findUnique({
      where: {
        collectionId_viewerId: {
          collectionId: design.legacyCollectionId,
          viewerId: requesterId,
        },
      },
      select: { state: true },
    });
    return access?.state === 'APPROVED';
  }

  async resolveExplicitDesign(designId: string, requesterId?: string) {
    const design = await this.prisma.design.findFirst({
      where: {
        OR: [{ id: designId }, { legacyCollectionId: designId }],
      },
      include: this.explicitDesignInclude(),
    });
    if (!design) return null;
    if (!(await this.canViewExplicitDesign(design, requesterId))) return null;

    return DesignResponseMapper.fromExplicitDesign({
      ...design,
      owner: this.mapOwner(design.owner),
    });
  }

  async resolveLegacyCollectionId(designId: string): Promise<string | null> {
    const design = await this.prisma.design.findFirst({
      where: { OR: [{ id: designId }, { legacyCollectionId: designId }] },
      select: { legacyCollectionId: true },
    });
    return design?.legacyCollectionId ?? null;
  }

  async syncFromLegacyCollectionId(legacyCollectionId: string) {
    const legacy = await this.prisma.collection.findUnique({
      where: { id: legacyCollectionId },
      include: {
        medias: { orderBy: { orderIndex: 'asc' } },
        draftSessions: true,
      },
    });
    if (!legacy) return null;
    return this.syncFromLegacyCollection(legacy);
  }

  async syncFromLegacyCollection(legacy: any) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId: legacy.ownerId },
      select: { id: true },
    });
    const media = Array.isArray(legacy.medias) ? legacy.medias : [];

    return this.prisma.$transaction(async (tx) => {
      const design = await tx.design.upsert({
        where: { legacyCollectionId: legacy.id },
        update: {
          ownerId: legacy.ownerId,
          brandId: brand?.id ?? null,
          title: legacy.title,
          description: legacy.description,
          status: legacy.status,
          archivedFromStatus: legacy.archivedFromStatus,
          visibility: legacy.visibility,
          type: legacy.type,
          categoryId: legacy.categoryId,
          categoryTypeId: legacy.categoryTypeId,
          deletedAt: legacy.deletedAt,
          deleteExpiresAt: legacy.deleteExpiresAt,
          lastActivityAt: legacy.lastActivityAt,
          draftVersion: legacy.draftVersion,
          minPrice: legacy.minPrice,
          maxPrice: legacy.maxPrice,
          customOrderEnabled: legacy.customOrderEnabled,
          tags: legacy.tags ?? [],
          saleMinPrice: legacy.saleMinPrice,
          saleMaxPrice: legacy.saleMaxPrice,
          saleStartAt: legacy.saleStartAt,
          saleEndAt: legacy.saleEndAt,
          sizingMode: legacy.sizingMode,
          rtwSizes: legacy.rtwSizes ?? [],
          rtwSizeSystem: legacy.rtwSizeSystem,
          rtwSizeType: legacy.rtwSizeType,
          customGender: legacy.customGender,
          customMeasurementKeys: legacy.customMeasurementKeys ?? [],
          customFreeformPointIds: legacy.customFreeformPointIds ?? [],
          fitPreference: legacy.fitPreference,
          targetAgeGroup: legacy.targetAgeGroup,
          metadataEditedAt: legacy.metadataEditedAt,
          threadsCount: legacy.threadsCount,
          dislikesCount: legacy.dislikesCount,
          commentsCount: legacy.commentsCount,
          collectionCollabsCount: legacy.collectionCollabsCount,
          viewsCount: legacy.viewsCount,
        },
        create: {
          id: uuidv4(),
          ownerId: legacy.ownerId,
          brandId: brand?.id ?? null,
          legacyCollectionId: legacy.id,
          title: legacy.title,
          description: legacy.description,
          status: legacy.status,
          archivedFromStatus: legacy.archivedFromStatus,
          visibility: legacy.visibility,
          type: legacy.type,
          categoryId: legacy.categoryId,
          categoryTypeId: legacy.categoryTypeId,
          deletedAt: legacy.deletedAt,
          deleteExpiresAt: legacy.deleteExpiresAt,
          lastActivityAt: legacy.lastActivityAt,
          draftVersion: legacy.draftVersion,
          minPrice: legacy.minPrice,
          maxPrice: legacy.maxPrice,
          customOrderEnabled: legacy.customOrderEnabled,
          tags: legacy.tags ?? [],
          saleMinPrice: legacy.saleMinPrice,
          saleMaxPrice: legacy.saleMaxPrice,
          saleStartAt: legacy.saleStartAt,
          saleEndAt: legacy.saleEndAt,
          sizingMode: legacy.sizingMode,
          rtwSizes: legacy.rtwSizes ?? [],
          rtwSizeSystem: legacy.rtwSizeSystem,
          rtwSizeType: legacy.rtwSizeType,
          customGender: legacy.customGender,
          customMeasurementKeys: legacy.customMeasurementKeys ?? [],
          customFreeformPointIds: legacy.customFreeformPointIds ?? [],
          fitPreference: legacy.fitPreference,
          targetAgeGroup: legacy.targetAgeGroup,
          createdAt: legacy.createdAt,
          updatedAt: legacy.updatedAt,
          metadataEditedAt: legacy.metadataEditedAt,
          threadsCount: legacy.threadsCount,
          dislikesCount: legacy.dislikesCount,
          commentsCount: legacy.commentsCount,
          collectionCollabsCount: legacy.collectionCollabsCount,
          viewsCount: legacy.viewsCount,
        },
        select: { id: true },
      });

      for (const item of media) {
        await tx.designMedia.upsert({
          where: { legacyCollectionMediaId: item.id },
          update: {
            designId: design.id,
            fileUploadId: item.fileUploadId,
            orderIndex: item.orderIndex,
            mediaType: item.mediaType,
            threadsCount: item.threadsCount,
            commentsCount: item.commentsCount,
          },
          create: {
            id: uuidv4(),
            designId: design.id,
            fileUploadId: item.fileUploadId,
            orderIndex: item.orderIndex,
            mediaType: item.mediaType,
            legacyCollectionMediaId: item.id,
            threadsCount: item.threadsCount,
            commentsCount: item.commentsCount,
          },
        });
      }

      await this.syncFilters(tx, legacy.id, design.id);

      if (legacy.coverMediaId) {
        const cover = await tx.designMedia.findUnique({
          where: { legacyCollectionMediaId: legacy.coverMediaId },
          select: { id: true },
        });
        if (cover) {
          await tx.design.update({
            where: { id: design.id },
            data: { coverMediaId: cover.id },
          });
        }
      }

      return design;
    });
  }

  async trySyncFromLegacyCollection(legacyCollectionId: string) {
    try {
      return await this.syncFromLegacyCollectionId(legacyCollectionId);
    } catch (error) {
      this.logger.warn(
        `Design dual-write sync failed for legacy collection ${legacyCollectionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  private async syncFilters(
    tx: Prisma.TransactionClient,
    legacyCollectionId: string,
    designId: string,
  ) {
    const filters = await tx.entityFilter.findMany({
      where: { entityType: 'COLLECTION', entityId: legacyCollectionId },
      select: { filterValueId: true },
    });

    for (const filter of filters) {
      await tx.entityFilter.upsert({
        where: {
          filterValueId_entityType_entityId: {
            filterValueId: filter.filterValueId,
            entityType: 'DESIGN',
            entityId: designId,
          },
        },
        update: { designId },
        create: {
          id: uuidv4(),
          filterValueId: filter.filterValueId,
          entityType: 'DESIGN',
          entityId: designId,
          designId,
        },
      });
    }
  }
}
