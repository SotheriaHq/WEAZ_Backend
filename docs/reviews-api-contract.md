# Reviews API Contract

Created: 2026-05-18.

## Buyer Endpoints

`GET /reviews/prompts`

Returns pending/shown prompts for the authenticated buyer. Pending prompts are marked `SHOWN` when returned.

`GET /reviews/eligibility?orderId=:orderId`

Returns eligible standard-order review targets for the authenticated buyer.

`GET /reviews/eligibility?customOrderId=:customOrderId`

Returns eligible custom-order review targets for the authenticated buyer.

`POST /reviews`

Creates a verified-purchase lifecycle review.

Body:

```json
{
  "promptId": "uuid-optional",
  "targetType": "PRODUCT",
  "orderId": "uuid-optional",
  "orderItemId": "uuid-optional",
  "customOrderId": "uuid-optional",
  "productId": "uuid-optional",
  "collectionId": "uuid-optional",
  "legacyCollectionId": "uuid-optional",
  "designId": "uuid-optional",
  "brandId": "uuid-optional",
  "rating": 5,
  "satisfaction": "EXCITED",
  "reviewText": "Optional text up to 5000 chars"
}
```

Rules:
- Auth required.
- Rating must be 1-5.
- Satisfaction is required: `NONE`, `ANGRY`, `SAD`, `OKAY`, `HAPPY`, `EXCITED`.
- Order/custom order must be completed and paid.
- Duplicate target review is rejected.
- Own-brand review is rejected.

`PATCH /reviews/:id`

Updates rating, satisfaction, and/or review text.

Rules:
- Reviewer only.
- Review must not be deleted or hidden.
- Current time must be before `editWindowExpiresAt`.
- `editWindowExpiresAt` never resets.

`DELETE /reviews/:id`

Soft deletes the authenticated buyer's own review at any time.

`POST /reviews/prompts/:id/skip`

Marks the authenticated buyer's prompt as `SKIPPED`. Skipped prompts do not loop.

`GET /reviews/me`

Returns the authenticated buyer's own submitted lifecycle reviews for the Buyer My Reviews screen.

Supported query params:
- `status`: `APPROVED`, `PENDING_MODERATION`, `HIDDEN`, `FLAGGED`, `DELETED`
- `targetType`: `PRODUCT`, `COLLECTION`, `DESIGN`, `CUSTOM_ORDER`, `BRAND`
- `includeDeleted`: optional boolean; defaults to non-deleted reviews
- `cursor`, `limit`: pagination

Rules:
- Auth required.
- The endpoint never returns another buyer's reviews.
- Items include target context and `canEdit` / `canDelete` so clients do not calculate editability from `updatedAt`.
- Default response excludes soft-deleted reviews.

## Public Endpoints

`GET /reviews/product/:productId`

Returns approved lifecycle product reviews plus summary when `reviews.publicDisplay.product.enabled` is enabled.

Response shape for product, collection, design, and brand list endpoints:

```json
{
  "items": [
    {
      "id": "review-id",
      "reviewerId": "buyer-id",
      "brandId": "brand-id",
      "productId": "product-id-or-null",
      "collectionId": "collection-id-or-null",
      "legacyCollectionId": "legacy-collection-id-or-null",
      "designId": "design-id-or-null",
      "customOrderId": "custom-order-id-or-null",
      "targetType": "PRODUCT",
      "rating": 5,
      "satisfaction": "HAPPY",
      "reviewText": "Optional review text",
      "verifiedPurchase": true,
      "editWindowExpiresAt": "2026-05-19T10:00:00.000Z",
      "createdAt": "2026-05-18T10:00:00.000Z",
      "updatedAt": "2026-05-18T10:00:00.000Z",
      "editedAt": null
    }
  ],
  "summary": {
    "averageRating": 4.75,
    "reviewCount": 12,
    "ratingBreakdown": { "1": 0, "2": 0, "3": 1, "4": 2, "5": 9 },
    "satisfactionDistribution": {
      "NONE": 0,
      "ANGRY": 0,
      "SAD": 0,
      "OKAY": 1,
      "HAPPY": 5,
      "EXCITED": 6
    }
  },
  "nextCursor": null
}
```

Public list DTOs include `reviewerId` and `editWindowExpiresAt` so authenticated clients can safely hide edit controls after the original 24-hour window without using `updatedAt`. Public clients must still call `PATCH /reviews/:id` and `DELETE /reviews/:id`; the backend remains the source of truth for ownership and permissions.

`GET /reviews/collection/:collectionId`

Returns approved lifecycle collection reviews plus summary when `reviews.publicDisplay.collection.enabled` is enabled. Default is disabled.

`GET /reviews/design/:designId`

Returns approved lifecycle design reviews plus summary when `reviews.publicDisplay.design.enabled` is enabled. Default is disabled.

`GET /reviews/brand/:brandId/summary`

Returns approved lifecycle brand summary when `reviews.publicDisplay.brand.enabled` is enabled.

`GET /reviews/brand/:brandId`

Returns approved lifecycle brand reviews plus summary when `reviews.publicDisplay.brand.enabled` is enabled. This endpoint is read-only and exists for brand catalog/profile Reviews tabs.

## Brand/Vendor Endpoints

`GET /brands/reviews/lifecycle`

Returns lifecycle reviews for the authenticated brand/vendor dashboard. This is read-only brand feedback management and does not expose delete, hide, or approve powers.

Supported query params:
- `status`: `APPROVED`, `PENDING_MODERATION`, `HIDDEN`, `FLAGGED`, `DELETED`
- `targetType`: `PRODUCT`, `COLLECTION`, `DESIGN`, `CUSTOM_ORDER`, `BRAND`
- `productId`, `collectionId`, `legacyCollectionId`, `designId`: target-specific filters
- `rating`: integer `1` to `5`
- `dateFrom`, `dateTo`: created-at date filters
- `cursor`, `limit`: pagination

Response shape:

```json
{
  "items": [],
  "summary": {
    "averageRating": 4.7,
    "reviewCount": 14,
    "ratingBreakdown": { "1": 0, "2": 0, "3": 1, "4": 2, "5": 11 },
    "satisfactionDistribution": {
      "NONE": 0,
      "ANGRY": 0,
      "SAD": 0,
      "OKAY": 1,
      "HAPPY": 6,
      "EXCITED": 7
    },
    "statusCounts": {
      "APPROVED": 12,
      "PENDING_MODERATION": 0,
      "HIDDEN": 1,
      "FLAGGED": 1,
      "DELETED": 0
    },
    "targetTypeCounts": {
      "PRODUCT": 10,
      "COLLECTION": 1,
      "DESIGN": 1,
      "CUSTOM_ORDER": 2,
      "BRAND": 0
    },
    "flaggedCount": 1,
    "hiddenCount": 1,
    "deletedCount": 0,
    "pendingModerationCount": 0
  },
  "breakdown": {
    "targets": [
      {
        "targetType": "PRODUCT",
        "targetId": "product-id",
        "name": "Product name",
        "reviewCount": 8,
        "averageRating": 4.9
      }
    ]
  },
  "nextCursor": null
}
```

`POST /brands/reviews/lifecycle/:reviewId/report`

Lets a brand/vendor report a lifecycle review tied to their own brand/products/sources for admin moderation.

Body:

```json
{
  "reason": "OFF_TOPIC",
  "details": "Optional context up to 1000 chars"
}
```

Rules:
- Auth required.
- The review must belong to the authenticated brand/vendor's own brand scope.
- Brands cannot delete, hide, approve, or directly moderate buyer reviews.
- Current implementation escalates the lifecycle review to `FLAGGED` and records the brand report reason in `hiddenReason` for admin review.
- Re-reporting an already flagged review is idempotent enough for UI retry behavior and does not grant brand delete powers.

## Admin Endpoints

`GET /admin/reviews/lifecycle`

Returns lifecycle `Review` records for admin moderation. Requires moderation read permission.

Supported query params:
- `status`: `APPROVED`, `PENDING_MODERATION`, `HIDDEN`, `FLAGGED`, `DELETED`
- `targetType`: `PRODUCT`, `COLLECTION`, `DESIGN`, `CUSTOM_ORDER`, `BRAND`
- `rating`: integer `1` to `5`
- `brandId`: brand UUID
- `dateFrom`, `dateTo`: created-at date filters
- `cursor`, `limit`: pagination

Each item includes reviewer context, brand context, target IDs, lifecycle timestamps, `hiddenReason`, `deletedAt`, and `deletedById`. This endpoint is the source for the web admin review moderation screen.

`GET /admin/reviews/lifecycle/:id`

Returns lifecycle review detail for admin inspection. Requires moderation read permission.

`GET /admin/reviews/analytics`

Returns lifecycle review analytics for the admin review analytics panel. Requires moderation read permission.

Response includes:
- `totalReviews`
- `activeReviewCount`
- `averageRating`
- `statusCounts`
- `targetTypeCounts`
- `satisfactionDistribution`
- `flaggedCount`
- `hiddenCount`
- `deletedCount`
- `pendingModerationCount`
- `reviewsCreatedOverTime`
- `topReviewedBrands`
- `topReviewedProducts`

`PATCH /admin/reviews/:id/hide`

Sets lifecycle review status to `HIDDEN`. Requires admin moderation write permission.

`PATCH /admin/reviews/:id/approve`

Sets lifecycle review status to `APPROVED`. Requires admin moderation write permission.

`PATCH /admin/reviews/:id/flag`

Sets lifecycle review status to `FLAGGED`. Requires admin moderation write permission.

Existing `/admin/reviews/:reviewId/moderation` remains for legacy product reviews. Its delete action no longer hard-deletes records; it removes the review from public display using `HIDDEN_BY_ADMIN`.
