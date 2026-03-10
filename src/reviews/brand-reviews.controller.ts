import {
    Controller,
    Get,
    Patch,
    Post,
    Param,
    Body,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
    BadRequestException,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType } from '@prisma/client';
import { ReviewsService } from './reviews.service';
import { ReviewQueryDto, ReplyToProductReviewDto, ReportReviewDto } from './dto';

@Controller('brands')
export class BrandReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    /**
     * GET /brands/:brandId/reviews
     * Public brand review feed.
     */
    @Get(':brandId/reviews')
    async getBrandReviews(
        @Param('brandId') brandId: string,
        @Query(new ValidationPipe({ transform: true })) query: ReviewQueryDto,
        @Req() req: any,
    ) {
        const viewerId = req.user?.id;
        return this.reviewsService.getBrandReviews(brandId, query, viewerId);
    }

    /**
     * PATCH /brands/reviews/:reviewId/reply
     * Brand owner replies to a review.
     */
    @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
    @Patch('reviews/:reviewId/reply')
    async replyToReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: ReplyToProductReviewDto,
        @Req() req: any,
    ) {
        // Look up the brand by owner
        const brand = await this.getBrandForUser(req.user.id);
        return this.reviewsService.replyToReview(brand.id, reviewId, dto);
    }

    /**
     * POST /brands/reviews/:reviewId/report
     * Brand reports a review.
     */
    @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
    @Post('reviews/:reviewId/report')
    @HttpCode(HttpStatus.NO_CONTENT)
    async reportReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: ReportReviewDto,
        @Req() req: any,
    ) {
        const brand = await this.getBrandForUser(req.user.id);
        await this.reviewsService.reportReview(
            req.user.id,
            reviewId,
            dto,
            brand.id,
        );
    }

    /**
     * Helper: resolve brand from user ID.
     * Brand controller routes are user-type-guarded, so user.id -> brand.ownerId.
     */
    private async getBrandForUser(userId: string) {
        // We inject PrismaService indirectly through ReviewsService,
        // but we need a clean lookup here. Use a lightweight approach:
        // The ReviewsService has prisma, but we should keep controller thin.
        // For V1, we rely on the fact that brand owner ID = user ID in the existing pattern.
        // The existing brands controller uses req.user.id === brandId (owner ID = brand ID pattern).
        // We follow the same pattern.
        return { id: userId };
    }
}
