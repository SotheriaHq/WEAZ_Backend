import { ProductReview, ProductReviewStatus, User, Brand } from '@prisma/client';

/**
 * Canonical reviewer object for review responses.
 * Follows BRD §4.8: identity from user table, not component-local logic.
 */
export interface ReviewerPayload {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
    profileImage: string | null;
    profileImageId: string | null;
    profileImageFile: { id: string; s3Url: string } | null;
}

export interface ReviewMediaItem {
    id: string;
    url: string;
    type: 'image' | 'video';
}

export interface BrandReplyPayload {
    content: string;
    brandId: string;
    brandName: string;
    createdAt: string;
    updatedAt: string | null;
}

export interface ProductReviewResponse {
    id: string;
    rating: number;
    title: string | null;
    content: string;
    helpfulCount: number;
    viewerHasMarkedHelpful: boolean;
    status: 'PUBLISHED';
    createdAt: string;
    updatedAt: string;
    editedAt: string | null;
    variantSummary: string | null;
    media: ReviewMediaItem[];
    reviewer: ReviewerPayload;
    brandReply: BrandReplyPayload | null;
}

export interface ProductReviewListResponse {
    items: ProductReviewResponse[];
    summary: {
        averageRating: number;
        totalReviews: number;
        ratingBreakdown: { 1: number; 2: number; 3: number; 4: number; 5: number };
    };
    nextCursor: string | null;
}

// Full prisma review with includes
type ReviewWithIncludes = ProductReview & {
    user: Pick<
        User,
        | 'id'
        | 'username'
        | 'firstName'
        | 'lastName'
        | 'profileImage'
        | 'profileImageId'
    > & {
        profileImageFile?: { id: string; s3Url: string } | null;
    };
    brand: Pick<Brand, 'id' | 'name'>;
    helpfulVotes?: Array<{ userId: string }>;
};

/**
 * Builds a variant summary from snapshots, e.g. "Size: M / Color: Navy"
 */
function buildVariantSummary(
    size: string | null | undefined,
    color: string | null | undefined,
): string | null {
    const parts: string[] = [];
    if (size) parts.push(`Size: ${size}`);
    if (color) parts.push(`Color: ${color}`);
    return parts.length > 0 ? parts.join(' / ') : null;
}

/**
 * Maps a Prisma ProductReview (with includes) to the public API response shape.
 * viewerUserId determines viewerHasMarkedHelpful.
 */
export function mapReviewToResponse(
    review: ReviewWithIncludes,
    viewerUserId?: string,
): ProductReviewResponse {
    const viewerHasMarkedHelpful = viewerUserId
        ? (review.helpfulVotes ?? []).some((v) => v.userId === viewerUserId)
        : false;

    return {
        id: review.id,
        rating: review.rating,
        title: review.title,
        content: review.content,
        helpfulCount: review.helpfulCount,
        viewerHasMarkedHelpful,
        status: 'PUBLISHED',
        createdAt: review.createdAt.toISOString(),
        updatedAt: review.updatedAt.toISOString(),
        editedAt: review.editedAt ? review.editedAt.toISOString() : null,
        variantSummary: buildVariantSummary(
            review.selectedSizeSnapshot,
            review.selectedColorSnapshot,
        ),
        media: [], // Media resolution deferred until upload integration is wired
        reviewer: {
            id: review.user.id,
            username: review.user.username,
            firstName: review.user.firstName,
            lastName: review.user.lastName,
            profileImage: review.user.profileImage ?? null,
            profileImageId: review.user.profileImageId ?? null,
            profileImageFile: review.user.profileImageFile ?? null,
        },
        brandReply: review.brandReply
            ? {
                content: review.brandReply,
                brandId: review.brand.id,
                brandName: review.brand.name,
                createdAt: review.brandReplyAt
                    ? review.brandReplyAt.toISOString()
                    : review.updatedAt.toISOString(),
                updatedAt: review.brandReplyUpdatedAt
                    ? review.brandReplyUpdatedAt.toISOString()
                    : null,
            }
            : null,
    };
}

/**
 * Standard Prisma include for review queries to get all fields needed by mapper.
 */
export function getReviewInclude(viewerUserId?: string) {
    return {
        user: {
            select: {
                id: true,
                username: true,
                firstName: true,
                lastName: true,
                profileImage: true,
                profileImageId: true,
                profileImageFile: {
                    select: { id: true, s3Url: true },
                },
            },
        },
        brand: {
            select: { id: true, name: true },
        },
        // Only include helpful votes for the current viewer (efficient)
        ...(viewerUserId
            ? {
                helpfulVotes: {
                    where: { userId: viewerUserId },
                    select: { userId: true },
                },
            }
            : {}),
    };
}
