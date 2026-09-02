import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AdminAuditAction,
  AdminDisputeStatus,
  BrandVerificationStatus,
  CollectionDomain,
  CollectionStatus,
  NotificationType,
  PaymentStatus,
  UserType,
} from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { EmailService } from 'src/email/email.service';
import * as emailTemplates from 'src/email/email.templates';
import {
  adminUserDisplaySelect,
  mapAdminUserDisplay,
} from '../admin-user-display.helper';

/** Rows returned per overview section. Keeps the admin modal payload bounded. */
const ADMIN_BRAND_OVERVIEW_SLICE = 25;

/**
 * Dispute lookup is a reverse scan over the brand's order ids because `Dispute`
 * stores an untyped (targetType, targetId) pointer with no brand relation. The
 * cap keeps the `IN (...)` list from growing without bound on busy brands.
 */
const ADMIN_BRAND_DISPUTE_SCAN_LIMIT = 2000;

/**
 * Nudges the platform sends a BRAND about an order it needs to move forward.
 * Buyer-side reminders (e.g. CUSTOM_ORDER_ACCEPTANCE_WINDOW_REMINDER) are
 * deliberately excluded — they are never delivered to the brand owner.
 */
const BRAND_ORDER_REMINDER_TYPES: NotificationType[] = [
  NotificationType.ORDER_FULFILLMENT_REMINDER,
  NotificationType.ORDER_FULFILLMENT_OVERDUE,
  NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
  NotificationType.CUSTOM_ORDER_STALE_STAGE_WARNING,
  NotificationType.CUSTOM_ORDER_ACCEPTANCE_SLA_RISK,
  NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
];

const OPEN_DISPUTE_STATUSES: AdminDisputeStatus[] = [
  AdminDisputeStatus.OPEN,
  AdminDisputeStatus.ASSIGNED,
  AdminDisputeStatus.IN_PROGRESS,
  AdminDisputeStatus.REOPENED,
];

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
        // `isStoreOpen` alone cannot tell an admin whether OPENING a store is a
        // sensible action. A brand that never finished setup (no bank details,
        // no policy, never published) has `storePublishedAt = null`, and forcing
        // its store open would publish an empty storefront that fails every
        // downstream gate. The list needs the same signal `/store/status`
        // already gives the owner.
        storePublishedAt: true,
        description: true,
        logo: true,
        createdAt: true,
        updatedAt: true,
        // The brand directory had no verification signal at all, so an admin
        // scanning the list could not tell a verified brand from an unverified
        // one without opening each row.
        verificationStatus: true,
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

  /**
   * One read for everything the admin brand-manage surface shows: storefront
   * reachability, verification reviewability, content counts, money movement,
   * the order reminders the platform sent this brand, and its disputes.
   *
   * It exists as a single endpoint on purpose — the modal previously had to
   * guess (e.g. it always offered "Open verification review", even for brands
   * that never submitted anything) because no payload told it the truth.
   */
  async getOverview(brandId: string) {
    const brand = await this.prisma.brand.findUnique({
      where: { id: brandId },
      select: {
        id: true,
        name: true,
        ownerId: true,
        currency: true,
        isStoreOpen: true,
        storePublishedAt: true,
        createdAt: true,
        verificationStatus: true,
        verificationSubmittedAt: true,
        verificationReviewedAt: true,
        verificationAttemptNumber: true,
        owner: { select: { id: true, username: true, type: true, status: true } },
      },
    });
    if (!brand) throw new NotFoundException('Brand not found');

    const ownerId = brand.ownerId;
    const status = brand.verificationStatus;
    // A review can only be OPENED while a submission is awaiting a decision.
    const isReviewOpen =
      status === BrandVerificationStatus.PENDING ||
      status === BrandVerificationStatus.IN_REVIEW ||
      status === BrandVerificationStatus.ADDITIONAL_INFO_REQUESTED;
    // Anything other than NOT_SUBMITTED means a record exists to look at.
    const hasSubmission = status !== BrandVerificationStatus.NOT_SUBMITTED;

    const collectionBase = { ownerId, deletedAt: null } as const;
    const productBase = { brandId, deletedAt: null } as const;

    const [
      designs,
      designsPublished,
      storeCollections,
      products,
      productsLive,
      productsInReview,
      productsDraft,
      posts,
    ] = await Promise.all([
      this.prisma.collection.count({
        where: { ...collectionBase, domain: CollectionDomain.DESIGN },
      }),
      this.prisma.collection.count({
        where: {
          ...collectionBase,
          domain: CollectionDomain.DESIGN,
          status: CollectionStatus.PUBLISHED,
        },
      }),
      this.prisma.collection.count({
        where: { ...collectionBase, domain: CollectionDomain.STORE },
      }),
      this.prisma.product.count({ where: productBase }),
      this.prisma.product.count({
        where: {
          ...productBase,
          isActive: true,
          archivedAt: null,
          publicationStatus: CollectionStatus.PUBLISHED,
        },
      }),
      this.prisma.product.count({
        where: { ...productBase, publicationStatus: CollectionStatus.IN_REVIEW },
      }),
      this.prisma.product.count({
        where: { ...productBase, publicationStatus: CollectionStatus.DRAFT },
      }),
      this.prisma.post.count({ where: { userId: ownerId } }),
    ]);

    const [paidOrders, paidCustomOrders, payouts, reminderRows] =
      await Promise.all([
        this.prisma.order.findMany({
          where: { brandId, paymentStatus: PaymentStatus.PAID },
          select: {
            id: true,
            totalAmount: true,
            currency: true,
            status: true,
            paymentStatus: true,
            paymentReference: true,
            customerName: true,
            paidAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: ADMIN_BRAND_OVERVIEW_SLICE,
        }),
        this.prisma.customOrder.findMany({
          where: { brandId, paymentStatus: PaymentStatus.PAID },
          select: {
            id: true,
            buyerPriceSummaryJson: true,
            currency: true,
            status: true,
            paymentStatus: true,
            paymentReference: true,
            sourceTitleSnapshot: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: ADMIN_BRAND_OVERVIEW_SLICE,
        }),
        this.prisma.payout.findMany({
          where: { brandId },
          select: {
            id: true,
            amount: true,
            currency: true,
            status: true,
            reference: true,
            paidAt: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: ADMIN_BRAND_OVERVIEW_SLICE,
        }),
        this.prisma.notification.findMany({
          where: {
            recipientId: ownerId,
            type: { in: BRAND_ORDER_REMINDER_TYPES },
          },
          select: {
            id: true,
            type: true,
            payload: true,
            isRead: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
          take: ADMIN_BRAND_OVERVIEW_SLICE,
        }),
      ]);

    // Disputes carry a loose (targetType, targetId) pointer with no brand
    // relation, so the brand's order ids are the only way back to them.
    const [orderIdRows, customOrderIdRows] = await Promise.all([
      this.prisma.order.findMany({
        where: { brandId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: ADMIN_BRAND_DISPUTE_SCAN_LIMIT,
      }),
      this.prisma.customOrder.findMany({
        where: { brandId },
        select: { id: true },
        orderBy: { createdAt: 'desc' },
        take: ADMIN_BRAND_DISPUTE_SCAN_LIMIT,
      }),
    ]);
    const orderIds = orderIdRows.map((row) => row.id);
    const customOrderIds = customOrderIdRows.map((row) => row.id);

    const disputeRows =
      orderIds.length === 0 && customOrderIds.length === 0
        ? []
        : await this.prisma.dispute.findMany({
            where: {
              OR: [
                ...(orderIds.length
                  ? [{ targetType: 'ORDER', targetId: { in: orderIds } }]
                  : []),
                ...(customOrderIds.length
                  ? [
                      {
                        targetType: 'CUSTOM_ORDER',
                        targetId: { in: customOrderIds },
                      },
                    ]
                  : []),
              ],
            },
            select: {
              id: true,
              type: true,
              status: true,
              description: true,
              targetType: true,
              targetId: true,
              resolution: true,
              resolvedAt: true,
              createdAt: true,
            },
            orderBy: { createdAt: 'desc' },
            take: ADMIN_BRAND_OVERVIEW_SLICE,
          });

    const toNumber = (value: unknown): number => {
      const parsed = Number(value ?? 0);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    const transactions = [
      ...paidOrders.map((order) => ({
        id: `order:${order.id}`,
        kind: 'ORDER' as const,
        direction: 'IN' as const,
        title: order.customerName || 'Store order',
        reference: order.paymentReference ?? null,
        amount: toNumber(order.totalAmount),
        currency: order.currency,
        status: order.status,
        occurredAt: (order.paidAt ?? order.createdAt).toISOString(),
        orderId: order.id,
        customOrderId: null,
        payoutId: null,
      })),
      ...paidCustomOrders.map((order) => {
        const summary =
          order.buyerPriceSummaryJson &&
          typeof order.buyerPriceSummaryJson === 'object' &&
          !Array.isArray(order.buyerPriceSummaryJson)
            ? (order.buyerPriceSummaryJson as Record<string, unknown>)
            : {};
        return {
          id: `custom:${order.id}`,
          kind: 'CUSTOM_ORDER' as const,
          direction: 'IN' as const,
          title: order.sourceTitleSnapshot || 'Custom order',
          reference: order.paymentReference ?? null,
          // Custom orders keep the grand total inside the buyer price summary;
          // there is no scalar total column to sum.
          amount: toNumber(summary.grandTotal),
          currency: order.currency,
          status: order.status,
          occurredAt: order.createdAt.toISOString(),
          orderId: null,
          customOrderId: order.id,
          payoutId: null,
        };
      }),
      ...payouts.map((payout) => ({
        id: `payout:${payout.id}`,
        kind: 'PAYOUT' as const,
        direction: 'OUT' as const,
        title: 'Payout to brand',
        reference: payout.reference ?? null,
        amount: toNumber(payout.amount),
        currency: payout.currency,
        status: payout.status,
        occurredAt: (payout.paidAt ?? payout.createdAt).toISOString(),
        orderId: null,
        customOrderId: null,
        payoutId: payout.id,
      })),
    ].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

    const grossInflow = transactions
      .filter((item) => item.direction === 'IN')
      .reduce((sum, item) => sum + item.amount, 0);
    const paidOut = transactions
      .filter((item) => item.kind === 'PAYOUT' && item.status === 'PAID')
      .reduce((sum, item) => sum + item.amount, 0);

    const reminders = reminderRows.map((row) => {
      const payload =
        row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
          ? (row.payload as Record<string, unknown>)
          : {};
      const orderId =
        typeof payload.orderId === 'string' ? payload.orderId : null;
      const customOrderId =
        typeof payload.customOrderId === 'string' ? payload.customOrderId : null;
      return {
        id: row.id,
        type: row.type,
        isRead: row.isRead,
        createdAt: row.createdAt.toISOString(),
        orderId,
        customOrderId,
        detail:
          typeof payload.tier === 'string'
            ? payload.tier
            : typeof payload.reason === 'string'
              ? payload.reason
              : null,
      };
    });

    return {
      brand: {
        id: brand.id,
        name: brand.name,
        ownerId,
        currency: brand.currency,
        isStoreOpen: brand.isStoreOpen,
        storePublishedAt: brand.storePublishedAt,
        createdAt: brand.createdAt,
        // The public storefront resolves by the owner's username and 404s while
        // the store is closed — mirror that so the client can't offer a dead link.
        storefrontSlug:
          brand.isStoreOpen &&
          brand.owner?.type === UserType.BRAND &&
          brand.owner?.username
            ? brand.owner.username
            : null,
      },
      verification: {
        status,
        isReviewOpen,
        hasSubmission,
        submittedAt: brand.verificationSubmittedAt,
        reviewedAt: brand.verificationReviewedAt,
        attemptNumber: brand.verificationAttemptNumber,
      },
      content: {
        designs,
        designsPublished,
        storeCollections,
        products,
        productsLive,
        productsInReview,
        productsDraft,
        posts,
      },
      transactions: {
        currency: brand.currency,
        grossInflow,
        paidOut,
        items: transactions.slice(0, ADMIN_BRAND_OVERVIEW_SLICE),
      },
      reminders,
      disputes: disputeRows.map((row) => ({
        id: row.id,
        type: row.type,
        status: row.status,
        description: row.description,
        targetType: row.targetType,
        targetId: row.targetId,
        resolution: row.resolution,
        resolvedAt: row.resolvedAt,
        createdAt: row.createdAt.toISOString(),
        isOpen: OPEN_DISPUTE_STATUSES.includes(row.status),
      })),
    };
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
