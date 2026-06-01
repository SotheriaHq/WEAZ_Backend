import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  BrandContentReviewMode,
  BrandTrustEventType,
  BrandTrustTier,
  BrandVerificationStatus,
  CollectionStatus,
  ContentEntityType,
  ContentMediaPurpose,
  ContentMediaReviewStatus,
  ContentMediaViewSlot,
  ContentReviewReasonCode,
  ContentSubmissionStatus,
  FileType,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { MonitoringService } from 'src/monitoring/monitoring.service';
import { NotificationsService } from 'src/notifications/notifications.service';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CONTENT_MEDIA_ORDER_SLOTS,
  CONTENT_REVIEW_REASON_LABELS,
  REQUIRED_CONTENT_MEDIA_VIEW_SLOTS,
} from './content-integrity.constants';

type ProductMediaInput = {
  fileUploadId?: string;
  fileId?: string;
  viewSlot?: ContentMediaViewSlot | string | null;
  orderIndex?: number | null;
};

type NormalizedMediaInput = {
  fileUploadId: string;
  viewSlot: ContentMediaViewSlot;
  mediaPurpose: ContentMediaPurpose;
  orderIndex: number;
  url: string;
};

type ReviewGate = {
  brandId: string;
  tier: BrandTrustTier;
  reviewMode: BrandContentReviewMode;
  requiresPreReview: boolean;
  publishDisabled: boolean;
  approvedListingCount: number;
};

type SubmissionTarget = {
  entityType: ContentEntityType;
  productId?: string | null;
  designId?: string | null;
  legacyCollectionId?: string | null;
  brandId?: string | null;
  submittedById: string;
  previousStatus?: CollectionStatus | null;
};

@Injectable()
export class ContentIntegrityService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly monitoring?: MonitoringService,
  ) {}

  getRequiredViewSlots(): ContentMediaViewSlot[] {
    return [...REQUIRED_CONTENT_MEDIA_VIEW_SLOTS];
  }

  getReasonCodes() {
    return Object.entries(CONTENT_REVIEW_REASON_LABELS).map(
      ([code, label]) => ({ code, label }),
    );
  }

  slotForOrderIndex(orderIndex: number | null | undefined) {
    const index = Number.isFinite(Number(orderIndex))
      ? Math.max(0, Number(orderIndex))
      : 0;
    return CONTENT_MEDIA_ORDER_SLOTS[index] ?? ContentMediaViewSlot.OTHER;
  }

  normalizeViewSlot(
    value: ContentMediaViewSlot | string | null | undefined,
    fallbackOrderIndex?: number | null,
  ): ContentMediaViewSlot {
    const raw = String(value ?? '')
      .trim()
      .toUpperCase()
      .replace(/[\s-]+/g, '_');
    const aliases: Record<string, ContentMediaViewSlot> = {
      FRONT: ContentMediaViewSlot.FRONT,
      FRONT_VIEW: ContentMediaViewSlot.FRONT,
      BACK: ContentMediaViewSlot.BACK,
      BACK_VIEW: ContentMediaViewSlot.BACK,
      LEFT: ContentMediaViewSlot.LEFT_SIDE,
      LEFT_SIDE: ContentMediaViewSlot.LEFT_SIDE,
      LEFT_VIEW: ContentMediaViewSlot.LEFT_SIDE,
      RIGHT: ContentMediaViewSlot.RIGHT_SIDE,
      RIGHT_SIDE: ContentMediaViewSlot.RIGHT_SIDE,
      RIGHT_VIEW: ContentMediaViewSlot.RIGHT_SIDE,
      DETAIL: ContentMediaViewSlot.DETAIL,
      DETAILS: ContentMediaViewSlot.DETAIL,
      DETAIL_VIEW: ContentMediaViewSlot.DETAIL,
      ON_MODEL: ContentMediaViewSlot.ON_MODEL,
      MODEL: ContentMediaViewSlot.ON_MODEL,
      FABRIC: ContentMediaViewSlot.FABRIC_DETAIL,
      FABRIC_DETAIL: ContentMediaViewSlot.FABRIC_DETAIL,
      OTHER: ContentMediaViewSlot.OTHER,
    };
    return aliases[raw] ?? this.slotForOrderIndex(fallbackOrderIndex);
  }

  mediaPurposeForSlot(slot: ContentMediaViewSlot): ContentMediaPurpose {
    return REQUIRED_CONTENT_MEDIA_VIEW_SLOTS.includes(slot)
      ? ContentMediaPurpose.REQUIRED_VIEW
      : ContentMediaPurpose.OPTIONAL_VIEW;
  }

  assertCompleteSlotSet(
    slots: Array<ContentMediaViewSlot | null | undefined>,
    entityLabel: string,
  ) {
    const present = new Set(slots.filter(Boolean) as ContentMediaViewSlot[]);
    const missing = REQUIRED_CONTENT_MEDIA_VIEW_SLOTS.filter(
      (slot) => !present.has(slot),
    );
    if (missing.length > 0) {
      throw new BadRequestException(
        `${entityLabel} requires front, back, left side, and right side media before publishing.`,
      );
    }
  }

  private assertNoDuplicateSlots(slots: ContentMediaViewSlot[]) {
    const seen = new Set<ContentMediaViewSlot>();
    for (const slot of slots) {
      if (seen.has(slot)) {
        throw new BadRequestException(
          `Duplicate media view slot: ${slot}. Each required and optional slot can be used once.`,
        );
      }
      seen.add(slot);
    }
  }

  async validateProductMediaInputs(args: {
    actorUserId: string;
    ownerUserId: string;
    entries?: ProductMediaInput[] | null;
    requireComplete: boolean;
  }): Promise<NormalizedMediaInput[]> {
    const entries = Array.isArray(args.entries) ? args.entries : [];
    if (args.requireComplete && entries.length === 0) {
      this.emitIntegrityAlert('product_publish_missing_structured_media', {
        actorId: args.actorUserId,
      });
      throw new BadRequestException(
        'Publishing requires structured product media slots. Upload front, back, left side, and right side media with fileUploadId values.',
      );
    }
    if (entries.length > 6) {
      throw new BadRequestException('You can upload up to 6 product images.');
    }

    const normalizedSlots = entries.map((entry, index) =>
      this.normalizeViewSlot(entry.viewSlot, entry.orderIndex ?? index),
    );
    this.assertNoDuplicateSlots(normalizedSlots);
    if (args.requireComplete) {
      this.assertCompleteSlotSet(normalizedSlots, 'A product');
    }

    const ids = entries
      .map((entry) => String(entry.fileUploadId ?? entry.fileId ?? '').trim())
      .filter(Boolean);
    if (ids.length !== entries.length) {
      throw new BadRequestException('Every media item must include fileUploadId.');
    }

    const files = await this.prisma.fileUpload.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        userId: true,
        s3Url: true,
        fileType: true,
        processingStatus: true,
        originalDeletedAt: true,
      },
    });
    const fileById = new Map(files.map((file) => [file.id, file]));

    return entries.map((entry, index) => {
      const fileUploadId = String(entry.fileUploadId ?? entry.fileId).trim();
      const file = fileById.get(fileUploadId);
      if (!file) {
        throw new BadRequestException('One or more media files were not found.');
      }
      if (![args.actorUserId, args.ownerUserId].includes(file.userId)) {
        throw new ForbiddenException(
          'One or more media files do not belong to this brand session.',
        );
      }
      if (file.originalDeletedAt || file.processingStatus !== 'READY') {
        throw new BadRequestException(
          'All product media must be fully processed before publishing.',
        );
      }
      if (file.fileType !== FileType.POST_IMAGE) {
        throw new BadRequestException(
          'Product publish media must use image uploads.',
        );
      }
      const viewSlot = normalizedSlots[index];
      return {
        fileUploadId,
        viewSlot,
        mediaPurpose: this.mediaPurposeForSlot(viewSlot),
        orderIndex:
          typeof entry.orderIndex === 'number' ? entry.orderIndex : index,
        url: file.s3Url,
      };
    });
  }

  async replaceProductMedia(
    tx: Prisma.TransactionClient,
    args: {
      productId: string;
      brandId: string;
      actorUserId: string;
      media: NormalizedMediaInput[];
    },
  ) {
    await (tx as any).productMedia.deleteMany({
      where: { productId: args.productId },
    });
    if (args.media.length === 0) {
      return;
    }
    await (tx as any).productMedia.createMany({
      data: args.media.map((media) => ({
        id: uuidv4(),
        productId: args.productId,
        fileUploadId: media.fileUploadId,
        brandId: args.brandId,
        createdById: args.actorUserId,
        viewSlot: media.viewSlot,
        mediaPurpose: media.mediaPurpose,
        reviewStatus: ContentMediaReviewStatus.APPROVED,
        orderIndex: media.orderIndex,
      })),
    });
  }

  async getProductMediaRows(tx: Prisma.TransactionClient, productId: string) {
    return (tx as any).productMedia.findMany({
      where: { productId },
      include: { file: true },
      orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
    });
  }

  validatePublishableMediaRows(
    rows: any[],
    entityLabel: string,
  ): { urls: string[]; thumbnail: string | null } {
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException(
        `${entityLabel} publish requires structured media slots.`,
      );
    }
    if (rows.length > 6) {
      throw new BadRequestException(`${entityLabel} can publish up to 6 media.`);
    }

    const slots = rows.map((row) =>
      this.normalizeViewSlot(row.viewSlot, row.orderIndex),
    );
    this.assertNoDuplicateSlots(slots);
    this.assertCompleteSlotSet(slots, entityLabel);

    const urls: string[] = [];
    for (const row of rows) {
      const slot = this.normalizeViewSlot(row.viewSlot, row.orderIndex);
      const file = row.file;
      if (!file || file.originalDeletedAt || file.processingStatus !== 'READY') {
        throw new BadRequestException(
          `${entityLabel} media must be fully processed before publishing.`,
        );
      }
      if (
        REQUIRED_CONTENT_MEDIA_VIEW_SLOTS.includes(slot) &&
        file.fileType !== FileType.POST_IMAGE
      ) {
        throw new BadRequestException(
          `${entityLabel} required front, back, left, and right views must be images.`,
        );
      }
      if (
        row.reviewStatus === ContentMediaReviewStatus.REJECTED ||
        row.reviewStatus === ContentMediaReviewStatus.REMOVED
      ) {
        throw new BadRequestException(
          `${entityLabel} contains rejected or removed media.`,
        );
      }
      urls.push(file.s3Url);
    }

    return { urls, thumbnail: urls[0] ?? null };
  }

  async assertProductHasPublishableMedia(
    tx: Prisma.TransactionClient,
    productId: string,
  ) {
    const rows = await this.getProductMediaRows(tx, productId);
    return this.validatePublishableMediaRows(rows, 'A product');
  }

  async assertCollectionHasPublishableMedia(
    tx: Prisma.TransactionClient,
    collectionId: string,
    options: {
      ownerUserId?: string | null;
      brandId?: string | null;
      backfillMissingSlots?: boolean;
    } = {},
  ) {
    const rows = await (tx as any).collectionMedia.findMany({
      where: { collectionId },
      include: { file: true },
      orderBy: [{ orderIndex: 'asc' }],
    });
    if (!Array.isArray(rows) || rows.length === 0) {
      throw new BadRequestException(
        'A design requires front, back, left side, and right side media before publishing.',
      );
    }

    if (options.backfillMissingSlots) {
      for (const row of rows) {
        const viewSlot = this.normalizeViewSlot(row.viewSlot, row.orderIndex);
        if (!row.viewSlot) {
          await (tx as any).collectionMedia.update({
            where: { id: row.id },
            data: {
              viewSlot,
              mediaPurpose: this.mediaPurposeForSlot(viewSlot),
              reviewStatus: row.reviewStatus ?? ContentMediaReviewStatus.APPROVED,
              createdById: row.createdById ?? options.ownerUserId ?? undefined,
              brandId: row.brandId ?? options.brandId ?? undefined,
            },
          });
          row.viewSlot = viewSlot;
        }
      }
    }

    return this.validatePublishableMediaRows(rows, 'A design');
  }

  async blockRequiredDesignMediaDeletion(
    collectionId: string,
    mediaId: string,
  ) {
    const media = await (this.prisma as any).collectionMedia.findFirst({
      where: { id: mediaId, collectionId },
      select: {
        id: true,
        orderIndex: true,
        viewSlot: true,
        collection: { select: { status: true } },
      },
    });
    if (!media || media.collection?.status !== CollectionStatus.PUBLISHED) {
      return;
    }
    const slot = this.normalizeViewSlot(media.viewSlot, media.orderIndex);
    if (REQUIRED_CONTENT_MEDIA_VIEW_SLOTS.includes(slot)) {
      throw new BadRequestException(
        'Published designs cannot remove required front, back, left side, or right side media until replacement media is uploaded and reviewed.',
      );
    }
  }

  async evaluateBrandGate(brandId: string): Promise<ReviewGate> {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        ownerId: true,
        createdAt: true,
        verificationStatus: true,
        contentMediaPolicyAcknowledgedAt: true,
        contentTrustTierOverride: true,
        contentReviewModeOverride: true,
      },
    });
    if (!brand) {
      throw new NotFoundException('Brand not found');
    }

    const [publishedProducts, publishedDesigns] = await Promise.all([
      this.prisma.product.count({
        where: {
          brandId,
          publicationStatus: CollectionStatus.PUBLISHED,
          deletedAt: null,
        },
      }),
      this.prisma.collection.count({
        where: {
          ownerId: brand.ownerId,
          domain: 'DESIGN',
          status: CollectionStatus.PUBLISHED,
          deletedAt: null,
        } as any,
      }),
    ]);

    const approvedListingCount = publishedProducts + publishedDesigns;
    const ageDays = Math.floor(
      (Date.now() - brand.createdAt.getTime()) / (24 * 60 * 60 * 1000),
    );
    const tier =
      brand.contentTrustTierOverride ??
      this.deriveTrustTier({
        ageDays,
        approvedListingCount,
        verificationStatus: brand.verificationStatus,
        acknowledgedPolicy: Boolean(brand.contentMediaPolicyAcknowledgedAt),
      });
    const reviewMode =
      brand.contentReviewModeOverride ?? this.reviewModeForTrustTier(tier);

    await this.recordBrandTrustEvent({
      brandId,
      eventType: BrandTrustEventType.TRUST_EVALUATED,
      tier,
      reviewMode,
      metadata: {
        approvedListingCount,
        ageDays,
        verificationStatus: brand.verificationStatus,
        acknowledgedPolicy: Boolean(brand.contentMediaPolicyAcknowledgedAt),
      },
    });

    return {
      brandId,
      tier,
      reviewMode,
      approvedListingCount,
      requiresPreReview:
        reviewMode === BrandContentReviewMode.PRE_REVIEW_REQUIRED,
      publishDisabled: reviewMode === BrandContentReviewMode.PUBLISH_DISABLED,
    };
  }

  private deriveTrustTier(args: {
    ageDays: number;
    approvedListingCount: number;
    verificationStatus: BrandVerificationStatus;
    acknowledgedPolicy: boolean;
  }): BrandTrustTier {
    if (!args.acknowledgedPolicy) return BrandTrustTier.NEW;
    if (args.verificationStatus !== BrandVerificationStatus.APPROVED) {
      return BrandTrustTier.NEW;
    }
    if (args.ageDays < 14 || args.approvedListingCount < 3) {
      return BrandTrustTier.NEW;
    }
    return BrandTrustTier.NORMAL;
  }

  private reviewModeForTrustTier(tier: BrandTrustTier): BrandContentReviewMode {
    switch (tier) {
      case BrandTrustTier.HIGH_TRUST:
        return BrandContentReviewMode.AUTO_PUBLISH_ALLOWED;
      case BrandTrustTier.RESTRICTED:
        return BrandContentReviewMode.PUBLISH_DISABLED;
      case BrandTrustTier.NORMAL:
        return BrandContentReviewMode.POST_REVIEW_ALLOWED;
      case BrandTrustTier.NEW:
      case BrandTrustTier.LOW_TRUST:
      default:
        return BrandContentReviewMode.PRE_REVIEW_REQUIRED;
    }
  }

  async resolvePublicationDecision(brandId?: string | null) {
    if (!brandId) {
      return {
        publicationStatus: CollectionStatus.PUBLISHED,
        isActive: true,
        reviewMode: null,
        requiresPreReview: false,
        publishDisabled: false,
      };
    }
    const gate = await this.evaluateBrandGate(brandId);
    if (gate.publishDisabled) {
      this.emitIntegrityAlert('content_publish_disabled_attempt', {
        brandId,
        reviewMode: gate.reviewMode,
      });
      throw new ForbiddenException(
        'Publishing is disabled for this brand pending admin review.',
      );
    }
    if (gate.requiresPreReview) {
      return {
        publicationStatus: CollectionStatus.IN_REVIEW,
        isActive: false,
        reviewMode: gate.reviewMode,
        requiresPreReview: true,
        publishDisabled: false,
      };
    }
    return {
      publicationStatus: CollectionStatus.PUBLISHED,
      isActive: true,
      reviewMode: gate.reviewMode,
      requiresPreReview: false,
      publishDisabled: false,
    };
  }

  async createSubmission(
    tx: Prisma.TransactionClient,
    target: SubmissionTarget,
  ) {
    const where: Record<string, unknown> = {
      entityType: target.entityType,
      status: ContentSubmissionStatus.IN_REVIEW,
    };
    if (target.productId) where.productId = target.productId;
    if (target.designId) where.designId = target.designId;
    if (target.legacyCollectionId) {
      where.legacyCollectionId = target.legacyCollectionId;
    }

    await (tx as any).contentSubmission.updateMany({
      where,
      data: { status: ContentSubmissionStatus.CANCELLED },
    });

    const submission = await (tx as any).contentSubmission.create({
      data: {
        id: uuidv4(),
        entityType: target.entityType,
        productId: target.productId ?? null,
        designId: target.designId ?? null,
        legacyCollectionId: target.legacyCollectionId ?? null,
        brandId: target.brandId ?? null,
        submittedById: target.submittedById,
        previousStatus: target.previousStatus ?? CollectionStatus.DRAFT,
        targetStatus: CollectionStatus.PUBLISHED,
        status: ContentSubmissionStatus.IN_REVIEW,
      },
    });

    await this.recordBrandTrustEvent({
      brandId: target.brandId,
      actorUserId: target.submittedById,
      eventType: BrandTrustEventType.CONTENT_SUBMITTED,
      metadata: {
        submissionId: submission.id,
        entityType: target.entityType,
        productId: target.productId,
        designId: target.designId,
        legacyCollectionId: target.legacyCollectionId,
      },
    });

    return submission;
  }

  async acknowledgeBrandContentPolicy(actorUserId: string) {
    const brand = await this.prisma.brand.findFirst({
      where: { ownerId: actorUserId },
      select: { id: true },
    });
    if (!brand) {
      throw new NotFoundException('Brand not found');
    }
    const acknowledgedAt = new Date();
    await this.prisma.brand.update({
      where: { id: brand.id },
      data: { contentMediaPolicyAcknowledgedAt: acknowledgedAt },
    });
    return {
      brandId: brand.id,
      contentMediaPolicyAcknowledgedAt: acknowledgedAt,
      requiredViewSlots: this.getRequiredViewSlots(),
    };
  }

  async listSubmissions(filters: {
    status?: ContentSubmissionStatus | string;
    entityType?: ContentEntityType | string;
    take?: number;
  }) {
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.entityType) where.entityType = filters.entityType;
    return (this.prisma as any).contentSubmission.findMany({
      where,
      orderBy: [{ submittedAt: 'asc' }],
      take: Math.min(Math.max(Number(filters.take) || 50, 1), 100),
    });
  }

  async getSubmission(id: string) {
    const submission = await (this.prisma as any).contentSubmission.findUnique({
      where: { id },
    });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    return submission;
  }

  async reviewSubmission(args: {
    submissionId: string;
    adminUserId: string;
    action: 'approve' | 'reject' | 'request_changes';
    reasonCode?: ContentReviewReasonCode | string | null;
    reasonNote?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const submission = await this.getSubmission(args.submissionId);
    const now = new Date();
    const nextSubmissionStatus =
      args.action === 'approve'
        ? ContentSubmissionStatus.APPROVED
        : args.action === 'reject'
          ? ContentSubmissionStatus.REJECTED
          : ContentSubmissionStatus.CHANGES_REQUESTED;
    const nextEntityStatus =
      args.action === 'approve'
        ? CollectionStatus.PUBLISHED
        : args.action === 'reject'
          ? CollectionStatus.REJECTED
          : CollectionStatus.CHANGES_REQUESTED;
    const nextMediaStatus =
      args.action === 'approve'
        ? ContentMediaReviewStatus.APPROVED
        : args.action === 'reject'
          ? ContentMediaReviewStatus.REJECTED
          : ContentMediaReviewStatus.CHANGES_REQUESTED;

    if (args.action !== 'approve' && !args.reasonCode) {
      throw new BadRequestException(
        'A rejection or change-request reason code is required.',
      );
    }

    const notificationOwner = await this.prisma.$transaction(async (tx) => {
      await (tx as any).contentSubmission.update({
        where: { id: submission.id },
        data: {
          status: nextSubmissionStatus,
          reviewedById: args.adminUserId,
          reviewedAt: now,
          reasonCode: args.reasonCode ?? null,
          reasonNote: args.reasonNote?.trim() || null,
        },
      });

      let ownerId: string | null = null;
      let targetType = String(submission.entityType);
      let targetId =
        submission.productId ??
        submission.designId ??
        submission.legacyCollectionId ??
        submission.id;

      if (submission.productId) {
        const product = await tx.product.update({
          where: { id: submission.productId },
          data: {
            publicationStatus: nextEntityStatus,
            isActive: args.action === 'approve',
          } as any,
          select: { id: true, name: true, brand: { select: { ownerId: true } } },
        });
        ownerId = product.brand?.ownerId ?? null;
        targetType = 'Product';
        targetId = product.id;
        await (tx as any).productMedia.updateMany({
          where: { productId: product.id },
          data: {
            reviewStatus: nextMediaStatus,
            reviewReasonCode: args.reasonCode ?? null,
            reviewReason: args.reasonNote?.trim() || null,
          },
        });
      }

      if (submission.legacyCollectionId) {
        const collection = await tx.collection.update({
          where: { id: submission.legacyCollectionId },
          data: { status: nextEntityStatus } as any,
          select: { id: true, ownerId: true, title: true },
        });
        ownerId = collection.ownerId;
        targetType = 'Collection';
        targetId = collection.id;
        await (tx as any).collectionMedia.updateMany({
          where: { collectionId: collection.id },
          data: {
            reviewStatus: nextMediaStatus,
            reviewReasonCode: args.reasonCode ?? null,
            reviewReason: args.reasonNote?.trim() || null,
          },
        });
      }

      if (submission.designId) {
        await (tx as any).design.update({
          where: { id: submission.designId },
          data: { status: nextEntityStatus },
        });
        await (tx as any).designMedia.updateMany({
          where: { designId: submission.designId },
          data: {
            reviewStatus: nextMediaStatus,
            reviewReasonCode: args.reasonCode ?? null,
            reviewReason: args.reasonNote?.trim() || null,
          },
        });
      }

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: args.adminUserId,
          action: 'ADMIN_CONTENT_REVIEW_ACTION',
          targetType,
          targetId,
          previousState: {
            submissionStatus: submission.status,
            targetStatus: submission.previousStatus,
          },
          newState: {
            action: args.action,
            submissionStatus: nextSubmissionStatus,
            targetStatus: nextEntityStatus,
            reasonCode: args.reasonCode ?? null,
          },
          metadata: {
            submissionId: submission.id,
            reasonNote: args.reasonNote?.trim() || null,
          },
          ipAddress: args.ipAddress ?? null,
          userAgent: args.userAgent ?? null,
        },
      });

      return ownerId;
    });

    await this.recordBrandTrustEvent({
      brandId: submission.brandId,
      actorUserId: args.adminUserId,
      eventType:
        args.action === 'approve'
          ? BrandTrustEventType.CONTENT_APPROVED
          : args.action === 'reject'
            ? BrandTrustEventType.CONTENT_REJECTED
            : BrandTrustEventType.CONTENT_CHANGES_REQUESTED,
      metadata: {
        submissionId: submission.id,
        reasonCode: args.reasonCode ?? null,
      },
    });

    if (notificationOwner) {
      await this.notifyContentReviewOutcome(notificationOwner, {
        type:
          args.action === 'approve'
            ? NotificationType.CONTENT_REVIEW_APPROVED
            : args.action === 'reject'
              ? NotificationType.CONTENT_REVIEW_REJECTED
              : NotificationType.CONTENT_CHANGES_REQUESTED,
        message: this.reviewOutcomeMessage(args.action, args.reasonCode),
        submissionId: submission.id,
        reasonCode: args.reasonCode ?? null,
      });
    }

    return this.getSubmission(submission.id);
  }

  async setBrandTrustOverride(args: {
    brandId: string;
    adminUserId: string;
    trustTier?: BrandTrustTier | string | null;
    reviewMode?: BrandContentReviewMode | string | null;
    reason?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    const brand = await this.prisma.brand.update({
      where: { id: args.brandId },
      data: {
        contentTrustTierOverride: args.trustTier || null,
        contentReviewModeOverride: args.reviewMode || null,
      } as any,
      select: {
        id: true,
        contentTrustTierOverride: true,
        contentReviewModeOverride: true,
      },
    });

    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: args.adminUserId,
        action: 'ADMIN_BRAND_TRUST_OVERRIDE',
        targetType: 'Brand',
        targetId: args.brandId,
        newState: {
          trustTier: brand.contentTrustTierOverride,
          reviewMode: brand.contentReviewModeOverride,
          reason: args.reason ?? null,
        },
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
      },
    });

    await this.recordBrandTrustEvent({
      brandId: args.brandId,
      actorUserId: args.adminUserId,
      eventType:
        args.trustTier || args.reviewMode
          ? BrandTrustEventType.TRUST_OVERRIDE_SET
          : BrandTrustEventType.TRUST_OVERRIDE_CLEARED,
      tier: (args.trustTier as BrandTrustTier) ?? null,
      reviewMode: (args.reviewMode as BrandContentReviewMode) ?? null,
      reason: args.reason ?? null,
    });

    return brand;
  }

  async recordBrandTrustEvent(args: {
    brandId?: string | null;
    actorUserId?: string | null;
    eventType: BrandTrustEventType;
    tier?: BrandTrustTier | null;
    reviewMode?: BrandContentReviewMode | null;
    reason?: string | null;
    metadata?: Record<string, unknown> | null;
  }) {
    if (!args.brandId) return null;
    try {
      return await (this.prisma as any).brandTrustEvent.create({
        data: {
          id: uuidv4(),
          brandId: args.brandId,
          actorUserId: args.actorUserId ?? null,
          eventType: args.eventType,
          tier: args.tier ?? null,
          reviewMode: args.reviewMode ?? null,
          reason: args.reason ?? null,
          metadata: args.metadata ?? undefined,
        },
      });
    } catch {
      return null;
    }
  }

  async notifyContentSubmitted(ownerId: string, payload: Record<string, unknown>) {
    await this.notifyContentReviewOutcome(ownerId, {
      type: NotificationType.CONTENT_SUBMITTED_FOR_REVIEW,
      message: 'Your content was submitted for review.',
      ...payload,
    });
  }

  private async notifyContentReviewOutcome(
    ownerId: string,
    payload: {
      type: NotificationType;
      message: string;
      submissionId?: string;
      reasonCode?: string | null;
      [key: string]: unknown;
    },
  ) {
    if (!this.notifications) return;
    try {
      const { type, ...rest } = payload;
      await this.notifications.create(ownerId, type, {
        payload: rest,
      });
    } catch {
      this.emitIntegrityAlert('content_review_notification_failed', {
        ownerId,
        notificationType: payload.type,
        submissionId: payload.submissionId,
      });
    }
  }

  private reviewOutcomeMessage(
    action: 'approve' | 'reject' | 'request_changes',
    reasonCode?: ContentReviewReasonCode | string | null,
  ) {
    if (action === 'approve') return 'Your content was approved and published.';
    const reason = reasonCode
      ? CONTENT_REVIEW_REASON_LABELS[reasonCode as ContentReviewReasonCode]
      : null;
    if (action === 'reject') {
      return reason
        ? `Your content was rejected: ${reason}.`
        : 'Your content was rejected.';
    }
    return reason
      ? `Changes requested before publishing: ${reason}.`
      : 'Changes requested before publishing.';
  }

  emitIntegrityAlert(event: string, metadata: Record<string, unknown>) {
    this.monitoring?.emitAlert({
      category: 'SYSTEM',
      severity: 'warning',
      event,
      message: event,
      actorId:
        typeof metadata.actorId === 'string' ? metadata.actorId : undefined,
      entityType:
        typeof metadata.entityType === 'string'
          ? metadata.entityType
          : undefined,
      entityId:
        typeof metadata.entityId === 'string' ? metadata.entityId : undefined,
      metadata,
    });
  }
}
