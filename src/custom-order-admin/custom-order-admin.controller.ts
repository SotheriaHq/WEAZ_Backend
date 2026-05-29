import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { AdminPermissionGuard } from 'src/admin/guards/admin-permission.guard';
import { RequirePermissions } from 'src/admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from 'src/admin/constants/permissions';
import { CustomOrderAdminService } from './custom-order-admin.service';
import {
  AdminCustomOrderReminderDto,
  CancelPaidCustomOrderDto,
  CreateAdminCustomFabricRuleBasisDto,
  EscalateCustomOrderRefundReviewDto,
  QueryAdminCustomFabricRuleBasesDto,
  FlagCustomOrderRiskDto,
  QueryAdminCustomOrdersDto,
  QueryCustomOrderDisputesDto,
  QueryCustomOrderExceptionReviewsDto,
  QueryCustomOrderLedgerAllocationsDto,
  ReleaseCustomOrderLedgerAllocationsDto,
  QueryCustomOrderRefundReviewsDto,
  QueryCustomOrderRiskDashboardDto,
  QueryStaleCustomOrdersDto,
  ReviewCustomFabricRuleBasisDto,
  UpdateCustomOrderRetentionHoldDto,
  DecideCustomOrderExceptionReviewDto,
  UpdateAdminCustomFabricRuleBasisDto,
  UpdateCustomOrderDisputeDto,
} from './dto/custom-order-admin.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class CustomOrderAdminController {
  constructor(private readonly service: CustomOrderAdminService) {}

  @Get('custom-fabric-rule-bases/pending')
  @RequirePermissions(ADMIN_PERMISSIONS.MEASUREMENTS_REVIEW)
  async getPendingBases() {
    return this.service.getPendingBases();
  }

  @Patch('custom-fabric-rule-bases/:id/review')
  @RequirePermissions(ADMIN_PERMISSIONS.MEASUREMENTS_REVIEW)
  async reviewBasis(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ReviewCustomFabricRuleBasisDto,
  ) {
    return this.service.reviewBasis(id, dto, req.user.id);
  }

  @Get('custom-fabric-rule-bases')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_READ)
  async listBases(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryAdminCustomFabricRuleBasesDto,
  ) {
    return this.service.listBases(query);
  }

  @Post('custom-fabric-rule-bases')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  async createBasis(
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CreateAdminCustomFabricRuleBasisDto,
  ) {
    return this.service.createBasis(dto, req.user.id);
  }

  @Patch('custom-fabric-rule-bases/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  async updateBasis(
    @Param('id') id: string,
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: UpdateAdminCustomFabricRuleBasisDto,
  ) {
    return this.service.updateBasis(id, dto);
  }

  @Delete('custom-fabric-rule-bases/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.TAXONOMY_WRITE)
  async deleteBasis(@Param('id') id: string) {
    return this.service.deleteBasis(id);
  }

  @Get('custom-orders/summary')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async getSummary() {
    return this.service.getSummary();
  }

  @Get('custom-orders/risk-dashboard')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async getRiskDashboard(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryCustomOrderRiskDashboardDto,
  ) {
    return this.service.getRiskDashboard(query);
  }

  @Get('custom-orders/refund-reviews')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_READ)
  async listRefundReviews(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryCustomOrderRefundReviewsDto,
  ) {
    return this.service.listRefundReviews(query);
  }

  @Get('custom-orders/refund-reviews/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_READ)
  async getRefundReview(@Param('id') id: string) {
    return this.service.getRefundReview(id);
  }

  @Get('custom-orders/stale')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async getStaleOrders(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryStaleCustomOrdersDto,
  ) {
    return this.service.getStaleOrders(query);
  }

  @Get('custom-orders')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async listOrders(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryAdminCustomOrdersDto,
  ) {
    return this.service.listOrders(query);
  }

  @Get('custom-orders/exception-reviews')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async listExceptionReviews(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryCustomOrderExceptionReviewsDto,
  ) {
    return this.service.listExceptionReviews(query);
  }

  @Post('custom-orders/:id/exception-reviews/:eventId/decide')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
  async decideExceptionReview(
    @Param('id') id: string,
    @Param('eventId') eventId: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: DecideCustomOrderExceptionReviewDto,
  ) {
    return this.service.decideExceptionReview(id, eventId, dto, req.user.id);
  }

  @Get('custom-orders/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
  async getOrder(@Param('id') id: string) {
    return this.service.getOrder(id);
  }

  @Post('custom-orders/:id/remind-brand')
  @RequirePermissions(
    ADMIN_PERMISSIONS.MODERATION_WRITE,
    ADMIN_PERMISSIONS.NOTIFICATIONS_SEND,
  )
  async remindBrand(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: AdminCustomOrderReminderDto,
  ) {
    return this.service.remindBrand(id, dto, req.user.id);
  }

  @Post('custom-orders/:id/flag-risk')
  @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
  async flagRisk(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: FlagCustomOrderRiskDto,
  ) {
    return this.service.flagRisk(id, dto, req.user.id);
  }

  @Post('custom-orders/:id/escalate-refund-review')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  async escalateRefundReview(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: EscalateCustomOrderRefundReviewDto,
  ) {
    return this.service.escalateRefundReview(id, dto, req.user.id);
  }

  @Post('custom-orders/:id/cancel')
  @Roles(Role.SuperAdmin)
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  async cancelPaidOrder(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: CancelPaidCustomOrderDto,
  ) {
    return this.service.cancelPaidOrder(id, dto, req.user.id);
  }

  @Get('custom-order-disputes')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_READ)
  async listDisputes(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryCustomOrderDisputesDto,
  ) {
    return this.service.listDisputes(query);
  }

  @Get('custom-order-ledger-allocations')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_READ)
  async listLedgerAllocations(
    @Query(new ValidationPipe({ transform: true, whitelist: true }))
    query: QueryCustomOrderLedgerAllocationsDto,
  ) {
    return this.service.listLedgerAllocations(query);
  }

  @Post('custom-order-ledger-allocations/release')
  @RequirePermissions(ADMIN_PERMISSIONS.PAYOUTS_PROCESS)
  async releaseLedgerAllocations(
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: ReleaseCustomOrderLedgerAllocationsDto,
  ) {
    return this.service.releaseEligibleLedgerAllocations(dto, req.user.id);
  }

  @Patch('custom-order-disputes/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.DISPUTES_RESOLVE)
  async updateDispute(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: UpdateCustomOrderDisputeDto,
  ) {
    return this.service.updateDispute(id, dto, req.user.id);
  }

  @Patch('custom-orders/:id/retention-hold')
  @RequirePermissions(ADMIN_PERMISSIONS.SYSTEM_DATA_RETENTION_WRITE)
  async updateRetentionHold(
    @Param('id') id: string,
    @Req() req: Request & { user: { id: string } },
    @Body(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    )
    dto: UpdateCustomOrderRetentionHoldDto,
  ) {
    return this.service.updateRetentionHold(id, dto, req.user.id);
  }
}
