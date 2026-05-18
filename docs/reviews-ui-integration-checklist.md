# Reviews UI Integration Checklist

Phase 16B checklist for completed-order lifecycle review UI across backend contract docs, web, and mobile.

Status values: `PASS`, `FAIL`, `PARTIAL`, `NOT TESTED`.

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend contract availability | GET /reviews/prompts available | PASS | `src/reviews/review-lifecycle.controller.ts`; `reviews-api-contract.md` | NO | PASS |
| Backend contract availability | GET /reviews/eligibility available | PASS | `ReviewLifecycleController.getEligibility()` | NO | PASS |
| Backend contract availability | POST /reviews available | PASS | `ReviewLifecycleController.createReview()` | NO | PASS |
| Backend contract availability | PATCH /reviews/:id available | PASS | `ReviewsService.updateLifecycleReview()` checks `editWindowExpiresAt` | NO | PASS |
| Backend contract availability | DELETE /reviews/:id available | PASS | `ReviewsService.deleteLifecycleReview()` soft deletes | NO | PASS |
| Backend contract availability | POST /reviews/prompts/:id/skip available | PASS | `ReviewsService.skipReviewPrompt()` | NO | PASS |
| Backend contract availability | GET /reviews/product/:productId available | PASS | `getLifecycleProductReviews()` | NO | PASS |
| Backend contract availability | GET /reviews/collection/:collectionId respects feature flag | PASS | `assertFeatureEnabled(PUBLIC_COLLECTION)` | NO | PASS |
| Backend contract availability | GET /reviews/design/:designId respects feature flag | PASS | `assertFeatureEnabled(PUBLIC_DESIGN)` | NO | PASS |
| Backend contract availability | GET /reviews/brand/:brandId/summary available | PASS | `getLifecycleBrandSummary()` | NO | PASS |
| Backend contract availability | API returns canEdit/canDelete or enough data to compute UI state safely | PASS | Create/update return `canEdit/canDelete`; public list DTO now includes `reviewerId` and `editWindowExpiresAt` via `ReviewAggregateService.mapPublicReview()` | NO | PASS |
| Web review API client | Review API client exists | FAIL | Added `fthreadly/src/api/ReviewApi.ts` | NO | PASS |
| Web review API client | Prompts endpoint wired | FAIL | `reviewApi.listReviewPrompts()` and `MyOrders.tsx` prompt load | NO | PASS |
| Web review API client | Eligibility endpoint wired | FAIL | `reviewApi.getReviewEligibility()` | NO | PASS |
| Web review API client | Submit review wired | FAIL | `reviewApi.submitReview()` and `ReviewFormModal.tsx` | NO | PASS |
| Web review API client | Edit review wired | FAIL | `reviewApi.updateReview()`, `ReviewCard.tsx`, `ReviewsTab.tsx`, `ProductReviewSection.tsx` | NO | PASS |
| Web review API client | Delete review wired | FAIL | `reviewApi.deleteReview()`, `DeleteReviewConfirmDialog.tsx` | NO | PASS |
| Web review API client | Skip prompt wired | FAIL | `reviewApi.skipReviewPrompt()` and `ReviewPromptCard.tsx` | NO | PASS |
| Web review API client | Product reviews endpoint wired | FAIL | `ProductReviewSection.tsx` calls `/reviews/product/:productId` | NO | PASS |
| Web review API client | Brand summary endpoint wired | FAIL | `ReviewsTab.tsx` calls `/reviews/brand/:brandId` and summary from list response | NO | PASS |
| Web review API client | Collection/design endpoints wired behind flags if needed | FAIL | `ReviewApi.ts` exposes collection/design clients; no public UI renders them by default | NO | PASS |
| Web review API client | API errors normalized | FAIL | `ReviewApiError` and `normalizeReviewApiError()` | NO | PASS |
| Mobile review API client | Same review API capabilities as web | FAIL | Added `threadly-mobile/src/api/ReviewApi.ts`, including prompts, eligibility, submit/edit/delete, skip, public list, and brand summary methods | NO | PASS |
| Mobile review API client | API errors normalized | FAIL | Mobile `ReviewApiError` normalization | NO | PASS |
| Mobile review API client | Auth-required responses handled | PARTIAL | Mobile `httpClient` 401 handling plus review API status mapping | NO | PASS |
| Mobile review API client | Feature flags respected | PARTIAL | Public endpoints treat backend 403 as feature-disabled in `ReviewsTab.tsx` | NO | PASS |
| Review prompt flow | Pending prompts shown after completed order | FAIL | Web `src/pages/orders/MyOrders.tsx`; mobile `app/orders/index.tsx` | NO | PARTIAL - implemented, not manually executed |
| Review prompt flow | Prompt can be submitted | FAIL | Web `ReviewFormModal.test.tsx`; mobile `ReviewFormSheet.tsx` | NO | PARTIAL - implemented, not manually executed |
| Review prompt flow | Prompt can be skipped | FAIL | Web/mobile prompt cards call skip endpoint | NO | PARTIAL - implemented, not manually executed |
| Review prompt flow | Submitted/skipped prompt disappears | FAIL | Web/mobile remove prompt from local state after submit/skip | NO | PARTIAL - implemented, not manually executed |
| Review prompt flow | Prompt does not loop after skip/submission | FAIL | Backend skip/submitted statuses; UI removes local prompt | NO | PARTIAL - requires manual/backend-data QA |
| Review prompt flow | Prompt UI is optional, not blocking | FAIL | Prompt cards render inside order history only; no checkout/payment blocking | NO | PASS |
| Review form | Star rating input works | PARTIAL | Web/mobile `StarRatingInput.tsx`; web form test | NO | PASS |
| Review form | Satisfaction emoji selector works | FAIL | Web/mobile `SatisfactionSelector.tsx` | NO | PASS |
| Review form | Text review input works | PARTIAL | Web `ReviewFormModal.tsx`; mobile `ReviewFormSheet.tsx` | NO | PASS |
| Review form | Text max length handled | PARTIAL | `REVIEW_TEXT_MAX_LENGTH = 5000`; input `maxLength` | NO | PASS |
| Review form | Submit disabled until required fields valid | PARTIAL | `ReviewFormModal.test.tsx` | NO | PASS |
| Review form | Loading state | PARTIAL | Web modal buttons and mobile sheet button loading | NO | PASS |
| Review form | Error state | PARTIAL | Web modal error alert; mobile sheet error text | NO | PASS |
| Review form | Success state | FAIL | Web/mobile success toast and prompt removal | NO | PARTIAL - no manual execution |
| Edit lifecycle | Edit visible only for reviewer | FAIL | `ReviewCard.tsx` gates on `currentUserId === reviewerId` | NO | PASS |
| Edit lifecycle | Edit visible only before editWindowExpiresAt | FAIL | Web/mobile `normalizeReview()` computes from `editWindowExpiresAt`; cards hide when `canEdit` false | NO | PASS |
| Edit lifecycle | Edit hidden/disabled after 24 hours | FAIL | `formatEditWindow()` plus `canEdit` gating; backend test suite passed | NO | PASS |
| Edit lifecycle | Edit window uses original creation/editWindowExpiresAt, not updatedAt | FAIL | Web/mobile clients use `editWindowExpiresAt`; backend service uses `editWindowExpiresAt` | NO | PASS |
| Edit lifecycle | Edit does not reset countdown | FAIL | UI never computes from `updatedAt`; backend tests passed | NO | PASS |
| Edit lifecycle | Edited review shows edited state if supported | FAIL | Web/mobile `ReviewCard.tsx` shows edited state when `editedAt` exists | NO | PASS |
| Delete lifecycle | Delete visible only for reviewer | FAIL | Web/mobile cards gate delete by reviewer ownership | NO | PASS |
| Delete lifecycle | Delete available anytime | FAIL | Delete does not depend on edit window in UI; backend permits reviewer soft delete anytime | NO | PASS |
| Delete lifecycle | Delete uses confirmation modal/sheet | FAIL | Web `DeleteReviewConfirmDialog.tsx`; mobile `DeleteReviewConfirmSheet.tsx` | NO | PASS |
| Delete lifecycle | Delete soft-delete result removes review from public list | FAIL | Web/mobile remove deleted card locally and decrement count | NO | PARTIAL - implemented, not manually executed |
| Delete lifecycle | Brand user cannot delete buyer review | FAIL | UI gates by `reviewerId`; backend tests passed | NO | PASS |
| Delete lifecycle | Deleted review excluded from public aggregate/list | PASS | Backend `ReviewAggregateService` filters `APPROVED`; review tests passed | NO | PASS |
| Brand catalog/profile Reviews tab | Reviews tab exists or existing tab wired | PARTIAL | Web wrapper `components/profile/tabs/ReviewsTab.tsx`; mobile `components/catalog/BrandReviewsTab.tsx` | NO | PASS |
| Brand catalog/profile Reviews tab | Average rating summary visible when feature allows | PARTIAL | Web/mobile `ReviewSummary.tsx` | NO | PASS |
| Brand catalog/profile Reviews tab | Review count visible | PARTIAL | Web/mobile `ReviewSummary.tsx` | NO | PASS |
| Brand catalog/profile Reviews tab | Satisfaction distribution visible | FAIL | Web/mobile `ReviewSummary.tsx` renders mood counts | NO | PASS |
| Brand catalog/profile Reviews tab | Review list visible | PARTIAL | Added backend `GET /reviews/brand/:brandId`; web/mobile lifecycle `ReviewsTab` | NO | PASS |
| Brand catalog/profile Reviews tab | Verified purchase badge visible | PARTIAL | Web/mobile `ReviewCard.tsx` | NO | PASS |
| Brand catalog/profile Reviews tab | Product/collection/design context shown where available | FAIL | Web/mobile review cards show `targetType`; IDs retained in DTO | NO | PASS |
| Brand catalog/profile Reviews tab | Loading state | PASS | Web skeleton; mobile loading block | NO | PASS |
| Brand catalog/profile Reviews tab | Empty state | PASS | Web/mobile empty copy: "No verified reviews yet." | NO | PASS |
| Brand catalog/profile Reviews tab | Error/retry state | PARTIAL | Web/mobile retry states | NO | PASS |
| Brand catalog/profile Reviews tab | Pagination or lazy loading if needed | PARTIAL | Backend returns `nextCursor: null`; UI uses stable local list | NO | PASS |
| Product/brand review summaries | Product summary can render on product detail/viewer where enabled | PARTIAL | Web `ProductReviewSection.tsx`; mobile `MarketCommerceViewer.tsx` compact product reviews | NO | PASS |
| Product/brand review summaries | Brand summary can render on catalog/profile | PARTIAL | Web/mobile `ReviewsTab` | NO | PASS |
| Product/brand review summaries | Collection/design review UI remains hidden when flags are OFF | PARTIAL | No collection/design public UI rendered; mobile design placeholder removed | NO | PASS |
| Product/brand review summaries | Collection/design placeholder allowed only behind flag or disabled note | PASS | No public collection/design placeholder exposed | NO | PASS |
| Smooth interaction / no parent shake | Reviews tab state isolated | PARTIAL | Web/mobile lifecycle state lives inside `ReviewsTab`; edit/delete update local list | NO | PASS |
| Smooth interaction / no parent shake | Parent catalog/profile does not refetch all tabs when review page changes | PARTIAL | Review edit/delete does not call catalog/profile reload; legacy parent fetch still runs on tab open | NO | PASS |
| Smooth interaction / no parent shake | Parent scroll position does not reset unnecessarily | NOT TESTED | Needs browser/device QA | TBD | NOT TESTED |
| Smooth interaction / no parent shake | Review edit/delete does not reload full profile | FAIL | Web/mobile local item updates only | NO | PASS |
| Smooth interaction / no parent shake | Nested review button clicks do not trigger parent card navigation | PARTIAL | Web `ReviewCard` stops propagation; mobile cards are not nested in pressable catalog cards | NO | PASS |
| Smooth interaction / no parent shake | Stable keys used | PARTIAL | Web/mobile maps use `review.id` | NO | PASS |
| Smooth interaction / no parent shake | Fixed-height skeletons used where needed | PARTIAL | Web fixed skeleton blocks; mobile fixed loading/empty heights | NO | PASS |
| Smooth interaction / no parent shake | Tab transition remains smooth | NOT TESTED | Needs browser/device QA | TBD | NOT TESTED |
| Smooth interaction / no parent shake | No layout jump when loading reviews | PARTIAL | Skeleton/loading blocks added; manual visual QA still needed | NO | PARTIAL |
| Web tests | Prompts render | FAIL | Prompt card implemented; no dedicated render test | YES | PARTIAL |
| Web tests | Submit review | FAIL | `ReviewFormModal.test.tsx`; `ReviewApi.test.ts` | NO | PASS |
| Web tests | Edit within 24h | FAIL | API/client logic covered; no component edit test | YES | PARTIAL |
| Web tests | Edit hidden/blocked after 24h | FAIL | Backend tests passed; no web component test | YES | PARTIAL |
| Web tests | Delete own review | FAIL | API test covers delete endpoint; no component delete test | YES | PARTIAL |
| Web tests | Brand cannot delete buyer review | FAIL | Existing `ReviewsTab.test.tsx` verifies owner reply/report gone; no explicit brand delete test | YES | PARTIAL |
| Web tests | Reviews tab renders summary/list | FAIL | Existing `ReviewsTab.test.tsx` renders wrapper; lifecycle summary/list not directly asserted | YES | PARTIAL |
| Web tests | Empty/error states | PARTIAL | Not directly tested | YES | PARTIAL |
| Web tests | Feature flags respected | FAIL | 403 handling implemented; not directly tested | YES | PARTIAL |
| Web tests | Parent tab does not reset where testable | NOT TESTED | Needs browser/integration test | TBD | NOT TESTED |
| Mobile validation/manual QA | TypeScript passes | NOT TESTED | `npm exec tsc -- --noEmit` passed | NO | PASS |
| Mobile validation/manual QA | Design-system CI passes | NOT TESTED | `npm run ci:design-system` passed | NO | PASS |
| Mobile validation/manual QA | Theme audit passes | NOT TESTED | `npm run audit:theme` passed | NO | PASS |
| Mobile validation/manual QA | Review prompt screen/sheet manually testable | FAIL | Implemented in `app/orders/index.tsx` and `ReviewFormSheet.tsx`; not manually run | NO | PARTIAL |
| Mobile validation/manual QA | Reviews tab manually testable | PARTIAL | Implemented in `BrandReviewsTab.tsx`; not manually run | NO | PARTIAL |
| Mobile validation/manual QA | Edit/delete manually testable | FAIL | Implemented; not manually run | NO | PARTIAL |

## Required Audit Answers

| Question | Answer |
| --- | --- |
| Where should review prompts appear on web? | `fthreadly/src/pages/orders/MyOrders.tsx`. |
| Where should review prompts appear on mobile? | `threadly-mobile/app/orders/index.tsx`. |
| Where is the brand catalog/profile tab implementation on web? | `fthreadly/src/pages/catalog/Catalog.tsx` renders `fthreadly/src/components/profile/tabs/ReviewsTab.tsx`. |
| Where is the brand catalog/profile tab implementation on mobile? | `threadly-mobile/app/catalog/index.tsx` renders `threadly-mobile/components/catalog/BrandReviewsTab.tsx`. |
| Is there an existing Reviews tab? | Yes. Both web and mobile tabs now delegate to lifecycle review components. |
| Is there an existing rating/star component? | No reusable lifecycle input existed; web/mobile `StarRatingInput.tsx` were added. |
| Is there an existing modal/sheet pattern to reuse? | Web uses `Modal` and `ConfirmDialog`; mobile uses `AppBottomSheet`, `Button`, `Input`, `Card`, and `AppText`. |
| Does API return canEdit/canDelete, or must UI compute from reviewerId and editWindowExpiresAt? | Create/update return `canEdit/canDelete`; public lists now include `reviewerId` and `editWindowExpiresAt` so clients compute safely without `updatedAt`. |
| Which feature flags are exposed to frontend/mobile? | Lifecycle public-display flags are enforced by backend 403. Web legacy runtime flags still exist for old `/store/reviews`; lifecycle UI treats 403 as disabled. |
| Which public review displays should remain hidden by default? | Collection and design review lists remain hidden because their public-display flags default OFF and no public UI was added for them. |

## Backend DB Migration Status

- Local migration file: `bthreadly/prisma/migrations/20260518170000_add_review_lifecycle/migration.sql` is present.
- Local DB migration status: review lifecycle migration applied locally on 2026-05-18 using `npx prisma migrate deploy` after resolving an already-applied Google auth migration.
- Production migration status: not applied by this task; production migration requires explicit owner approval.

## Validation Evidence

- Backend: `npx prisma generate` passed.
- Backend: `npx jest src/reviews src/bagging src/store src/custom-orders --runInBand` passed, 12 suites / 96 tests.
- Backend: `npm run build` passed.
- Web: `npm run test -- ReviewApi.test.ts ReviewFormModal.test.tsx AdminReviewsPage.test.tsx` passed, 3 files / 6 tests.
- Web: `npm run build` passed.
- Web: scoped ESLint on changed review/catalog/order files passed.
- Mobile: `npm exec tsc -- --noEmit` passed.
- Mobile: `npm run ci:design-system` passed.
- Mobile: `npm run audit:theme` passed.

## Remaining NOT TESTED Items

- Browser manual QA for prompt submit/skip/edit/delete, brand Reviews tab, product summary, and parent tab stability.
- Mobile emulator/device QA for prompt sheet, submit/skip/edit/delete, brand Reviews tab, market product summary, and parent tab stability.
- Web seeded bagging E2E was not rerun because this phase did not touch bagging routes or bagging API behavior.

## Production Blockers

- Phase 16B should not be called production-ready until manual QA in `docs/reviews-ui-manual-qa.md` is executed with completed-order review prompt data.
- Seeded review data exists, but edit-after-24h hidden state and delete-anytime behavior still need browser/device verification.

## Phase 16B-2 Addendum

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend admin lifecycle contract | Admin lifecycle review list available | PASS | `GET /admin/reviews/lifecycle`; `ReviewsService.adminGetLifecycleReviews()`; focused review tests passed | NO | PASS |
| Backend admin lifecycle contract | Admin lifecycle review detail available | PASS | `GET /admin/reviews/lifecycle/:id`; `ReviewsService.adminGetLifecycleReview()`; focused review tests passed | NO | PASS |
| Backend seeded QA | Deterministic review lifecycle data | PASS | `scripts/seed-reviews-e2e.ts`; `npm run seed:e2e:reviews` passed; `docs/reviews-e2e-seed-data.md` | NO | PASS |
| Web admin moderation | Lifecycle admin review list screen | PASS | `/admin/reviews`; `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `AdminReviewsPage.test.tsx` passed | NO | PASS |
| Web admin moderation | Admin hide/approve/flag action UI | PARTIAL | UI actions implemented; approve wiring tested; hide/flag need browser QA | NO | PARTIAL |
| Web admin settings | Review feature flag/edit-window controls | PASS | `AdminSettingsPage.tsx` `Review Rules` tab; web build passed | NO | PASS |
| Buyer My Reviews | Dedicated management screen | FAIL | No route added | NO - documented deferral | DEFERRED |
| Brand dashboard reviews | Read-only vendor management screen | FAIL | No dashboard route added | NO - documented deferral | DEFERRED |
| Admin analytics | Review analytics screen | FAIL | No analytics screen added | NO - documented deferral | DEFERRED |
| Manual QA | Web seeded lifecycle execution | NOT TESTED | `reviews-ui-manual-qa.md` updated with seeded credentials and blockers | YES | NOT TESTED |
| Manual QA | Mobile lifecycle execution | NOT TESTED | Static validation passed; no emulator/device execution | YES | NOT TESTED |
