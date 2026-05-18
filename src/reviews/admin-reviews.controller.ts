import {
    Controller,
    Get,
    Patch,
    Param,
    Body,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
} from '@nestjs/common';
import { Role } from '@prisma/client';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { RolesGuard } from '../auth/guard/role.guard';
import { Roles } from '../auth/decorator/roles.decorator';
import { AdminPermissionGuard } from '../admin/guards/admin-permission.guard';
import { RequirePermissions } from '../admin/decorators/require-permissions.decorator';
import { ADMIN_PERMISSIONS } from '../admin/constants/permissions';
import { ReviewsService } from './reviews.service';
import { AdminModerationDto, AdminReviewStatusDto } from './dto';

@Controller('admin/reviews')
@UseGuards(JwtAuthGuard, RolesGuard, AdminPermissionGuard)
@Roles(Role.SuperAdmin, Role.Admin)
export class AdminReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    /**
     * GET /admin/reviews
     * Admin review list with optional status filter.
     */
    @Get()
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
    async getReviews(
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
        @Query('status') status?: string,
    ) {
        return this.reviewsService.adminGetReviews({
            cursor,
            limit: limit ? parseInt(limit, 10) : undefined,
            status,
        });
    }

    /**
     * GET /admin/reviews/reports
     * Admin report queue.
     */
    @Get('reports')
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_READ)
    async getReports(
        @Query('cursor') cursor?: string,
        @Query('limit') limit?: string,
    ) {
        return this.reviewsService.adminGetReports({
            cursor,
            limit: limit ? parseInt(limit, 10) : undefined,
        });
    }

    /**
     * PATCH /admin/reviews/:reviewId/moderation
     * Admin moderates a review (keep/hide/restore/delete).
     */
    @Patch(':reviewId/moderation')
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
    async moderateReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: AdminModerationDto,
        @Req() req: any,
    ) {
        return this.reviewsService.adminModerateReview(
            req.user.id,
            reviewId,
            dto,
            req,
        );
    }

    @Patch(':reviewId/hide')
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
    async hideLifecycleReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: AdminReviewStatusDto,
        @Req() req: any,
    ) {
        return this.reviewsService.adminHideLifecycleReview(
            req.user.id,
            reviewId,
            dto.reason,
            req,
        );
    }

    @Patch(':reviewId/approve')
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
    async approveLifecycleReview(
        @Param('reviewId') reviewId: string,
        @Req() req: any,
    ) {
        return this.reviewsService.adminApproveLifecycleReview(
            req.user.id,
            reviewId,
            req,
        );
    }

    @Patch(':reviewId/flag')
    @RequirePermissions(ADMIN_PERMISSIONS.MODERATION_WRITE)
    async flagLifecycleReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: AdminReviewStatusDto,
        @Req() req: any,
    ) {
        return this.reviewsService.adminFlagLifecycleReview(
            req.user.id,
            reviewId,
            dto.reason,
            req,
        );
    }
}
