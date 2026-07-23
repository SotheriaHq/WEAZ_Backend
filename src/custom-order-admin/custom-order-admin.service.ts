import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  CustomOrderActorType,
  CustomOrderDisputeStatus,
  CustomOrderLedgerAllocationStatus,
  CustomFabricRuleBasisStatus,
  CustomOrderRetentionHoldType,
  CustomOrderStatus,
  NotificationType,
  PaymentStatus,
  Prisma,
} from '@prisma/client';
import { CustomOrderRefundService } from 'src/custom-orders/custom-order-refund.service';
import { CustomOrderSideEffectsService } from 'src/custom-orders/custom-order-side-effects.service';
import { CustomOrdersService } from 'src/custom-orders/custom-orders.service';
import {
  adminAttentionActiveWhere,
  clearAdminAttention as clearAdminAttentionFlag,
  clearAdminAttentionMany,
  markAdminAttention as markAdminAttentionFlag,
  TERMINAL_CUSTOM_ORDER_STATUSES,
} from 'src/custom-orders/custom-order-admin-attention';
import {
  AdminCustomOrderReminderDto,
  CancelPaidCustomOrderDto,
  CreateAdminCustomFabricRuleBasisDto,
  DecideCustomOrderExceptionReviewDto,
  EscalateCustomOrderRefundReviewDto,
  FlagCustomOrderRiskDto,
  QueryAdminCustomFabricRuleBasesDto,
  QueryAdminCustomOrdersDto,
  QueryCustomOrderDisputesDto,
  QueryCustomOrderExceptionReviewsDto,
  QueryCustomOrderLedgerAllocationsDto,
  QueryCustomOrderRefundReviewsDto,
  QueryCustomOrderRiskDashboardDto,
  ReleaseCustomOrderLedgerAllocationsDto,
  QueryStaleCustomOrdersDto,
  ReviewCustomFabricRuleBasisDto,
  UpdateAdminCustomFabricRuleBasisDto,
  UpdateCustomOrderRetentionHoldDto,
  UpdateCustomOrderDisputeDto,
} from './dto/custom-order-admin.dto';

@Injectable()
export class CustomOrderAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sideEffects: CustomOrderSideEffectsService,
    private readonly refundService: CustomOrderRefundService,
    private readonly customOrdersService: CustomOrdersService,
  ) {}

  async getPendingBases() {
    const items = await this.prisma.customFabricRuleBasis.findMany({
      where: { status: 'BRAND_ONLY' },
      orderBy: { createdAt: 'desc' },
    });

    return {
      statusCode: 200,
      message: 'Pending custom fabric rule bases retrieved',
      data: items,
    };
  }

  async reviewBasis(
    id: string,
    dto: ReviewCustomFabricRuleBasisDto,
    adminUserId: string,
  ) {
    const basis = await this.prisma.customFabricRuleBasis.findUnique({
      where: { id },
    });
    if (!basis) {
      throw new NotFoundException('Custom fabric rule basis not found');
    }

    const updated = await this.prisma.customFabricRuleBasis.update({
      where: { id },
      data: {
        status: dto.status,
        moderationNotes: dto.moderationNotes?.trim() || null,
        reviewedById: adminUserId,
        reviewedAt: new Date(),
      },
    });

    return {
      statusCode: 200,
      message: 'Custom fabric rule basis reviewed',
      data: updated,
    };
  }

  async listBases(query: QueryAdminCustomFabricRuleBasesDto) {
    void query;
    const where: Prisma.CustomFabricRuleBasisWhereInput = {
      status: CustomFabricRuleBasisStatus.APPROVED_GLOBAL,
    };

    const items = await this.prisma.customFabricRuleBasis.findMany({
      where,
      orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
    });

    return {
      statusCode: 200,
      message: 'Admin custom fabric rule bases retrieved',
      data: items,
    };
  }

  async createBasis(
    dto: CreateAdminCustomFabricRuleBasisDto,
    _adminUserId: string,
  ) {
    void _adminUserId;
    const measurementKeys = Array.from(
      new Set(
        (dto.measurementKeys ?? [])
          .map((key) => String(key).trim())
          .filter(Boolean),
      ),
    );
    if (measurementKeys.length === 0) {
      throw new BadRequestException(
        'At least one measurement key is required for a fabric rule basis',
      );
    }

    const created = await this.prisma.customFabricRuleBasis.create({
      data: {
        label: dto.label.trim(),
        measurementKeys,
        source: 'SYSTEM',
        status: 'APPROVED_GLOBAL',
      },
    });

    return {
      statusCode: 201,
      message: 'Global custom fabric rule basis created',
      data: created,
    };
  }

  async updateBasis(id: string, dto: UpdateAdminCustomFabricRuleBasisDto) {
    const existing = await this.prisma.customFabricRuleBasis.findUnique({
      where: { id },
    });
    if (
      !existing ||
      existing.status !== CustomFabricRuleBasisStatus.APPROVED_GLOBAL
    ) {
      throw new NotFoundException('Global custom fabric rule basis not found');
    }

    const measurementKeys = dto.measurementKeys
      ? Array.from(
          new Set(
            dto.measurementKeys
              .map((key) => String(key).trim())
              .filter(Boolean),
          ),
        )
      : undefined;
    if (
      dto.measurementKeys &&
      (!measurementKeys || measurementKeys.length === 0)
    ) {
      throw new BadRequestException(
        'At least one measurement key is required for a fabric rule basis',
      );
    }

    const updated = await this.prisma.customFabricRuleBasis.update({
      where: { id },
      data: {
        ...(dto.label?.trim() ? { label: dto.label.trim() } : {}),
        ...(measurementKeys ? { measurementKeys } : {}),
      },
    });

    return {
      statusCode: 200,
      message: 'Global custom fabric rule basis updated',
      data: updated,
    };
  }

  async deleteBasis(id: string) {
    const existing = await this.prisma.customFabricRuleBasis.findUnique({
      where: { id },
      include: {
        configurations: {
          select: { id: true },
          take: 1,
        },
      },
    });

    if (
      !existing ||
      existing.status !== CustomFabricRuleBasisStatus.APPROVED_GLOBAL
    ) {
      throw new NotFoundException('Global custom fabric rule basis not found');
    }

    if (existing.configurations.length > 0) {
      throw new BadRequestException(
        'Cannot delete this basis because it is already used by active configurations',
      );
    }

    await this.prisma.customFabricRuleBasis.delete({ where: { id } });
    return {
      statusCode: 200,
      message: 'Global custom fabric rule basis deleted',
      data: { id },
    };
  }

  /** Columns the admin table needs — never pull measurement/price JSON blobs. */
  private static readonly LIST_SELECT = {
    id: true,
    brandId: true,
    buyerId: true,
    status: true,
    paymentStatus: true,
    currentProgressStage: true,
    sourceType: true,
    sourceId: true,
    sourceTitleSnapshot: true,
    sourceBrandNameSnapshot: true,
    sourcePrimaryMediaUrlSnapshot: true,
    lastBrandProgressUpdateAt: true,
    buyerAcceptanceWindowEndsAt: true,
    createdAt: true,
    updatedAt: true,
    currency: true,
    contactInfoJson: true,
    buyerPriceSummaryJson: true,
    adminAttentionRequiredAt: true,
    adminAttentionReason: true,
    anonymizedAt: true,
    brand: { select: { id: true, name: true, ownerId: true } },
  } satisfies Prisma.CustomOrderSelect;

  async listOrders(query: QueryAdminCustomOrdersDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const attentionOnly = Boolean(query.attention);
    const sort = query.sort ?? 'attention';
    const cursorPayload = this.decodeListCursor(query.cursor);

    const baseWhere: Prisma.CustomOrderWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.stage ? { currentProgressStage: query.stage } : {}),
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...this.buildAdminListSearchWhere(query.q),
    };

    // Attention filter is server-side so the dashboard deep-link never lands on
    // an empty page-1 while older flagged orders sit on later pages.
    let where: Prisma.CustomOrderWhereInput = attentionOnly
      ? adminAttentionActiveWhere(baseWhere)
      : baseWhere;

    // Keyset pagination (preferred over deep OFFSET for large queues).
    if (cursorPayload) {
      where = {
        AND: [where, this.buildListCursorWhere(cursorPayload, sort)],
      };
    }

    const orderBy = this.buildAdminListOrderBy(sort);
    const attentionWhere = adminAttentionActiveWhere(baseWhere);
    // Counts ignore the cursor so the footer total stays stable across pages.
    const fullFilterWhere = attentionOnly ? attentionWhere : baseWhere;

    // Read-only: Promise.all (no interactive transaction). When attentionOnly,
    // total === attentionTotal so we only count once.
    const [rawItems, total, attentionTotalMaybe] = await Promise.all([
      this.prisma.customOrder.findMany({
        where,
        select: CustomOrderAdminService.LIST_SELECT,
        orderBy,
        // Cursor mode: no skip. Page mode: OFFSET (fine for shallow pages).
        ...(cursorPayload ? {} : { skip: (page - 1) * take }),
        take: take + 1, // one extra row to detect next page
      }),
      this.prisma.customOrder.count({ where: fullFilterWhere }),
      attentionOnly
        ? Promise.resolve(null as number | null)
        : this.prisma.customOrder.count({ where: attentionWhere }),
    ]);
    const attentionTotal = attentionOnly ? total : (attentionTotalMaybe as number);

    const hasMore = rawItems.length > take;
    const pageItems = hasMore ? rawItems.slice(0, take) : rawItems;
    const last = pageItems[pageItems.length - 1];
    const nextCursor =
      hasMore && last
        ? this.encodeListCursor({
            id: last.id,
            createdAt: last.createdAt.toISOString(),
            attentionAt: last.adminAttentionRequiredAt
              ? last.adminAttentionRequiredAt.toISOString()
              : null,
            sort,
          })
        : null;

    // Resolve real content titles (e.g. "Yello") for rows whose snapshot is the
    // generic "Custom order configuration" — same hydration the buyer/brand use.
    const hydratedItems =
      await this.customOrdersService.hydrateAdminOrderSnapshots(pageItems);

    return {
      statusCode: 200,
      message: 'Admin custom-order queue retrieved',
      data: {
        items: hydratedItems.map((item) => this.mapOrderListItem(item)),
        page: cursorPayload ? undefined : page,
        limit: take,
        total,
        attentionTotal,
        nextCursor,
      },
    };
  }

  /**
   * Restricted search: prefer indexed exact/prefix paths over ILIKE %term%.
   * - Full UUID → exact id (PK lookup)
   * - Else → prefix match on title/brand (startsWith), capped length
   *   (UUID columns cannot use string startsWith filters in Prisma)
   */
  private buildAdminListSearchWhere(
    rawQ?: string,
  ): Prisma.CustomOrderWhereInput {
    const q = String(rawQ ?? '').trim().slice(0, 80);
    if (!q) {
      return {};
    }

    const uuidRe =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (uuidRe.test(q)) {
      return { id: q };
    }

    // Prefix-only (not contains) — avoids leading-wildcard seq scans.
    return {
      OR: [
        { sourceTitleSnapshot: { startsWith: q, mode: 'insensitive' } },
        { sourceBrandNameSnapshot: { startsWith: q, mode: 'insensitive' } },
      ],
    };
  }

  private buildAdminListOrderBy(
    sort: 'attention' | 'newest' | 'oldest' | 'amount',
  ): Prisma.CustomOrderOrderByWithRelationInput[] {
    switch (sort) {
      case 'oldest':
        return [{ createdAt: 'asc' }, { id: 'asc' }];
      case 'newest':
        return [{ createdAt: 'desc' }, { id: 'desc' }];
      case 'amount':
        // Grand total lives in buyerPriceSummaryJson — no scalar column.
        return [{ createdAt: 'desc' }, { id: 'desc' }];
      case 'attention':
      default:
        return [
          { adminAttentionRequiredAt: { sort: 'desc', nulls: 'last' } },
          { createdAt: 'desc' },
          { id: 'desc' },
        ];
    }
  }

  private encodeListCursor(payload: {
    id: string;
    createdAt: string;
    attentionAt: string | null;
    sort: string;
  }): string {
    return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  }

  private decodeListCursor(
    cursor?: string,
  ): {
    id: string;
    createdAt: Date;
    attentionAt: Date | null;
    sort: string;
  } | null {
    if (!cursor?.trim()) {
      return null;
    }
    try {
      const raw = JSON.parse(
        Buffer.from(cursor, 'base64url').toString('utf8'),
      ) as {
        id?: string;
        createdAt?: string;
        attentionAt?: string | null;
        sort?: string;
      };
      if (!raw.id || !raw.createdAt) {
        return null;
      }
      const createdAt = new Date(raw.createdAt);
      if (Number.isNaN(createdAt.getTime())) {
        return null;
      }
      const attentionAt =
        raw.attentionAt != null ? new Date(raw.attentionAt) : null;
      if (attentionAt && Number.isNaN(attentionAt.getTime())) {
        return null;
      }
      return {
        id: raw.id,
        createdAt,
        attentionAt,
        sort: raw.sort ?? 'attention',
      };
    } catch {
      return null;
    }
  }

  private buildListCursorWhere(
    cursor: {
      id: string;
      createdAt: Date;
      attentionAt: Date | null;
      sort: string;
    },
    sort: 'attention' | 'newest' | 'oldest' | 'amount',
  ): Prisma.CustomOrderWhereInput {
    if (sort === 'oldest') {
      return {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      };
    }

    if (sort === 'newest' || sort === 'amount') {
      return {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      };
    }

    // attention: flagged first (non-null desc), then nulls, then createdAt desc.
    // After a flagged row: later flags by attentionAt, then unflagged.
    // After an unflagged row: only older unflagged by createdAt.
    if (cursor.attentionAt) {
      return {
        OR: [
          { adminAttentionRequiredAt: { lt: cursor.attentionAt } },
          {
            adminAttentionRequiredAt: cursor.attentionAt,
            createdAt: { lt: cursor.createdAt },
          },
          {
            adminAttentionRequiredAt: cursor.attentionAt,
            createdAt: cursor.createdAt,
            id: { lt: cursor.id },
          },
          { adminAttentionRequiredAt: null },
        ],
      };
    }

    return {
      adminAttentionRequiredAt: null,
      OR: [
        { createdAt: { lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { lt: cursor.id } },
      ],
    };
  }

  async listExceptionReviews(query: QueryCustomOrderExceptionReviewsDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;

    const where: Prisma.CustomOrderTimelineEventWhereInput = {
      eventType: 'ADMIN_ESCALATED',
      payloadJson: { path: ['kind'], equals: 'EXCEPTION_REVIEW_REQUEST' },
      customOrder: query.brandId ? { brandId: query.brandId } : undefined,
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrderTimelineEvent.findMany({
        where,
        include: {
          customOrder: {
            select: {
              id: true,
              brandId: true,
              sourceTitleSnapshot: true,
              sourceBrandNameSnapshot: true,
              status: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderTimelineEvent.count({ where }),
    ]);

    const filtered = query.status
      ? items.filter((item) => {
          const payload = item.payloadJson as Record<string, unknown>;
          return payload?.status === query.status;
        })
      : items;

    return {
      statusCode: 200,
      message: 'Custom-order exception review queue retrieved',
      data: {
        items: filtered.map((item) => ({
          id: item.id,
          createdAt: item.createdAt,
          payload: item.payloadJson,
          customOrder: item.customOrder,
        })),
        page,
        limit: take,
        total,
      },
    };
  }

  async decideExceptionReview(
    customOrderId: string,
    eventId: string,
    dto: DecideCustomOrderExceptionReviewDto,
    adminUserId: string,
  ) {
    const event = await this.prisma.customOrderTimelineEvent.findFirst({
      where: {
        id: eventId,
        customOrderId,
        eventType: 'ADMIN_ESCALATED',
      },
    });
    if (!event) {
      throw new NotFoundException('Exception review request not found');
    }

    const payload = (event.payloadJson ?? {}) as Record<string, unknown>;
    if (payload.kind !== 'EXCEPTION_REVIEW_REQUEST') {
      throw new BadRequestException('Invalid exception review request payload');
    }

    const isRequestMoreInfo = dto.decision === 'REQUEST_MORE_INFO';
    const nextStatus = isRequestMoreInfo
      ? 'IN_REVIEW'
      : dto.decision === 'APPROVED'
        ? 'APPROVED'
        : 'REJECTED';
    const nowIso = new Date().toISOString();

    const updatedOrder = await this.prisma.$transaction(async (tx) => {
      await tx.customOrderTimelineEvent.update({
        where: { id: eventId },
        data: {
          payloadJson: {
            ...payload,
            status: nextStatus,
            decidedAt: nowIso,
            decidedById: adminUserId,
            rationale: dto.rationale.trim(),
            approvedQuoteTotal: dto.approvedQuoteTotal ?? null,
          } as Prisma.InputJsonValue,
        },
      });

      const order = await tx.customOrder.findUnique({
        where: { id: customOrderId },
      });
      if (!order) {
        throw new NotFoundException('Custom order not found');
      }

      const breakdown = (order.internalPriceBreakdownJson ?? {}) as Record<
        string,
        unknown
      >;
      const nextBreakdown = isRequestMoreInfo
        ? {
            ...breakdown,
            exceptionReview: {
              status: nextStatus,
              rationale: dto.rationale.trim(),
              updatedAt: nowIso,
              updatedById: adminUserId,
            },
          }
        : {
            ...breakdown,
            exceptionDecision: {
              decision: nextStatus,
              rationale: dto.rationale.trim(),
              approvedQuoteTotal: dto.approvedQuoteTotal ?? null,
              decidedAt: nowIso,
              decidedById: adminUserId,
            },
          };

      return tx.customOrder.update({
        where: { id: customOrderId },
        data: {
          internalPriceBreakdownJson: nextBreakdown as Prisma.InputJsonValue,
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.ADMIN,
              actorId: adminUserId,
              eventType: 'ADMIN_ESCALATED',
              payloadJson: {
                kind: isRequestMoreInfo
                  ? 'EXCEPTION_REVIEW_REQUEST_MORE_INFO'
                  : 'EXCEPTION_REVIEW_DECISION',
                requestEventId: eventId,
                decision: nextStatus,
                rationale: dto.rationale.trim(),
                approvedQuoteTotal:
                  nextStatus === 'APPROVED'
                    ? (dto.approvedQuoteTotal ?? null)
                    : null,
              },
            },
          },
        },
      });
    });

    await this.clearAdminAttention(customOrderId, adminUserId);

    return {
      statusCode: 200,
      message: 'Exception review decision recorded',
      data: updatedOrder,
    };
  }

  async getSummary() {
    const now = new Date();
    const acceptanceSlaThreshold = new Date(
      now.getTime() - 24 * 60 * 60 * 1000,
    );
    const acceptanceTimeoutThreshold = new Date(
      now.getTime() - 48 * 60 * 60 * 1000,
    );

    const [
      activeOrders,
      refundInProgress,
      deliveredAwaitingConfirmation,
      openDisputes,
      acceptanceSlaRisk,
      acceptanceTimeouts,
      staleOrderIds,
      disputeOrders,
      rejectedOrders,
    ] = await this.prisma.$transaction([
      this.prisma.customOrder.count({
        where: {
          status: {
            in: [
              CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
              CustomOrderStatus.ACCEPTED,
              CustomOrderStatus.IN_PRODUCTION,
              CustomOrderStatus.READY_FOR_DISPATCH,
              CustomOrderStatus.IN_TRANSIT,
              CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
              CustomOrderStatus.DISPUTED,
              CustomOrderStatus.REFUND_IN_PROGRESS,
            ],
          },
        },
      }),
      this.prisma.customOrder.count({
        where: { status: CustomOrderStatus.REFUND_IN_PROGRESS },
      }),
      this.prisma.customOrder.count({
        where: {
          status: CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
        },
      }),
      this.prisma.customOrderDispute.count({
        where: {
          status: {
            in: [
              CustomOrderDisputeStatus.OPEN,
              CustomOrderDisputeStatus.BRAND_RESPONDED,
              CustomOrderDisputeStatus.ADMIN_REVIEW,
            ],
          },
        },
      }),
      this.prisma.customOrder.count({
        where: {
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
          paymentStatus: 'PAID',
          createdAt: {
            lte: acceptanceSlaThreshold,
            gt: acceptanceTimeoutThreshold,
          },
        },
      }),
      this.prisma.customOrder.count({
        where: {
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
          paymentStatus: 'PAID',
          createdAt: { lte: acceptanceTimeoutThreshold },
        },
      }),
      this.prisma.customOrderProgressEvent.findMany({
        where: {
          staleThresholdAt: { lte: now },
          customOrder: {
            status: {
              in: [
                CustomOrderStatus.ACCEPTED,
                CustomOrderStatus.IN_PRODUCTION,
                CustomOrderStatus.READY_FOR_DISPATCH,
                CustomOrderStatus.IN_TRANSIT,
              ],
            },
          },
        },
        distinct: ['customOrderId'],
        select: { customOrderId: true },
      }),
      this.prisma.customOrderDispute.findMany({
        where: {
          status: {
            in: [
              CustomOrderDisputeStatus.OPEN,
              CustomOrderDisputeStatus.BRAND_RESPONDED,
              CustomOrderDisputeStatus.ADMIN_REVIEW,
            ],
          },
        },
        select: { customOrderId: true },
      }),
      this.prisma.customOrder.findMany({
        where: { status: CustomOrderStatus.REJECTED_BY_BRAND },
        select: { brandId: true },
      }),
    ]);

    const staleCount = staleOrderIds.length;
    const staleBrandIds = staleOrderIds.length
      ? (
          await this.prisma.customOrder.findMany({
            where: {
              id: { in: staleOrderIds.map((entry) => entry.customOrderId) },
            },
            select: { brandId: true },
          })
        ).map((entry) => entry.brandId)
      : [];

    const disputeOrderIds = [
      ...new Set(disputeOrders.map((entry) => entry.customOrderId)),
    ];
    const disputeBrands = disputeOrderIds.length
      ? await this.prisma.customOrder.findMany({
          where: { id: { in: disputeOrderIds } },
          select: { brandId: true },
        })
      : [];

    const riskByBrand = new Map<
      string,
      { stale: number; disputes: number; rejections: number }
    >();

    for (const brandId of staleBrandIds) {
      const current = riskByBrand.get(brandId) ?? {
        stale: 0,
        disputes: 0,
        rejections: 0,
      };
      current.stale += 1;
      riskByBrand.set(brandId, current);
    }
    for (const entry of disputeBrands) {
      const current = riskByBrand.get(entry.brandId) ?? {
        stale: 0,
        disputes: 0,
        rejections: 0,
      };
      current.disputes += 1;
      riskByBrand.set(entry.brandId, current);
    }
    for (const entry of rejectedOrders) {
      const current = riskByBrand.get(entry.brandId) ?? {
        stale: 0,
        disputes: 0,
        rejections: 0,
      };
      current.rejections += 1;
      riskByBrand.set(entry.brandId, current);
    }

    const topRiskBrandIds = [...riskByBrand.entries()]
      .sort(
        (left, right) =>
          right[1].stale +
          right[1].disputes +
          right[1].rejections -
          (left[1].stale + left[1].disputes + left[1].rejections),
      )
      .slice(0, 10)
      .map(([brandId]) => brandId);

    const brands = topRiskBrandIds.length
      ? await this.prisma.brand.findMany({
          where: { id: { in: topRiskBrandIds } },
          select: { id: true, name: true },
        })
      : [];

    const brandsById = new Map(brands.map((brand) => [brand.id, brand]));

    return {
      statusCode: 200,
      message: 'Custom-order admin summary retrieved',
      data: {
        totals: {
          activeOrders,
          staleOrders: staleCount,
          openDisputes,
          refundInProgress,
          deliveredAwaitingConfirmation,
          acceptanceSlaRisk,
          acceptanceTimeouts,
        },
        brandRisk: topRiskBrandIds.map((brandId) => ({
          brandId,
          brandName: brandsById.get(brandId)?.name ?? null,
          ...riskByBrand.get(brandId),
        })),
      },
    };
  }

  async getRiskDashboard(query: QueryCustomOrderRiskDashboardDto) {
    const now = new Date();
    const days = query.days ?? 30;
    const limit = query.limit ?? 10;
    const since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const orderWhere: Prisma.CustomOrderWhereInput = {
      ...(query.brandId ? { brandId: query.brandId } : {}),
    };
    const analyticsWhere: Prisma.CustomOrderAnalyticsEventWhereInput = {
      occurredAt: { gte: since },
      customOrder: orderWhere,
      eventType: {
        in: [
          'BRAND_REJECTED',
          'DISPUTE_CREATED',
          'REFUND_INITIATED',
          'ADMIN_ESCALATED',
        ],
      },
    };

    const [
      periodOrders,
      periodAnalytics,
      staleEvents,
      acceptanceSlaRiskOrders,
      acceptanceTimeoutOrders,
    ] = await Promise.all([
      this.prisma.customOrder.findMany({
        where: {
          ...orderWhere,
          createdAt: { gte: since },
        },
        select: {
          id: true,
          brandId: true,
          rushSelected: true,
          status: true,
        },
      }),
      this.prisma.customOrderAnalyticsEvent.findMany({
        where: analyticsWhere,
        select: {
          eventType: true,
          customOrder: {
            select: {
              brandId: true,
              rushSelected: true,
            },
          },
        },
      }),
      this.prisma.customOrderProgressEvent.findMany({
        where: {
          staleThresholdAt: { lte: now },
          customOrder: {
            ...orderWhere,
            status: {
              in: [
                CustomOrderStatus.ACCEPTED,
                CustomOrderStatus.IN_PRODUCTION,
                CustomOrderStatus.READY_FOR_DISPATCH,
                CustomOrderStatus.IN_TRANSIT,
              ],
            },
          },
        },
        select: {
          customOrderId: true,
          customOrder: {
            select: {
              brandId: true,
            },
          },
        },
        distinct: ['customOrderId'],
      }),
      this.prisma.customOrder.findMany({
        where: {
          ...orderWhere,
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
          paymentStatus: 'PAID',
          createdAt: {
            lte: new Date(now.getTime() - 24 * 60 * 60 * 1000),
            gt: new Date(now.getTime() - 48 * 60 * 60 * 1000),
          },
        },
        select: { brandId: true },
      }),
      this.prisma.customOrder.findMany({
        where: {
          ...orderWhere,
          status: CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
          paymentStatus: 'PAID',
          createdAt: { lte: new Date(now.getTime() - 48 * 60 * 60 * 1000) },
        },
        select: { brandId: true },
      }),
    ]);

    const overview = {
      periodDays: days,
      ordersPlaced: periodOrders.length,
      rushOrders: periodOrders.filter((order) => order.rushSelected).length,
      brandRejections: periodAnalytics.filter(
        (event) => event.eventType === 'BRAND_REJECTED',
      ).length,
      disputesOpened: periodAnalytics.filter(
        (event) => event.eventType === 'DISPUTE_CREATED',
      ).length,
      refundsInitiated: periodAnalytics.filter(
        (event) => event.eventType === 'REFUND_INITIATED',
      ).length,
      adminEscalations: periodAnalytics.filter(
        (event) => event.eventType === 'ADMIN_ESCALATED',
      ).length,
      currentStaleOrders: staleEvents.length,
      currentAcceptanceSlaRisk: acceptanceSlaRiskOrders.length,
      currentAcceptanceTimeouts: acceptanceTimeoutOrders.length,
      rushOrdersWithExceptions: 0,
    };

    const brandRiskMap = new Map<
      string,
      {
        ordersPlaced: number;
        rushOrders: number;
        brandRejections: number;
        disputesOpened: number;
        refundsInitiated: number;
        adminEscalations: number;
        staleOrders: number;
        acceptanceSlaRisk: number;
        acceptanceTimeouts: number;
        rushOrdersWithExceptions: number;
      }
    >();

    const ensureBrandRisk = (brandId: string) => {
      const current = brandRiskMap.get(brandId);
      if (current) {
        return current;
      }

      const next = {
        ordersPlaced: 0,
        rushOrders: 0,
        brandRejections: 0,
        disputesOpened: 0,
        refundsInitiated: 0,
        adminEscalations: 0,
        staleOrders: 0,
        acceptanceSlaRisk: 0,
        acceptanceTimeouts: 0,
        rushOrdersWithExceptions: 0,
      };
      brandRiskMap.set(brandId, next);
      return next;
    };
    const rushExceptionStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.REJECTED_BY_BRAND,
      CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
      CustomOrderStatus.DISPUTED,
      CustomOrderStatus.REFUND_IN_PROGRESS,
    ]);

    for (const order of periodOrders) {
      const current = ensureBrandRisk(order.brandId);
      current.ordersPlaced += 1;
      if (order.rushSelected) {
        current.rushOrders += 1;
        if (rushExceptionStatuses.has(order.status)) {
          current.rushOrdersWithExceptions += 1;
          overview.rushOrdersWithExceptions += 1;
        }
      }
    }

    const eventKeyMap: Record<
      string,
      keyof ReturnType<typeof ensureBrandRisk>
    > = {
      BRAND_REJECTED: 'brandRejections',
      DISPUTE_CREATED: 'disputesOpened',
      REFUND_INITIATED: 'refundsInitiated',
      ADMIN_ESCALATED: 'adminEscalations',
    };

    for (const event of periodAnalytics) {
      const metricKey = eventKeyMap[event.eventType];
      if (!metricKey) {
        continue;
      }
      ensureBrandRisk(event.customOrder.brandId)[metricKey] += 1;
    }

    for (const event of staleEvents) {
      ensureBrandRisk(event.customOrder.brandId).staleOrders += 1;
    }
    for (const order of acceptanceSlaRiskOrders) {
      ensureBrandRisk(order.brandId).acceptanceSlaRisk += 1;
    }
    for (const order of acceptanceTimeoutOrders) {
      ensureBrandRisk(order.brandId).acceptanceTimeouts += 1;
    }

    const topBrandIds = [...brandRiskMap.entries()]
      .map(([brandId, metrics]) => ({
        brandId,
        riskScore:
          metrics.brandRejections * 4 +
          metrics.disputesOpened * 5 +
          metrics.refundsInitiated * 4 +
          metrics.adminEscalations * 2 +
          metrics.staleOrders * 3 +
          metrics.acceptanceSlaRisk * 2 +
          metrics.acceptanceTimeouts * 5 +
          metrics.rushOrdersWithExceptions * 3,
      }))
      .sort((left, right) => right.riskScore - left.riskScore)
      .slice(0, limit);

    const brands = topBrandIds.length
      ? await this.prisma.brand.findMany({
          where: { id: { in: topBrandIds.map((item) => item.brandId) } },
          select: { id: true, name: true },
        })
      : [];
    const brandNames = new Map(brands.map((brand) => [brand.id, brand.name]));

    return {
      statusCode: 200,
      message: 'Custom-order risk dashboard retrieved',
      data: {
        overview,
        brandRisk: topBrandIds.map((item) => ({
          brandId: item.brandId,
          brandName: brandNames.get(item.brandId) ?? null,
          riskScore: item.riskScore,
          ...brandRiskMap.get(item.brandId),
        })),
      },
    };
  }

  async listRefundReviews(query: QueryCustomOrderRefundReviewsDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const where: Prisma.CustomOrderWhereInput = {
      ...(query.brandId ? { brandId: query.brandId } : {}),
      ...(query.q
        ? {
            OR: [
              {
                sourceTitleSnapshot: { contains: query.q, mode: 'insensitive' },
              },
              {
                sourceBrandNameSnapshot: {
                  contains: query.q,
                  mode: 'insensitive',
                },
              },
              { paymentReference: { contains: query.q, mode: 'insensitive' } },
            ],
          }
        : {}),
      OR: query.includeSettled
        ? [
            { status: CustomOrderStatus.REFUND_IN_PROGRESS },
            { paymentStatus: 'REFUNDED' },
          ]
        : [{ status: CustomOrderStatus.REFUND_IN_PROGRESS }],
    };

    const [orders, total] = await this.prisma.$transaction([
      this.prisma.customOrder.findMany({
        where,
        include: {
          brand: { select: { id: true, name: true, ownerId: true } },
          disputes: { orderBy: { openedAt: 'desc' }, take: 3 },
          issues: { orderBy: { createdAt: 'desc' }, take: 3 },
          timelineEvents: {
            where: { eventType: 'REFUND_INITIATED' },
            orderBy: { createdAt: 'desc' },
            take: 1,
          },
        },
        orderBy: [{ updatedAt: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrder.count({ where }),
    ]);

    const orderIds = orders.map((order) => order.id);
    const attempts = orderIds.length
      ? await this.prisma.paymentAttempt.findMany({
          where: { customOrderId: { in: orderIds } },
          orderBy: [{ createdAt: 'desc' }],
          select: {
            id: true,
            customOrderId: true,
            reference: true,
            status: true,
            provider: true,
            amount: true,
            currency: true,
            confirmedAt: true,
            lastVerifiedAt: true,
            failureMessage: true,
            createdAt: true,
          },
        })
      : [];
    const latestAttempts = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (!latestAttempts.has(attempt.customOrderId!)) {
        latestAttempts.set(attempt.customOrderId!, attempt);
      }
    }

    const attemptIds = [...new Set(attempts.map((attempt) => attempt.id))];
    const refundEvents = attemptIds.length
      ? await this.prisma.paymentEvent.findMany({
          where: {
            paymentAttemptId: { in: attemptIds },
            type: { contains: 'REFUND' },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            paymentAttemptId: true,
            type: true,
            source: true,
            payload: true,
            createdAt: true,
          },
        })
      : [];
    const latestRefundEvents = new Map<string, (typeof refundEvents)[number]>();
    for (const event of refundEvents) {
      if (!latestRefundEvents.has(event.paymentAttemptId)) {
        latestRefundEvents.set(event.paymentAttemptId, event);
      }
    }

    return {
      statusCode: 200,
      message: 'Custom-order refund review queue retrieved',
      data: {
        items: orders.map((order) => {
          const attempt = latestAttempts.get(order.id);
          const refundEvent = attempt
            ? latestRefundEvents.get(attempt.id)
            : undefined;

          return {
            id: order.id,
            status: order.status,
            paymentStatus: order.paymentStatus,
            paymentReference: order.paymentReference,
            sourceTitle: order.sourceTitleSnapshot,
            sourceBrandName: order.sourceBrandNameSnapshot,
            createdAt: order.createdAt,
            updatedAt: order.updatedAt,
            brand: order.brand,
            disputeCount: order.disputes.length,
            issueCount: order.issues.length,
            latestRefundTimelineEvent: order.timelineEvents[0] ?? null,
            latestPaymentAttempt: attempt
              ? {
                  id: attempt.id,
                  reference: attempt.reference,
                  status: attempt.status,
                  provider: attempt.provider,
                  amount: Number(attempt.amount),
                  currency: attempt.currency,
                  confirmedAt: attempt.confirmedAt,
                  lastVerifiedAt: attempt.lastVerifiedAt,
                  failureMessage: attempt.failureMessage,
                  createdAt: attempt.createdAt,
                }
              : null,
            latestRefundEvent: refundEvent
              ? {
                  type: refundEvent.type,
                  source: refundEvent.source,
                  payload: refundEvent.payload,
                  createdAt: refundEvent.createdAt,
                }
              : null,
          };
        }),
        page,
        limit: take,
        total,
      },
    };
  }

  async getRefundReview(id: string) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      include: this.detailInclude,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const paymentAttempts = await this.prisma.paymentAttempt.findMany({
      where: { customOrderId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        reference: true,
        status: true,
        provider: true,
        amount: true,
        currency: true,
        confirmedAt: true,
        lastVerifiedAt: true,
        failureMessage: true,
        requestSnapshot: true,
        responseSnapshot: true,
        createdAt: true,
      },
    });
    const paymentEvents = paymentAttempts.length
      ? await this.prisma.paymentEvent.findMany({
          where: {
            paymentAttemptId: {
              in: paymentAttempts.map((attempt) => attempt.id),
            },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            paymentAttemptId: true,
            type: true,
            source: true,
            payload: true,
            createdAt: true,
          },
        })
      : [];

    return {
      statusCode: 200,
      message: 'Custom-order refund review detail retrieved',
      data: {
        order,
        paymentAttempts: paymentAttempts.map((attempt) => ({
          ...attempt,
          amount: Number(attempt.amount),
        })),
        paymentEvents,
      },
    };
  }

  async getStaleOrders(query: QueryStaleCustomOrdersDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const now = new Date();

    const staleWhere: Prisma.CustomOrderProgressEventWhereInput = {
      staleThresholdAt: { lte: now },
      ...(query.escalatedOnly ? { adminEscalatedAt: { not: null } } : {}),
      customOrder: {
        ...(query.brandId ? { brandId: query.brandId } : {}),
        status: {
          in: [
            CustomOrderStatus.ACCEPTED,
            CustomOrderStatus.IN_PRODUCTION,
            CustomOrderStatus.READY_FOR_DISPATCH,
            CustomOrderStatus.IN_TRANSIT,
          ],
        },
      },
    };

    const [events, total] = await this.prisma.$transaction([
      this.prisma.customOrderProgressEvent.findMany({
        where: staleWhere,
        include: {
          customOrder: {
            include: {
              brand: { select: { id: true, name: true, ownerId: true } },
            },
          },
        },
        orderBy: [{ adminEscalatedAt: 'desc' }, { staleThresholdAt: 'asc' }],
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderProgressEvent.count({ where: staleWhere }),
    ]);

    return {
      statusCode: 200,
      message: 'Stale custom-order queue retrieved',
      data: {
        items: events.map((event) => ({
          id: event.id,
          stage: event.stage,
          changedAt: event.changedAt,
          staleThresholdAt: event.staleThresholdAt,
          staleBuyerWarnedAt: event.staleBuyerWarnedAt,
          adminEscalatedAt: event.adminEscalatedAt,
          customOrder: this.mapOrderListItem(event.customOrder),
        })),
        page,
        limit: take,
        total,
      },
    };
  }

  async getOrder(id: string) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      include: this.detailInclude,
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    // Resolve the real content title when the stored snapshot is generic.
    const hydrated = await this.customOrdersService.hydrateAdminOrderSnapshot(order);

    return {
      statusCode: 200,
      message: 'Custom-order admin detail retrieved',
      data: this.mapAdminOrderDetail(hydrated),
    };
  }

  /**
   * Map the raw custom order into the structured detail the admin UI expects
   * (nested `source`, parsed `buyerPriceSummary`, decoded JSON breakdowns) plus
   * the sticky admin-attention signal. Previously the endpoint returned the raw
   * Prisma row, so the detail screen showed "Source type: Unknown" / "No
   * breakdown available" and a generic title.
   */
  private mapAdminOrderDetail(order: any) {
    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const breakdown = asRecord(order.internalPriceBreakdownJson);
    const chartLock = (breakdown.chartLock ?? null) as Record<
      string,
      unknown
    > | null;
    const priceRaw = asRecord(order.buyerPriceSummaryJson);
    const mediaUrls = order.sourcePrimaryMediaUrlSnapshot
      ? [order.sourcePrimaryMediaUrlSnapshot]
      : [];

    return {
      id: order.id,
      status: order.status,
      paymentStatus: order.paymentStatus,
      paymentReference: order.paymentReference,
      source: {
        type: order.sourceType,
        id: order.sourceId,
        title: order.sourceTitleSnapshot,
        slug: order.sourceSlugSnapshot,
        primaryMediaUrl: order.sourcePrimaryMediaUrlSnapshot,
        mediaUrls,
        brandName: order.sourceBrandNameSnapshot,
      },
      configurationVersionId: order.configurationVersionId,
      buyerPriceSummary: {
        fabricCharge: Number(priceRaw.fabricCharge ?? 0),
        subtotal: Number(priceRaw.subtotal ?? priceRaw.outfitTotal ?? 0),
        shippingFee: Number(priceRaw.shippingFee ?? priceRaw.delivery ?? 0),
        rushFee: Number(priceRaw.rushFee ?? priceRaw.rush ?? 0),
        grandTotal: Number(priceRaw.grandTotal ?? 0),
        currency: order.currency ?? (priceRaw.currency as string) ?? 'NGN',
      },
      internalPriceBreakdown: order.internalPriceBreakdownJson,
      quoteStatus: (chartLock?.quoteStatus as string | undefined) ?? 'AUTO_PRICED',
      chartLock,
      exceptionDecision: (breakdown.exceptionDecision ?? null) as
        | Record<string, unknown>
        | null,
      measurementSnapshot: order.measurementSnapshotJson,
      measurementConfirmedAt: order.measurementConfirmedAt,
      shippingAddress: order.shippingAddressJson,
      contactInfo: order.contactInfoJson,
      currentProgressStage: order.currentProgressStage,
      acceptedAt: order.acceptedAt,
      buyerAcceptedAt: order.buyerAcceptedAt,
      completedAt: order.completedAt,
      promisedProductionAt: order.promisedProductionAt,
      promisedDispatchAt: order.promisedDispatchAt,
      promisedDeliveryAt: order.promisedDeliveryAt,
      buyerAcceptanceWindowEndsAt: order.buyerAcceptanceWindowEndsAt,
      measurementRetentionUntil: order.measurementRetentionUntil,
      anonymizedAt: order.anonymizedAt,
      retentionHoldType: order.retentionHoldType,
      retentionHoldReason: order.retentionHoldReason,
      retentionHoldUntil: order.retentionHoldUntil,
      retentionHoldSetById: order.retentionHoldSetById,
      retentionHoldSetAt: order.retentionHoldSetAt,
      // Sticky admin-attention signal (drives the detail-page danger banner).
      // Suppress on terminal/anonymized rows (same rule as list + dashboard).
      adminAttentionRequiredAt:
        order.anonymizedAt != null ||
        TERMINAL_CUSTOM_ORDER_STATUSES.includes(order.status)
          ? null
          : (order.adminAttentionRequiredAt ?? null),
      adminAttentionReason:
        order.anonymizedAt != null ||
        TERMINAL_CUSTOM_ORDER_STATUSES.includes(order.status)
          ? null
          : (order.adminAttentionReason ?? null),
      brandId: order.brandId,
      buyerId: order.buyerId,
      progressEvents: order.progressEvents,
      extensionRequests: order.extensionRequests,
      issues: order.issues,
      disputes: order.disputes,
      ledgerAllocations: order.ledgerAllocations,
      timelineEvents: order.timelineEvents,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
    };
  }

  async listDisputes(query: QueryCustomOrderDisputesDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const where = {
      ...(query.status ? { status: query.status } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrderDispute.findMany({
        where,
        include: {
          customOrder: {
            select: {
              id: true,
              brandId: true,
              buyerId: true,
              sourceTitleSnapshot: true,
              sourceBrandNameSnapshot: true,
              status: true,
            },
          },
        },
        orderBy: { openedAt: 'asc' },
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderDispute.count({ where }),
    ]);

    return {
      statusCode: 200,
      message: 'Custom-order disputes retrieved',
      data: {
        items,
        page,
        limit: take,
        total,
      },
    };
  }

  async listLedgerAllocations(query: QueryCustomOrderLedgerAllocationsDto) {
    const page = query.page ?? 1;
    const take = query.limit ?? 20;
    const where: Prisma.CustomOrderLedgerAllocationWhereInput = {
      ...(query.customOrderId ? { customOrderId: query.customOrderId } : {}),
      ...(query.payoutId ? { payoutId: query.payoutId } : {}),
      ...(query.brandId ? { customOrder: { brandId: query.brandId } } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.customOrderLedgerAllocation.findMany({
        where,
        include: {
          customOrder: {
            select: {
              id: true,
              brandId: true,
              buyerId: true,
              sourceTitleSnapshot: true,
              sourceBrandNameSnapshot: true,
              status: true,
            },
          },
          payout: {
            select: {
              id: true,
              status: true,
              amount: true,
              currency: true,
              reference: true,
              createdAt: true,
            },
          },
        },
        orderBy: [{ eligibleAt: 'asc' }, { createdAt: 'asc' }],
        skip: (page - 1) * take,
        take,
      }),
      this.prisma.customOrderLedgerAllocation.count({ where }),
    ]);

    return {
      statusCode: 200,
      message: 'Custom-order ledger allocations retrieved',
      data: {
        items,
        page,
        limit: take,
        total,
      },
    };
  }

  async releaseEligibleLedgerAllocations(
    dto: ReleaseCustomOrderLedgerAllocationsDto,
    adminUserId: string,
  ) {
    const now = new Date();
    const allocationFilter = {
      ...(dto.customOrderId ? { customOrderId: dto.customOrderId } : {}),
      ...(dto.allocationIds?.length ? { id: { in: dto.allocationIds } } : {}),
      ...(dto.brandId ? { customOrder: { brandId: dto.brandId } } : {}),
      status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
      paidOutAt: null,
      payoutId: null,
      customOrder: {
        ...(dto.brandId ? { brandId: dto.brandId } : {}),
        status: {
          in: [
            CustomOrderStatus.ACCEPTED,
            CustomOrderStatus.COMPLETED,
            CustomOrderStatus.CLOSED,
          ],
        },
        disputes: {
          none: {
            status: {
              in: ['OPEN', 'BRAND_RESPONDED', 'ADMIN_REVIEW'],
            },
          },
        },
      },
    } as Prisma.CustomOrderLedgerAllocationWhereInput;

    const allocations = await this.prisma.customOrderLedgerAllocation.findMany({
      where: allocationFilter,
      select: {
        id: true,
        amount: true,
        netBrandAmount: true,
        currency: true,
        customOrderId: true,
        customOrder: {
          select: {
            brandId: true,
          },
        },
      },
      take: 1000,
    });

    if (allocations.length === 0) {
      return {
        statusCode: 200,
        message:
          'No payout-eligible custom-order allocations found for release',
        data: {
          dryRun: Boolean(dto.dryRun),
          releasedBatches: 0,
          releasedAllocations: 0,
          releasedTotalAmount: 0,
        },
      };
    }

    const grouped = new Map<
      string,
      {
        brandId: string;
        currency: string;
        totalAmount: number;
        allocationIds: string[];
        customOrderIds: string[];
      }
    >();

    for (const allocation of allocations) {
      const brandId = allocation.customOrder.brandId;
      const key = `${brandId}:${allocation.currency}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.totalAmount += Number(allocation.netBrandAmount ?? 0);
        existing.allocationIds.push(allocation.id);
        existing.customOrderIds.push(allocation.customOrderId);
      } else {
        grouped.set(key, {
          brandId,
          currency: allocation.currency,
          totalAmount: Number(allocation.netBrandAmount ?? 0),
          allocationIds: [allocation.id],
          customOrderIds: [allocation.customOrderId],
        });
      }
    }

    if (dto.dryRun) {
      return {
        statusCode: 200,
        message: 'Dry-run release summary generated',
        data: {
          dryRun: true,
          releasedBatches: grouped.size,
          releasedAllocations: allocations.length,
          releasedTotalAmount: allocations.reduce(
            (sum, item) => sum + Number(item.netBrandAmount ?? 0),
            0,
          ),
        },
      };
    }

    let releasedBatches = 0;
    for (const group of grouped.values()) {
      await this.prisma.$transaction(async (tx) => {
        const payoutId = uuidv4();
        await tx.payout.create({
          data: {
            id: payoutId,
            brandId: group.brandId,
            amount: new Prisma.Decimal(group.totalAmount.toFixed(2)),
            currency: group.currency,
            status: 'PENDING_APPROVAL',
            reference: `CO-${group.brandId.slice(0, 8)}-${now.getTime()}`,
          },
        });

        const reserved = await tx.customOrderLedgerAllocation.updateMany({
          where: {
            id: { in: group.allocationIds },
            status: CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            paidOutAt: null,
            payoutId: null,
          },
          data: {
            payoutId,
          },
        });

        if (reserved.count !== group.allocationIds.length) {
          throw new BadRequestException(
            'CUSTOM_ORDER_PAYOUT_BATCH_RESERVATION_FAILED',
          );
        }

        const uniqueOrderIds = Array.from(new Set(group.customOrderIds));
        await tx.customOrderTimelineEvent.createMany({
          data: uniqueOrderIds.map((customOrderId) => ({
            customOrderId,
            actorType: CustomOrderActorType.ADMIN,
            actorId: adminUserId,
            eventType: 'ADMIN_ESCALATED',
            payloadJson: {
              action: 'MANUAL_PAYOUT_RELEASE_QUEUED',
              payoutId,
              allocationCount: group.allocationIds.length,
              queuedNetAmount: Number(group.totalAmount.toFixed(2)),
            } as Prisma.InputJsonValue,
          })),
        });
      });

      releasedBatches += 1;
    }

    // Releasing payouts is the exact action that resolves PAYOUT_RELEASE_ELIGIBLE.
    const releasedOrderIds = Array.from(
      new Set(allocations.map((item) => item.customOrderId)),
    );
    await clearAdminAttentionMany(
      this.prisma,
      releasedOrderIds,
      adminUserId,
    );

    return {
      statusCode: 200,
      message:
        'Custom-order payout-eligible allocations released to payout queue',
      data: {
        dryRun: false,
        releasedBatches,
        releasedAllocations: allocations.length,
        releasedTotalAmount: allocations.reduce(
          (sum, item) => sum + Number(item.netBrandAmount ?? 0),
          0,
        ),
      },
    };
  }

  async updateDispute(
    id: string,
    dto: UpdateCustomOrderDisputeDto,
    adminUserId: string,
  ) {
    const dispute = await this.prisma.customOrderDispute.findUnique({
      where: { id },
    });
    if (!dispute) {
      throw new NotFoundException('Custom-order dispute not found');
    }

    const nextStatus = dto.status ?? dispute.status;
    const isResolved =
      nextStatus === 'RESOLVED' || nextStatus === 'CLOSED';

    const updated = await this.prisma.customOrderDispute.update({
      where: { id },
      data: {
        status: nextStatus,
        resolution: dto.resolution ?? dispute.resolution,
        adminNotes: dto.adminNotes ?? dispute.adminNotes,
        assignedAdminId: dto.assignedAdminId ?? adminUserId,
        resolvedAt: isResolved ? new Date() : dispute.resolvedAt,
      },
    });

    // Only clear attention when the dispute is actually closed — assigning
    // notes / changing assignee is not a resolution.
    if (isResolved) {
      await this.clearAdminAttention(dispute.customOrderId, adminUserId);
    }

    // Surface the admin's dispute decision on the brand's order queue.
    await this.prisma.customOrder.update({
      where: { id: dispute.customOrderId },
      data: { brandAdminNoticeAt: new Date() },
    });

    return {
      statusCode: 200,
      message: 'Custom-order dispute updated',
      data: updated,
    };
  }

  async updateRetentionHold(
    id: string,
    dto: UpdateCustomOrderRetentionHoldDto,
    adminUserId: string,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      select: {
        id: true,
        retentionHoldType: true,
        retentionHoldReason: true,
        retentionHoldUntil: true,
      },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    if (!dto.clear) {
      if (!dto.holdType) {
        throw new BadRequestException('Retention hold type is required');
      }
      if (!dto.reason?.trim()) {
        throw new BadRequestException('Retention hold reason is required');
      }
    }

    const updated = await this.prisma.customOrder.update({
      where: { id },
      data: dto.clear
        ? {
            retentionHoldType: null,
            retentionHoldReason: null,
            retentionHoldUntil: null,
            retentionHoldSetById: adminUserId,
            retentionHoldSetAt: new Date(),
          }
        : {
            retentionHoldType: dto.holdType as CustomOrderRetentionHoldType,
            retentionHoldReason: dto.reason!.trim(),
            retentionHoldUntil: dto.holdUntil ?? null,
            retentionHoldSetById: adminUserId,
            retentionHoldSetAt: new Date(),
          },
      select: {
        id: true,
        retentionHoldType: true,
        retentionHoldReason: true,
        retentionHoldUntil: true,
        retentionHoldSetById: true,
        retentionHoldSetAt: true,
      },
    });

    await this.prisma.customOrderTimelineEvent.create({
      data: {
        customOrderId: id,
        actorType: CustomOrderActorType.ADMIN,
        actorId: adminUserId,
        eventType: 'ADMIN_ESCALATED',
        payloadJson: {
          action: dto.clear ? 'CLEAR_RETENTION_HOLD' : 'SET_RETENTION_HOLD',
          previousHoldType: order.retentionHoldType,
          nextHoldType: updated.retentionHoldType,
          holdUntil: updated.retentionHoldUntil,
          reason: updated.retentionHoldReason,
        } as Prisma.InputJsonValue,
      },
    });

    await this.clearAdminAttention(id, adminUserId);

    return {
      statusCode: 200,
      message: dto.clear
        ? 'Custom-order retention hold cleared'
        : 'Custom-order retention hold updated',
      data: updated,
    };
  }

  async remindBrand(
    id: string,
    dto: AdminCustomOrderReminderDto,
    adminUserId: string,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
      },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (!order.brand.ownerId) {
      throw new BadRequestException(
        'Brand owner could not be resolved for this order',
      );
    }

    await this.prisma.customOrderTimelineEvent.create({
      data: {
        customOrderId: order.id,
        actorType: CustomOrderActorType.ADMIN,
        actorId: adminUserId,
        eventType: 'ADMIN_ESCALATED',
        payloadJson: {
          reason: 'MANUAL_BRAND_REMINDER',
          note: dto.note ?? null,
        } as Prisma.InputJsonValue,
      },
    });

    await this.sideEffects.enqueueNotification({
      customOrderId: order.id,
      recipientIds: [order.brand.ownerId],
      notificationType: NotificationType.CUSTOM_ORDER_REVIEW_REQUIRED,
      target: this.brandTarget(order.id),
      payload: {
        customOrderId: order.id,
        note: dto.note ?? null,
        reason: 'MANUAL_BRAND_REMINDER',
      },
      dedupeMs: 60 * 1000,
    });

    await this.clearAdminAttention(order.id, adminUserId);
    // Surface the reminder on the brand's order queue (read-only for the brand).
    await this.prisma.customOrder.update({
      where: { id: order.id },
      data: { brandAdminNoticeAt: new Date() },
    });

    return {
      statusCode: 200,
      message: 'Brand reminder queued',
      data: { customOrderId: order.id, brandId: order.brandId },
    };
  }

  async flagRisk(id: string, dto: FlagCustomOrderRiskDto, adminUserId: string) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      select: { id: true, buyerId: true, brandId: true },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    await this.prisma.customOrderTimelineEvent.create({
      data: {
        customOrderId: id,
        actorType: CustomOrderActorType.ADMIN,
        actorId: adminUserId,
        eventType: 'ADMIN_ESCALATED',
        payloadJson: {
          reason: dto.reason.trim(),
          note: dto.note?.trim() || null,
          action: 'FLAG_RISK',
        } as Prisma.InputJsonValue,
      },
    });

    // flagRisk raises concern — it does NOT resolve admin attention. Keep (or
    // set) the sticky flag so the order stays visible on the dashboard.
    await markAdminAttentionFlag(this.prisma, id, 'FLAG_RISK');

    // Buyer-facing copy: never reuse admin-review "take action" language.
    const shortCode = id.slice(0, 8).toUpperCase();
    await this.sideEffects.enqueueNotification({
      customOrderId: id,
      recipientIds: [order.buyerId],
      notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      target: this.buyerTarget(id),
      payload: {
        customOrderId: id,
        reason: 'FLAG_RISK',
        adminReason: dto.reason.trim(),
        message: `We've noted a concern on #CO-${shortCode} and our team is looking into it. You don't need to do anything right now — we'll follow up if we need you.`,
      },
      dedupeMs: 60 * 1000,
    });

    return {
      statusCode: 200,
      message: 'Custom-order risk flag recorded',
      data: {
        customOrderId: id,
        brandId: order.brandId,
        reason: dto.reason.trim(),
      },
    };
  }

  async escalateRefundReview(
    id: string,
    dto: EscalateCustomOrderRefundReviewDto,
    adminUserId: string,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        status: true,
      },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }

    const eligibleStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      CustomOrderStatus.REJECTED_BY_BRAND,
      CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
      CustomOrderStatus.DISPUTED,
      CustomOrderStatus.REFUND_IN_PROGRESS,
    ]);
    if (!eligibleStatuses.has(order.status)) {
      throw new BadRequestException(
        'Custom order cannot be moved to refund review from its current state',
      );
    }

    const updated = await this.prisma.customOrder.update({
      where: { id },
      data: {
        status: CustomOrderStatus.REFUND_IN_PROGRESS,
        timelineEvents: {
          create: [
            {
              actorType: CustomOrderActorType.ADMIN,
              actorId: adminUserId,
              eventType: 'REFUND_INITIATED',
              payloadJson: {
                reason: dto.reason.trim(),
                note: dto.note?.trim() || null,
                action: 'ESCALATE_REFUND_REVIEW',
              },
            },
          ],
        },
      },
      include: {
        brand: { select: { id: true, name: true, ownerId: true } },
      },
    });

    await this.sideEffects.enqueueNotification({
      customOrderId: id,
      recipientIds: [updated.buyerId],
      notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
      target: this.buyerTarget(id),
      payload: {
        customOrderId: id,
        reason: dto.reason.trim(),
      },
      dedupeMs: 60 * 1000,
    });

    await this.clearAdminAttention(id, adminUserId);

    return {
      statusCode: 200,
      message: 'Custom order moved to refund review',
      data: {
        customOrderId: id,
        status: updated.status,
      },
    };
  }

  async cancelPaidOrder(
    id: string,
    dto: CancelPaidCustomOrderDto,
    adminUserId: string,
  ) {
    const order = await this.prisma.customOrder.findUnique({
      where: { id },
      select: {
        id: true,
        buyerId: true,
        brandId: true,
        status: true,
        paymentStatus: true,
        sourceBrandNameSnapshot: true,
        brand: {
          select: {
            ownerId: true,
          },
        },
      },
    });
    if (!order) {
      throw new NotFoundException('Custom order not found');
    }
    if (order.paymentStatus !== PaymentStatus.PAID) {
      throw new BadRequestException(
        'Only fully paid custom orders can be cancelled from admin',
      );
    }

    const cancellableStatuses = new Set<CustomOrderStatus>([
      CustomOrderStatus.PENDING_BRAND_ACCEPTANCE,
      CustomOrderStatus.ACCEPTED,
      CustomOrderStatus.IN_PRODUCTION,
      CustomOrderStatus.READY_FOR_DISPATCH,
      CustomOrderStatus.IN_TRANSIT,
      CustomOrderStatus.DELIVERED_PENDING_BUYER_CONFIRMATION,
      CustomOrderStatus.DELIVERY_ISSUE_REPORTED,
      CustomOrderStatus.DISPUTED,
      CustomOrderStatus.COMPLETED,
    ]);
    if (!cancellableStatuses.has(order.status)) {
      throw new BadRequestException(
        'Custom order cannot be cancelled from its current state',
      );
    }

    const normalizedReason = dto.reason.trim();
    const normalizedNote = dto.note?.trim() || null;

    const updated = await this.prisma.$transaction(async (tx) => {
      const next = await tx.customOrder.update({
        where: { id },
        data: {
          status: CustomOrderStatus.REFUND_IN_PROGRESS,
          timelineEvents: {
            create: {
              actorType: CustomOrderActorType.ADMIN,
              actorId: adminUserId,
              eventType: 'REFUND_INITIATED',
              payloadJson: {
                reason: normalizedReason,
                note: normalizedNote,
                action: 'SUPER_ADMIN_CANCEL_ORDER',
              } as Prisma.InputJsonValue,
            },
          },
        },
        select: {
          id: true,
          status: true,
          paymentStatus: true,
        },
      });

      await tx.customOrderLedgerAllocation.updateMany({
        where: {
          customOrderId: id,
          status: {
            in: [
              CustomOrderLedgerAllocationStatus.HELD,
              CustomOrderLedgerAllocationStatus.PAYOUT_ELIGIBLE,
            ],
          },
        },
        data: {
          status: CustomOrderLedgerAllocationStatus.REVERSED,
          reversedAt: new Date(),
          reversalReason: 'SUPER_ADMIN_CANCELLED',
        },
      });

      await this.refundService.initiateRefund(tx, {
        customOrderId: id,
        reason: normalizedReason,
        actorType: CustomOrderActorType.ADMIN,
        actorId: adminUserId,
      });

      return next;
    });

    const recipientIds = [order.buyerId, order.brand?.ownerId].filter(
      (recipientId): recipientId is string => Boolean(recipientId),
    );
    if (recipientIds.length > 0) {
      await this.sideEffects.enqueueNotification({
        customOrderId: id,
        recipientIds,
        notificationType: NotificationType.CUSTOM_ORDER_ADMIN_REVIEW_TRIGGERED,
        target: this.buyerTarget(id),
        payload: {
          customOrderId: id,
          reason: normalizedReason,
          message: `A super admin cancelled ${id.slice(0, 8)} and initiated a full refund.`,
        },
        dedupeMs: 60 * 1000,
      });
    }

    await this.clearAdminAttention(id, adminUserId);

    return {
      statusCode: 200,
      message: 'Custom order cancelled and refund initiated',
      data: {
        customOrderId: updated.id,
        status: updated.status,
        paymentStatus: updated.paymentStatus,
      },
    };
  }

  private mapOrderListItem(order: any) {
    const asRecord = (value: unknown): Record<string, unknown> =>
      value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const contactInfo = asRecord(order.contactInfoJson);
    const priceSummary = asRecord(order.buyerPriceSummaryJson);
    const parsedTotal = Number(priceSummary.grandTotal ?? 0);
    const currency =
      typeof order.currency === 'string' && order.currency ? order.currency : 'NGN';

    // Hide stale flags on terminal/anonymized rows so the table badge cannot
    // disagree with the dashboard count (which excludes them at query time).
    const isTerminal =
      order.anonymizedAt != null ||
      TERMINAL_CUSTOM_ORDER_STATUSES.includes(order.status);
    const attentionAt = isTerminal
      ? null
      : (order.adminAttentionRequiredAt ?? null);

    return {
      id: order.id,
      brandId: order.brandId,
      buyerId: order.buyerId,
      status: order.status,
      paymentStatus: order.paymentStatus,
      currentProgressStage: order.currentProgressStage,
      sourceType: order.sourceType,
      sourceId: order.sourceId,
      sourceTitle: order.sourceTitleSnapshot,
      sourceBrandName: order.sourceBrandNameSnapshot,
      sourcePrimaryMediaUrl: order.sourcePrimaryMediaUrlSnapshot ?? null,
      lastBrandProgressUpdateAt: order.lastBrandProgressUpdateAt,
      buyerAcceptanceWindowEndsAt: order.buyerAcceptanceWindowEndsAt,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      currency,
      // Surface the buyer's paid total + who placed it so the admin table shows
      // real money and a named buyer instead of "NGN 0 / No email".
      buyerPriceSummary: {
        grandTotal: Number.isFinite(parsedTotal) ? parsedTotal : 0,
        currency,
      },
      buyer: {
        name:
          typeof contactInfo.customerName === 'string'
            ? contactInfo.customerName
            : null,
        email: typeof contactInfo.email === 'string' ? contactInfo.email : null,
        phone: typeof contactInfo.phone === 'string' ? contactInfo.phone : null,
      },
      // Sticky "needs attention" signal (set by cron/buyer events, cleared by
      // resolving admin actions) powering the dashboard flag + row badge.
      adminAttentionRequiredAt: attentionAt,
      adminAttentionReason: attentionAt
        ? (order.adminAttentionReason ?? null)
        : null,
      brand: order.brand
        ? {
            id: order.brand.id,
            name: order.brand.name,
            ownerId: order.brand.ownerId,
          }
        : undefined,
    };
  }

  /**
   * Clear the sticky "needs admin attention" flag once an admin has taken a
   * concrete resolving action. Idempotent; never fails the parent action.
   */
  private async clearAdminAttention(
    customOrderId: string,
    adminUserId?: string,
  ) {
    await clearAdminAttentionFlag(this.prisma, customOrderId, adminUserId);
  }

  private buyerTarget(customOrderId: string) {
    return {
      type: 'SYSTEM' as const,
      id: `custom-order:${customOrderId}`,
      preview: `/custom-orders/${customOrderId}`,
    };
  }

  private brandTarget(customOrderId: string) {
    return {
      type: 'SYSTEM' as const,
      id: `brand-custom-order:${customOrderId}`,
      preview: `/studio/custom-orders/${customOrderId}`,
    };
  }

  private get detailInclude() {
    // Cap history relations so long-lived orders don't get slower forever.
    // Frontend uses ledgerAllocations from this payload (no second fetch).
    return {
      brand: { select: { id: true, name: true, ownerId: true } },
      progressEvents: {
        orderBy: { changedAt: 'desc' as const },
        take: 50,
      },
      extensionRequests: {
        orderBy: { createdAt: 'desc' as const },
        take: 20,
      },
      timelineEvents: {
        orderBy: { createdAt: 'desc' as const },
        take: 50,
      },
      issues: {
        orderBy: { createdAt: 'desc' as const },
        take: 20,
      },
      disputes: {
        orderBy: { openedAt: 'desc' as const },
        take: 20,
      },
      ledgerAllocations: {
        include: {
          payout: {
            select: {
              id: true,
              status: true,
              amount: true,
              currency: true,
              reference: true,
              createdAt: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' as const },
        take: 50,
      },
    };
  }
}
