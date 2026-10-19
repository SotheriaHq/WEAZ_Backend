import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseEnumPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  UsePipes,
  ValidationPipe,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Role, SubscriptionTierKey } from '@prisma/client';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS as P } from 'src/admin/constants/permissions';
import { PrismaService } from 'src/prisma/prisma.service';
import { CustomOrderQueueService } from './custom-order-queue.service';
import { CustomOrderQueueRefundsService } from './custom-order-queue-refunds.service';
import {
  QueuePublishNoticeDto,
  QueueReconcileRefundDto,
  QueueReconcileLaneDto,
  QueueRefundListDto,
} from './custom-order-queue.dto';
import {
  QueueAssignTierDto,
  QueueCampaignDto,
  QueueCancelManyDto,
  QueueIdsDto,
  QueueIntakeDto,
  QueueNoticeDto,
  QueueOverrideDto,
  QueueReasonDto,
  QueueRevisionDto,
  QueueSettingsDto,
  QueueTierDto,
} from './custom-order-queue.dto';

type ActorRequest = { user: { id: string; role: Role } };
const validation = new ValidationPipe({
  transform: true,
  whitelist: true,
  forbidNonWhitelisted: true,
});

@Controller('custom-orders/queue')
@UseGuards(JwtAuthGuard)
@UsePipes(validation)
export class CustomOrderQueueController {
  constructor(private readonly queue: CustomOrderQueueService) {}
  @Get('brands/:brandId') summary(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
  ) {
    return this.queue.summary(brandId, req.user.id);
  }
  @Post('summaries') @Throttle({ default: { limit: 30, ttl: 60000 } }) batch(
    @Req() req: ActorRequest,
    @Body() dto: QueueIdsDto,
  ) {
    return this.queue.batch(req.user.id, dto.orderIds);
  }
  @Get('notices') notices(@Req() req: ActorRequest) {
    return this.queue.notices(req.user.id);
  }
  @Get('orders/:id') get(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queue.get(req.user.id, id);
  }
  @Get('orders/:id/refund-quote') quote(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.queue.refundQuote(req.user.id, id);
  }
  @Post('orders/:id/retain')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  retain(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueRevisionDto,
  ) {
    return this.queue.retain(req.user.id, id, dto.expectedRevision);
  }
  @Post('orders/:id/cancel')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  cancel(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReasonDto,
  ) {
    return this.queue.cancel(req.user.id, id, dto.reason, dto.expectedRevision);
  }
  @Post('orders/:id/resubmit')
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  resubmit(@Req() req: ActorRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.queue.resubmit(req.user.id, id);
  }
  @Post('brands/:brandId/cancel-many')
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  bulk(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: QueueCancelManyDto,
  ) {
    return this.queue.cancelMany(
      req.user.id,
      brandId,
      dto.orderIds,
      dto.reason,
    );
  }
  @Patch('brands/:brandId/settings') settings(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: QueueSettingsDto,
  ) {
    return this.queue.settings(req.user.id, brandId, dto.queueJumpEnabled);
  }
}

@Controller('admin/custom-order-queue')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
@UsePipes(validation)
export class AdminCustomOrderQueueController {
  constructor(
    private readonly queue: CustomOrderQueueService,
    private readonly prisma: PrismaService,
    private readonly refunds: CustomOrderQueueRefundsService,
  ) {}
  @Get('refunds') @RequirePermissions(P.DISPUTES_REFUND) async pendingRefunds(
    @Query() dto: QueueRefundListDto,
  ) {
    const rows = await this.prisma.customOrderQueueRefund.findMany({
      where: { status: { not: 'SETTLED' } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      ...(dto.cursor ? { cursor: { id: dto.cursor }, skip: 1 } : {}),
      take: 101,
      select: {
        id: true,
        customOrderId: true,
        kind: true,
        amount: true,
        currency: true,
        status: true,
        providerRefundId: true,
        lastError: true,
        createdAt: true,
      },
    });
    return {
      refunds: rows.slice(0, 100),
      nextCursor: rows.length > 100 ? rows[99].id : null,
    };
  }
  @Post('refunds/:id/reconcile')
  @RequirePermissions(P.DISPUTES_REFUND)
  @Throttle({ default: { limit: 3, ttl: 60000 } })
  async reconcile(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReconcileRefundDto,
  ) {
    return this.refunds.reconcile(id, dto.providerRefundId, req.user.id);
  }
  @Get('brands/:brandId') @RequirePermissions(P.BRANDS_READ) summary(
    @Param('brandId', ParseUUIDPipe) id: string,
  ) {
    return this.queue.summary(id);
  }
  @Get('orders/:id/refund-quote')
  @RequirePermissions(P.DISPUTES_REFUND)
  async quote(@Param('id', ParseUUIDPipe) id: string) {
    return this.queue.quoteWithSettlement(
      await this.prisma.customOrder.findUniqueOrThrow({ where: { id } }),
    );
  }
  @Post('orders/:id/promote') @RequirePermissions(P.MODERATION_WRITE) promote(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReasonDto,
  ) {
    return this.queue.reorder(
      id,
      'promote',
      req.user.id,
      dto.reason,
      dto.expectedRevision,
    );
  }
  @Post('orders/:id/reconcile-lane')
  @RequirePermissions(P.MODERATION_WRITE)
  reconcileLane(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReconcileLaneDto,
  ) {
    return this.queue.reconcileHistoricalLane(
      id,
      dto.lane,
      dto.evidence,
      dto.expectedRevision,
      req.user.id,
    );
  }
  @Post('orders/:id/demote') @RequirePermissions(P.MODERATION_WRITE) demote(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReasonDto,
  ) {
    return this.queue.reorder(
      id,
      'demote',
      req.user.id,
      dto.reason,
      dto.expectedRevision,
    );
  }
  @Post('orders/:id/release-hold')
  @RequirePermissions(P.MODERATION_WRITE)
  release(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReasonDto,
  ) {
    return this.queue.reorder(
      id,
      'release-hold',
      req.user.id,
      dto.reason,
      dto.expectedRevision,
    );
  }
  @Post('orders/:id/cancel')
  @RequirePermissions(P.DISPUTES_REFUND)
  @Throttle({ default: { limit: 5, ttl: 60000 } })
  cancel(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueueReasonDto,
  ) {
    return this.queue.cancel(
      req.user.id,
      id,
      dto.reason,
      dto.expectedRevision,
      'ADMIN',
    );
  }
  @Patch('brands/:brandId/intake')
  @RequirePermissions(P.BRANDS_SUSPEND)
  async intake(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: QueueIntakeDto,
  ) {
    await this.prisma.$transaction(async (tx) => {
      const now = await this.queue.lockBrand(tx, brandId);
      await tx.brand.update({
        where: { id: brandId },
        data: {
          customOrderIntakeBlockedAt: dto.blocked ? now : null,
          customOrderIntakeBlockedById: dto.blocked ? req.user.id : null,
          customOrderIntakeBlockReason: dto.blocked ? dto.reason : null,
        },
      });
      await this.queue.audit(
        tx,
        req.user.id,
        dto.blocked ? 'queue.intake.block' : 'queue.intake.unblock',
        brandId,
        { reason: dto.reason },
      );
    });
    return this.queue.summary(brandId);
  }
  @Patch('brands/:brandId/override')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async override(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: QueueOverrideDto,
  ) {
    if (dto.activeCap === undefined)
      throw new BadRequestException('An Active cap or null is required');
    if (dto.expiresAt && new Date(dto.expiresAt) <= new Date())
      throw new BadRequestException('Override expiry must be in the future');
    await this.prisma.$transaction(async (tx) => {
      await this.queue.lockBrand(tx, brandId);
      await tx.brand.update({
        where: { id: brandId },
        data: {
          activeOrderCapOverride: dto.activeCap,
          activeOrderCapOverrideUntil: dto.expiresAt
            ? new Date(dto.expiresAt)
            : null,
        },
      });
      await this.queue.audit(
        tx,
        req.user.id,
        'queue.capacity.override',
        brandId,
        { ...dto },
      );
    });
    return this.queue.summary(brandId);
  }
  @Post('brands/:brandId/assign-tier')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async assign(
    @Req() req: ActorRequest,
    @Param('brandId', ParseUUIDPipe) brandId: string,
    @Body() dto: QueueAssignTierDto,
  ) {
    if (dto.tierKey === 'LEGACY')
      throw new BadRequestException('Legacy is not a sold subscription');
    await this.prisma.$transaction(async (tx) => {
      await this.queue.lockBrand(tx, brandId);
      await tx.brand.update({
        where: { id: brandId },
        data: { assignedSubscriptionTierKey: dto.tierKey },
      });
      await this.queue.audit(
        tx,
        req.user.id,
        'queue.subscription.assign-offer',
        brandId,
        { ...dto },
      );
    });
    return {
      ...(await this.queue.summary(brandId)),
      assignedTierKey: dto.tierKey,
    };
  }
  @Get('tiers') @RequirePermissions(P.BRANDS_READ) async tiers() {
    return {
      tiers: (
        await this.prisma.subscriptionTier.findMany({
          where: { key: { not: 'LEGACY' } },
          orderBy: { monthlyPriceNgn: 'asc' },
        })
      ).map((tier) => ({ ...tier, tierKey: tier.key, label: tier.name })),
    };
  }
  @Patch('tiers/:key') @RequirePermissions(P.BRANDS_STORE_OVERRIDE) async tier(
    @Req() req: ActorRequest,
    @Param('key', new ParseEnumPipe(SubscriptionTierKey))
    key: SubscriptionTierKey,
    @Body() dto: QueueTierDto,
  ) {
    if (
      key === 'LEGACY' ||
      !Object.keys(dto).length ||
      Object.values(dto).some((value) => value === null)
    )
      throw new BadRequestException('Invalid tier changes');
    if (dto.monthlyPriceNgn !== undefined && req.user.role !== Role.SuperAdmin)
      throw new ForbiddenException(
        'Only a super admin may change subscription prices',
      );
    const { expectedUpdatedAt, ...changes } = dto;
    if (!Object.keys(changes).length)
      throw new BadRequestException('No tier changes supplied');
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "key" FROM "SubscriptionTier" WHERE "key" = ${key}::"SubscriptionTierKey" FOR UPDATE`;
      const previous = await tx.subscriptionTier.findUniqueOrThrow({
        where: { key },
      });
      if (
        expectedUpdatedAt &&
        previous.updatedAt.toISOString() !==
          new Date(expectedUpdatedAt).toISOString()
      )
        throw new ConflictException(
          'Subscription tier changed; refresh before saving',
        );
      await tx.subscriptionTier.update({ where: { key }, data: changes });
      await this.queue.audit(tx, req.user.id, 'queue.tier.update', key, {
        previous,
        next: changes,
      });
    });
    return this.tiers();
  }
  @Get('campaigns') @RequirePermissions(P.BRANDS_READ) async campaigns() {
    return {
      campaigns: await this.prisma.capacityCampaign.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
  @Post('campaigns')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async campaign(@Req() req: ActorRequest, @Body() dto: QueueCampaignDto) {
    if (new Date(dto.endsAt) <= new Date(dto.startsAt))
      throw new BadRequestException('Campaign end must follow start');
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('custom-order-capacity-campaign'))`;
      const overlaps = await tx.capacityCampaign.findFirst({
        where: {
          resetAt: null,
          startsAt: { lt: new Date(dto.endsAt) },
          OR: [
            { resetMode: 'MANUAL' },
            { endsAt: { gt: new Date(dto.startsAt) } },
          ],
        },
      });
      if (overlaps)
        throw new BadRequestException(
          'A capacity campaign already overlaps this period; reset it first',
        );
      const created = await tx.capacityCampaign.create({
        data: {
          ...dto,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          createdById: req.user.id,
        },
      });
      await this.queue.audit(
        tx,
        req.user.id,
        'queue.campaign.create',
        created.id,
        { ...dto },
      );
      return created;
    });
  }
  @Post('campaigns/:id/reset')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async reset(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.capacityCampaign.update({
        where: { id },
        data: { resetAt: new Date() },
      });
      await this.queue.audit(tx, req.user.id, 'queue.campaign.reset', id, {});
      return updated;
    });
  }
  @Get('notices') @RequirePermissions(P.BRANDS_READ) async notices() {
    return {
      notices: await this.prisma.runwayBrandNotice.findMany({
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
  @Post('notices') @RequirePermissions(P.BRANDS_STORE_OVERRIDE) async notice(
    @Req() req: ActorRequest,
    @Body() dto: QueueNoticeDto,
  ) {
    if (new Date(dto.endsAt) <= new Date(dto.startsAt))
      throw new BadRequestException('Notice end must follow start');
    return this.prisma.$transaction(async (tx) => {
      const created = await tx.runwayBrandNotice.create({
        data: {
          title: dto.title,
          body: dto.body,
          kind: dto.kind,
          startsAt: new Date(dto.startsAt),
          endsAt: new Date(dto.endsAt),
          publishedAt: dto.published === false ? null : new Date(),
          createdById: req.user.id,
        },
      });
      await this.queue.audit(
        tx,
        req.user.id,
        'queue.notice.publish',
        created.id,
        { title: dto.title },
      );
      return created;
    });
  }
  @Post('notices/:id/end')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async end(@Req() req: ActorRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.runwayBrandNotice.update({
        where: { id },
        data: { endedAt: new Date() },
      });
      await this.queue.audit(tx, req.user.id, 'queue.notice.end', id, {});
      return updated;
    });
  }
  @Patch('notices/:id')
  @RequirePermissions(P.BRANDS_STORE_OVERRIDE)
  async publish(
    @Req() req: ActorRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: QueuePublishNoticeDto,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.runwayBrandNotice.findUniqueOrThrow({
        where: { id },
      });
      if (dto.published && (current.endedAt || current.endsAt <= new Date()))
        throw new BadRequestException('An ended notice cannot be published');
      const updated = await tx.runwayBrandNotice.update({
        where: { id },
        data: { publishedAt: dto.published ? new Date() : null },
      });
      await this.queue.audit(tx, req.user.id, 'queue.notice.publish', id, {
        published: dto.published,
      });
      return updated;
    });
  }
}
