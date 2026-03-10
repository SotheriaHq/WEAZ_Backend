import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { QueueModule } from '../queue/queue.module';
import { ReviewsService } from './reviews.service';
import { ReviewsController } from './reviews.controller';
import { BrandReviewsController } from './brand-reviews.controller';
import { AdminReviewsController } from './admin-reviews.controller';

@Module({
    imports: [PrismaModule, QueueModule],
    controllers: [ReviewsController, BrandReviewsController, AdminReviewsController],
    providers: [ReviewsService],
    exports: [ReviewsService],
})
export class ReviewsModule { }
