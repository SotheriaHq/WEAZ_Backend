import {
    Body,
    Controller,
    Delete,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Patch,
    Post,
    Query,
    Req,
    UseGuards,
    UseInterceptors,
    ValidationPipe,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/guard/jwt-auth.guard';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import { CreateReviewDto, ReviewQueryDto, UpdateReviewDto } from './dto';
import { ReviewsService } from './reviews.service';

@Controller('reviews')
export class ReviewLifecycleController {
    constructor(private readonly reviewsService: ReviewsService) {}

    @UseGuards(JwtAuthGuard)
    @Get('prompts')
    async getPrompts(@Req() req: any) {
        return this.reviewsService.getReviewPrompts(req.user.id);
    }

    @UseGuards(JwtAuthGuard)
    @Get('eligibility')
    async getEligibility(
        @Req() req: any,
        @Query('orderId') orderId?: string,
        @Query('customOrderId') customOrderId?: string,
    ) {
        return this.reviewsService.getReviewEligibility(req.user.id, {
            orderId,
            customOrderId,
        });
    }

    @UseGuards(JwtAuthGuard)
    @UseInterceptors(IdempotencyInterceptor)
    @Post()
    async createReview(
        @Req() req: any,
        @Body(ValidationPipe) dto: CreateReviewDto,
    ) {
        return this.reviewsService.submitLifecycleReview(req.user.id, dto);
    }

    @UseGuards(JwtAuthGuard)
    @UseInterceptors(IdempotencyInterceptor)
    @Patch(':id')
    async updateReview(
        @Req() req: any,
        @Param('id') id: string,
        @Body(ValidationPipe) dto: UpdateReviewDto,
    ) {
        return this.reviewsService.updateLifecycleReview(req.user.id, id, dto);
    }

    @UseGuards(JwtAuthGuard)
    @UseInterceptors(IdempotencyInterceptor)
    @Delete(':id')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deleteReview(@Req() req: any, @Param('id') id: string) {
        await this.reviewsService.deleteLifecycleReview(req.user.id, id);
    }

    @UseGuards(JwtAuthGuard)
    @UseInterceptors(IdempotencyInterceptor)
    @Post('prompts/:id/skip')
    async skipPrompt(@Req() req: any, @Param('id') id: string) {
        return this.reviewsService.skipReviewPrompt(req.user.id, id);
    }

    @Get('product/:productId')
    async getProductReviews(
        @Param('productId') productId: string,
        @Query(new ValidationPipe({ transform: true })) query: ReviewQueryDto,
    ) {
        return this.reviewsService.getLifecycleProductReviews(productId, query);
    }

    @Get('collection/:collectionId')
    async getCollectionReviews(
        @Param('collectionId') collectionId: string,
        @Query(new ValidationPipe({ transform: true })) query: ReviewQueryDto,
    ) {
        return this.reviewsService.getLifecycleCollectionReviews(collectionId, query);
    }

    @Get('design/:designId')
    async getDesignReviews(
        @Param('designId') designId: string,
        @Query(new ValidationPipe({ transform: true })) query: ReviewQueryDto,
    ) {
        return this.reviewsService.getLifecycleDesignReviews(designId, query);
    }

    @Get('brand/:brandId/summary')
    async getBrandSummary(@Param('brandId') brandId: string) {
        return this.reviewsService.getLifecycleBrandSummary(brandId);
    }
}
