import { BadRequestException } from '@nestjs/common';
import {
  BrandContentReviewMode,
  BrandTrustTier,
  BrandVerificationStatus,
  CollectionStatus,
  ContentReportReasonCode,
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

  function createService(prismaOverrides: Record<string, any> = {}) {
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
    return { prisma, service: new ContentIntegrityService(prisma) };
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
    expect(gate.reviewMode).toBe(
      BrandContentReviewMode.PRE_REVIEW_REQUIRED,
    );
    expect(gate.requiresPreReview).toBe(true);
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
});
