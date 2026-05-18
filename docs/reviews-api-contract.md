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

## Public Endpoints

`GET /reviews/product/:productId`

Returns approved lifecycle product reviews plus summary when `reviews.publicDisplay.product.enabled` is enabled.

`GET /reviews/collection/:collectionId`

Returns approved lifecycle collection reviews plus summary when `reviews.publicDisplay.collection.enabled` is enabled. Default is disabled.

`GET /reviews/design/:designId`

Returns approved lifecycle design reviews plus summary when `reviews.publicDisplay.design.enabled` is enabled. Default is disabled.

`GET /reviews/brand/:brandId/summary`

Returns approved lifecycle brand summary when `reviews.publicDisplay.brand.enabled` is enabled.

## Admin Endpoints

`PATCH /admin/reviews/:id/hide`

Sets lifecycle review status to `HIDDEN`. Requires admin moderation write permission.

`PATCH /admin/reviews/:id/approve`

Sets lifecycle review status to `APPROVED`. Requires admin moderation write permission.

`PATCH /admin/reviews/:id/flag`

Sets lifecycle review status to `FLAGGED`. Requires admin moderation write permission.

Existing `/admin/reviews/:reviewId/moderation` remains for legacy product reviews. Its delete action no longer hard-deletes records; it removes the review from public display using `HIDDEN_BY_ADMIN`.
