# Reviews Architecture

Created: 2026-05-18.

Phase 16A adds a completed-order review lifecycle beside the existing product-review API. The legacy `ProductReview` table and `/store/reviews` contract remain intact for compatibility. New completed-order reviews use `Review` and `ReviewPrompt`.

## Lifecycle

1. A standard order becomes review-eligible after buyer delivery confirmation moves it to `OrderStatus.DELIVERED` with `PaymentStatus.PAID`.
2. A custom order becomes review-eligible after buyer delivery confirmation moves it to `CustomOrderStatus.COMPLETED` with `PaymentStatus.PAID`.
3. `ReviewEligibilityService` creates idempotent `ReviewPrompt` rows after those completion boundaries.
4. Review submission is optional. Buyers may skip prompts.
5. Submitted reviews are verified-purchase records because submission re-checks completed order ownership.
6. `editWindowExpiresAt` is set at create time from `createdAt + reviews.editWindowHours`.
7. Edits are allowed only before `editWindowExpiresAt`. Later edits are rejected.
8. Edits set `editedAt` and do not change `editWindowExpiresAt`.
9. Buyer delete is soft delete: `status=DELETED`, `deletedAt`, `deletedById`.
10. Admin moderation is separate: `APPROVED`, `PENDING_MODERATION`, `HIDDEN`, or `FLAGGED`.

## Targets

`ReviewTargetType` supports:

- `PRODUCT`: standard order item product review.
- `COLLECTION`: standard order item collection review when the purchased product belongs to a store collection.
- `DESIGN`: custom order review for a design source.
- `CUSTOM_ORDER`: custom order review for a product custom-order source.
- `BRAND`: standard/custom order brand review.

## Prompt Creation

Standard orders:
- Product prompt per completed paid order item.
- Collection prompt per completed paid order item when the product has `collectionId`.
- Brand prompt per completed paid order.

Custom orders:
- Design prompt when `sourceType=DESIGN`.
- Custom-order prompt when `sourceType=PRODUCT`.
- Brand prompt per completed paid custom order.

Prompt creation skips own-brand reviews and is idempotent through unique constraints.

## Aggregates

`ReviewAggregateService` computes summaries from approved lifecycle reviews:
- average rating
- review count
- rating breakdown
- satisfaction distribution

Public aggregates exclude `DELETED`, `HIDDEN`, `FLAGGED`, and `PENDING_MODERATION` reviews.

## Compatibility

Existing product reviews, helpful votes, reports, brand replies, reminder cron, and legacy product/brand aggregate queues remain in place. Existing admin product-review delete moderation was changed from hard delete to soft public removal through `HIDDEN_BY_ADMIN`.
