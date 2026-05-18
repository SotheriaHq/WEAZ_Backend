# Reviews Lifecycle Checklist

Created: 2026-05-18. Updated: 2026-05-18.

Phase 16A gate for completed-order review lifecycle architecture.

## 1. Order Completion Eligibility

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Order completion eligibility | Standard order completion source identified | PASS | `src/store/store.service.ts` `confirmOrderDelivery()` moves paid shipped/legacy delivered orders to `OrderStatus.DELIVERED` and sets `buyerConfirmedDeliveryAt`. | NO | PASS |
| Order completion eligibility | Custom order completion source identified | PASS | `src/custom-orders/custom-orders.service.ts` `confirmDelivery()` moves `DELIVERED_PENDING_BUYER_CONFIRMATION` to `CustomOrderStatus.COMPLETED` and sets `completedAt`. | NO | PASS |
| Order completion eligibility | Delivery confirmation source identified | PASS | Standard: `POST /orders/:orderId/confirm-delivery`. Custom: `POST /custom-orders/buyer/:id/confirm-delivery`. | NO | PASS |
| Order completion eligibility | Completed order only | PARTIAL | Audit found product-only support. `ReviewEligibilityService` now requires standard `DELIVERED/PAID` or custom `COMPLETED/PAID`. Tested in `review-lifecycle.service.spec.ts`. | YES | PASS |
| Order completion eligibility | Cancelled/failed/refunded orders excluded unless explicitly allowed | PARTIAL | Lifecycle eligibility requires `PaymentStatus.PAID` and completed status. Tests cover uncompleted, cancelled, and refunded cases. | YES | PASS |
| Order completion eligibility | One review prompt per eligible review target | FAIL | Added `ReviewPrompt`, prompt unique constraints, and idempotent standard/custom prompt creation. Tested in `review-lifecycle.service.spec.ts`. | YES | PASS |

## 2. Review Lifecycle

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Review lifecycle | Submit review | PARTIAL | Added `POST /reviews` and verified-purchase lifecycle submission. Tests cover product and custom/design submission. | YES | PASS |
| Review lifecycle | Edit review within 24 hours | FAIL | Added `editWindowExpiresAt` and `PATCH /reviews/:id`. Tested edit within window. | YES | PASS |
| Review lifecycle | Edit blocked after 24 hours | FAIL | `ReviewsService.updateLifecycleReview()` rejects when `now >= editWindowExpiresAt`. Tested. | YES | PASS |
| Review lifecycle | Edit window uses `createdAt`/`editWindowExpiresAt`, not `updatedAt` | FAIL | `editWindowExpiresAt` is set on creation from `reviews.editWindowHours`; update path does not mutate it. Tested. | YES | PASS |
| Review lifecycle | Delete own review anytime | PARTIAL | Added lifecycle soft delete with `status=DELETED`, `deletedAt`, and `deletedById`. Tested after edit-window expiry. | YES | PASS |
| Review lifecycle | Brand cannot delete review | PASS | Brand controller still has no delete route. Lifecycle delete checks `reviewerId`. Tested brand user rejection. | NO | PASS |
| Review lifecycle | Admin moderation separate from buyer delete | PARTIAL | Added lifecycle `hide/approve/flag` admin endpoints. Legacy product-review admin delete now hides instead of hard-deleting. | YES | PASS |
| Review lifecycle | Duplicate review blocked | PARTIAL | Added duplicate checks and unique constraints for order item, custom order, and brand/order targets. Tested. | YES | PASS |

## 3. Review Content

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Review content | Rating 1-5 | PASS | `CreateReviewDto` and `UpdateReviewDto` validate rating 1-5; DB check added in migration. Tested. | YES | PASS |
| Review content | Satisfaction enum required | FAIL | Added `ReviewSatisfaction` enum and required DTO validation. Tested. | YES | PASS |
| Review content | Review text max length | PASS | Lifecycle `reviewText` is optional and capped at 5000 chars. | YES | PASS |
| Review content | Verified purchase flag | PARTIAL | Added `verifiedPurchase` default true and eligibility re-checks completed paid purchase before submission. Tested. | YES | PASS |
| Review content | Target type supported: PRODUCT | PARTIAL | Added `ReviewTargetType.PRODUCT`, product prompts, submission, and public product endpoint. | YES | PASS |
| Review content | Target type supported: COLLECTION | FAIL | Added `ReviewTargetType.COLLECTION`, collection prompts for purchased products with a store collection, and gated public endpoint. | YES | PASS |
| Review content | Target type supported: DESIGN | FAIL | Added `ReviewTargetType.DESIGN`, custom design prompts, submission, and gated public endpoint. | YES | PASS |
| Review content | Target type supported: CUSTOM_ORDER | FAIL | Added `ReviewTargetType.CUSTOM_ORDER` for product-source custom orders and aggregate support. | YES | PASS |
| Review content | Target type supported: BRAND | PARTIAL | Added `ReviewTargetType.BRAND`, standard/custom brand prompts, submission support, and brand summary endpoint. | YES | PASS |

## 4. Review Prompt Lifecycle

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Review prompt lifecycle | Prompt pending after completion | FAIL | `ReviewEligibilityService.createPromptsForCompletedStandardOrder()` and `createPromptsForCompletedCustomOrder()` create `PENDING` prompts after completion. Tested. | YES | PASS |
| Review prompt lifecycle | Prompt shown | FAIL | `GET /reviews/prompts` marks pending prompts `SHOWN`. | YES | PASS |
| Review prompt lifecycle | Prompt skipped | FAIL | `POST /reviews/prompts/:id/skip` sets `SKIPPED`. Tested. | YES | PASS |
| Review prompt lifecycle | Prompt submitted | FAIL | `POST /reviews` links prompt and sets `SUBMITTED`. Tested. | YES | PASS |
| Review prompt lifecycle | Prompt does not loop after skip/submission | FAIL | Prompt list returns only `PENDING`/`SHOWN`; skipped/submitted prompts are excluded. | YES | PASS |
| Review prompt lifecycle | Prompt idempotency | FAIL | Unique constraints and upserts prevent duplicate prompt rows. Tested. | YES | PASS |

## 5. Aggregates

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Aggregates | Product rating summary | PASS | Existing product-review aggregate remains; lifecycle `ReviewAggregateService.getProductSummary()` added and tested through public product endpoint. | YES | PASS |
| Aggregates | Brand rating summary | PASS | Existing product-review brand aggregate remains; lifecycle `getBrandSummary()` added. | YES | PASS |
| Aggregates | Collection rating summary | FAIL | Lifecycle `getCollectionSummary()` and gated collection endpoint added. | YES | PASS |
| Aggregates | Design/custom source rating summary | FAIL | Lifecycle `getDesignSummary()` and `getCustomOrderSummary()` added. | YES | PASS |
| Aggregates | Satisfaction distribution | FAIL | Lifecycle summaries include `satisfactionDistribution`. Tested. | YES | PASS |
| Aggregates | Deleted/hidden reviews excluded from public aggregates | PASS | Public summaries/lists filter `ReviewStatus.APPROVED`. Tested. | YES | PASS |
| Aggregates | Admin/internal audit can still see historical records if allowed | PARTIAL | Lifecycle delete is soft delete; legacy admin product-review delete now hides instead of hard-deleting. | YES | PASS |

## 6. Feature Flags

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Feature flags | Review capture enabled | FAIL | Added `reviews.capture.enabled` default true. | YES | PASS |
| Feature flags | Product reviews public display | FAIL | Added `reviews.publicDisplay.product.enabled` default true. | YES | PASS |
| Feature flags | Collection reviews public display | FAIL | Added `reviews.publicDisplay.collection.enabled` default false. | YES | PASS |
| Feature flags | Design reviews public display | FAIL | Added `reviews.publicDisplay.design.enabled` default false. | YES | PASS |
| Feature flags | Brand reviews public display | FAIL | Added `reviews.publicDisplay.brand.enabled` default true. | YES | PASS |
| Feature flags | Moderation required flag | FAIL | Added `reviews.moderation.required` default false. | YES | PASS |
| Feature flags | Defaults documented | FAIL | `docs/reviews-feature-flags.md`. | YES | PASS |

## 7. Security / Permissions

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Security / permissions | Buyer can submit own eligible review | PARTIAL | Lifecycle submission re-checks buyer ownership and completed paid purchase. Tested. | YES | PASS |
| Security / permissions | Buyer can edit own review within window | FAIL | Lifecycle update checks reviewer and `editWindowExpiresAt`. Tested. | YES | PASS |
| Security / permissions | Buyer can delete own review anytime | PARTIAL | Lifecycle delete checks reviewer only and soft-deletes. Tested. | YES | PASS |
| Security / permissions | Brand cannot delete buyer review | PASS | Lifecycle delete rejects non-reviewer. Tested. | NO | PASS |
| Security / permissions | Admin moderation requires admin permission | PASS | Admin lifecycle endpoints use `JwtAuthGuard`, `RolesGuard`, `AdminPermissionGuard`, and `MODERATION_WRITE`. | YES | PASS |
| Security / permissions | Unauthenticated blocked | PASS | Buyer lifecycle endpoints use `JwtAuthGuard`. | YES | PASS |

## Initial Gap Summary

Backend audit found an existing product-only review system with delivered-order verification, buyer soft delete, admin moderation, product/brand aggregates, and delayed reminder notifications. Confirmed gaps were generalized targets, review prompts, satisfaction, fixed edit windows, lifecycle feature flags, collection/design/custom-order aggregates, and hard-delete-safe moderation.

## Validation Summary

- `npx prisma generate`: PASS.
- `npx jest src/reviews src/bagging src/store src/custom-orders --runInBand`: PASS, 12 suites / 94 tests.
- `npm run build`: PASS.

## Remaining NOT TESTED Items

- Frontend and native review capture UI are not implemented in Phase 16A by scope.
- Real database migration application was not run in this workspace; migration SQL is committed for target environments.
- Public collection/design display remains disabled by default and should be manually verified only when product enables those flags.

## Production Blockers

- Apply migration `20260518170000_add_review_lifecycle` in the target backend environment before enabling lifecycle UI.
- Frontend/native prompt, submission, edit, and delete UI remain future work.
