import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import { AdminAuditAction, BrandVerificationStatus } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

@Injectable()
export class AdminBrandsService {
  private readonly logger = new Logger(AdminBrandsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
  ) {}

  async list(params: {
    cursor?: string;
    limit?: number;
    search?: string;
    isStoreOpen?: boolean;
  }) {
    const take = Math.min(params.limit ?? 50, 100);
    const where: Record<string, unknown> = {};

    if (params.search) {
      where.name = { contains: params.search, mode: 'insensitive' };
    }
    if (params.isStoreOpen !== undefined) {
      where.isStoreOpen = params.isStoreOpen;
    }

    const items = await this.prisma.brand.findMany({
      where,
      select: {
        id: true,
        name: true,
        ownerId: true,
        isStoreOpen: true,
        description: true,
        logo: true,
        createdAt: true,
        updatedAt: true,
        owner: {
          select: adminUserDisplaySelect,
        },
      },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return {
      items: results.map((item) => ({
        ...item,
        owner: mapAdminUserDisplay(item.owner),
      })),
      nextCursor,
    };
  }

  async getById(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      include: {
        owner: {
          select: adminUserDisplaySelect,
        },
        policy: true,
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return { ...brand, owner: mapAdminUserDisplay(brand.owner) };
  }

  async overrideStoreOpen(
    brandId: string,
    isStoreOpen: boolean,
    actorId: string,
    req: Request,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isStoreOpen: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.update({
        where: { id: brandId },
        data: { isStoreOpen },
        select: { id: true, name: true, isStoreOpen: true },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_BRAND_STORE_OVERRIDE,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { isStoreOpen: brand.isStoreOpen },
          newState: { isStoreOpen },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async suspendBrand(
    brandId: string,
    reason: string | undefined,
    actorId: string,
    req: Request,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: { id: true, isStoreOpen: true, ownerId: true },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      // Force close the store
      const result = await tx.brand.update({
        where: { id: brandId },
        data: { isStoreOpen: false },
        select: { id: true, name: true, isStoreOpen: true },
      });

      // Suspend the brand owner's account
      await tx.user.update({
        where: { id: brand.ownerId },
        data: {
          status: 'SUSPENDED',
          adminSuspendedAt: new Date(),
          adminSuspendedReason: reason ?? 'Brand suspended by admin',
        },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_BRAND_SUSPEND,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { isStoreOpen: brand.isStoreOpen },
          newState: { isStoreOpen: false, suspended: true, reason },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    return updated;
  }

  async getVerificationQueue(params: { cursor?: string; limit?: number }) {
    const take = Math.min(params.limit ?? 30, 100);

    const items = await this.prisma.brand.findMany({
      where: { verificationStatus: BrandVerificationStatus.PENDING },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        verificationSubmittedAt: true,
        verificationAddress: true,
        verificationClientEstimate: true,
        createdAt: true,
        owner: {
          select: adminUserDisplaySelect,
        },
      },
      orderBy: { verificationSubmittedAt: 'asc' },
      take: take + 1,
      ...(params.cursor ? { cursor: { id: params.cursor }, skip: 1 } : {}),
    });

    const hasMore = items.length > take;
    const results = hasMore ? items.slice(0, take) : items;
    const nextCursor = hasMore ? results[results.length - 1]?.id : undefined;

    return {
      items: results.map((item) => ({
        ...item,
        owner: mapAdminUserDisplay(item.owner),
      })),
      nextCursor,
    };
  }

  async getVerificationDetails(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        verificationSubmittedAt: true,
        verificationReviewedAt: true,
        verificationReviewedById: true,
        verificationRejectionReason: true,
        verificationPhoto1Key: true,
        verificationPhoto2Key: true,
        verificationNinKey: true,
        verificationCacKey: true,
        verificationAddress: true,
        verificationClientEstimate: true,
        createdAt: true,
        owner: {
          select: adminUserDisplaySelect,
        },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');
    return { ...brand, owner: mapAdminUserDisplay(brand.owner) };
  }

  async reviewVerification(
    brandId: string,
    dto: { decision: 'APPROVED' | 'REJECTED'; rejectionReason?: string },
    actorId: string,
    req: Request,
  ) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        verificationStatus: true,
        ownerId: true,
        owner: { select: { email: true } },
      },
    });

    if (!brand) throw new NotFoundException('Brand not found');
    if (brand.verificationStatus !== BrandVerificationStatus.PENDING) {
      throw new BadRequestException('Brand is not pending verification');
    }

    if (dto.decision === 'REJECTED' && !dto.rejectionReason?.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const newStatus =
      dto.decision === 'APPROVED'
        ? BrandVerificationStatus.APPROVED
        : BrandVerificationStatus.REJECTED;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.brand.update({
        where: { id: brandId },
        data: {
          verificationStatus: newStatus,
          verificationReviewedAt: new Date(),
          verificationReviewedById: actorId,
          verificationRejectionReason:
            dto.decision === 'REJECTED' ? dto.rejectionReason!.trim() : null,
        },
        select: { id: true, name: true, verificationStatus: true },
      });

      await (tx as any).adminAuditLog.create({
        data: {
          id: uuidv4(),
          actorUserId: actorId,
          action: AdminAuditAction.ADMIN_BRAND_VERIFY,
          targetType: 'Brand',
          targetId: brandId,
          previousState: { verificationStatus: brand.verificationStatus },
          newState: {
            verificationStatus: newStatus,
            rejectionReason: dto.rejectionReason ?? null,
          },
          ipAddress: req.socket?.remoteAddress ?? null,
          userAgent: req.headers['user-agent'] ?? null,
        },
      });

      return result;
    });

    // Send email notification
    const appName = this.emailService.getAppName();
    if (brand.owner?.email) {
      if (dto.decision === 'APPROVED') {
        const mail = emailTemplates.brandVerificationApprovedEmail(
          brand.name,
          appName,
        );
        void this.emailService
          .send(brand.owner.email, mail.subject, mail.html, mail.text)
          .catch(() => undefined);
      } else {
        const mail = emailTemplates.brandVerificationRejectedEmail(
          brand.name,
          dto.rejectionReason!,
          appName,
        );
        void this.emailService
          .send(brand.owner.email, mail.subject, mail.html, mail.text)
          .catch(() => undefined);
      }
    }

    return updated;
  }
}
