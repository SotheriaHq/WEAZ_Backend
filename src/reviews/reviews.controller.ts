import {
    Controller,
    Get,
    Post,
    Patch,
    Delete,
    Param,
    Body,
    Query,
    Req,
    UseGuards,
    ValidationPipe,
    HttpCode,
    HttpStatus,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { ReviewsService } from './reviews.service';
import {
    CreateProductReviewDto,
    UpdateProductReviewDto,
    ReviewQueryDto,
    ReportReviewDto,
} from './dto';

@Controller('store')
export class ReviewsController {
    constructor(private readonly reviewsService: ReviewsService) { }

    /**
     * GET /store/products/:productId/reviews
     * Public product review feed with cursor pagination.
     */
    @Get('products/:productId/reviews')
    async getProductReviews(
        @Param('productId') productId: string,
        @Query(new ValidationPipe({ transform: true })) query: ReviewQueryDto,
        @Req() req: any,
    ) {
        const viewerId = req.user?.id;
        return this.reviewsService.getProductReviews(productId, query, viewerId);
    }

    /**
     * POST /store/reviews
     * Create a product review (requires auth + verified buyer).
     */
    @UseGuards(JwtAuthGuard)
    @Post('reviews')
    async createReview(
        @Body(ValidationPipe) dto: CreateProductReviewDto,
        @Req() req: any,
    ) {
        return this.reviewsService.createReview(req.user.id, dto);
    }

    /**
     * PATCH /store/reviews/:reviewId
     * Update own review.
     */
    @UseGuards(JwtAuthGuard)
    @Patch('reviews/:reviewId')
    async updateReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: UpdateProductReviewDto,
        @Req() req: any,
    ) {
        return this.reviewsService.updateReview(req.user.id, reviewId, dto);
    }

    /**
     * DELETE /store/reviews/:reviewId
     * Soft-delete own review.
     */
    @UseGuards(JwtAuthGuard)
    @Delete('reviews/:reviewId')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteReview(
        @Param('reviewId') reviewId: string,
        @Req() req: any,
    ) {
        await this.reviewsService.deleteReview(req.user.id, reviewId);
    }

    /**
     * POST /store/reviews/:reviewId/helpful
     * Mark a review as helpful.
     */
    @UseGuards(JwtAuthGuard)
    @Post('reviews/:reviewId/helpful')
    @HttpCode(HttpStatus.NO_CONTENT)
    async addHelpfulVote(
        @Param('reviewId') reviewId: string,
        @Req() req: any,
    ) {
        await this.reviewsService.addHelpfulVote(req.user.id, reviewId);
    }

    /**
     * DELETE /store/reviews/:reviewId/helpful
     * Remove helpful vote.
     */
    @UseGuards(JwtAuthGuard)
    @Delete('reviews/:reviewId/helpful')
    @HttpCode(HttpStatus.NO_CONTENT)
    async removeHelpfulVote(
        @Param('reviewId') reviewId: string,
        @Req() req: any,
    ) {
        await this.reviewsService.removeHelpfulVote(req.user.id, reviewId);
    }

    /**
     * POST /store/reviews/:reviewId/report
     * Report a review.
     */
    @UseGuards(JwtAuthGuard)
    @Post('reviews/:reviewId/report')
    @HttpCode(HttpStatus.NO_CONTENT)
    async reportReview(
        @Param('reviewId') reviewId: string,
        @Body(ValidationPipe) dto: ReportReviewDto,
        @Req() req: any,
    ) {
        await this.reviewsService.reportReview(req.user.id, reviewId, dto);
    }
}
