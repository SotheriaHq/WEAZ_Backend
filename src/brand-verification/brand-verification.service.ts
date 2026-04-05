import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  BrandVerificationStatus,
  NotificationType,
  VerificationAuthorityType,
  VerificationIdDocumentType,
  VerificationSignatureMethod,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { UploadService } from 'src/upload/upload.service';
import { FileType } from 'src/upload/upload.enums';
import { NotificationsService } from 'src/notifications/notifications.service';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import {
  FinalizeVerificationUploadDto,
  PresignVerificationUploadDto,
  RequestVerificationInfoDto,
  ResubmitVerificationInfoDto,
  ReviewBrandVerificationDto,
  SaveVerificationDraftDto,
  SignVerificationLetterDto,
  SubmitBrandVerificationDto,
  VerificationNoteDto,
} from './dto/verification.dto';
import { randomUUID } from 'crypto';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { getBrandVerificationTruth } from './verification-truth.util';

type RejectionReasonRecord = {
  code: string;
  label: string;
  category: string;
  customReason?: string;
};

const DEFAULT_REJECTION_REASONS = [
  { code: 'ID_BLURRY', label: 'ID document is blurry or unreadable', category: 'DOCUMENT_QUALITY', sortOrder: 1 },
  { code: 'ID_EXPIRED', label: 'ID document appears expired', category: 'IDENTITY', sortOrder: 2 },
  { code: 'ID_NAME_MISMATCH', label: 'Name on ID does not match submitted name', category: 'IDENTITY', sortOrder: 3 },
  { code: 'PHOTO_UNCLEAR', label: 'Owner photo does not meet requirements', category: 'DOCUMENT_QUALITY', sortOrder: 4 },
  { code: 'CAC_NUMBER_MISMATCH', label: 'CAC number does not match certificate', category: 'BUSINESS', sortOrder: 5 },
  { code: 'CAC_INVALID', label: 'CAC certificate is invalid or unverifiable', category: 'BUSINESS', sortOrder: 6 },
  { code: 'NIN_MISMATCH', label: 'NIN does not match other provided information', category: 'IDENTITY', sortOrder: 7 },
  { code: 'UNDERAGE', label: 'Applicant appears to be under 18 years old', category: 'IDENTITY', sortOrder: 8 },
  { code: 'CUSTOM', label: 'Other', category: 'OTHER', sortOrder: 99 },
];

const DEFAULT_LETTER_TEMPLATE = {
  version: 1,
  title: 'Threadly Seller Verification Agreement',
  body: `LETTER OF CONFIRMATION\n\nI confirm that the information and documents submitted for store verification are accurate and belong to me or to the business I am authorized to represent. I understand that Threadly may reject, suspend, or revoke verification if the submitted information is false, misleading, incomplete, or becomes stale. I consent to the processing of the submitted verification materials for trust, safety, fraud review, legal compliance, and audit purposes.`,
};

@Injectable()
export class BrandVerificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly uploadService: UploadService,
    private readonly notifications: NotificationsService,
    private readonly emailService: EmailService,
    private readonly configService: ConfigService,
  ) {}

  async presignUpload(ownerId: string, dto: PresignVerificationUploadDto) {
    const normalizedName = `${dto.documentType}-${dto.fileName}`;
    const presign = await this.uploadService.createPresignedPost(
      ownerId,
      normalizedName,
      FileType.BRAND_VERIFICATION,
      dto.contentType,
    );

    return {
      fileId: presign.fileId,
      expectedKey: presign.key,
      uploadUrl: presign.url,
      uploadFields: presign.fields ?? null,
      method: 'POST' as const,
      expiresIn: presign.expiresIn,
    };
  }

  async finalizeUpload(ownerId: string, dto: FinalizeVerificationUploadDto) {
    const file = await this.uploadService.createFileRecordFromPresign(
      dto.fileId,
      ownerId,
      dto.key,
      dto.actualMimeType,
      dto.actualSize,
    );

    return {
      fileId: file.id,
      s3Key: file.s3Key,
      s3Url: file.s3Url,
      mimeType: file.mimeType,
      size: file.size,
    };
  }

  async getStatus(ownerId: string) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const [latestAttempt, attemptHistory] = await Promise.all([
      this.prisma.brandVerificationAttempt.findFirst({
        where: { brandId: brand.id },
        orderBy: [{ attemptNumber: 'desc' }],
      }),
      this.prisma.brandVerificationAttempt.findMany({
        where: { brandId: brand.id },
        orderBy: [{ attemptNumber: 'desc' }],
        take: 5,
        select: {
          id: true,
          attemptNumber: true,
          status: true,
          submittedAt: true,
          reviewedAt: true,
          cancelledAt: true,
          rejectionReasons: true,
        },
      }),
    ]);
    const badgeState = this.getBadgeState(brand);

    return {
      brandId: brand.id,
      updatedAt: brand.updatedAt.toISOString(),
      verificationStatus: brand.verificationStatus,
      verificationSubmittedAt: brand.verificationSubmittedAt,
      verificationReviewedAt: brand.verificationReviewedAt,
      verificationReviewStartedAt: brand.verificationReviewStartedAt,
      verificationCancelledAt: brand.verificationCancelledAt,
      verificationAttemptNumber: brand.verificationAttemptNumber,
      verificationRejectionCount: brand.verificationRejectionCount,
      cooldownExpiresAt: brand.verificationCooldownExpiresAt,
      cooldownRemainingDays: this.getCooldownRemainingDays(brand.verificationCooldownExpiresAt),
      rejectionReasons: this.normalizeReasonList((brand.verificationRejectionReasons as RejectionReasonRecord[] | null) ?? []),
      infoRequestedAt: brand.verificationInfoRequestedAt,
      infoRequestedItems: (brand.verificationInfoRequestedItems as Record<string, unknown>[] | null) ?? [],
      infoRequestMessage: brand.verificationInfoRequestMessage ?? null,
      badgeState,
      canSubmit: this.canSubmit(brand),
      nudgeOptOut: brand.verificationNudgeOptOut,
      attemptHistory: attemptHistory.map((attempt) => ({
        ...attempt,
        rejectionReasons: this.normalizeReasonList((attempt.rejectionReasons as RejectionReasonRecord[] | null) ?? []),
      })),
      latestAttempt,
    };
  }

  async getDraft(ownerId: string) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    return {
      draftData: this.decryptDraft(brand.verificationDraftData),
      lastSavedAt: brand.verificationDraftUpdatedAt,
    };
  }

  async saveDraft(ownerId: string, dto: SaveVerificationDraftDto) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const payload = JSON.stringify({ ...dto.draftData, currentStep: dto.currentStep ?? null });
    if (Buffer.byteLength(payload, 'utf8') > 50_000) {
      throw new BadRequestException('Verification draft is too large');
    }

    await this.prisma.brand.update({
      where: { id: brand.id },
      data: {
        verificationDraftData: this.encryptDraft({
          ...dto.draftData,
          currentStep: dto.currentStep ?? null,
        }),
        verificationDraftUpdatedAt: new Date(),
      },
    });

    return { ok: true, lastSavedAt: new Date().toISOString() };
  }

  async getLetter(ownerId: string) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const template = await this.getLetterTemplate();
    return {
      version: template.version,
      title: template.title,
      body: template.body,
      brandName: brand.name,
      ownerName: brand.ownerName,
    };
  }

  async signLetter(ownerId: string, dto: SignVerificationLetterDto, req?: Request) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const template = await this.getLetterTemplate();
    if (dto.letterVersion !== template.version) {
      throw new BadRequestException('Letter version mismatch');
    }

    const signedAt = new Date();
    const signatureLabel =
      dto.signatureMethod === VerificationSignatureMethod.TYPED
        ? dto.typedSignatureText?.trim() || brand.ownerName
        : '[drawn signature captured]';
    const pdf = this.buildSimplePdf([
      template.title,
      '',
      `Brand: ${brand.name}`,
      `Owner: ${brand.ownerName}`,
      '',
      ...template.body.split('\n').slice(0, 18),
      '',
      `Signature method: ${dto.signatureMethod}`,
      `Signature: ${signatureLabel}`,
      `Signature image bytes: ${dto.signatureImage.length}`,
      `Signed at: ${signedAt.toISOString()}`,
      `IP: ${this.extractIp(req) ?? 'unknown'}`,
    ]);
    const hash = createHash('sha256').update(pdf).digest('hex');
    const upload = await this.uploadService.uploadBufferDirect(
      ownerId,
      `verification-letter-v${template.version}.pdf`,
      pdf,
      'application/pdf',
      FileType.BRAND_VERIFICATION,
    );

    await this.prisma.brand.update({
      where: { id: brand.id },
      data: {
        verificationLetterKey: upload.s3Key,
        verificationLetterHash: hash,
        verificationLetterVersion: template.version,
      },
    });

    return {
      letterKey: upload.s3Key,
      letterHash: hash,
      letterVersion: template.version,
      signedAt: signedAt.toISOString(),
    };
  }

  async submit(ownerId: string, dto: SubmitBrandVerificationDto) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    this.assertCanSubmit(brand);
    await this.validateVerificationDocuments(ownerId, dto);
    await this.ensureNinNotApprovedElsewhere(dto.ownerNin, brand.id);
    const resolvedOwnerPhoneNumber =
      String(dto.ownerPhoneNumber ?? '').trim() ||
      String(brand.owner.phoneNumber ?? '').trim();

    if (!resolvedOwnerPhoneNumber) {
      throw new BadRequestException('Owner phone number is required');
    }

    const attemptNumber = (brand.verificationAttemptNumber ?? 0) + 1;
    const now = new Date();
    const rejectionReasons: RejectionReasonRecord[] = [];
    const evidenceManifest = await this.buildEvidenceManifest(ownerId, [
      dto.ownerPhotoKey,
      dto.idDocumentFrontKey,
      dto.idDocumentBackKey,
      dto.cacCertificateKey,
      dto.authorityProofKey,
      dto.letterKey,
    ]);

    await this.prisma.$transaction(async (tx) => {
      await tx.brandVerificationAttempt.create({
        data: {
          id: randomUUID(),
          brandId: brand.id,
          attemptNumber,
          status: BrandVerificationStatus.PENDING,
          submittedAt: now,
          ownerLegalFirstName: dto.ownerLegalFirstName,
          ownerLegalLastName: dto.ownerLegalLastName,
          ownerDateOfBirth: new Date(dto.ownerDateOfBirth),
          ownerGender: dto.ownerGender,
          ownerPhoneNumber: resolvedOwnerPhoneNumber,
          ownerNin: dto.ownerNin,
          cacNumber: dto.cacNumber,
          businessAddress: dto.businessAddress as any,
          idDocumentType: dto.idDocumentType,
          idDocumentNumber: dto.idDocumentNumber,
          idDocumentExpiryDate: dto.idDocumentExpiryDate ? new Date(dto.idDocumentExpiryDate) : null,
          legalEntityType: dto.legalEntityType,
          authorityType: dto.authorityType,
          authorityProofKey: dto.authorityProofKey ?? null,
          authorityProofDescription: dto.authorityProofDescription ?? null,
          ownerPhotoKey: dto.ownerPhotoKey,
          idDocumentFrontKey: dto.idDocumentFrontKey,
          idDocumentBackKey: dto.idDocumentBackKey ?? null,
          cacCertificateKey: dto.cacCertificateKey,
          letterOfConfirmationKey: dto.letterKey,
          letterHash: brand.verificationLetterHash ?? null,
          letterVersion: brand.verificationLetterVersion ?? null,
          rejectionReasons: rejectionReasons as any,
          evidenceManifest: evidenceManifest as any,
        },
      });

      await tx.brand.update({
        where: { id: brand.id },
        data: {
          verificationStatus: BrandVerificationStatus.PENDING,
          verificationSubmittedAt: now,
          verificationReviewedAt: null,
          verificationReviewedById: null,
          verificationReviewStartedAt: null,
          verificationCancelledAt: null,
          verificationRejectionReason: null,
          verificationRejectionReasons: rejectionReasons as any,
          verificationAttemptNumber: attemptNumber,
          verificationInfoRequestedAt: null,
          verificationInfoRequestedItems: null,
          verificationInfoRequestMessage: null,
          verificationPhoto1Key: dto.ownerPhotoKey,
          verificationPhoto2Key: dto.idDocumentBackKey ?? dto.idDocumentFrontKey,
          verificationNinKey: dto.idDocumentFrontKey,
          verificationCacKey: dto.cacCertificateKey,
          verificationAddress: `${dto.businessAddress.street}, ${dto.businessAddress.city}, ${dto.businessAddress.state}, ${dto.businessAddress.country}`,
          verificationDraftData: null,
          verificationDraftUpdatedAt: null,
        },
      });
    });

    await this.notifications.create(ownerId, NotificationType.VERIFICATION_SUBMITTED, {
      payload: {
        brandId: brand.id,
        attemptNumber,
        submittedAt: now.toISOString(),
        targetUrl: '/studio/verification',
      },
    });

    const appName = this.emailService.getAppName();
    const mail = emailTemplates.verificationSubmittedEmail(brand.name, appName);
    void this.emailService.send(brand.email, mail.subject, mail.html, mail.text).catch(() => undefined);

    return {
      verificationStatus: BrandVerificationStatus.PENDING,
      submittedAt: now.toISOString(),
      attemptNumber,
      message: 'Verification submitted successfully. Review takes 2–5 business days.',
    };
  }

  async cancel(ownerId: string, expectedUpdatedAt?: string) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const isActiveVerification =
      brand.verificationStatus === BrandVerificationStatus.PENDING ||
      brand.verificationStatus === BrandVerificationStatus.IN_REVIEW ||
      brand.verificationStatus === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED;
    if (!isActiveVerification) {
      throw new BadRequestException('Verification request is not active');
    }

    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brand.id,
          verificationStatus: {
            in: [
              BrandVerificationStatus.PENDING,
              BrandVerificationStatus.IN_REVIEW,
              BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
            ],
          },
          ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}),
        },
        data: {
          verificationStatus: BrandVerificationStatus.CANCELLED,
          verificationCancelledAt: now,
          verificationCancellationCount: { increment: 1 },
          verificationReviewStartedAt: null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before cancellation could be completed');
      }

      await tx.brandVerificationAttempt.updateMany({
        where: { brandId: brand.id, attemptNumber: brand.verificationAttemptNumber },
        data: {
          status: BrandVerificationStatus.CANCELLED,
          cancelledAt: now,
        },
      });
    });

    await this.notifications.create(ownerId, NotificationType.VERIFICATION_CANCELLED, {
      payload: {
        brandId: brand.id,
        cancelledAt: now.toISOString(),
        targetUrl: '/studio/verification',
      },
    });

    if (brand.verificationReviewedById) {
      await this.notifications.create(brand.verificationReviewedById, NotificationType.VERIFICATION_CANCELLED_ADMIN, {
        actorId: ownerId,
        payload: {
          brandId: brand.id,
          brandName: brand.name,
          cancelledAt: now.toISOString(),
          targetUrl: `/admin/brands/${brand.id}/verification-review`,
        },
      });
    }

    return { verificationStatus: BrandVerificationStatus.CANCELLED, cancelledAt: now.toISOString() };
  }

  async resubmitInfo(ownerId: string, dto: ResubmitVerificationInfoDto) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    if (brand.verificationStatus !== BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED) {
      throw new BadRequestException('Verification is not awaiting additional information');
    }
    const latestAttempt = await this.getLatestAttemptOrThrow(brand.id);
    const now = new Date();
    const patch: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(dto)) {
      if (value !== undefined) {
        patch[key] = key.endsWith('DateOfBirth') || key.endsWith('ExpiryDate') ? new Date(String(value)) : value;
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.brandVerificationAttempt.update({
        where: { id: latestAttempt.id },
        data: {
          ...patch,
          status: BrandVerificationStatus.IN_REVIEW,
          reviewStartedAt: now,
          infoRequestedItems: null,
          infoRequestMessage: null,
        },
      });

      await tx.brand.update({
        where: { id: brand.id },
        data: {
          verificationStatus: BrandVerificationStatus.IN_REVIEW,
          verificationReviewStartedAt: now,
          verificationInfoRequestedAt: null,
          verificationInfoRequestedItems: null,
          verificationInfoRequestMessage: null,
        },
      });
    });

    if (brand.verificationReviewedById) {
      await this.notifications.create(brand.verificationReviewedById, NotificationType.VERIFICATION_INFO_RESUBMITTED, {
        actorId: ownerId,
        payload: {
          brandId: brand.id,
          brandName: brand.name,
          targetUrl: `/admin/brands/${brand.id}/verification-review`,
        },
      });
    }

    return {
      verificationStatus: BrandVerificationStatus.IN_REVIEW,
      message: 'Corrections submitted. Your application has been returned to the assigned reviewer.',
    };
  }

  async getQueue(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    status?: string;
  }) {
    const take = Math.min(params.limit ?? 30, 100);
    const statuses = params.status
      ? params.status.split(',').map((value) => value.trim() as BrandVerificationStatus)
      : [BrandVerificationStatus.PENDING, BrandVerificationStatus.IN_REVIEW, BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED];

    const items = await this.prisma.brand.findMany({
      where: {
        verificationStatus: { in: statuses },
        ...(params.search
          ? {
              OR: [
                { name: { contains: params.search, mode: 'insensitive' } },
                { owner: { email: { contains: params.search, mode: 'insensitive' } } },
                { owner: { firstName: { contains: params.search, mode: 'insensitive' } } },
                { owner: { lastName: { contains: params.search, mode: 'insensitive' } } },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        updatedAt: true,
        verificationSubmittedAt: true,
        verificationAttemptNumber: true,
        verificationReviewedById: true,
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            profileImage: true,
          },
        },
      },
      orderBy: { verificationSubmittedAt: 'asc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    return {
      items: results,
      nextCursor: hasMore ? results[results.length - 1]?.id : undefined,
      totalPending: await this.prisma.brand.count({ where: { verificationStatus: BrandVerificationStatus.PENDING } }),
    };
  }

  async getDetails(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            status: true,
            deactivatedAt: true,
          },
        },
        verificationAttempts: {
          orderBy: { attemptNumber: 'desc' },
          take: 5,
        },
        verificationNotes: {
          orderBy: { createdAt: 'desc' },
          take: 20,
        },
      },
    });

    if (!brand) throw new NotFoundException('Brand not found');
    const latestAttempt = brand.verificationAttempts[0] ?? null;
    const documents = latestAttempt
      ? await this.buildReviewerDocuments(latestAttempt)
      : [];
    return {
      ...brand,
      maskedOwnerNin: latestAttempt?.ownerNin ? this.maskValue(latestAttempt.ownerNin, 4) : null,
      documents,
      badgeState: this.getBadgeState(brand as any),
      latestAttempt,
    };
  }

  async claim(brandId: string, adminId: string, req: Request, expectedUpdatedAt?: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        verificationStatus: true,
        verificationAttemptNumber: true,
        updatedAt: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.verificationStatus !== BrandVerificationStatus.PENDING) {
      throw new ConflictException('Brand is not pending verification');
    }
    const now = new Date();

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brandId,
          verificationStatus: BrandVerificationStatus.PENDING,
          ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}),
        },
        data: {
          verificationStatus: BrandVerificationStatus.IN_REVIEW,
          verificationReviewedById: adminId,
          verificationReviewStartedAt: now,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before it could be claimed');
      }
      await tx.brandVerificationAttempt.updateMany({
        where: { brandId, attemptNumber: brand.verificationAttemptNumber },
        data: {
          status: BrandVerificationStatus.IN_REVIEW,
          reviewedById: adminId,
          reviewStartedAt: now,
        },
      });
      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_VERIFICATION_CLAIM',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          previousState: { verificationStatus: brand.verificationStatus },
          newState: { verificationStatus: BrandVerificationStatus.IN_REVIEW },
        },
      });
    });

    await this.notifications.create(brand.ownerId, NotificationType.VERIFICATION_IN_REVIEW, {
      actorId: adminId,
      payload: {
        brandId,
        reviewStartedAt: now.toISOString(),
        targetUrl: '/studio/verification',
      },
    });

    const owner = await this.prisma.user.findUnique({ where: { id: brand.ownerId }, select: { email: true } });
    if (owner?.email) {
      const appName = this.emailService.getAppName();
      const mail = emailTemplates.verificationInReviewEmail(brand.name, appName);
      void this.emailService.send(owner.email, mail.subject, mail.html, mail.text).catch(() => undefined);
    }

    return { verificationStatus: BrandVerificationStatus.IN_REVIEW, assignedTo: adminId, reviewStartedAt: now.toISOString() };
  }

  async release(brandId: string, adminId: string, req: Request, expectedUpdatedAt?: string) {
    const brand = await this.mustBeAssignedToAdmin(brandId, adminId, [BrandVerificationStatus.IN_REVIEW]);
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brandId,
          verificationStatus: BrandVerificationStatus.IN_REVIEW,
          verificationReviewedById: adminId,
          ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}),
        },
        data: {
          verificationStatus: BrandVerificationStatus.PENDING,
          verificationReviewedById: null,
          verificationReviewStartedAt: null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before it could be released');
      }
      await tx.brandVerificationAttempt.updateMany({
        where: { brandId, attemptNumber: brand.verificationAttemptNumber },
        data: {
          status: BrandVerificationStatus.PENDING,
          reviewedById: null,
          reviewStartedAt: null,
        },
      });
      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_VERIFICATION_RELEASE',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          previousState: { verificationStatus: brand.verificationStatus },
          newState: { verificationStatus: BrandVerificationStatus.PENDING },
        },
      });
    });
    return { verificationStatus: BrandVerificationStatus.PENDING };
  }

  async requestInfo(brandId: string, adminId: string, dto: RequestVerificationInfoDto, req: Request) {
    const brand = await this.mustBeAssignedToAdmin(brandId, adminId, [BrandVerificationStatus.IN_REVIEW]);
    if (!dto.items?.length) {
      throw new BadRequestException('At least one item is required');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brandId,
          verificationStatus: BrandVerificationStatus.IN_REVIEW,
          verificationReviewedById: adminId,
          ...(dto.expectedUpdatedAt ? { updatedAt: new Date(dto.expectedUpdatedAt) } : {}),
        },
        data: {
          verificationStatus: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
          verificationInfoRequestedAt: now,
          verificationInfoRequestedItems: dto.items as any,
          verificationInfoRequestMessage: dto.generalMessage ?? null,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before the info request was saved');
      }
      await tx.brandVerificationAttempt.updateMany({
        where: { brandId, attemptNumber: brand.verificationAttemptNumber },
        data: {
          status: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED,
          infoRequestedItems: dto.items as any,
          infoRequestMessage: dto.generalMessage ?? null,
        },
      });
      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_VERIFICATION_REQUEST_INFO',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          previousState: { verificationStatus: brand.verificationStatus },
          newState: { verificationStatus: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED, items: dto.items },
        },
      });
    });

    await this.notifications.create(brand.ownerId, NotificationType.VERIFICATION_INFO_REQUESTED, {
      actorId: adminId,
      payload: {
        brandId,
        items: dto.items,
        message: dto.generalMessage ?? null,
        targetUrl: '/studio/verification',
      },
    });

    const owner = await this.prisma.user.findUnique({ where: { id: brand.ownerId }, select: { email: true } });
    if (owner?.email) {
      const appName = this.emailService.getAppName();
      const mail = emailTemplates.verificationInfoRequestedEmail(
        brand.name,
        dto.items.map((item) => item.label),
        appName,
      );
      void this.emailService.send(owner.email, mail.subject, mail.html, mail.text).catch(() => undefined);
    }

    return { verificationStatus: BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED, requestedAt: now.toISOString() };
  }

  async review(brandId: string, adminId: string, dto: ReviewBrandVerificationDto, req: Request) {
    const brand = await this.mustBeAssignedToAdmin(brandId, adminId, [BrandVerificationStatus.IN_REVIEW]);
    const now = new Date();
    const decision = dto.decision;
    const latestAttempt = await this.getLatestAttemptOrThrow(brandId);
    const owner = await this.prisma.user.findUnique({ where: { id: brand.ownerId }, select: { email: true, status: true } });

    if (decision === 'APPROVED' && owner?.status !== 'ACTIVE') {
      throw new ForbiddenException('Cannot approve a non-active owner account');
    }
    if (decision === 'APPROVED' && latestAttempt.ownerNin) {
      await this.ensureNinNotApprovedElsewhere(latestAttempt.ownerNin, brandId);
    }
    if (decision === 'REJECTED' && !dto.rejectionReasons?.length) {
      throw new BadRequestException('At least one rejection reason is required');
    }

    const newStatus = decision === 'APPROVED' ? BrandVerificationStatus.APPROVED : BrandVerificationStatus.REJECTED;
    const rejectionReasons = this.normalizeReasonList(dto.rejectionReasons ?? []);
    const cooldownExpiresAt = decision === 'REJECTED'
      ? this.calculateCooldownExpiry((brand.verificationRejectionCount ?? 0) + 1, now)
      : null;

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brandId,
          verificationStatus: BrandVerificationStatus.IN_REVIEW,
          verificationReviewedById: adminId,
          ...(dto.expectedUpdatedAt ? { updatedAt: new Date(dto.expectedUpdatedAt) } : {}),
        },
        data: {
          verificationStatus: newStatus,
          verificationReviewedAt: now,
          verificationReviewStartedAt: brand.verificationReviewStartedAt ?? now,
          verificationRejectionReason: decision === 'REJECTED' ? rejectionReasons.map((reason) => reason.label).join('; ') : null,
          verificationRejectionReasons: decision === 'REJECTED' ? (rejectionReasons as any) : null,
          verificationRejectionCount: decision === 'REJECTED' ? { increment: 1 } : undefined,
          verificationCooldownExpiresAt: cooldownExpiresAt,
          verificationBrandNameAtApproval: decision === 'APPROVED' ? brand.name : brand.verificationBrandNameAtApproval,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before the review decision was saved');
      }

      await tx.brandVerificationAttempt.update({
        where: { id: latestAttempt.id },
        data: {
          status: newStatus,
          reviewedAt: now,
          reviewedById: adminId,
          rejectionReasons: decision === 'REJECTED' ? (rejectionReasons as any) : null,
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_BRAND_VERIFY',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          previousState: { verificationStatus: brand.verificationStatus },
          newState: {
            verificationStatus: newStatus,
            rejectionReasons,
            cooldownExpiresAt: cooldownExpiresAt?.toISOString() ?? null,
          },
        },
      });
    });

    const appName = this.emailService.getAppName();
    if (decision === 'APPROVED') {
      await this.notifications.create(brand.ownerId, NotificationType.VERIFICATION_APPROVED, {
        actorId: adminId,
        payload: {
          brandId,
          approvedAt: now.toISOString(),
          targetUrl: '/studio/verification',
        },
      });
      if (owner?.email) {
        const mail = emailTemplates.brandVerificationApprovedEmail(brand.name, appName);
        void this.emailService.send(owner.email, mail.subject, mail.html, mail.text).catch(() => undefined);
      }
    } else {
      await this.notifications.create(brand.ownerId, NotificationType.VERIFICATION_REJECTED, {
        actorId: adminId,
        payload: {
          brandId,
          rejectedAt: now.toISOString(),
          reasons: rejectionReasons,
          cooldownExpiresAt: cooldownExpiresAt?.toISOString() ?? null,
          targetUrl: '/studio/verification',
        },
      });
      if (owner?.email) {
        const mail = emailTemplates.brandVerificationRejectedEmail(
          brand.name,
          rejectionReasons.map((reason) => reason.label).join('; '),
          appName,
        );
        void this.emailService.send(owner.email, mail.subject, mail.html, mail.text).catch(() => undefined);
      }
    }

    return {
      verificationStatus: newStatus,
      reviewedAt: now.toISOString(),
      cooldownExpiresAt: cooldownExpiresAt?.toISOString() ?? null,
    };
  }

  async reassignToSelf(brandId: string, adminId: string, req: Request, expectedUpdatedAt?: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        verificationStatus: true,
        verificationReviewedById: true,
        verificationAttemptNumber: true,
        updatedAt: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    const reassignableStatus =
      brand.verificationStatus === BrandVerificationStatus.IN_REVIEW ||
      brand.verificationStatus === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED;
    if (!reassignableStatus) {
      throw new BadRequestException('Verification is not assigned for review');
    }

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.updateMany({
        where: {
          id: brandId,
          verificationStatus: { in: [BrandVerificationStatus.IN_REVIEW, BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED] },
          ...(expectedUpdatedAt ? { updatedAt: new Date(expectedUpdatedAt) } : {}),
        },
        data: { verificationReviewedById: adminId },
      });
      if (result.count !== 1) {
        throw new ConflictException('Verification state changed before reassignment could be completed');
      }
      await tx.brandVerificationAttempt.updateMany({
        where: { brandId, attemptNumber: brand.verificationAttemptNumber },
        data: { reviewedById: adminId },
      });
      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_VERIFICATION_REASSIGN',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          previousState: { verificationReviewedById: brand.verificationReviewedById },
          newState: { verificationReviewedById: adminId },
        },
      });
    });

    return { verificationStatus: brand.verificationStatus, assignedTo: adminId, reassignedAt: new Date().toISOString() };
  }

  async addNote(brandId: string, adminId: string, dto: VerificationNoteDto, req: Request) {
    const brand = await this.prisma.brand.findUnique({ where: { id: brandId }, select: { id: true } });
    if (!brand) throw new NotFoundException('Brand not found');

    const note = await this.prisma.$transaction(async (tx) => {
      const created = await tx.brandVerificationNote.create({
        data: {
          id: randomUUID(),
          brandId,
          adminId,
          text: dto.text.trim(),
        },
      });
      await (tx as any).adminAuditLog.create({
        data: {
          id: randomUUID(),
          actorUserId: adminId,
          action: 'ADMIN_VERIFICATION_NOTE_CREATE',
          targetType: 'Brand',
          targetId: brandId,
          ipAddress: this.extractIp(req),
          userAgent: req.headers['user-agent'] ?? null,
          metadata: { noteId: created.id },
        },
      });
      return created;
    });

    return note;
  }

  async getNotes(brandId: string) {
    return {
      notes: await this.prisma.brandVerificationNote.findMany({
        where: { brandId },
        orderBy: { createdAt: 'desc' },
      }),
    };
  }

  async getRejectionReasons() {
    const reasons = await this.prisma.verificationRejectionReason.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { label: 'asc' }],
    });
    if (reasons.length > 0) {
      return { reasons };
    }
    return { reasons: DEFAULT_REJECTION_REASONS };
  }

  async setNudgeOptOut(ownerId: string, nudgeOptOut: boolean) {
    const brand = await this.getBrandByOwnerOrThrow(ownerId);
    const updated = await this.prisma.brand.update({
      where: { id: brand.id },
      data: { verificationNudgeOptOut: nudgeOptOut },
      select: {
        verificationNudgeOptOut: true,
        updatedAt: true,
      },
    });

    return {
      nudgeOptOut: updated.verificationNudgeOptOut,
      updatedAt: updated.updatedAt.toISOString(),
    };
  }

  private async getBrandByOwnerOrThrow(ownerId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { ownerId },
      include: {
        owner: {
          select: {
            id: true,
            email: true,
            firstName: true,
            lastName: true,
            phoneNumber: true,
            status: true,
            deactivatedAt: true,
          },
        },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return {
      ...brand,
      email: brand.owner.email,
      ownerName: `${brand.owner.firstName ?? ''} ${brand.owner.lastName ?? ''}`.trim() || brand.name,
    };
  }

  private assertCanSubmit(brand: Awaited<ReturnType<BrandVerificationService['getBrandByOwnerOrThrow']>>) {
    if (brand.owner.status !== 'ACTIVE' || brand.owner.deactivatedAt) {
      throw new ForbiddenException('Owner account is not active');
    }
    const hasActiveVerification =
      brand.verificationStatus === BrandVerificationStatus.PENDING ||
      brand.verificationStatus === BrandVerificationStatus.IN_REVIEW ||
      brand.verificationStatus === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED;
    if (hasActiveVerification) {
      throw new ConflictException('You already have an active verification request');
    }
    if (brand.verificationCooldownExpiresAt && brand.verificationCooldownExpiresAt > new Date()) {
      throw new ForbiddenException('Verification cooldown is active');
    }
  }

  private canSubmit(brand: Awaited<ReturnType<BrandVerificationService['getBrandByOwnerOrThrow']>>) {
    try {
      this.assertCanSubmit(brand);
      return true;
    } catch {
      return false;
    }
  }

  private async validateVerificationDocuments(ownerId: string, dto: SubmitBrandVerificationDto) {
    const requiredKeys = [
      dto.ownerPhotoKey,
      dto.idDocumentFrontKey,
      dto.cacCertificateKey,
      dto.letterKey,
      dto.authorityType === VerificationAuthorityType.AUTHORIZED_REPRESENTATIVE ? dto.authorityProofKey : undefined,
      this.requiresBackImage(dto.idDocumentType) ? dto.idDocumentBackKey : undefined,
    ];
    await this.buildEvidenceManifest(ownerId, requiredKeys);
  }

  private async buildEvidenceManifest(ownerId: string, keys: Array<string | undefined>) {
    const filteredKeys = keys.filter((value): value is string => Boolean(value));
    const rows = await Promise.all(
      filteredKeys.map((key) => this.getOwnedVerificationFile(ownerId, key)),
    );

    return rows.map((row) => ({
      fileId: row.id,
      s3Key: row.s3Key,
      mimeType: row.mimeType,
      size: row.size,
      sha256: row.sha256 ?? null,
      uploadedAt: row.createdAt,
      fileType: row.fileType,
    }));
  }

  private async getOwnedVerificationFile(ownerId: string, s3Key: string) {
    const file = await this.prisma.fileUpload.findFirst({
      where: {
        userId: ownerId,
        s3Key,
        fileType: FileType.BRAND_VERIFICATION as any,
      },
    });
    if (!file) {
      throw new BadRequestException(`Verification file does not belong to this brand owner: ${s3Key}`);
    }
    return file;
  }

  private async getLatestAttemptOrThrow(brandId: string) {
    const attempt = await this.prisma.brandVerificationAttempt.findFirst({
      where: { brandId },
      orderBy: [{ attemptNumber: 'desc' }],
    });
    if (!attempt) throw new NotFoundException('Verification attempt not found');
    return attempt;
  }

  private async ensureNinNotApprovedElsewhere(ownerNin: string, brandId: string) {
    const conflict = await this.prisma.brandVerificationAttempt.findFirst({
      where: {
        ownerNin,
        status: BrandVerificationStatus.APPROVED,
        brandId: { not: brandId },
      },
      select: {
        id: true,
        brandId: true,
      },
    });

    if (conflict) {
      throw new ConflictException('This NIN is already associated with a verified brand');
    }
  }

  private async buildReviewerDocuments(
    attempt: Awaited<ReturnType<BrandVerificationService['getLatestAttemptOrThrow']>>,
  ) {
    const docConfig = [
      { key: 'ownerPhotoKey', label: 'Owner photo', s3Key: attempt.ownerPhotoKey },
      { key: 'idDocumentFrontKey', label: 'ID front', s3Key: attempt.idDocumentFrontKey },
      { key: 'idDocumentBackKey', label: 'ID back', s3Key: attempt.idDocumentBackKey },
      { key: 'cacCertificateKey', label: 'CAC certificate', s3Key: attempt.cacCertificateKey },
      { key: 'authorityProofKey', label: 'Authority proof', s3Key: attempt.authorityProofKey },
      { key: 'letterOfConfirmationKey', label: 'Signed verification letter', s3Key: attempt.letterOfConfirmationKey },
    ].filter((item) => Boolean(item.s3Key));

    const files = await this.prisma.fileUpload.findMany({
      where: {
        s3Key: { in: docConfig.map((item) => item.s3Key!) },
      },
      select: {
        s3Key: true,
        mimeType: true,
        size: true,
      },
    });
    const fileMap = new Map(files.map((file) => [file.s3Key, file]));

    return Promise.all(
      docConfig.map(async (item) => {
        const meta = fileMap.get(item.s3Key!);
        const signedUrl = item.s3Key
          ? await this.uploadService.getPublicSignedUrlByKey(item.s3Key)
          : null;

        return {
          key: item.key,
          label: item.label,
          s3Key: item.s3Key,
          signedUrl,
          mimeType: meta?.mimeType ?? null,
          size: meta?.size ?? null,
        };
      }),
    );
  }

  private getBadgeState(
    brand:
      | Awaited<ReturnType<BrandVerificationService['getBrandByOwnerOrThrow']>>
      | {
          verificationStatus?: BrandVerificationStatus | null;
          isStoreOpen?: boolean | null;
          owner?: { status?: string | null; deactivatedAt?: Date | null };
        },
  ) {
    return getBrandVerificationTruth({
      verificationStatus: brand.verificationStatus,
      isStoreOpen: 'isStoreOpen' in brand ? brand.isStoreOpen : undefined,
      ownerStatus: brand.owner?.status ?? null,
      ownerDeactivatedAt: brand.owner?.deactivatedAt ?? null,
    });
  }

  private async mustBeAssignedToAdmin(
    brandId: string,
    adminId: string,
    allowedStatuses: BrandVerificationStatus[],
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        verificationStatus: true,
        verificationReviewedById: true,
        verificationReviewStartedAt: true,
        verificationAttemptNumber: true,
        verificationRejectionCount: true,
        verificationBrandNameAtApproval: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    if (!allowedStatuses.includes(brand.verificationStatus)) {
      throw new BadRequestException('Verification is not in a reviewable state');
    }
    if (brand.verificationReviewedById && brand.verificationReviewedById !== adminId) {
      throw new ForbiddenException('Verification is assigned to another reviewer');
    }
    return brand;
  }

  private normalizeReasonList(reasons: Array<RejectionReasonRecord | { code: string; label: string; customReason?: string }>) {
    return reasons.map((reason) => ({
      code: reason.code,
      label: reason.customReason?.trim() ? `${reason.label}: ${reason.customReason.trim()}` : reason.label,
      category: 'category' in reason ? reason.category : 'OTHER',
      customReason: reason.customReason?.trim() || undefined,
    }));
  }

  private calculateCooldownExpiry(rejectionCount: number, from: Date) {
    const days = rejectionCount <= 1 ? 14 : rejectionCount === 2 ? 30 : rejectionCount === 3 ? 60 : 90;
    return new Date(from.getTime() + days * 24 * 60 * 60 * 1000);
  }

  private getCooldownRemainingDays(expiresAt?: Date | null) {
    if (!expiresAt) return 0;
    const diff = expiresAt.getTime() - Date.now();
    if (diff <= 0) return 0;
    return Math.ceil(diff / (24 * 60 * 60 * 1000));
  }

  private requiresBackImage(documentType: VerificationIdDocumentType) {
    return (
      documentType === VerificationIdDocumentType.NIN_SLIP ||
      documentType === VerificationIdDocumentType.VOTERS_CARD ||
      documentType === VerificationIdDocumentType.DRIVERS_LICENSE ||
      documentType === VerificationIdDocumentType.NATIONAL_ID
    );
  }

  private extractIp(req?: Request) {
    return req?.ip || req?.socket?.remoteAddress || null;
  }

  private maskValue(value: string, visibleTail = 4) {
    if (!value) return value;
    const tail = value.slice(-visibleTail);
    return `${'*'.repeat(Math.max(0, value.length - visibleTail))}${tail}`;
  }

  private getDraftKey() {
    const secret = this.configService.get<string>('VERIFICATION_DRAFT_SECRET') || 'threadly-verification-draft-secret';
    return createHash('sha256').update(secret).digest();
  }

  private encryptDraft(value: Record<string, unknown>) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.getDraftKey(), iv);
    const plaintext = Buffer.from(JSON.stringify(value), 'utf8');
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${encrypted.toString('base64')}`;
  }

  private decryptDraft(value?: string | null) {
    if (!value) return null;
    try {
      const [ivText, tagText, encryptedText] = value.split('.');
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.getDraftKey(),
        Buffer.from(ivText, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(tagText, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(encryptedText, 'base64')),
        decipher.final(),
      ]);
      return JSON.parse(decrypted.toString('utf8'));
    } catch {
      return null;
    }
  }

  private async getLetterTemplate() {
    const template = await this.prisma.verificationLetterTemplate.findFirst({
      where: { isActive: true },
      orderBy: { version: 'desc' },
    });
    return template ?? DEFAULT_LETTER_TEMPLATE;
  }

  private escapePdfText(value: string) {
    return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  private buildSimplePdf(lines: string[]) {
    const contentLines = ['BT', '/F1 11 Tf', '50 760 Td'];
    for (const line of lines.slice(0, 40)) {
      contentLines.push(`(${this.escapePdfText(line)}) Tj`);
      contentLines.push('0 -16 Td');
    }
    contentLines.push('ET');
    const stream = contentLines.join('\n');
    const objects = [
      '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
      '2 0 obj << /Type /Pages /Count 1 /Kids [3 0 R] >> endobj',
      '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj',
      `4 0 obj << /Length ${Buffer.byteLength(stream, 'utf8')} >> stream\n${stream}\nendstream endobj`,
      '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj',
    ];
    let offset = 0;
    const bodyParts = ['%PDF-1.4\n'];
    const offsets = [0];
    for (const object of objects) {
      offsets.push(offset + Buffer.byteLength(bodyParts.join(''), 'utf8'));
      bodyParts.push(`${object}\n`);
    }
    const body = bodyParts.join('');
    offset = Buffer.byteLength(body, 'utf8');
    const xref = ['xref', `0 ${objects.length + 1}`, '0000000000 65535 f '];
    for (let index = 1; index < offsets.length; index += 1) {
      xref.push(`${String(offsets[index]).padStart(10, '0')} 00000 n `);
    }
    const trailer = `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
    return Buffer.from(`${body}${xref.join('\n')}\n${trailer}`, 'utf8');
  }
}
