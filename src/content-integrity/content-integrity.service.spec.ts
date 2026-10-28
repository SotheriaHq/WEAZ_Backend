import { BadRequestException, ForbiddenException } from '@nestjs/common';
import {
  BrandContentReviewMode,
  BrandTrustTier,
  BrandVerificationStatus,
  CollectionStatus,
  ContentReportReasonCode,
  ContentEntityType,
  ContentReportTargetType,
  ContentMediaViewSlot,
  ContentReviewReasonCode,
  ContentSubmissionStatus,
  FileType,
} from '@prisma/client';
import { ContentIntegrityService } from './content-integrity.service';

describe('ContentIntegrityService', () => {
  const readyFile = (id: string, userId = 'owner-1') => ({
    id,
    userId,
    s3Url: `https://cdn.test/${id}.jpg`,
    fileType: FileType.POST_IMAGE,
    processingStatus: 'READY',
    originalDeletedAt: null,
  });

  function createService(
    prismaOverrides: Record<string, any> = {},
    deps: { uploadService?: any } = {},
  ) {
    const prisma: any = {
      fileUpload: {
        findMany: jest.fn(),
      },
      brand: {
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      product: {
        count: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        findUnique: jest.fn(),
      },
      collection: {
        count: jest.fn(),
      },
      contentSubmission: {
        findUnique: jest.fn(),
      },
      contentReport: {
        findFirst: jest.fn(),
        create: jest.fn(),
      },
      brandTrustEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
      ...prismaOverrides,
    };
    return {
      prisma,
      service: new ContentIntegrityService(
        prisma,
        undefined,
        undefined,
        undefined,
        deps.uploadService,
      ),
    };
  }

  it('requires all four required slots for product publish media', async () => {
    const { prisma, service } = createService();
    prisma.fileUpload.findMany.mockResolvedValue([
      readyFile('file-front'),
      readyFile('file-back'),
      readyFile('file-left'),
    ]);

    await expect(
      service.validateProductMediaInputs({
        actorUserId: 'owner-1',
        ownerUserId: 'owner-1',
        requireComplete: true,
        entries: [
          { fileUploadId: 'file-front', viewSlot: ContentMediaViewSlot.FRONT },
          { fileUploadId: 'file-back', viewSlot: ContentMediaViewSlot.BACK },
          {
            fileUploadId: 'file-left',
            viewSlot: ContentMediaViewSlot.LEFT_SIDE,
          },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects duplicate view slots before publish', async () => {
    const { service } = createService();

    await expect(
      service.validateProductMediaInputs({
        actorUserId: 'owner-1',
        ownerUserId: 'owner-1',
        requireComplete: false,
        entries: [
          { fileUploadId: 'file-1', viewSlot: ContentMediaViewSlot.FRONT },
          { fileUploadId: 'file-2', viewSlot: ContentMediaViewSlot.FRONT },
        ],
      }),
    ).rejects.toThrow('Duplicate media view slot');
  });

  it('accepts durable uploaded image files for required product slots', async () => {
    const { prisma, service } = createService();
    prisma.fileUpload.findMany.mockResolvedValue([
      readyFile('file-front'),
      readyFile('file-back'),
      readyFile('file-left'),
      readyFile('file-right'),
    ]);

    const result = await service.validateProductMediaInputs({
      actorUserId: 'owner-1',
      ownerUserId: 'owner-1',
      requireComplete: true,
      entries: [
        { fileUploadId: 'file-front', viewSlot: ContentMediaViewSlot.FRONT },
        { fileUploadId: 'file-back', viewSlot: ContentMediaViewSlot.BACK },
        { fileUploadId: 'file-left', viewSlot: ContentMediaViewSlot.LEFT_SIDE },
        {
          fileUploadId: 'file-right',
          viewSlot: ContentMediaViewSlot.RIGHT_SIDE,
        },
      ],
    });

    expect(result.map((entry) => entry.viewSlot)).toEqual([
      ContentMediaViewSlot.FRONT,
      ContentMediaViewSlot.BACK,
      ContentMediaViewSlot.LEFT_SIDE,
      ContentMediaViewSlot.RIGHT_SIDE,
    ]);
  });

  it('keeps new or unacknowledged brands in pre-review mode', async () => {
    const { prisma, service } = createService();
    prisma.brand.findUnique.mockResolvedValue({
      id: 'brand-1',
      ownerId: 'owner-1',
      createdAt: new Date(),
      verificationStatus: BrandVerificationStatus.APPROVED,
      contentMediaPolicyAcknowledgedAt: null,
      contentTrustTierOverride: null,
      contentReviewModeOverride: null,
    });
    prisma.product.count.mockResolvedValue(0);
    prisma.collection.count.mockResolvedValue(0);

    const gate = await service.evaluateBrandGate('brand-1');

    expect(gate.tier).toBe(BrandTrustTier.NEW);
    expect(gate.reviewMode).toBe(BrandContentReviewMode.PRE_REVIEW_REQUIRED);
    expect(gate.requiresPreReview).toBe(true);
  });

  const establishedBrand = (overrides: Record<string, unknown> = {}) => ({
    id: 'brand-1',
    ownerId: 'owner-1',
    createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
    verificationStatus: BrandVerificationStatus.APPROVED,
    contentMediaPolicyAcknowledgedAt: new Date(),
    contentTrustTierOverride: null,
    contentReviewModeOverride: null,
    ...overrides,
  });

  it('still requires review for an established NORMAL-tier brand', async () => {
    // Regression: NORMAL mapped to POST_REVIEW_ALLOWED, which published at once
    // and never created a submission — a design went live unreviewed on SIT.
    const { prisma, service } = createService();
    prisma.brand.findUnique.mockResolvedValue(establishedBrand());
    prisma.product.count.mockResolvedValue(5);
    prisma.collection.count.mockResolvedValue(5);

    const gate = await service.evaluateBrandGate('brand-1');
    const decision = await service.resolvePublicationDecision('brand-1');

    expect(gate.tier).toBe(BrandTrustTier.NORMAL);
    expect(gate.requiresPreReview).toBe(true);
    expect(decision.publicationStatus).toBe(CollectionStatus.IN_REVIEW);
    expect(decision.requiresPreReview).toBe(true);
  });

  it('publishes without review only when an admin override allows it', async () => {
    const { prisma, service } = createService();
    prisma.brand.findUnique.mockResolvedValue(
      establishedBrand({
        contentReviewModeOverride: BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
      }),
    );
    prisma.product.count.mockResolvedValue(5);
    prisma.collection.count.mockResolvedValue(5);

    const decision = await service.resolvePublicationDecision('brand-1');

    expect(decision.publicationStatus).toBe(CollectionStatus.PUBLISHED);
    expect(decision.requiresPreReview).toBe(false);
  });

  it('sends content with no resolvable brand to review instead of publishing it', async () => {
    const { service } = createService();

    const decision = await service.resolvePublicationDecision(null);

    expect(decision.publicationStatus).toBe(CollectionStatus.IN_REVIEW);
    expect(decision.requiresPreReview).toBe(true);
  });

  describe('brand auto-publish', () => {
    const auditCreate = () => ({ adminAuditLog: { create: jest.fn() } });

    it('turns auto-publish on with an audited reason', async () => {
      const { prisma, service } = createService(auditCreate());
      prisma.brand.findUnique.mockResolvedValue({
        id: 'brand-1',
        name: 'Brand',
        contentReviewModeOverride: null,
        contentTrustTierOverride: null,
      });

      const result = await service.setBrandAutoPublish({
        brandId: 'brand-1',
        adminUserId: 'admin-1',
        enabled: true,
        reason: 'Long-standing verified brand',
      });

      expect(result.enabled).toBe(true);
      expect(prisma.brand.update).toHaveBeenCalledWith({
        where: { id: 'brand-1' },
        data: {
          contentReviewModeOverride:
            BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
        },
      });
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            previousState: expect.objectContaining({ autoPublish: false }),
            newState: expect.objectContaining({
              autoPublish: true,
              reason: 'Long-standing verified brand',
            }),
          }),
        }),
      );
    });

    it('refuses a change without a reason', async () => {
      const { prisma, service } = createService(auditCreate());

      await expect(
        service.setBrandAutoPublish({
          brandId: 'brand-1',
          adminUserId: 'admin-1',
          enabled: true,
          reason: '   ',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.brand.update).not.toHaveBeenCalled();
    });

    it('does not let the general trust override turn auto-publish on', async () => {
      const { prisma, service } = createService(auditCreate());

      await expect(
        service.setBrandTrustOverride({
          brandId: 'brand-1',
          adminUserId: 'admin-1',
          reviewMode: BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.brand.update).not.toHaveBeenCalled();
    });

    it('keeps an existing auto-publish when the trust override leaves review mode out', async () => {
      const { prisma, service } = createService(auditCreate());
      prisma.brand.findUnique.mockResolvedValue({
        contentReviewModeOverride: BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
      });
      prisma.brand.update.mockResolvedValue({
        id: 'brand-1',
        contentTrustTierOverride: BrandTrustTier.NORMAL,
        contentReviewModeOverride: BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
      });

      await service.setBrandTrustOverride({
        brandId: 'brand-1',
        adminUserId: 'admin-1',
        trustTier: BrandTrustTier.NORMAL,
      });

      expect(prisma.brand.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            contentReviewModeOverride:
              BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
          }),
        }),
      );
    });

    it('refuses to change review mode over an active auto-publish from the trust override', async () => {
      const { prisma, service } = createService(auditCreate());
      prisma.brand.findUnique.mockResolvedValue({
        contentReviewModeOverride: BrandContentReviewMode.AUTO_PUBLISH_ALLOWED,
      });

      await expect(
        service.setBrandTrustOverride({
          brandId: 'brand-1',
          adminUserId: 'admin-1',
          reviewMode: BrandContentReviewMode.PRE_REVIEW_REQUIRED,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.brand.update).not.toHaveBeenCalled();
    });
  });

  it('requires a reason code when rejecting a submission', async () => {
    const { prisma, service } = createService();
    prisma.contentSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      entityType: 'PRODUCT',
      productId: 'product-1',
      status: ContentSubmissionStatus.IN_REVIEW,
    });

    await expect(
      service.reviewSubmission({
        submissionId: 'submission-1',
        adminUserId: 'admin-1',
        action: 'reject',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('requires an admin note when Other is selected for reject/request changes', async () => {
    const { prisma, service } = createService();
    prisma.contentSubmission.findUnique.mockResolvedValue({
      id: 'submission-1',
      entityType: 'PRODUCT',
      productId: 'product-1',
      submittedById: 'owner-1',
      status: ContentSubmissionStatus.IN_REVIEW,
    });

    await expect(
      service.reviewSubmission({
        submissionId: 'submission-1',
        adminUserId: 'admin-1',
        action: 'request_changes',
        reasonCode: ContentReviewReasonCode.OTHER,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('creates a content report without returning raw media URLs', async () => {
    const { prisma, service } = createService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-1',
      brandId: 'brand-1',
      name: 'Boubou',
    });
    prisma.product.findUnique.mockResolvedValue({
      id: 'product-1',
      brandId: 'brand-1',
      name: 'Boubou',
      publicationStatus: CollectionStatus.PUBLISHED,
    });
    prisma.contentReport.findFirst.mockResolvedValue(null);
    prisma.contentReport.create.mockResolvedValue({
      id: 'report-1',
      reporterId: 'user-1',
      targetType: ContentReportTargetType.PRODUCT,
      targetId: 'product-1',
      mediaId: null,
      reasonCode: ContentReportReasonCode.WRONG_OR_UNRELATED_IMAGE,
      note: 'Wrong item',
      status: 'OPEN',
      reviewedById: null,
      reviewedAt: null,
      resolution: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'reporter',
    });

    const report = await service.reportContent({
      reporterId: 'user-1',
      targetType: ContentReportTargetType.PRODUCT,
      targetId: 'product-1',
      reasonCode: ContentReportReasonCode.WRONG_OR_UNRELATED_IMAGE,
      note: 'Wrong item',
    });

    expect(report.duplicate).toBe(false);
    expect(report.reasonLabel).toBe('Wrong or unrelated image');
    expect(JSON.stringify(report)).not.toContain('s3Url');
  });

  it('returns admin review media preview URLs without exposing raw storage URLs', async () => {
    const createdAt = new Date('2026-06-12T21:08:48.000Z');
    const rawStorageUrl =
      'https://wiez-private.s3.amazonaws.com/POST_IMAGE/owner-1/front.jpg';
    const uploadService = {
      getBatchVariantDisplayUrls: jest.fn().mockResolvedValue(new Map()),
      getPublicDisplayUrl: jest.fn().mockReturnValue(null),
      getTemporarySignedDisplayUrl: jest
        .fn()
        .mockResolvedValue('https://signed.example/review-front.jpg?token=ok'),
    };
    const { service } = createService(
      {
        contentSubmission: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'submission-1',
            entityType: 'DESIGN',
            legacyCollectionId: 'collection-1',
            brandId: 'brand-1',
            submittedById: 'owner-1',
            status: ContentSubmissionStatus.IN_REVIEW,
            previousStatus: CollectionStatus.DRAFT,
            targetStatus: CollectionStatus.PUBLISHED,
            submittedAt: createdAt,
            reviewedAt: null,
            reasonCode: null,
            reasonNote: null,
          }),
          findMany: jest.fn().mockResolvedValue([]),
        },
        collection: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'collection-1',
            title: 'Ada Nne',
            description: 'Lookbook',
            status: CollectionStatus.IN_REVIEW,
            ownerId: 'owner-1',
            createdAt,
            updatedAt: createdAt,
          }),
        },
        collectionMedia: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: 'media-front',
              fileUploadId: 'file-front',
              mediaType: FileType.POST_IMAGE,
              viewSlot: ContentMediaViewSlot.FRONT,
              mediaPurpose: 'REQUIRED_VIEW',
              reviewStatus: 'PENDING',
              orderIndex: 0,
              file: {
                ...readyFile('file-front'),
                s3Url: rawStorageUrl,
                s3Key: 'POST_IMAGE/owner-1/front.jpg',
              },
            },
          ]),
        },
        brand: {
          findUnique: jest.fn().mockResolvedValue({
            id: 'brand-1',
            name: 'Avery Cotour',
            contentTrustTierOverride: null,
            contentReviewModeOverride: null,
          }),
        },
        brandTrustEvent: {
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
        },
        user: {
          findUnique: jest.fn().mockResolvedValue(null),
        },
        contentReport: {
          findMany: jest.fn().mockResolvedValue([]),
        },
      },
      { uploadService },
    );

    const detail = await service.getSubmission('submission-1');

    expect(detail.media[0]).toEqual(
      expect.objectContaining({
        fileId: 'file-front',
        slot: ContentMediaViewSlot.FRONT,
        canPreview: true,
        previewUrl: 'https://signed.example/review-front.jpg?token=ok',
        url: 'https://signed.example/review-front.jpg?token=ok',
        thumbnailUrl: 'https://signed.example/review-front.jpg?token=ok',
      }),
    );
    expect(JSON.stringify(detail)).not.toContain(rawStorageUrl);
    expect(uploadService.getTemporarySignedDisplayUrl).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'file-front' }),
      15 * 60,
    );
  });

  it('returns an existing open content report for duplicate reports', async () => {
    const createdAt = new Date();
    const { prisma, service } = createService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-1',
      brandId: 'brand-1',
      name: 'Boubou',
    });
    prisma.product.findUnique.mockResolvedValue({
      id: 'product-1',
      brandId: 'brand-1',
      name: 'Boubou',
      publicationStatus: CollectionStatus.PUBLISHED,
    });
    prisma.contentReport.findFirst.mockResolvedValue({
      id: 'report-1',
      reporterId: 'user-1',
      targetType: ContentReportTargetType.PRODUCT,
      targetId: 'product-1',
      mediaId: null,
      reasonCode: ContentReportReasonCode.WRONG_OR_UNRELATED_IMAGE,
      note: 'Wrong item',
      status: 'OPEN',
      reviewedById: null,
      reviewedAt: null,
      resolution: null,
      createdAt,
      updatedAt: createdAt,
    });
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-1',
      username: 'reporter',
    });

    const report = await service.reportContent({
      reporterId: 'user-1',
      targetType: ContentReportTargetType.PRODUCT,
      targetId: 'product-1',
      reasonCode: ContentReportReasonCode.WRONG_OR_UNRELATED_IMAGE,
      note: 'Wrong item',
    });

    expect(report.duplicate).toBe(true);
    expect(prisma.contentReport.create).not.toHaveBeenCalled();
  });
  describe('createSubmission supersedes open submissions for the same target', () => {
    const buildTx = () => ({
      $queryRaw: jest.fn().mockResolvedValue([{ id: 'source' }]),
      contentSubmission: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        create: jest.fn().mockResolvedValue({ id: 'submission-2' }),
        // No open change request in these two cases, so change detection has
        // nothing to compare against and stays out of the way. The gate itself
        // is covered by content-change-detection.spec.ts.
        findFirst: jest.fn().mockResolvedValue(null),
      },
      product: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ name: 'P', description: 'd', gender: 'MALE' }),
      },
      collection: {
        findUnique: jest
          .fn()
          .mockResolvedValue({ title: 'D', description: 'd', type: 'MALE' }),
      },
      productMedia: { findMany: jest.fn().mockResolvedValue([]) },
      collectionMedia: { findMany: jest.fn().mockResolvedValue([]) },
      brandTrustEvent: {
        create: jest.fn().mockResolvedValue({ id: 'event-1' }),
      },
    });

    it('retires a CHANGES_REQUESTED row when the brand answers and resubmits', async () => {
      const { service } = createService();
      const tx = buildTx();

      await service.createSubmission(tx as any, {
        entityType: ContentEntityType.DESIGN,
        legacyCollectionId: 'design-1',
        brandId: 'brand-1',
        submittedById: 'owner-1',
        previousStatus: CollectionStatus.CHANGES_REQUESTED,
      });

      const where = tx.contentSubmission.updateMany.mock.calls[0][0].where;
      const data = tx.contentSubmission.updateMany.mock.calls[0][0].data;

      // The bug: this matched IN_REVIEW only, so the change request the brand
      // had just answered stayed open forever.
      expect(where.status.in).toEqual(
        expect.arrayContaining([
          ContentSubmissionStatus.IN_REVIEW,
          ContentSubmissionStatus.CHANGES_REQUESTED,
        ]),
      );
      expect(where.legacyCollectionId).toBe('design-1');
      expect(data.status).toBe(ContentSubmissionStatus.SUPERSEDED);
    });

    it('leaves terminal decisions alone', async () => {
      const { service } = createService();
      const tx = buildTx();

      await service.createSubmission(tx as any, {
        entityType: ContentEntityType.PRODUCT,
        productId: 'product-1',
        brandId: 'brand-1',
        submittedById: 'owner-1',
        previousStatus: CollectionStatus.DRAFT,
      });

      const statuses =
        tx.contentSubmission.updateMany.mock.calls[0][0].where.status.in;
      // APPROVED and REJECTED are the record of a decision that was made, not
      // open work — rewriting them would erase review history.
      expect(statuses).not.toContain(ContentSubmissionStatus.APPROVED);
      expect(statuses).not.toContain(ContentSubmissionStatus.REJECTED);
      expect(statuses).not.toContain(ContentSubmissionStatus.CANCELLED);
    });
  });
  it('loads a fifty-submission review queue with shared minimal reads and processed previews', async () => {
    const at = new Date('2026-10-21T12:00:00Z');
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: `submission-${index}`,
      entityType: 'PRODUCT',
      productId: `product-${index}`,
      brandId: `brand-${index}`,
      submittedById: `user-${index}`,
      reviewedById: null,
      status: 'IN_REVIEW',
      submittedAt: at,
    }));
    const products = rows.map((row) => ({
      id: row.productId,
      name: row.productId,
      brandId: row.brandId,
      publicationStatus: 'IN_REVIEW',
      isActive: true,
      createdAt: at,
      updatedAt: at,
      price: 100,
      salePrice: null,
    }));
    const media = rows.map((row, index) => ({
      id: `media-${index}`,
      productId: row.productId,
      fileUploadId: `file-${index}`,
      viewSlot: 'FRONT',
      orderIndex: 0,
      file: readyFile(`file-${index}`),
    }));
    const uploadService = {
      getBatchVariantDisplayUrls: jest.fn(
        async (_ids: string[], kind: string) =>
          new Map(
            media.map((item) => [
              item.fileUploadId,
              `https://processed.test/${kind}/${item.fileUploadId}`,
            ]),
          ),
      ),
      getPublicDisplayUrl: jest.fn(() => null),
      getTemporarySignedDisplayUrl: jest.fn(
        async () => 'https://signed.test/private-original',
      ),
    };
    const { prisma, service } = createService(
      {
        $queryRaw: jest.fn().mockResolvedValue(
          rows.map((row) => ({
            id: row.brandId,
            name: row.brandId,
            trustTier: null,
            reviewMode: null,
          })),
        ),
        product: {
          findMany: jest.fn().mockResolvedValue(products),
          findUnique: jest.fn(),
        },
        productMedia: { findMany: jest.fn().mockResolvedValue(media) },
        contentSubmission: {
          findMany: jest.fn().mockResolvedValue(rows),
          count: jest.fn().mockResolvedValue(50),
        },
        user: {
          findMany: jest.fn().mockResolvedValue(
            rows.map((row) => ({
              id: row.submittedById,
              username: row.submittedById,
            })),
          ),
          findUnique: jest.fn(),
        },
      },
      { uploadService },
    );
    const result = await service.listSubmissions({ take: 50 });
    expect(result.items).toHaveLength(50);
    expect(result.items[0].media[0].previewUrl).toBe(
      'https://processed.test/CARD/file-0',
    );
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(prisma.productMedia.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(uploadService.getBatchVariantDisplayUrls).toHaveBeenCalledTimes(2);
  });
  it('batches report identities and keeps deleted or domain-mismatched targets distinguishable', async () => {
    const reports = [
      {
        id: 'r1',
        targetType: 'PRODUCT',
        targetId: 'missing',
        reporterId: 'u1',
      },
      { id: 'r2', targetType: 'DESIGN', targetId: 'store', reporterId: 'u1' },
      {
        id: 'r3',
        targetType: 'COLLECTION',
        targetId: 'store',
        reporterId: 'u2',
      },
    ];
    const { prisma, service } = createService({
      contentReport: {
        findMany: jest.fn().mockResolvedValue(reports),
        count: jest.fn().mockResolvedValue(3),
      },
      product: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
      },
      collection: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'store',
            domain: 'STORE',
            title: 'Store',
            status: 'PUBLISHED',
            ownerId: 'owner',
          },
        ]),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'u1', username: 'Ada' },
          { id: 'u2', username: 'Nne' },
        ]),
        findUnique: jest.fn(),
      },
    });
    const result = await service.listReports({});
    expect(result.items.map((item) => item.target.title)).toEqual([
      'Deleted product',
      'Deleted design',
      'Store',
    ]);
    expect(result.items.map((item) => item.reporter?.username)).toEqual([
      'Ada',
      'Ada',
      'Nne',
    ]);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.collection.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.collection.findFirst).not.toHaveBeenCalled();
  });
});
