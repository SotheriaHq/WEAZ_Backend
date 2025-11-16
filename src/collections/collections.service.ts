import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { v4 as uuidv4 } from 'uuid';
import {
  ReactionType,
  UserType,
  Prisma,
  ContentTarget,
  NotificationType,
  CollectionVisibility,
  CollectionType,
} from '@prisma/client';
import { NotificationsService } from 'src/notifications/notifications.service';
import { AnalyticsService } from 'src/analytics/analytics.service';
import {
  CreateCollectionDto,
  FinalizeCollectionDto,
} from './dto/create-collection.dto';
import { HelperService } from './helper/Helper.service';
import { UploadService } from 'src/upload/upload.service';
import * as crypto from 'crypto';
import { sanitizeTags } from 'src/common/utils/tag-validator';
import { UpdateCollectionDto } from './dto/update-collection.dto';

@Injectable()
export class CollectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly helperservice: HelperService,
    private readonly uploadService: UploadService,
    private readonly analytics?: AnalyticsService,
    private readonly notifications?: NotificationsService,
  ) {}

  private async canViewCollection(
    collectionId: string,
    requesterId?: string,
  ): Promise<boolean> {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true, status: true, visibility: true },
    });
    if (!c || c.status !== 'PUBLISHED') return false;
    if (c.visibility === CollectionVisibility.PUBLIC) return true;
    if (requesterId && requesterId === c.ownerId) return true;
    if (requesterId) {
      const access = await this.prisma.collectionAccess.findUnique({
        where: {
          collectionId_viewerId: { collectionId, viewerId: requesterId },
        },
        select: { state: true },
      });
      return access?.state === 'APPROVED';
    }
    return false;
  }

  private async canViewMedia(mediaId: string, requesterId?: string) {
    const m = await this.prisma.collectionMedia.findUnique({
      where: { id: mediaId },
      select: { collectionId: true },
    });
    if (!m) return false;
    return this.canViewCollection(m.collectionId, requesterId);
  }

  // ===================== Access Management =====================
  async requestAccess(collectionId: string, requesterId: string) {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { id: true, ownerId: true, status: true, visibility: true },
    });
    if (!c || c.status !== 'PUBLISHED')
      throw new NotFoundException('Collection not found');
    if (c.visibility === CollectionVisibility.PUBLIC)
      return { state: 'APPROVED' };
    if (c.ownerId === requesterId) return { state: 'APPROVED' };
    const now = new Date();
    const existing = await this.prisma.collectionAccess.findUnique({
      where: { collectionId_viewerId: { collectionId, viewerId: requesterId } },
    });
    if (!existing) {
      await this.prisma.collectionAccess.create({
        data: {
          id: uuidv4(),
          collectionId,
          viewerId: requesterId,
          state: 'PENDING',
          createdAt: now,
        },
      } as any);
      console.log('metrics.access_request', { collectionId, requesterId });
      return { state: 'PENDING' };
    }
    if (existing.state === 'APPROVED') {
      return { state: 'APPROVED' };
    }
    if (existing.state === 'PENDING') {
      console.log('metrics.access_request', { collectionId, requesterId });
      return { state: 'PENDING' };
    }
    await this.prisma.collectionAccess.update({
      where: { collectionId_viewerId: { collectionId, viewerId: requesterId } },
      data: { state: 'PENDING', updatedAt: now },
    } as any);
    console.log('metrics.access_request', { collectionId, requesterId });
    return { state: 'PENDING' };
  }

  private async assertOwner(collectionId: string, ownerId: string) {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { ownerId: true },
    });
    if (!c) throw new NotFoundException('Collection not found');
    if (c.ownerId !== ownerId) throw new ForbiddenException('Not owner');
  }

  async listAccessRequests(
    collectionId: string,
    ownerId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const rows = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'PENDING' },
      include: {
        viewer: { select: { id: true, username: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    } as any);
    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, -1) : rows;
    return {
      items: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  async listApprovedViewers(
    collectionId: string,
    ownerId: string,
    limit = 20,
    cursor?: string,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const rows = await this.prisma.collectionAccess.findMany({
      where: { collectionId, state: 'APPROVED' },
      include: {
        viewer: { select: { id: true, username: true, profileImage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    } as any);
    const hasNext = rows.length > limit;
    const data = hasNext ? rows.slice(0, -1) : rows;
    return {
      items: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  async approveAccessBulk(
    collectionId: string,
    ownerId: string,
    userIds: string[],
  ) {
    await this.assertOwner(collectionId, ownerId);
    const now = new Date();
    await this.prisma.$transaction(
      userIds.map((uid) =>
        this.prisma.collectionAccess.upsert({
          where: { collectionId_viewerId: { collectionId, viewerId: uid } },
          update: { state: 'APPROVED', grantedBy: ownerId, updatedAt: now },
          create: {
            id: uuidv4(),
            collectionId,
            viewerId: uid,
            state: 'APPROVED',
            grantedBy: ownerId,
            createdAt: now,
          },
        } as any),
      ),
    );
    console.log('metrics.access_approve_bulk', {
      collectionId,
      count: userIds.length,
    });
    return { success: true };
  }

  async updateAccessState(
    collectionId: string,
    ownerId: string,
    userId: string,
    state: 'APPROVED' | 'REVOKED',
  ) {
    await this.assertOwner(collectionId, ownerId);
    await this.prisma.collectionAccess.upsert({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
      update: { state, grantedBy: ownerId, updatedAt: new Date() },
      create: {
        id: uuidv4(),
        collectionId,
        viewerId: userId,
        state,
        grantedBy: ownerId,
      },
    } as any);
    console.log('metrics.access_update_state', { collectionId, userId, state });
    return { success: true };
  }

  /**
   * STEP 1: Create collection draft and return presigned URLs
   * Simplified: category suggestions removed; categoryId is required and must be active.
   */
  async initializeCollection(userId: string, dto: CreateCollectionDto) {
    // Validate user is brand
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can create collections');
    }

    // Validate files array
    if (!dto.files || dto.files.length === 0) {
      throw new BadRequestException('At least one file is required');
    }

    if (dto.files.length > 10) {
      throw new BadRequestException('Maximum 10 files per collection');
    }

    // PHASE 2: Use shared tag normalization utility
    const sanitizedTags = sanitizeTags(dto.tags ?? []);

    if (sanitizedTags.length === 0) {
      throw new BadRequestException('At least one descriptive tag is required');
    }

    // Require a valid, active category
    const category = await this.prisma.collectionCategory.findUnique({
      where: { id: dto.categoryId },
    });
    if (!category) {
      throw new NotFoundException('Category not found');
    }
    if (!category.isActive) {
      throw new BadRequestException('This category is not active');
    }
    const finalCategoryId = dto.categoryId;
    const collectionStatus: 'DRAFT' | 'PUBLISHED' = 'DRAFT';

    // Create collection in DRAFT status
    const collectionId = uuidv4();
    const collection = await this.prisma.collection.create({
      data: {
        id: collectionId,
        owner: { connect: { id: userId } },
        title: dto.title,
        description: dto.description,
        minPrice: dto.minPrice,
        maxPrice: dto.maxPrice,
        isAvailableInStore: dto.isAvailableInStore ?? false,
        tags: sanitizedTags,
        status: collectionStatus,
        visibility: dto.visibility ?? CollectionVisibility.PUBLIC,
        type: dto.type ?? CollectionType.EVERYBODY,
        // Set required category
        category: { connect: { id: finalCategoryId } },
      },
    });

    // Generate presigned URLs for each file using UploadService (creates presign DB entries)
    const uploadData = await Promise.all(
      dto.files.map(async (fileSpec, index) => {
        // Validate and determine file type
        const fileType = this.helperservice.determineFileType(
          fileSpec.type,
          fileSpec.fileType,
        );
        this.helperservice.validateFileSpec(fileSpec, fileType);

        // Use UploadService to create presigned POST and presign DB record
        const presign = await this.uploadService.createPresignedPost(
          userId,
          fileSpec.name,
          fileType as any,
          fileSpec.type,
        );

        return {
          fileId: (presign as any).fileId,
          orderIndex: index,
          expectedKey: (presign as any).key,
          uploadUrl: (presign as any).url,
          uploadFields: (presign as any).fields,
          expiresIn: (presign as any).expiresIn || 600, // default 10 minutes
        };
      }),
    );

    return {
      collectionId: collection.id,
      uploads: uploadData,
      expiresIn: 600,
      tags: sanitizedTags,
      // Draft status (simplified)
      draftStatus: {
        isDraft: collectionStatus === 'DRAFT',
      },
    };
  }

  async getMarketFeed(options?: {
    cursor?: string;
    limit?: number;
    tag?: string;
    countsPolicy?: 'combined';
    requesterId?: string; // Add requesterId to check like status
  }) {
    const { cursor, limit = 20, tag, requesterId } = options ?? {};
    const take = Math.min(Math.max(limit, 1), 40);

    const where: Prisma.CollectionMediaWhereInput = {
      collection: {
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PUBLIC,
        ...(tag
          ? {
              tags: {
                has: tag,
              },
            }
          : {}),
      },
    };

    const medias = await this.prisma.collectionMedia.findMany({
      where,
      take: take + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: [
        {
          file: {
            createdAt: 'desc',
          },
        },
        {
          collection: {
            createdAt: 'desc',
          },
        },
        {
          orderIndex: 'asc',
        },
      ],
      include: {
        file: true,
        collection: {
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
                profileImageId: true,
                profileImageFile: {
                  select: {
                    id: true,
                    s3Url: true,
                    fileName: true,
                    originalName: true,
                  },
                },
              },
            },
            _count: {
              select: {
                reactions: true,
                comments: true,
                patches: true,
              },
            },
          },
        },
      },
    });

    const hasNextPage = medias.length > take;
    const data = hasNextPage ? medias.slice(0, -1) : medias;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const mediaIds = data.map((m) => m.id);
      if (mediaIds.length) {
        const liked = await this.prisma.collectionMediaReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionMediaId: { in: mediaIds },
          },
          select: { collectionMediaId: true },
        });
        const set = new Set(liked.map((r) => r.collectionMediaId));
        isLikedMap = mediaIds.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    // Collect all file IDs that need signed URLs
    const fileIds = new Set<string>();
    data.forEach((media) => {
      if (media.fileUploadId) {
        fileIds.add(media.fileUploadId);
      }
      const owner = media.collection.owner;
      if (owner.profileImageId) {
        fileIds.add(owner.profileImageId);
      } else if (owner.profileImageFile?.id) {
        fileIds.add(owner.profileImageFile.id);
      }
    });

    // Batch generate signed URLs for all files
    const signedUrlMap = await this.uploadService.getBatchPublicSignedUrls(
      Array.from(fileIds),
    );

    const items = data.map((media) => {
      const { collection } = media;
      const owner = collection.owner;
      const file = media.file;

      // Get signed URL for media file
      const mediaSignedUrl = media.fileUploadId
        ? (signedUrlMap.get(media.fileUploadId) ?? null)
        : null;

      // Get signed URL for brand logo
      const logoFileId = owner.profileImageId ?? owner.profileImageFile?.id;
      const logoSignedUrl = logoFileId
        ? (signedUrlMap.get(logoFileId) ?? null)
        : null;

      const base = {
        id: media.id,
        collectionId: media.collectionId,
        mediaType: media.mediaType,
        mediaFileId: media.fileUploadId,
        mediaUrl: mediaSignedUrl, // Now contains actual signed URL
        createdAt: file?.createdAt ?? collection.createdAt,
        collectionTitle: collection.title ?? '',
        collectionDescription: collection.description ?? '',
        minPrice: collection.minPrice,
        maxPrice: collection.maxPrice,
        // Sale price fields for frontend display 
        saleMinPrice: collection.saleMinPrice,
        saleMaxPrice: collection.saleMaxPrice,
        saleStartAt: collection.saleStartAt,
        saleEndAt: collection.saleEndAt,
        likesCount: media.likesCount,
        commentsCount: media.commentsCount,
        patchesCount: collection.patchesCount,
        tags: collection.tags ?? [],
        brandId: owner.id,
        brandName: owner.brandFullName ?? owner.username ?? '',
        username: owner.username ?? '',
        brandLogo: logoSignedUrl ?? owner.profileImage ?? null, // Signed URL or fallback
        brandLogoFileId: logoFileId ?? null,
        isLiked: requesterId ? !!isLikedMap[media.id] : false, // Add like status for requester
      };
      // Optionally include combinedCommentsCount for frontend normalization
      if (options?.countsPolicy === 'combined') {
        (base as any).combinedCommentsCount =
          (collection.commentsCount ?? 0) + (media.commentsCount ?? 0);
      }
      return base;
    });
    return {
      items,
      hasNextPage,
      nextCursor: hasNextPage ? (data[data.length - 1]?.id ?? null) : null,
    };
  }

  /**
   * STEP 2: Finalize collection after S3 uploads complete
   */
  async finalizeCollection(
    collectionId: string,
    userId: string,
    dto: FinalizeCollectionDto,
  ) {
    // Verify collection exists and belongs to user
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId, ownerId: userId },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found or not owned by user');
    }

    if (collection.status !== 'DRAFT') {
      throw new BadRequestException('Collection is not in draft status');
    }

    // Verify all uploads completed successfully and create central FileUpload records via UploadService
    const verifiedFiles = await Promise.all(
      dto.completions.map(async (completion) => {
        // Verify object exists in S3
        const exists = await this.uploadService.verifyObjectExists(
          completion.s3Key,
        );
        if (!exists) {
          throw new BadRequestException(
            `File not found in S3: ${completion.s3Key}`,
          );
        }

        // Create FileUpload DB record using presign entry (marks presign as USED)
        const fileUpload = await this.uploadService.createFileRecordFromPresign(
          completion.fileId,
          userId,
          completion.s3Key,
          completion.actualMimeType,
          completion.actualSize,
        );

        return fileUpload;
      }),
    );

    // Create collection media records
    await Promise.all(
      verifiedFiles.map((file, index) =>
        this.prisma.collectionMedia.create({
          data: {
            id: uuidv4(),
            collectionId: collection.id,
            fileUploadId: file.id,
            orderIndex: index,
            mediaType: file.fileType,
          },
        }),
      ),
    );

    // Mark collection as published
    const publishedCollection = await this.prisma.collection.update({
      where: { id: collectionId },
      data: { status: 'PUBLISHED' },
      include: {
        owner: true,
        medias: { include: { file: true }, orderBy: { orderIndex: 'asc' } },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
          },
        },
      },
    });

    return publishedCollection;
  }

  /**
   * Enhanced get method with proper includes
   */
  async getCollection(id: string, requesterId?: string) {
    const ok = await this.canViewCollection(id, requesterId);
    if (!ok) throw new NotFoundException('Collection not found');
    const collection = await this.prisma.collection.findUnique({
      where: { id },
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
        },
        reactions: {
          include: {
            user: {
              select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
              },
            },
          },
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
      },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    const mediaAgg = await this.prisma.collectionMedia.aggregate({
      where: { collectionId: id },
      _sum: { likesCount: true },
    });
    const totalLikes = collection.likesCount + (mediaAgg._sum.likesCount ?? 0);
    return { ...collection, totalLikes };
  }

  /**
   * PHASE 6: Get draft collections for current user
   */
  async getMyDraftCollections(userId: string) {
    const items = await this.prisma.collection.findMany({
      where: {
        ownerId: userId,
        status: 'DRAFT',
      },
      orderBy: { createdAt: 'desc' },
      include: {
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          take: 1,
        },
        _count: {
          select: { medias: true },
        },
      },
    });

    // Generate signed URLs for cover images
    const fileIds = items
      .map((c) => c.medias[0]?.fileUploadId)
      .filter((id): id is string => !!id);

    const signedUrlMap =
      await this.uploadService.getBatchPublicSignedUrls(fileIds);

    return {
      items: items.map((c) => {
        const firstMedia = c.medias[0];
        const coverImage = firstMedia?.fileUploadId
          ? (signedUrlMap.get(firstMedia.fileUploadId) ?? null)
          : null;

        return {
          id: c.id,
          title: c.title,
          description: c.description,
          pendingCategoryName: c.pendingCategoryName,
          draftReason: c.draftReason,
          createdAt: c.createdAt,
          itemCount: c._count.medias,
          coverImage,
        };
      }),
    };
  }

  /**
   * Get collections for a specific user (optionally show drafts to owner)
   */
  async getUserCollections(
    userId: string,
    requesterId?: string,
    options?: { cursor?: string; limit?: number },
  ) {
    const { cursor, limit = 20 } = options || {};
    const where: any = { ownerId: userId };

    // If requester is not the owner, only show published public collections
    if (requesterId !== userId) {
      where.status = 'PUBLISHED';
      (where as any).visibility = CollectionVisibility.PUBLIC;
    }

    const items = await this.prisma.collection.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          take: 1,
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
        owner: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const liked = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(liked.map((r) => r.collectionId));
        isLikedMap = ids.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    return {
      items: data.map((c) => ({
        ...c,
        isLiked: requesterId ? !!isLikedMap[c.id] : false,
      })),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Delete entire collection and all its media (S3 + DB)
   */
  async deleteCollection(collectionId: string, requesterId: string) {
    // Verify collection and ownership
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.ownerId !== requesterId)
      throw new ForbiddenException('Not owner of collection');

    // Collect S3 keys to delete
    const keys = collection.medias
      .map((m) => m.file?.s3Key)
      .filter((k): k is string => !!k);

    // First delete from S3. Abort if any S3 deletion fails.
    try {
      await this.uploadService.deleteS3ObjectsByKeys(keys);
    } catch (err) {
      console.warn('Aborting collection deletion due to S3 delete failure');
      throw new BadRequestException(
        'Failed to delete files from storage; aborting',
      );
    }

    // Then delete DB records in a transaction: fileUpload, collectionMedia, collection
    try {
      await this.prisma.$transaction(async (tx) => {
        // Delete collection medias (and dependent file uploads)
        const fileIds = collection.medias
          .map((m) => m.file?.id)
          .filter((id): id is string => !!id);

        if (fileIds.length) {
          await tx.fileUpload.deleteMany({
            where: { id: { in: fileIds } } as any,
          });
        }

        await tx.collectionMedia.deleteMany({ where: { collectionId } as any });

        await tx.collection.delete({ where: { id: collectionId } });
      });
    } catch (err) {
      console.warn('DB transaction failed after S3 deletion:', err);
      throw new BadRequestException('Failed to delete collection records');
    }

    return { success: true };
  }

  /**
   * Delete a single collection item. If it was the only item, delete the collection as well.
   */
  async deleteCollectionItem(
    collectionId: string,
    itemId: string,
    requesterId: string,
  ) {
    // Verify collection exists and owner
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      include: { medias: { include: { file: true } } },
    });
    if (!collection) throw new NotFoundException('Collection not found');
    if (collection.ownerId !== requesterId)
      throw new ForbiddenException('Not owner of collection');

    const media = collection.medias.find(
      (m) =>
        m.id === itemId ||
        (m as any).fileUploadId === itemId ||
        m.file?.id === itemId,
    );
    if (!media) throw new NotFoundException('Collection item not found');

    // Delete S3 object for this media first
    const key = media.file?.s3Key;
    if (!key) throw new BadRequestException('No file key found for media');

    try {
      await this.uploadService.deleteS3ObjectByKey(key);
    } catch (err) {
      console.warn('Failed to delete S3 object for media:', media.id, err);
      throw new BadRequestException('Failed to delete file from storage');
    }

    // Then run DB transaction to remove fileUpload, media row, and possibly collection
    try {
      await this.prisma.$transaction(async (tx) => {
        if (media.file && media.file.id) {
          await tx.fileUpload.delete({ where: { id: media.file.id } as any });
        }

        await tx.collectionMedia.delete({ where: { id: media.id } as any });

        const remaining = await tx.collectionMedia.count({
          where: { collectionId } as any,
        });
        if (remaining === 0) {
          await tx.collection.delete({ where: { id: collectionId } });
        }
      });
    } catch (err) {
      console.warn('DB transaction failed after S3 deletion for media:', err);
      throw new BadRequestException('Failed to delete media records');
    }

    const remainingAfter = await this.prisma.collectionMedia.count({
      where: { collectionId },
    });
    const deletedCollection = remainingAfter === 0;
    return { success: true, deletedCollection };
  }

  /**
   * Improved listing with better performance
   */
  async listCollections({
    cursor,
    limit = 20,
    requesterId,
  }: {
    cursor?: string;
    limit?: number;
    requesterId?: string;
  }) {
    const items = await this.prisma.collection.findMany({
      where: {
        status: 'PUBLISHED',
        visibility: CollectionVisibility.PUBLIC,
      } as any,
      orderBy: [
        { patchesCount: 'desc' }, // Show most patched first
        { createdAt: 'desc' },
      ],
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            brandFullName: true,
            profileImage: true,
            profileImageId: true,
            profileImageFile: {
              select: {
                id: true,
                s3Url: true,
                fileName: true,
                originalName: true,
                createdAt: true,
                updatedAt: true,
              },
            },
          },
        },
        medias: {
          include: { file: true },
          orderBy: { orderIndex: 'asc' },
          take: 1, // Only get first media for listing
        },
        _count: {
          select: {
            reactions: true,
            comments: true,
            patches: true,
            views: true,
            medias: true,
          },
        },
      },
    });

    const hasNext = items.length > limit;
    const data = hasNext ? items.slice(0, -1) : items;

    // Hydrate isLiked for requester when available
    let isLikedMap: Record<string, boolean> = {};
    if (requesterId) {
      const ids = data.map((c) => c.id);
      if (ids.length) {
        const liked = await this.prisma.collectionReaction.findMany({
          where: {
            userId: requesterId,
            type: 'LIKE',
            collectionId: { in: ids },
          },
          select: { collectionId: true },
        });
        const set = new Set(liked.map((r) => r.collectionId));
        isLikedMap = ids.reduce(
          (acc, id) => {
            acc[id] = set.has(id);
            return acc;
          },
          {} as Record<string, boolean>,
        );
      }
    }

    return {
      items: data.map((c) => ({
        ...c,
        isLiked: requesterId ? !!isLikedMap[c.id] : false,
      })),
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Simplified reaction toggle - your existing logic is good
   */
  async toggleReaction(
    collectionId: string,
    userId: string,
    type: ReactionType,
  ) {
    const ok = await this.canViewCollection(collectionId, userId);
    if (!ok) throw new NotFoundException('Collection not found');
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { visibility: true, ownerId: true },
    });
    if (collection && collection.visibility !== CollectionVisibility.PUBLIC) {
      throw new ForbiddenException('Cannot interact with private collection');
    }

    const existing = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });

    let delta = 0;
    let nowLiked = false;
    if (existing) {
      if (existing.type === type) {
        // Remove reaction
        await this.prisma.collectionReaction.delete({
          where: { id: existing.id },
        });
        if (type === ReactionType.LIKE) {
          delta = -1;
          nowLiked = false;
        }
      } else {
        // Change reaction type
        await this.prisma.collectionReaction.update({
          where: { id: existing.id },
          data: { type },
        });
        if (
          existing.type === ReactionType.DISLIKE &&
          type === ReactionType.LIKE
        ) {
          delta = +1;
        }
        if (
          existing.type === ReactionType.LIKE &&
          type === ReactionType.DISLIKE
        ) {
          // Moving from LIKE to DISLIKE decrements likes for analytics
          delta = -1;
        }
        nowLiked = type === ReactionType.LIKE;
      }
    } else {
      // Create new reaction
      await this.prisma.collectionReaction.create({
        data: {
          id: uuidv4(),
          collectionId,
          userId,
          type,
        },
      });
      if (type === ReactionType.LIKE) {
        delta = +1;
        nowLiked = true;
      }
    }

    // Update denormalized counts
    const [likes, dislikes] = await Promise.all([
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.LIKE },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data: { likesCount: likes, dislikesCount: dislikes },
    });

    // Update analytics daily likes if changed
    if (this.analytics && delta !== 0) {
      await this.analytics.updateDailyLike(
        ContentTarget.COLLECTION,
        collectionId,
        delta,
      );
    }

    // Notify owner when a new LIKE is added
    if (nowLiked && userId !== collection.ownerId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.LIKE,
          {
            actorId: userId,
            payload: { collectionId },
            dedupeMs: 5 * 60 * 1000,
          },
        );
      } catch {}
    }

    return {
      likes: updated.likesCount,
      dislikes: updated.dislikesCount,
      liked: nowLiked,
    };
  }

  /**
   * Track views with IP-based deduplication
   */
  async recordView(
    collectionId: string,
    viewerId?: string,
    ipAddress?: string,
  ) {
    const ok = await this.canViewCollection(collectionId, viewerId);
    if (!ok) throw new NotFoundException('Collection not found');

    // Create IP hash for privacy
    const ipHash = ipAddress ? this.helperservice.hashIP(ipAddress) : null;

    // Check if view already exists (prevent spam)
    const existingView = await this.prisma.view.findFirst({
      where: {
        collectionId,
        OR: [
          { viewerId: viewerId || undefined },
          { ipHash: ipHash || undefined },
        ],
        createdAt: {
          gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Within last 24 hours
        },
      },
    });

    if (!existingView) {
      await this.prisma.view.create({
        data: {
          id: uuidv4(),
          collectionId,
          viewerId,
          ipHash,
        },
      });

      // Update denormalized count
      const viewCount = await this.prisma.view.count({
        where: { collectionId },
      });
      await this.prisma.collection.update({
        where: { id: collectionId },
        data: { viewsCount: viewCount },
      });
    }

    return { viewed: !existingView };
  }

  // ============================================
  // HELPER METHODS
  // ============================================

  /**
   * PATCHING SYSTEM - Scalable approach
   * Patches are like "reposts" that boost visibility
   */
  async patchCollection(
    collectionId: string,
    patchingBrandId: string,
    weight = 1,
  ) {
    // Verify collection exists and is published
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId, status: 'PUBLISHED' },
    });

    if (!collection) {
      throw new NotFoundException('Collection not found');
    }

    // Verify patching user is a brand
    const brand = await this.prisma.user.findUnique({
      where: { id: patchingBrandId },
    });

    if (!brand || brand.type !== UserType.BRAND) {
      throw new ForbiddenException('Only brands can patch collections');
    }

    // Check if brand already patched this collection
    const existingPatch = await this.prisma.patch.findFirst({
      where: {
        collectionId,
        patchingBrandId,
      },
    });

    if (existingPatch) {
      throw new BadRequestException('You have already patched this collection');
    }

    // Create patch record
    const patch = await this.prisma.patch.create({
      data: {
        id: uuidv4(),
        collectionId,
        patchingBrandId,
        weight,
      },
      include: {
        patchingBrand: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
      },
    });

    // Update denormalized patches count
    const totalPatches = await this.prisma.patch.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { patchesCount: totalPatches },
    });

    // Optional: Create notification for collection owner
    if (collection.ownerId !== patchingBrandId && this.notifications) {
      try {
        await this.notifications.create(
          collection.ownerId,
          NotificationType.PATCH,
          {
            actorId: patchingBrandId,
            payload: {
              collectionId,
              collectionTitle: collection.title,
              patchWeight: weight,
            },
          },
        );
      } catch {}
    }

    return patch;
  }

  /**
   * Get patches for a collection (who patched it)
   */
  async getCollectionPatches(
    collectionId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const patches = await this.prisma.patch.findMany({
      where: { collectionId },
      include: {
        patchingBrand: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = patches.length > limit;
    const data = hasNext ? patches.slice(0, -1) : patches;

    return {
      patches: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Get collections patched by a specific brand
   */
  async getBrandPatches(
    brandId: string,
    { cursor, limit = 20 }: { cursor?: string; limit?: number },
  ) {
    const patches = await this.prisma.patch.findMany({
      where: { patchingBrandId: brandId },
      include: {
        collection: {
          include: {
            owner: {
              select: {
                id: true,
                username: true,
                brandFullName: true,
                profileImage: true,
              },
            },
            medias: {
              include: { file: true },
              orderBy: { orderIndex: 'asc' },
              take: 1,
            },
            _count: {
              select: {
                reactions: true,
                comments: true,
                patches: true,
                views: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });

    const hasNext = patches.length > limit;
    const data = hasNext ? patches.slice(0, -1) : patches;

    return {
      patches: data,
      hasNextPage: hasNext,
      endCursor: data.length ? data[data.length - 1].id : null,
    };
  }

  /**
   * Remove patch (unpatch)
   */
  async removePatch(collectionId: string, patchingBrandId: string) {
    const patch = await this.prisma.patch.findFirst({
      where: {
        collectionId,
        patchingBrandId,
      },
    });

    if (!patch) {
      throw new NotFoundException('Patch not found');
    }

    await this.prisma.patch.delete({ where: { id: patch.id } });

    // Update denormalized count
    const totalPatches = await this.prisma.patch.count({
      where: { collectionId },
    });

    await this.prisma.collection.update({
      where: { id: collectionId },
      data: { patchesCount: totalPatches },
    });

    return { success: true };
  }

  /**
   * Get reactions for a collection
   */
  async getReactions(collectionId: string, limit = 20) {
    const ok = await this.canViewCollection(collectionId);
    if (!ok) throw new NotFoundException('Collection not found');

    const [reactions, totalLikes, totalDislikes] = await Promise.all([
      this.prisma.collectionReaction.findMany({
        where: { collectionId, type: ReactionType.LIKE },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              firstName: true,
              lastName: true,
              profileImage: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.LIKE },
      }),
      this.prisma.collectionReaction.count({
        where: { collectionId, type: ReactionType.DISLIKE },
      }),
    ]);

    return {
      users: reactions.map((r) => r.user),
      totalLikes,
      totalDislikes,
    };
  }

  /**
   * Helper method to create notifications
   */
  private async createNotification(data: {
    recipientId: string;
    actorId: string;
    type: string;
    payload: any;
  }) {
    try {
      await this.prisma.notification.create({
        data: {
          id: uuidv4(),
          recipientId: data.recipientId,
          actorId: data.actorId,
          type: data.type as any,
          payload: data.payload,
          isRead: false,
        },
      });
    } catch (error) {
      console.warn('Failed to create notification:', error);
    }
  }
  // =============================
  // Media-level likes (per upload)
  // =============================
  async toggleMediaLike(mediaId: string, userId: string) {
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');

    const existing = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });

    let delta = 0;
    let nowLiked = false;
    if (existing) {
      await this.prisma.collectionMediaReaction.delete({
        where: { id: existing.id },
      });
      delta = -1;
      nowLiked = false;
    } else {
      await this.prisma.collectionMediaReaction.create({
        data: {
          id: uuidv4(),
          collectionMediaId: mediaId,
          userId,
          type: ReactionType.LIKE,
        },
      });
      delta = +1;
      nowLiked = true;
    }

    const updated = await this.prisma.collectionMedia.update({
      where: { id: mediaId },
      data: { likesCount: { increment: delta } },
    });
    return { likes: updated.likesCount, liked: nowLiked };
  }

  async getMediaReactions(mediaId: string, limit = 20) {
    const can = await this.canViewMedia(mediaId);
    if (!can) throw new NotFoundException('Media not found');
    const rows = await this.prisma.collectionMediaReaction.findMany({
      where: { collectionMediaId: mediaId, type: ReactionType.LIKE },
      include: {
        user: {
          select: {
            id: true,
            username: true,
            firstName: true,
            lastName: true,
            profileImage: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    const total = await this.prisma.collectionMediaReaction.count({
      where: { collectionMediaId: mediaId, type: ReactionType.LIKE },
    });
    return { users: rows.map((r) => r.user), totalLikes: total };
  }

  async isMediaLikedByUser(mediaId: string, userId: string) {
    const can = await this.canViewMedia(mediaId, userId);
    if (!can) throw new NotFoundException('Media not found');
    const r = await this.prisma.collectionMediaReaction.findUnique({
      where: {
        collectionMediaId_userId: { collectionMediaId: mediaId, userId },
      },
    });
    return { liked: !!r };
  }

  async isCollectionLikedByUser(collectionId: string, userId: string) {
    const r = await this.prisma.collectionReaction.findUnique({
      where: { collectionId_userId: { collectionId, userId } },
    });
    return { liked: !!r };
  }

  async getLikesSummary(collectionId: string) {
    const collection = await this.prisma.collection.findUnique({
      where: { id: collectionId },
    });
    if (!collection) {
      throw new NotFoundException('Collection not found');
    }
    const mediaAgg = await this.prisma.collectionMedia.aggregate({
      where: { collectionId },
      _sum: { likesCount: true },
    });
    const collectionLikes = collection.likesCount;
    const mediaLikes = mediaAgg._sum.likesCount ?? 0;
    const totalLikes = collectionLikes + mediaLikes;
    return { collectionLikes, mediaLikes, totalLikes };
  }

  // ===================== PHASE 2: Auto-Publishing for Approved Categories =====================

  /**
   * Automatically publish all draft collections waiting for a specific category suggestion
   * Called when admin approves a category suggestion
   */
  async autoPublishPendingCollections(
    suggestionId: string,
    approvedCategoryId: string,
  ): Promise<{
    published: number;
    skipped: number;
    failed: number;
    errors: string[];
  }> {
    const results = {
      published: 0,
      skipped: 0,
      failed: 0,
      errors: [] as string[],
    };

    // Find all draft collections waiting for this suggestion
    const pendingCollections = await this.prisma.collection.findMany({
      where: {
        pendingCategorySuggestionId: suggestionId,
        status: 'DRAFT',
      },
      include: {
        owner: { select: { id: true, username: true, email: true } },
        medias: { include: { file: true } },
      },
    });

    console.log(
      `Found ${pendingCollections.length} collections waiting for suggestion ${suggestionId}`,
    );

    // Process each collection independently
    for (const collection of pendingCollections) {
      try {
        // Verify collection has uploaded media files
        if (!collection.medias || collection.medias.length === 0) {
          console.log(
            `Skipping collection ${collection.id} - no media uploaded`,
          );
          results.skipped++;

          // Notify user that upload is incomplete
          if (this.notifications) {
            await this.notifications.create(
              collection.ownerId,
              NotificationType.COLLECTION_UPLOAD,
              {
                payload: {
                  collectionId: collection.id,
                  message:
                    'Your category was approved, but your collection upload is incomplete. Please complete the upload to publish.',
                },
              },
            );
          }
          continue;
        }

        // Update collection in a transaction
        await this.prisma.$transaction(async (tx) => {
          await tx.collection.update({
            where: { id: collection.id },
            data: {
              categoryId: approvedCategoryId,
              pendingCategorySuggestionId: null,
              draftReason: null,
              status: 'PUBLISHED',
              updatedAt: new Date(),
            },
          });
        });

        results.published++;
        console.log(
          `Published collection ${collection.id} for user ${collection.owner.username}`,
        );

        // Send success notification
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                title: collection.title,
                message: `Great news! Your collection "${collection.title}" has been published automatically because the category you requested was approved.`,
              },
            },
          );
        }
      } catch (error) {
        results.failed++;
        const errorMsg = `Failed to publish collection ${collection.id}: ${error.message}`;
        results.errors.push(errorMsg);
        console.error(errorMsg, error);

        // Notify user of failure
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                message:
                  'There was an issue publishing your collection automatically. Please try publishing manually.',
              },
            },
          );
        }
      }
    }

    return results;
  }

  /**
   * Handle rejected category suggestions - update linked draft collections
   * Called when admin rejects a category suggestion
   */
  async handleRejectedCategory(
    suggestionId: string,
    rejectionReason: string,
  ): Promise<{ updated: number; notified: number }> {
    const results = { updated: 0, notified: 0 };

    // Find all collections waiting for this suggestion
    const affectedCollections = await this.prisma.collection.findMany({
      where: {
        pendingCategorySuggestionId: suggestionId,
        status: 'DRAFT',
      },
      include: {
        owner: { select: { id: true, username: true, email: true } },
      },
    });

    console.log(
      `Found ${affectedCollections.length} collections affected by rejected suggestion ${suggestionId}`,
    );

    for (const collection of affectedCollections) {
      try {
        // Update collection to reflect rejection
        await this.prisma.collection.update({
          where: { id: collection.id },
          data: {
            draftReason: 'CATEGORY_REJECTED',
            // Keep pendingCategorySuggestionId for reference
            updatedAt: new Date(),
          },
        });

        results.updated++;

        // Notify user
        if (this.notifications) {
          await this.notifications.create(
            collection.ownerId,
            NotificationType.COLLECTION_UPLOAD,
            {
              payload: {
                collectionId: collection.id,
                title: collection.title,
                pendingCategoryName: collection.pendingCategoryName,
                rejectionReason,
                message: `Your category suggestion "${collection.pendingCategoryName}" was not approved. Your collection "${collection.title}" is saved as a draft. You can select a different category to publish it.`,
              },
            },
          );
          results.notified++;
        }
      } catch (error) {
        console.error(`Failed to update collection ${collection.id}:`, error);
      }
    }

    return results;
  }

  // ===================== Invite Links (Feature-flagged) =====================
  private getInviteSecret() {
    const key = process.env.INVITE_TOKEN_SIGNING_KEY;
    if (!key) throw new Error('Missing INVITE_TOKEN_SIGNING_KEY');
    return key;
  }

  async createInviteLink(
    collectionId: string,
    ownerId: string,
    ttlSeconds = 86400,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const payload = {
      cid: collectionId,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + Math.max(60, ttlSeconds),
    } as any;
    const secret = this.getInviteSecret();
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    const token = `${body}.${sig}`;
    return { token };
  }

  async acceptInvite(token: string, userId: string) {
    const secret = this.getInviteSecret();
    const parts = token.split('.');
    if (parts.length !== 2) throw new BadRequestException('Invalid token');
    const [body, sig] = parts;
    const expected = crypto
      .createHmac('sha256', secret)
      .update(body)
      .digest('base64url');
    if (sig !== expected) throw new BadRequestException('Invalid signature');
    let payload: any;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('Invalid token');
    }
    if (!payload?.cid || !payload?.exp)
      throw new BadRequestException('Invalid token');
    if (Date.now() / 1000 > payload.exp)
      throw new BadRequestException('Token expired');
    const collectionId = String(payload.cid);
    await this.prisma.collectionAccess.upsert({
      where: { collectionId_viewerId: { collectionId, viewerId: userId } },
      update: { state: 'APPROVED', grantedBy: null, updatedAt: new Date() },
      create: {
        id: uuidv4(),
        collectionId,
        viewerId: userId,
        state: 'APPROVED',
        grantedBy: null,
      },
    } as any);
    return { success: true };
  }

  // ===================== Metrics =====================
  async getAccessMetrics(collectionId: string, from?: string, to?: string) {
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    const [pending, approved, revoked] = await Promise.all([
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'PENDING',
          createdAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'APPROVED',
          updatedAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
      this.prisma.collectionAccess.count({
        where: {
          collectionId,
          state: 'REVOKED',
          updatedAt: { gte: fromDate, lte: toDate },
        } as any,
      }),
    ]);
    return {
      pending,
      approved,
      revoked,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  async getPrivateViewsMetrics(
    collectionId: string,
    from?: string,
    to?: string,
  ) {
    const c = await this.prisma.collection.findUnique({
      where: { id: collectionId },
      select: { visibility: true },
    });
    if (!c) throw new NotFoundException('Collection not found');
    const fromDate = from
      ? new Date(from)
      : new Date(Date.now() - 30 * 86400000);
    const toDate = to ? new Date(to) : new Date();
    const views = await this.prisma.view.count({
      where: { collectionId, createdAt: { gte: fromDate, lte: toDate } },
    });
    return {
      visibility: c.visibility,
      views,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
    };
  }

  // ===================== Categories =====================
  async listCategories() {
    const rows = await this.prisma.collectionCategory.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: {
        id: true,
        slug: true,
        name: true,
        description: true,
        order: true,
      },
    });
    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      description: r.description,
      order: r.order,
    }));
  }

  // ===================== Update collection (owner only) =====================
  async updateCollection(
    collectionId: string,
    ownerId: string,
    body: UpdateCollectionDto,
  ) {
    await this.assertOwner(collectionId, ownerId);
    const data: any = {};
    if (typeof body.minPrice === 'number' || body.minPrice === null)
      data.minPrice = body.minPrice as any;
    if (typeof body.maxPrice === 'number' || body.maxPrice === null)
      data.maxPrice = body.maxPrice as any;
    if (typeof body.saleMinPrice === 'number' || body.saleMinPrice === null)
      data.saleMinPrice = body.saleMinPrice as any;
    if (typeof body.saleMaxPrice === 'number' || body.saleMaxPrice === null)
      data.saleMaxPrice = body.saleMaxPrice as any;
    if (typeof body.saleStartAt === 'string' || body.saleStartAt === null)
      data.saleStartAt = body.saleStartAt ? new Date(body.saleStartAt) : null;
    if (typeof body.saleEndAt === 'string' || body.saleEndAt === null)
      data.saleEndAt = body.saleEndAt ? new Date(body.saleEndAt) : null;
    if (Array.isArray(body.tags)) data.tags = sanitizeTags(body.tags);
    if (typeof body.coverMediaId === 'string' || body.coverMediaId === null)
      data.coverMediaId = body.coverMediaId || null;

    const updated = await this.prisma.collection.update({
      where: { id: collectionId },
      data,
      include: {
        owner: {
          select: {
            id: true,
            username: true,
            brandFullName: true,
            profileImage: true,
          },
        },
        // coverMedia relation may not be generated yet until migration applied; comment out include safely
        // coverMedia: { include: { file: true } },
        _count: { select: { medias: true, views: true, comments: true } },
      },
    });
    return updated;
  }
}

export { CreateCollectionDto, FinalizeCollectionDto };
