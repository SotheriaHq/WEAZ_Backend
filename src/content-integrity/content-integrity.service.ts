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
  ContentReportReasonCode,
  ContentReportStatus,
  ContentReportTargetType,
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
  CONTENT_REPORT_REASON_LABELS,
  CONTENT_REVIEW_REASON_LABELS,
  HIGH_SEVERITY_CONTENT_REPORT_REASONS,
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

type SubmissionListFilters = {
  status?: ContentSubmissionStatus | string;
  entityType?: ContentEntityType | string;
  brandId?: string | null;
  trustTier?: BrandTrustTier | string | null;
  reviewMode?: BrandContentReviewMode | string | null;
  from?: string | null;
  to?: string | null;
  q?: string | null;
  cursor?: string | null;
  take?: number;
};

type ReportListFilters = {
  status?: ContentReportStatus | string;
  targetType?: ContentReportTargetType | string;
  targetId?: string | null;
  mediaId?: string | null;
  reasonCode?: ContentReportReasonCode | string;
  from?: string | null;
  to?: string | null;
  take?: number;
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

  async listSubmissions(filters: SubmissionListFilters) {
    const take = Math.min(Math.max(Number(filters.take) || 50, 1), 100);
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.entityType) where.entityType = filters.entityType;
    if (filters.brandId) where.brandId = filters.brandId;
    if (filters.from || filters.to) {
      where.submittedAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }

    const [rows, summary] = await Promise.all([
      (this.prisma as any).contentSubmission.findMany({
        where,
        orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }],
        ...(filters.cursor
          ? { cursor: { id: filters.cursor }, skip: 1 }
          : {}),
        take: take + 1,
      }),
      this.buildSubmissionSummary(where),
    ]);

    const pageRows = rows.slice(0, take);
    const enriched = await Promise.all(
      pageRows.map((row) => this.mapSubmissionDetail(row)),
    );
    const q = String(filters.q ?? '').trim().toLowerCase();
    const items = enriched.filter((item) => {
      const matchesTrust =
        !filters.trustTier || item.brand?.trustTier === filters.trustTier;
      const matchesReviewMode =
        !filters.reviewMode || item.brand?.reviewMode === filters.reviewMode;
      const matchesSearch =
        !q ||
        [
          item.target?.title,
          item.brand?.name,
          item.submittedBy?.username,
          item.id,
        ]
          .filter(Boolean)
          .some((value) => String(value).toLowerCase().includes(q));
      return matchesTrust && matchesReviewMode && matchesSearch;
    });

    return {
      items,
      summary,
      nextCursor: rows.length > take ? rows[take].id : null,
    };
  }

  private async getSubmissionRow(id: string) {
    const submission = await (this.prisma as any).contentSubmission.findUnique({
      where: { id },
    });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    return submission;
  }

  async getSubmission(id: string) {
    return this.mapSubmissionDetail(await this.getSubmissionRow(id));
  }

  async getOwnerSubmission(id: string, actorUserId: string) {
    const submission = await this.getSubmissionRow(id);
    if (submission.submittedById !== actorUserId) {
      const brand = submission.brandId
        ? await this.prisma.brand.findUnique({
            where: { id: submission.brandId },
            select: { ownerId: true },
          })
        : null;
      if (brand?.ownerId !== actorUserId) {
        throw new ForbiddenException('You cannot view this review decision.');
      }
    }
    return this.mapSubmissionDetail(submission, { includeReports: false });
  }

  getReportReasonCodes() {
    return Object.entries(CONTENT_REPORT_REASON_LABELS).map(
      ([code, label]) => ({ code, label }),
    );
  }

  async listReports(filters: ReportListFilters) {
    const take = Math.min(Math.max(Number(filters.take) || 50, 1), 100);
    const where: Record<string, unknown> = {};
    if (filters.status) where.status = filters.status;
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.targetId) where.targetId = filters.targetId;
    if (filters.mediaId) where.mediaId = filters.mediaId;
    if (filters.reasonCode) where.reasonCode = filters.reasonCode;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: new Date(filters.from) } : {}),
        ...(filters.to ? { lte: new Date(filters.to) } : {}),
      };
    }

    const [rows, summary] = await Promise.all([
      (this.prisma as any).contentReport.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        take,
      }),
      this.buildReportSummary(where),
    ]);

    return {
      items: await Promise.all(rows.map((row) => this.mapReport(row))),
      summary,
    };
  }

  async getReport(id: string) {
    const report = await (this.prisma as any).contentReport.findUnique({
      where: { id },
    });
    if (!report) {
      throw new NotFoundException('Report not found');
    }
    return this.mapReport(report);
  }

  async reportContent(args: {
    reporterId: string;
    targetType: ContentReportTargetType | string;
    targetId: string;
    mediaId?: string | null;
    reasonCode: ContentReportReasonCode | string;
    note?: string | null;
  }) {
    const target = await this.resolveReportTarget(args);
    const note = String(args.note ?? '').trim() || null;
    const existing = await (this.prisma as any).contentReport.findFirst({
      where: {
        reporterId: args.reporterId,
        targetType: target.targetType,
        targetId: target.targetId,
        mediaId: target.mediaId ?? null,
        reasonCode: args.reasonCode,
        status: { in: [ContentReportStatus.OPEN, ContentReportStatus.REVIEWED] },
      },
      orderBy: { createdAt: 'desc' },
    });

    if (existing) {
      return {
        ...(await this.mapReport(existing)),
        duplicate: true,
      };
    }

    const report = await (this.prisma as any).contentReport.create({
      data: {
        id: uuidv4(),
        reporterId: args.reporterId,
        targetType: target.targetType,
        targetId: target.targetId,
        mediaId: target.mediaId ?? null,
        reasonCode: args.reasonCode,
        note,
      },
    });

    this.emitReportAlert(report, target);
    return {
      ...(await this.mapReport(report)),
      duplicate: false,
    };
  }

  async resolveReport(args: {
    reportId: string;
    adminUserId: string;
    status: ContentReportStatus | string;
    resolution?: string | null;
    ipAddress?: string | null;
    userAgent?: string | null;
  }) {
    if (args.status === ContentReportStatus.OPEN) {
      throw new BadRequestException('Report resolution cannot reopen a report.');
    }
    const current = await (this.prisma as any).contentReport.findUnique({
      where: { id: args.reportId },
    });
    if (!current) {
      throw new NotFoundException('Report not found');
    }

    const report = await (this.prisma as any).contentReport.update({
      where: { id: args.reportId },
      data: {
        status: args.status,
        resolution: String(args.resolution ?? '').trim() || null,
        reviewedById: args.adminUserId,
        reviewedAt: new Date(),
      },
    });

    await (this.prisma as any).adminAuditLog.create({
      data: {
        id: uuidv4(),
        actorUserId: args.adminUserId,
        action: 'ADMIN_CONTENT_REVIEW_ACTION',
        targetType: 'ContentReport',
        targetId: args.reportId,
        previousState: {
          status: current.status,
          resolution: current.resolution,
        },
        newState: {
          status: report.status,
          resolution: report.resolution,
        },
        metadata: {
          targetType: report.targetType,
          reportedTargetId: report.targetId,
          mediaId: report.mediaId,
          reasonCode: report.reasonCode,
        },
        ipAddress: args.ipAddress ?? null,
        userAgent: args.userAgent ?? null,
      },
    });

    this.monitoring?.emitMetric('content_report_resolved', {
      reportId: report.id,
      targetType: report.targetType,
      targetId: report.targetId,
      mediaId: report.mediaId,
      status: report.status,
    });

    return this.mapReport(report);
  }

  private async buildSubmissionSummary(where: Record<string, unknown>) {
    const { status: _status, ...baseWhere } = where;
    const [pending, changesRequested, rejected, approved] = await Promise.all([
      (this.prisma as any).contentSubmission.count({
        where: { ...baseWhere, status: ContentSubmissionStatus.IN_REVIEW },
      }),
      (this.prisma as any).contentSubmission.count({
        where: {
          ...baseWhere,
          status: ContentSubmissionStatus.CHANGES_REQUESTED,
        },
      }),
      (this.prisma as any).contentSubmission.count({
        where: { ...baseWhere, status: ContentSubmissionStatus.REJECTED },
      }),
      (this.prisma as any).contentSubmission.count({
        where: { ...baseWhere, status: ContentSubmissionStatus.APPROVED },
      }),
    ]);
    return {
      pending,
      changesRequested,
      rejected,
      approvedPublished: approved,
    };
  }

  private async buildReportSummary(where: Record<string, unknown>) {
    const { status: _status, ...baseWhere } = where;
    const [open, reviewed, resolved, dismissed] = await Promise.all([
      (this.prisma as any).contentReport.count({
        where: { ...baseWhere, status: ContentReportStatus.OPEN },
      }),
      (this.prisma as any).contentReport.count({
        where: { ...baseWhere, status: ContentReportStatus.REVIEWED },
      }),
      (this.prisma as any).contentReport.count({
        where: { ...baseWhere, status: ContentReportStatus.RESOLVED },
      }),
      (this.prisma as any).contentReport.count({
        where: { ...baseWhere, status: ContentReportStatus.DISMISSED },
      }),
    ]);
    return { open, reviewed, resolved, dismissed };
  }

  private async mapSubmissionDetail(
    submission: any,
    options: { includeReports?: boolean } = {},
  ) {
    const target = await this.getSubmissionTarget(submission);
    const media = await this.getSubmissionMedia(submission);
    const [brand, submittedBy, reviewedBy, history, reports] =
      await Promise.all([
        this.getBrandReviewSnapshot(submission.brandId ?? target.brandId),
        this.getUserSnapshot(submission.submittedById),
        submission.reviewedById
          ? this.getUserSnapshot(submission.reviewedById)
          : Promise.resolve(null),
        this.getSubmissionHistory(submission),
        options.includeReports === false
          ? Promise.resolve([])
          : this.getReportsForSubmission(target, media),
      ]);

    const checklist = this.buildRequiredSlotChecklist(media);
    return {
      id: submission.id,
      entityType: submission.entityType,
      status: submission.status,
      previousStatus: submission.previousStatus,
      targetStatus: submission.targetStatus,
      reasonCode: submission.reasonCode,
      reasonLabel: submission.reasonCode
        ? CONTENT_REVIEW_REASON_LABELS[
            submission.reasonCode as ContentReviewReasonCode
          ]
        : null,
      reasonNote: submission.reasonNote,
      submittedAt: submission.submittedAt,
      reviewedAt: submission.reviewedAt,
      target,
      brand,
      submittedBy,
      reviewedBy,
      media,
      requiredSlotChecklist: checklist,
      slotCompleteness: {
        required: checklist.length,
        present: checklist.filter((slot) => slot.present).length,
        missing: checklist.filter((slot) => !slot.present).map((slot) => slot.slot),
      },
      reviewHistory: history,
      reports,
    };
  }

  private async getSubmissionTarget(submission: any) {
    if (submission.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: submission.productId },
        select: {
          id: true,
          name: true,
          description: true,
          brandId: true,
          publicationStatus: true,
          isActive: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return {
        id: submission.productId,
        type: ContentEntityType.PRODUCT,
        reportTargetType: ContentReportTargetType.PRODUCT,
        title: product?.name ?? 'Deleted product',
        description: product?.description ?? null,
        brandId: product?.brandId ?? submission.brandId ?? null,
        status: product?.publicationStatus ?? null,
        isActive: product?.isActive ?? false,
        createdAt: product?.createdAt ?? null,
        updatedAt: product?.updatedAt ?? null,
      };
    }

    if (submission.designId) {
      const design = await (this.prisma as any).design.findUnique({
        where: { id: submission.designId },
        select: {
          id: true,
          title: true,
          description: true,
          brandId: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return {
        id: submission.designId,
        type: ContentEntityType.DESIGN,
        reportTargetType: ContentReportTargetType.DESIGN,
        title: design?.title ?? 'Deleted design',
        description: design?.description ?? null,
        brandId: design?.brandId ?? submission.brandId ?? null,
        status: design?.status ?? null,
        isActive: design?.status === CollectionStatus.PUBLISHED,
        createdAt: design?.createdAt ?? null,
        updatedAt: design?.updatedAt ?? null,
      };
    }

    const collection = submission.legacyCollectionId
      ? await this.prisma.collection.findUnique({
          where: { id: submission.legacyCollectionId },
          select: {
            id: true,
            title: true,
            description: true,
            status: true,
            ownerId: true,
            createdAt: true,
            updatedAt: true,
          },
        })
      : null;
    return {
      id: submission.legacyCollectionId ?? submission.id,
      type: ContentEntityType.DESIGN,
      reportTargetType: ContentReportTargetType.COLLECTION,
      title: collection?.title ?? 'Deleted design',
      description: collection?.description ?? null,
      brandId: submission.brandId ?? null,
      ownerId: collection?.ownerId ?? null,
      status: collection?.status ?? null,
      isActive: collection?.status === CollectionStatus.PUBLISHED,
      createdAt: collection?.createdAt ?? null,
      updatedAt: collection?.updatedAt ?? null,
    };
  }

  private async getSubmissionMedia(submission: any) {
    const rows = submission.productId
      ? await (this.prisma as any).productMedia.findMany({
          where: { productId: submission.productId },
          include: { file: true },
          orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
        })
      : submission.designId
        ? await (this.prisma as any).designMedia.findMany({
            where: { designId: submission.designId },
            include: { file: true },
            orderBy: [{ orderIndex: 'asc' }, { createdAt: 'asc' }],
          })
        : submission.legacyCollectionId
          ? await (this.prisma as any).collectionMedia.findMany({
              where: { collectionId: submission.legacyCollectionId },
              include: { file: true },
              orderBy: [{ orderIndex: 'asc' }],
            })
          : [];

    return rows.map((row) => this.mapMediaRow(row));
  }

  private mapMediaRow(row: any) {
    const slot = this.normalizeViewSlot(row.viewSlot, row.orderIndex);
    const reasonCode = row.reviewReasonCode as ContentReviewReasonCode | null;
    return {
      id: row.id,
      fileId: row.fileUploadId,
      mediaType: row.mediaType ?? row.file?.fileType ?? null,
      mimeType: row.file?.mimeType ?? null,
      slot,
      slotLabel: this.slotLabel(slot),
      mediaPurpose: row.mediaPurpose,
      reviewStatus: row.reviewStatus,
      reviewReasonCode: reasonCode,
      reviewReasonLabel: reasonCode
        ? CONTENT_REVIEW_REASON_LABELS[reasonCode]
        : null,
      reviewReason: row.reviewReason ?? null,
      orderIndex: row.orderIndex,
      canPreview: Boolean(row.fileUploadId),
      previewUrl: null,
    };
  }

  private buildRequiredSlotChecklist(media: any[]) {
    return REQUIRED_CONTENT_MEDIA_VIEW_SLOTS.map((slot) => {
      const mediaItem = media.find((item) => item.slot === slot);
      return {
        slot,
        label: this.slotLabel(slot),
        present: Boolean(mediaItem),
        mediaId: mediaItem?.id ?? null,
        reviewStatus: mediaItem?.reviewStatus ?? null,
      };
    });
  }

  private slotLabel(slot: ContentMediaViewSlot | string) {
    const labels: Record<string, string> = {
      FRONT: 'Front',
      BACK: 'Back',
      LEFT_SIDE: 'Left Side',
      RIGHT_SIDE: 'Right Side',
      DETAIL: 'Detail',
      ON_MODEL: 'On Model',
      FABRIC_DETAIL: 'Fabric Detail',
      OTHER: 'Other',
    };
    return labels[String(slot)] ?? 'Other';
  }

  private async getBrandReviewSnapshot(brandId?: string | null) {
    if (!brandId) return null;
    const [brand, latestEvent] = await Promise.all([
      this.prisma.brand.findUnique({
        where: { id: brandId },
        select: {
          id: true,
          name: true,
          contentTrustTierOverride: true,
          contentReviewModeOverride: true,
        },
      }),
      (this.prisma as any).brandTrustEvent.findFirst({
        where: { brandId },
        orderBy: { createdAt: 'desc' },
        select: {
          tier: true,
          reviewMode: true,
          eventType: true,
          createdAt: true,
        },
      }),
    ]);
    if (!brand) return null;
    return {
      id: brand.id,
      name: brand.name,
      trustTier: brand.contentTrustTierOverride ?? latestEvent?.tier ?? null,
      reviewMode:
        brand.contentReviewModeOverride ?? latestEvent?.reviewMode ?? null,
      latestTrustEvent: latestEvent?.eventType ?? null,
      latestTrustEventAt: latestEvent?.createdAt ?? null,
    };
  }

  private async getUserSnapshot(userId?: string | null) {
    if (!userId) return null;
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, username: true },
    });
    return user ? { id: user.id, username: user.username } : null;
  }

  private async getSubmissionHistory(submission: any) {
    const where: Record<string, unknown> = { entityType: submission.entityType };
    if (submission.productId) where.productId = submission.productId;
    if (submission.designId) where.designId = submission.designId;
    if (submission.legacyCollectionId) {
      where.legacyCollectionId = submission.legacyCollectionId;
    }
    const rows = await (this.prisma as any).contentSubmission.findMany({
      where,
      orderBy: [{ submittedAt: 'desc' }],
      take: 10,
      select: {
        id: true,
        status: true,
        reasonCode: true,
        reasonNote: true,
        submittedAt: true,
        reviewedAt: true,
        reviewedById: true,
      },
    });
    return rows.map((row) => ({
      ...row,
      reasonLabel: row.reasonCode
        ? CONTENT_REVIEW_REASON_LABELS[
            row.reasonCode as ContentReviewReasonCode
          ]
        : null,
    }));
  }

  private async getReportsForSubmission(target: any, media: any[]) {
    const mediaIds = media.map((item) => item.id).filter(Boolean);
    const orConditions = [
      {
        targetType: target.reportTargetType,
        targetId: target.id,
      },
      ...mediaIds.map((mediaId) => ({ mediaId })),
    ];
    if (!target.id && mediaIds.length === 0) return [];
    const reports = await (this.prisma as any).contentReport.findMany({
      where: { OR: orConditions },
      orderBy: [{ createdAt: 'desc' }],
      take: 20,
    });
    return Promise.all(reports.map((report) => this.mapReport(report)));
  }

  private async mapReport(report: any) {
    const [reporter, reviewer, target] = await Promise.all([
      this.getUserSnapshot(report.reporterId),
      report.reviewedById
        ? this.getUserSnapshot(report.reviewedById)
        : Promise.resolve(null),
      this.getReportTargetSummary(report.targetType, report.targetId),
    ]);
    return {
      id: report.id,
      reporter,
      targetType: report.targetType,
      targetId: report.targetId,
      mediaId: report.mediaId,
      target,
      reasonCode: report.reasonCode,
      reasonLabel:
        CONTENT_REPORT_REASON_LABELS[report.reasonCode as ContentReportReasonCode],
      note: report.note,
      status: report.status,
      reviewedBy: reviewer,
      reviewedAt: report.reviewedAt,
      resolution: report.resolution,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
    };
  }

  private async getReportTargetSummary(
    targetType: ContentReportTargetType | string,
    targetId: string,
  ) {
    if (targetType === ContentReportTargetType.PRODUCT) {
      const product = await this.prisma.product.findUnique({
        where: { id: targetId },
        select: { id: true, name: true, brandId: true, publicationStatus: true },
      });
      return product
        ? {
            id: product.id,
            type: targetType,
            title: product.name,
            brandId: product.brandId,
            status: product.publicationStatus,
          }
        : { id: targetId, type: targetType, title: 'Deleted product' };
    }
    if (targetType === ContentReportTargetType.DESIGN) {
      const design = await (this.prisma as any).design.findUnique({
        where: { id: targetId },
        select: { id: true, title: true, brandId: true, status: true },
      });
      return design
        ? {
            id: design.id,
            type: targetType,
            title: design.title,
            brandId: design.brandId,
            status: design.status,
          }
        : { id: targetId, type: targetType, title: 'Deleted design' };
    }
    if (targetType === ContentReportTargetType.COLLECTION) {
      const collection = await this.prisma.collection.findUnique({
        where: { id: targetId },
        select: { id: true, title: true, status: true, ownerId: true },
      });
      return collection
        ? {
            id: collection.id,
            type: targetType,
            title: collection.title,
            ownerId: collection.ownerId,
            status: collection.status,
          }
        : { id: targetId, type: targetType, title: 'Deleted design' };
    }
    if (targetType === ContentReportTargetType.BRAND) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: targetId },
        select: { id: true, name: true },
      });
      return brand
        ? { id: brand.id, type: targetType, title: brand.name, brandId: brand.id }
        : { id: targetId, type: targetType, title: 'Deleted brand' };
    }
    return { id: targetId, type: targetType, title: 'Media item' };
  }

  private async resolveReportTarget(args: {
    targetType: ContentReportTargetType | string;
    targetId: string;
    mediaId?: string | null;
  }) {
    if (args.targetType === ContentReportTargetType.PRODUCT) {
      const product = await this.prisma.product.findFirst({
        where: {
          id: args.targetId,
          deletedAt: null,
          publicationStatus: CollectionStatus.PUBLISHED,
          isActive: true,
        },
        select: { id: true, brandId: true, name: true },
      });
      if (!product) throw new NotFoundException('Report target not found');
      if (args.mediaId) {
        await this.assertMediaBelongsToTarget('productMedia', args.mediaId, {
          productId: product.id,
        });
      }
      return {
        targetType: ContentReportTargetType.PRODUCT,
        targetId: product.id,
        mediaId: args.mediaId ?? null,
        title: product.name,
        brandId: product.brandId,
      };
    }

    if (args.targetType === ContentReportTargetType.DESIGN) {
      const design = await (this.prisma as any).design.findFirst({
        where: {
          id: args.targetId,
          deletedAt: null,
          status: CollectionStatus.PUBLISHED,
        },
        select: { id: true, brandId: true, title: true },
      });
      if (!design) throw new NotFoundException('Report target not found');
      if (args.mediaId) {
        await this.assertMediaBelongsToTarget('designMedia', args.mediaId, {
          designId: design.id,
        });
      }
      return {
        targetType: ContentReportTargetType.DESIGN,
        targetId: design.id,
        mediaId: args.mediaId ?? null,
        title: design.title,
        brandId: design.brandId,
      };
    }

    if (args.targetType === ContentReportTargetType.COLLECTION) {
      const collection = await this.prisma.collection.findFirst({
        where: {
          id: args.targetId,
          deletedAt: null,
          status: CollectionStatus.PUBLISHED,
        },
        select: { id: true, ownerId: true, title: true },
      });
      if (!collection) throw new NotFoundException('Report target not found');
      if (args.mediaId) {
        await this.assertMediaBelongsToTarget('collectionMedia', args.mediaId, {
          collectionId: collection.id,
        });
      }
      return {
        targetType: ContentReportTargetType.COLLECTION,
        targetId: collection.id,
        mediaId: args.mediaId ?? null,
        title: collection.title,
      };
    }

    if (args.targetType === ContentReportTargetType.MEDIA) {
      const media =
        (await this.findReportMediaTarget('productMedia', args.targetId)) ??
        (await this.findReportMediaTarget('designMedia', args.targetId)) ??
        (await this.findReportMediaTarget('collectionMedia', args.targetId));
      if (!media) throw new NotFoundException('Report target not found');
      return {
        targetType: ContentReportTargetType.MEDIA,
        targetId: media.id,
        mediaId: media.id,
        title: 'Media item',
      };
    }

    if (args.targetType === ContentReportTargetType.BRAND) {
      const brand = await this.prisma.brand.findUnique({
        where: { id: args.targetId },
        select: { id: true, name: true },
      });
      if (!brand) throw new NotFoundException('Report target not found');
      return {
        targetType: ContentReportTargetType.BRAND,
        targetId: brand.id,
        mediaId: null,
        title: brand.name,
        brandId: brand.id,
      };
    }

    throw new BadRequestException('Unsupported report target type.');
  }

  private async assertMediaBelongsToTarget(
    modelName: 'productMedia' | 'designMedia' | 'collectionMedia',
    mediaId: string,
    where: Record<string, unknown>,
  ) {
    const media = await (this.prisma as any)[modelName].findFirst({
      where: { id: mediaId, ...where },
      select: { id: true },
    });
    if (!media) {
      throw new BadRequestException('Reported media does not belong to target.');
    }
  }

  private async findReportMediaTarget(
    modelName: 'productMedia' | 'designMedia' | 'collectionMedia',
    mediaId: string,
  ) {
    const visibilityWhere =
      modelName === 'productMedia'
        ? {
            product: {
              publicationStatus: CollectionStatus.PUBLISHED,
              isActive: true,
              deletedAt: null,
            },
          }
        : modelName === 'designMedia'
          ? { design: { status: CollectionStatus.PUBLISHED, deletedAt: null } }
          : {
              collection: {
                status: CollectionStatus.PUBLISHED,
                deletedAt: null,
              },
            };
    const media = await (this.prisma as any)[modelName].findFirst({
      where: { id: mediaId, ...visibilityWhere },
      select: { id: true },
    });
    return media ?? null;
  }

  private emitReportAlert(report: any, target: any) {
    const highSeverity = HIGH_SEVERITY_CONTENT_REPORT_REASONS.includes(
      report.reasonCode,
    );
    this.monitoring?.emitAlert({
      category: 'ADMIN',
      severity: highSeverity ? 'warning' : 'info',
      event: highSeverity
        ? 'content_report_high_severity'
        : 'content_report_received',
      message: highSeverity
        ? 'High-severity content report received.'
        : 'Content report received.',
      actorId: report.reporterId,
      entityType: String(report.targetType),
      entityId: report.targetId,
      metadata: {
        reportId: report.id,
        targetType: report.targetType,
        targetId: report.targetId,
        mediaId: report.mediaId,
        reasonCode: report.reasonCode,
        title: target.title,
      },
    });
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
    const submission = await this.getSubmissionRow(args.submissionId);
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
    if (
      args.action !== 'approve' &&
      args.reasonCode === ContentReviewReasonCode.OTHER &&
      !String(args.reasonNote ?? '').trim()
    ) {
      throw new BadRequestException('Admin note is required when reason is Other.');
    }
    if (submission.submittedById === args.adminUserId) {
      throw new ForbiddenException('Admins cannot review their own content.');
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
