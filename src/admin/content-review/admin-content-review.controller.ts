import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { Roles } from 'src/auth/decorator/roles.decorator';
import { JwtAuthGuard } from 'src/auth/guard/jwt-auth.guard';
import { RolesGuard } from 'src/auth/guard/role.guard';
import { ADMIN_PERMISSIONS } from '../constants/permissions';
import { RequirePermissions } from '../decorators/require-permissions.decorator';
import { AdminPermissionGuard } from '../guards/admin-permission.guard';
import { AdminContentReviewService } from './admin-content-review.service';
import {
  BrandTrustOverrideDto,
  ContentReviewDecisionDto,
  ContentReviewQueryDto,
} from './dto/content-review.dto';

@Controller('admin/content-review')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminContentReviewController {
  constructor(private readonly reviewService: AdminContentReviewService) {}

  @Get('reason-codes')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_READ)
  reasonCodes() {
    return this.reviewService.getReasonCodes();
  }

  @Get('submissions')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_READ)
  listSubmissions(@Query() query: ContentReviewQueryDto) {
    return this.reviewService.listSubmissions(query);
  }

  @Get('submissions/:id')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_READ)
  getSubmission(@Param('id') id: string) {
    return this.reviewService.getSubmission(id);
  }

  @Patch('submissions/:id/approve')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE)
  approveSubmission(@Param('id') id: string, @Req() req: Request) {
    const actorId = (req as any).user.sub;
    return this.reviewService.approveSubmission(id, actorId, req);
  }

  @Patch('submissions/:id/reject')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE)
  rejectSubmission(
    @Param('id') id: string,
    @Body() dto: ContentReviewDecisionDto,
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.reviewService.rejectSubmission(id, actorId, dto, req);
  }

  @Patch('submissions/:id/request-changes')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE)
  requestChanges(
    @Param('id') id: string,
    @Body() dto: ContentReviewDecisionDto,
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.reviewService.requestChanges(id, actorId, dto, req);
  }

  @Patch('brands/:brandId/trust')
  @RequirePermissions(ADMIN_PERMISSIONS.CONTENT_REVIEW_MANAGE)
  setBrandTrustOverride(
    @Param('brandId') brandId: string,
    @Body() dto: BrandTrustOverrideDto,
    @Req() req: Request,
  ) {
    const actorId = (req as any).user.sub;
    return this.reviewService.setBrandTrustOverride(
      brandId,
      actorId,
      dto,
      req,
    );
  }
}
