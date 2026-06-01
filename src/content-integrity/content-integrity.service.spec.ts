import { BadRequestException } from '@nestjs/common';
import {
  BrandContentReviewMode,
  BrandTrustTier,
  BrandVerificationStatus,
  ContentMediaViewSlot,
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
      },
      collection: {
        count: jest.fn(),
      },
      contentSubmission: {
        findUnique: jest.fn(),
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
});
