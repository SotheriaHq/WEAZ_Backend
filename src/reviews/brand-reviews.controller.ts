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
    UseInterceptors,
    ValidationPipe,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { UserTypeGuard } from '../auth/guard/user-type.guard';
import { UserType } from '@prisma/client';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
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
    @UseInterceptors(IdempotencyInterceptor)
    @Patch('reviews/:reviewId/reply')
    async replyToReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: ReplyToProductReviewDto,
        @Req() req: any,
    ) {
        const brandId = await this.reviewsService.getBrandIdForOwner(req.user.id);
        return this.reviewsService.replyToReview(brandId, reviewId, dto);
    }

    /**
     * POST /brands/reviews/:reviewId/report
     * Brand reports a review.
     */
    @UseGuards(JwtAuthGuard, new UserTypeGuard(UserType.BRAND))
    @UseInterceptors(IdempotencyInterceptor)
    @Post('reviews/:reviewId/report')
    @HttpCode(HttpStatus.NO_CONTENT)
    async reportReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: ReportReviewDto,
        @Req() req: any,
    ) {
        const brandId = await this.reviewsService.getBrandIdForOwner(req.user.id);
        await this.reviewsService.reportReview(
            req.user.id,
            reviewId,
            dto,
            brandId,
        );
    }
}
