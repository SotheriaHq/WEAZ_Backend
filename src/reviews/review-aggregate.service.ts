import { Injectable } from '@nestjs/common';
import { Prisma, ReviewSatisfaction, ReviewStatus, ReviewTargetType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';

export type ReviewAggregateSummary = {
  averageRating: number;
  reviewCount: number;
  ratingBreakdown: Record<1 | 2 | 3 | 4 | 5, number>;
  satisfactionDistribution: Record<ReviewSatisfaction, number>;
};

@Injectable()
export class ReviewAggregateService {
  constructor(private readonly prisma: PrismaService) {}

  async getProductSummary(productId: string) {
    return this.computeSummary({ productId });
  }

  async getCollectionSummary(collectionId: string) {
    return this.computeSummary({ collectionId });
  }

  async getDesignSummary(designId: string) {
    return this.computeSummary({ designId });
  }

  async getBrandSummary(brandId: string) {
    return this.computeSummary({ brandId });
  }

  async getCustomOrderSummary(customOrderId: string) {
    return this.computeSummary({ customOrderId });
  }

  async listPublicReviews(
    where: Prisma.ReviewWhereInput,
    limit: number,
  ) {
    const items = await this.prisma.review.findMany({
      where: {
        ...where,
        status: ReviewStatus.APPROVED,
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });

    return items.map((review) => this.mapPublicReview(review));
  }

  private async computeSummary(
    targetWhere: Prisma.ReviewWhereInput,
  ): Promise<ReviewAggregateSummary> {
    const where = {
      ...targetWhere,
      status: ReviewStatus.APPROVED,
    };

    const [ratingStats, ratingRows, satisfactionRows] = await Promise.all([
      this.prisma.review.aggregate({
        where,
        _avg: { rating: true },
        _count: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['rating'],
        where,
        _count: { rating: true },
      }),
      this.prisma.review.groupBy({
        by: ['satisfaction'],
        where,
        _count: { satisfaction: true },
      }),
    ]);

    const ratingBreakdown: ReviewAggregateSummary['ratingBreakdown'] = {
      1: 0,
      2: 0,
      3: 0,
      4: 0,
      5: 0,
    };
    for (const row of ratingRows) {
      if (row.rating >= 1 && row.rating <= 5) {
        ratingBreakdown[row.rating as 1 | 2 | 3 | 4 | 5] = row._count.rating;
      }
    }

    const satisfactionDistribution = Object.values(ReviewSatisfaction).reduce(
      (result, level) => {
        result[level] = 0;
        return result;
      },
      {} as Record<ReviewSatisfaction, number>,
    );
    for (const row of satisfactionRows) {
      satisfactionDistribution[row.satisfaction] = row._count.satisfaction;
    }

    return {
      averageRating: Math.round((ratingStats._avg.rating ?? 0) * 100) / 100,
      reviewCount: ratingStats._count.rating,
      ratingBreakdown,
      satisfactionDistribution,
    };
  }

  private mapPublicReview(review: {
    id: string;
    reviewerId: string;
    brandId: string | null;
    productId: string | null;
    collectionId: string | null;
    legacyCollectionId: string | null;
    designId: string | null;
    customOrderId: string | null;
    targetType: ReviewTargetType;
    rating: number;
    satisfaction: ReviewSatisfaction;
    reviewText: string | null;
    verifiedPurchase: boolean;
    createdAt: Date;
    editedAt: Date | null;
  }) {
    return {
      id: review.id,
      reviewerId: review.reviewerId,
      brandId: review.brandId,
      productId: review.productId,
      collectionId: review.collectionId,
      legacyCollectionId: review.legacyCollectionId,
      designId: review.designId,
      customOrderId: review.customOrderId,
      targetType: review.targetType,
      rating: review.rating,
      satisfaction: review.satisfaction,
      reviewText: review.reviewText,
      verifiedPurchase: review.verifiedPurchase,
      createdAt: review.createdAt,
      editedAt: review.editedAt,
    };
  }
}
