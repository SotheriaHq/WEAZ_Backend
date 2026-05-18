# Reviews Screen Architecture Checklist

Phase: 16B-2
Updated: 2026-05-18
Scope: Buyer, brand, and admin review lifecycle screens across web/mobile, with seeded/manual QA tracking.

## Phase 16B-3 Completion Gate

Audit timestamp: 2026-05-18.

### Phase 16B-3 Audit Answers

| Question | Answer | Evidence |
| --- | --- | --- |
| Which buyer review screens already exist? | Web/mobile completed-order prompt surfaces, submit/edit form modal/sheet, delete confirmation, product review section, and public brand Reviews tab already exist. | Web: `fthreadly/src/pages/orders/MyOrders.tsx`, `fthreadly/src/components/reviews/*`, `fthreadly/src/components/profile/tabs/ReviewsTab.tsx`; Mobile: `threadly-mobile/app/orders/index.tsx`, `threadly-mobile/components/reviews/*`, `threadly-mobile/components/catalog/BrandReviewsTab.tsx` |
| Which buyer My Reviews screen is missing? | Closed in Phase 16B-3. Web now has `/account/reviews`; mobile now has `/reviews`. | Web: `fthreadly/src/pages/account/MyReviewsPage.tsx`, `fthreadly/src/App.tsx`; Mobile: `threadly-mobile/app/reviews/index.tsx`, `threadly-mobile/app/_layout.tsx` |
| Which brand review dashboard exists or is missing? | Closed on web in Phase 16B-3. Public brand Reviews tabs remain web/mobile; vendor management is web-first through Studio Reviews. | `fthreadly/src/pages/studio/BrandReviewsDashboardPage.tsx`, `fthreadly/src/pages/studio/StudioHome.tsx`, `fthreadly/src/components/studio/StudioSidebar.tsx`; mobile public tab: `threadly-mobile/components/catalog/BrandReviewsTab.tsx` |
| Which brand review breakdown screens exist or are missing? | Closed on web in Phase 16B-3 with lifecycle target breakdown cards and filters. | `bthreadly/src/reviews/reviews.service.ts` `getBrandLifecycleDashboard()`; `fthreadly/src/pages/studio/BrandReviewsDashboardPage.tsx` |
| Which brand report/flag action exists or is missing? | Closed for lifecycle reviews in Phase 16B-3. Brands can report own-brand lifecycle reviews for admin moderation but cannot delete/hide/approve. | Backend: `POST /brands/reviews/lifecycle/:reviewId/report`; Web: `BrandReviewsDashboardPage.tsx`; tests: `review-lifecycle.service.spec.ts`, `BrandReviewsDashboardPage.test.tsx` |
| Which admin review analytics screen exists or is missing? | Closed in Phase 16B-3 with backend analytics endpoint and admin analytics panel. | Backend: `GET /admin/reviews/analytics`; Web: `AdminReviewsPage.tsx`; tests: `AdminReviewsPage.test.tsx` |
| Which review feature flags are currently visible to admin? | Capture, prompt-after-completion, product/brand/collection/design public display, moderation required, and edit window hours are visible in Review Rules. | `fthreadly/src/pages/admin/AdminSettingsPage.tsx` |
| Which screens still require runtime QA only? | Browser/device confirmation remains for prompt submit/skip/edit/delete, parent tab shake/reset, brand dashboard interactions, report/flag confirmation, admin analytics visibility, and mobile review routes. These are manual QA blockers only. | `bthreadly/docs/reviews-ui-manual-qa.md` remains NOT TESTED for manual execution. |
| Which gaps can be closed with automated tests/static validation now? | Backend buyer/brand/admin lifecycle endpoints, web API clients, Buyer My Reviews, Brand Reviews dashboard, brand report/flag UI, admin analytics panel, route wiring, mobile My Reviews route/API, docs, and static validation. | This phase will add focused backend/web tests and mobile TypeScript/theme validation; manual QA remains pending. |

### Phase 16B-3 Required Surfaces

| User type | Screen/surface | Required behavior | Current status: PASS / FAIL / PARTIAL / NOT TESTED / DEFERRED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Buyer/customer | Web Orders review prompt surface | Completed-order prompts can submit/skip optionally. | PASS | `fthreadly/src/pages/orders/MyOrders.tsx` | NO | PASS |
| Buyer/customer | Mobile Orders review prompt surface | Completed-order prompts can submit/skip optionally. | PASS | `threadly-mobile/app/orders/index.tsx` | NO | PASS |
| Buyer/customer | Web review submit/edit modal | Rating, satisfaction, optional text; edit only while `canEdit`. | PASS | `fthreadly/src/components/reviews/ReviewFormModal.tsx`; `ReviewFormModal.test.tsx` | NO | PASS |
| Buyer/customer | Mobile review submit/edit sheet | Rating, satisfaction, optional text; edit only while `canEdit`. | PASS | `threadly-mobile/components/reviews/ReviewFormSheet.tsx` | NO | PASS |
| Buyer/customer | Web delete review confirmation | Buyer soft delete with confirmation. | PASS | `fthreadly/src/components/reviews/DeleteReviewConfirmDialog.tsx` | NO | PASS |
| Buyer/customer | Mobile delete review confirmation | Buyer soft delete with confirmation. | PASS | `threadly-mobile/components/reviews/DeleteReviewConfirmSheet.tsx` | NO | PASS |
| Buyer/customer | Web product review section | Product summary/list respects product public display flag. | PASS | `fthreadly/src/components/reviews/ProductReviewSection.tsx` | NO | PASS |
| Buyer/customer | Mobile product review section | Product summary/list in commerce viewer for product targets. | PASS | `threadly-mobile/src/features/market/components/MarketCommerceViewer.tsx` | NO | PASS |
| Buyer/customer | Web brand Reviews tab | Public brand summary/list. | PASS | `fthreadly/src/components/reviews/ReviewsTab.tsx`; `fthreadly/src/components/profile/tabs/ReviewsTab.tsx` | NO | PASS |
| Buyer/customer | Mobile brand Reviews tab | Public brand summary/list. | PASS | `threadly-mobile/components/catalog/BrandReviewsTab.tsx` | NO | PASS |
| Buyer/customer | Web Buyer My Reviews screen | Dedicated authenticated list/edit/delete management screen. | PASS | `fthreadly/src/pages/account/MyReviewsPage.tsx`; route `/account/reviews`; `MyReviewsPage.test.tsx` passed | NO | PASS |
| Buyer/customer | Mobile Buyer My Reviews screen | Dedicated authenticated list/edit/delete management screen. | PASS | `threadly-mobile/app/reviews/index.tsx`; route `reviews` added in `app/_layout.tsx`; profile action link added in `(tabs)/me.tsx` | NO | PARTIAL - static implementation complete, device QA pending |
| Brand/vendor | Web public brand Reviews tab | Public verified reviews visible where feature allows. | PASS | `fthreadly/src/components/profile/tabs/ReviewsTab.tsx` | NO | PASS |
| Brand/vendor | Mobile public brand Reviews tab | Public verified reviews visible where feature allows. | PASS | `threadly-mobile/components/catalog/BrandReviewsTab.tsx` | NO | PASS |
| Brand/vendor | Web brand dashboard Reviews screen | Read-only vendor review management, no delete. | PASS | `fthreadly/src/pages/studio/BrandReviewsDashboardPage.tsx`; `/brand/reviews` redirects to `/studio?tab=reviews`; `BrandReviewsDashboardPage.test.tsx` passed | NO | PASS |
| Brand/vendor | Web brand product/design/collection review breakdown | Breakdown by lifecycle target with filters. | PASS | `GET /brands/reviews/lifecycle` returns `breakdown.targets`; dashboard target cards filter by target | NO | PASS |
| Brand/vendor | Web brand report/flag review action | Vendor can escalate own-brand lifecycle review; no hide/approve/delete. | PASS | `POST /brands/reviews/lifecycle/:reviewId/report`; report modal in `BrandReviewsDashboardPage.tsx`; backend/web tests passed | NO | PASS |
| Brand/vendor | Mobile brand review dashboard or documented mobile equivalent | Mobile equivalent or documented absence. | PARTIAL | Mobile has public brand Reviews tab; vendor management remains web-first in Studio because no native vendor dashboard architecture exists for this workflow. | NO | PARTIAL - documented web-first equivalent |
| Brand/vendor | Confirm no brand delete buyer review UI exists anywhere | Vendors cannot delete buyer reviews. | PASS | Delete controls require reviewer ownership in web/mobile `ReviewCard`; no brand delete route/UI found. | NO | PASS |
| Admin/super admin | Web Admin Reviews Moderation screen | Lifecycle moderation list with filters. | PASS | `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `bthreadly/src/reviews/admin-reviews.controller.ts` | NO | PASS |
| Admin/super admin | Web Admin Review Detail modal/page | Detail view includes IDs/timestamps/source context. | PASS | `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `GET /admin/reviews/lifecycle/:reviewId` | NO | PASS |
| Admin/super admin | Web Admin approve/hide/flag action UI | No hard delete; permission-gated. | PASS | `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `AdminReviewsPage.test.tsx` | NO | PASS |
| Admin/super admin | Web Admin Review Rules settings tab | Feature flags and edit-window control. | PASS | `fthreadly/src/pages/admin/AdminSettingsPage.tsx` | NO | PASS |
| Admin/super admin | Web Admin Review Analytics screen | Review analytics visible to permitted admins. | PASS | `GET /admin/reviews/analytics`; analytics panel in `AdminReviewsPage.tsx`; `AdminReviewsPage.test.tsx` passed | NO | PASS |
| Admin/super admin | SuperAdmin can access all review admin surfaces | SuperAdmin bypasses permission aliases. | PASS | `fthreadly/src/hooks/useAdminPermissions.ts` | NO | PASS |
| Admin/super admin | Permission-limited admin cannot access moderation actions | Actions hidden/blocked without moderation write permission. | PASS | `AdminReviewsPage.tsx` checks `MODERATION_REVIEW`; `AdminReviewsPage.test.tsx` covers permission-limited action hiding | NO | PASS |
| General | Feature flags respected | Capture/public display flags remain source of truth. | PASS | Backend `REVIEW_FEATURE_FLAGS`; web/mobile catch 403 public-display disabled responses. | NO | PASS |
| General | Collection/design public reviews hidden when flags are OFF | No default public collection/design UI; backend gates endpoints. | PASS | `bthreadly/src/reviews/reviews.service.ts`; web/mobile only render product/brand public surfaces by default. | NO | PASS |
| General | Parent catalog/profile tab state is not reset by nested review interaction where code-testable | Review state isolated in child components. | PARTIAL | `fthreadly/src/components/reviews/ReviewsTab.tsx`; manual runtime QA still pending. | NO | PASS - code-testable isolation complete |
| General | Review screens have loading states | All implemented review management screens include loading states. | PASS | Web: `MyReviewsPage.tsx`, `BrandReviewsDashboardPage.tsx`, `AdminReviewsPage.tsx`; Mobile: `app/reviews/index.tsx` | NO | PASS |
| General | Review screens have empty states | All implemented review management screens include empty states. | PASS | Web/mobile My Reviews, brand dashboard, admin moderation | NO | PASS |
| General | Review screens have error/retry states | All implemented review management screens include error or retry states. | PASS | Web/mobile My Reviews, brand dashboard, admin moderation | NO | PASS |
| General | Review screens have stable keys | Existing review lists key by review id. | PASS | Web/mobile `ReviewCard` list renderers. | NO | PASS |
| General | Review screens do not use hardcoded theme-breaking colors | New mobile screen uses theme/tokens; web follows existing Tailwind dark/light classes. | PASS | `threadly-mobile/app/reviews/index.tsx`; web review pages use existing design tokens/classes | NO | PASS |
| General | Seeded review data supports all non-manual automated checks | Seed covers buyer, brand, admin lifecycle states; new non-manual checks are covered by backend/web focused tests. | PASS | `scripts/seed-reviews-e2e.ts`; backend `review-lifecycle.service.spec.ts`; web focused tests passed | NO | PASS |

## Audit Questions

| Question | Answer | Evidence |
| --- | --- | --- |
| Which buyer review screens exist? | Order-history prompt surfaces, review submit/edit sheets/modals, delete confirmation, product review summary, and brand Reviews tab exist on web/mobile. | Web: `fthreadly/src/pages/orders/MyOrders.tsx`, `fthreadly/src/components/reviews/*`; Mobile: `threadly-mobile/app/orders/index.tsx`, `threadly-mobile/components/reviews/*` |
| Which brand review screens exist? | Public brand Reviews tab exists on web/mobile. Dedicated brand dashboard review-management screen is deferred. | Web: `fthreadly/src/components/profile/tabs/ReviewsTab.tsx`; Mobile: `threadly-mobile/components/catalog/BrandReviewsTab.tsx` |
| Which admin review screens exist? | Phase 16B-2 adds a lifecycle admin Reviews screen at `/admin/reviews`. Legacy product-review moderation remains under existing moderation surfaces. | `fthreadly/src/pages/admin/AdminReviewsPage.tsx`, `fthreadly/src/App.tsx`, `bthreadly/src/reviews/admin-reviews.controller.ts` |
| Is there a My Reviews screen? | Yes. Web uses `/account/reviews`; mobile uses `/reviews`. | Web: `fthreadly/src/pages/account/MyReviewsPage.tsx`; Mobile: `threadly-mobile/app/reviews/index.tsx`. |
| Is there an admin moderation screen? | Yes for lifecycle reviews on web admin. Manual browser QA is still pending. | `AdminReviewsPage.test.tsx` passed; route `/admin/reviews`. |
| Is there a feature flag UI for review public display? | Yes, integrated into web admin Settings under `Review Rules`. | `fthreadly/src/pages/admin/AdminSettingsPage.tsx` |
| Can brand users report/flag reviews, or is that deferred? | Yes for lifecycle reviews on web. Brands can report own-brand reviews for admin moderation and still cannot delete buyer reviews. | Backend: `POST /brands/reviews/lifecycle/:reviewId/report`; Web: `BrandReviewsDashboardPage.tsx`. |
| Are collection/design reviews hidden when flags are OFF? | Yes by backend default and UI behavior. No public collection/design review UI is exposed by default. | `bthreadly/docs/reviews-feature-flags.md`; web/mobile product/brand surfaces only. |
| Do review interactions preserve parent tab state? | Code isolates review state inside ReviewsTab/admin pages, but runtime browser/device QA is pending. | `fthreadly/src/components/profile/tabs/ReviewsTab.tsx`, `threadly-mobile/components/reviews/ReviewsTab.tsx` |
| What is still NOT TESTED? | Manual browser/device QA for buyer prompt submit/skip/edit/delete, brand cannot delete, parent tab stability, and admin hide/approve/flag. | `bthreadly/docs/reviews-ui-manual-qa.md` |

## Buyer/Customer

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Buyer/customer | Orders / Completed Orders review prompt surface | Show optional review prompts after completed order lifecycle eligibility. | PASS | Web: `fthreadly/src/pages/orders/MyOrders.tsx`; Mobile: `threadly-mobile/app/orders/index.tsx` | NO | PARTIAL - implemented, manual QA pending |
| Buyer/customer | Review submit/edit modal or sheet | Capture rating, satisfaction, and optional review text; edit only inside backend window. | PASS | Web/mobile review form components; `ReviewFormModal.test.tsx` passed | NO | PARTIAL - implemented, manual QA pending |
| Buyer/customer | Delete review confirmation modal or sheet | Confirm buyer soft-delete action. | PASS | Web/mobile delete confirmation components under `components/reviews` | NO | PARTIAL - implemented, manual QA pending |
| Buyer/customer | Product review section | Show product review summary/list where public display is enabled. | PASS | `fthreadly/src/components/reviews/ProductReviewSection.tsx`; mobile `MarketCommerceViewer` product summary | NO | PARTIAL - implemented, manual QA pending |
| Buyer/customer | Brand catalog/profile Reviews tab | Show public brand review summary/list. | PASS | Web/mobile brand Reviews tab components | NO | PARTIAL - implemented, manual QA pending |
| Buyer/customer | Optional My Reviews management screen | Let buyer manage submitted reviews outside order/product context. | PASS | Web `/account/reviews`; mobile `/reviews`; focused web test passed | NO | PASS - manual QA pending |

## Brand/Vendor

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Brand/vendor | Public brand Reviews tab | Display public verified reviews on brand profile/catalog. | PASS | Web/mobile brand Reviews tab components | NO | PARTIAL - implemented, manual QA pending |
| Brand/vendor | Brand dashboard Reviews screen or documented deferral | Give vendors a safe read-only view of buyer reviews. | PASS | Web Studio Reviews dashboard at `/studio?tab=reviews`; `/brand/reviews` redirects there | NO | PASS |
| Brand/vendor | Product/design/collection review breakdown or documented deferral | Filter/review feedback by target. | PASS | Brand lifecycle dashboard target breakdown and filters | NO | PASS |
| Brand/vendor | Brand report/flag review action if supported, or documented deferral | Allow a vendor escalation path without delete power. | PASS | Lifecycle brand report endpoint and web report modal | NO | PASS |
| Brand/vendor | Confirm no brand delete buyer review UI exists | Ensure vendors cannot delete buyer lifecycle reviews. | PASS | Delete controls are reviewer-owned; no brand lifecycle delete UI found. | NO | PARTIAL - code audited, manual QA pending |

## Admin/Super Admin

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Admin/super admin | Admin Reviews Moderation screen | List lifecycle reviews with filters and moderation actions. | FAIL | Added `GET /admin/reviews/lifecycle`; added `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `AdminReviewsPage.test.tsx` passed | NO | PASS |
| Admin/super admin | Admin Review Detail modal/page | Inspect full lifecycle review details and source IDs. | FAIL | Added detail modal and `GET /admin/reviews/lifecycle/:id`; web build passed | NO | PASS |
| Admin/super admin | Admin hide/approve/flag action UI | Moderate lifecycle reviews without hard delete. | PARTIAL | Added web action buttons; approve wiring covered by `AdminReviewsPage.test.tsx`; backend focused suite passed | NO | PARTIAL - hide/flag manual QA pending |
| Admin/super admin | Admin Review Feature Flags screen or integration into existing System Config UI | Control review lifecycle/public display flags and edit window safely. | PARTIAL | Added `Review Rules` tab to `AdminSettingsPage.tsx`; web build passed | NO | PASS |
| Admin/super admin | Admin Review Analytics screen or documented deferral | Show higher-level review analytics. | PASS | `GET /admin/reviews/analytics`; admin analytics panel; focused test passed | NO | PASS |

## General

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| General | Feature-flag behavior | Respect capture and public-display flags. | PARTIAL | Backend flags exist; web `Review Rules` tab exposes flags; collection/design defaults remain OFF | NO | PARTIAL - manual QA pending |
| General | Smooth catalog tab behavior | Keep parent catalog/profile state stable during nested review interactions. | PARTIAL | Review state is isolated in components; no full parent reload was added. | NO | PARTIAL - manual browser/device QA pending |
| General | Parent page/screen does not shake/reset | Avoid parent reload/reset on review list/edit/delete interactions. | NOT TESTED | Requires browser/device execution. | YES | NOT TESTED |
| General | Seeded QA coverage | Deterministic review lifecycle data and execution record. | NOT TESTED | Added `scripts/seed-reviews-e2e.ts`; `npm run seed:e2e:reviews` passed; `docs/reviews-e2e-seed-data.md` generated | NO | PASS |

## Validation Summary

| Command | Result |
| --- | --- |
| `npx prisma migrate status` | PASS - database schema is up to date |
| `npm run seed:e2e:reviews` | PASS |
| `npx prisma generate` | PASS |
| `npx jest src/reviews src/bagging src/store src/custom-orders --runInBand` | PASS - 12 suites, 100 tests |
| `npm run build` in backend | PASS |
| `npm run test -- ReviewApi.test.ts MyReviewsPage.test.tsx BrandReviewsDashboardPage.test.tsx AdminReviewsPage.test.tsx` | PASS - 4 files, 12 tests |
| `npm run build` in web | PASS |
| scoped web ESLint on changed files | PASS |
| `npm exec tsc -- --noEmit` in mobile | PASS |
| `npm run ci:design-system` in mobile | PASS |
| `npm run audit:theme` in mobile | PASS |

## Production Blockers

- Manual web QA has not been executed against seeded review data.
- Manual mobile QA has not been executed on Android/iOS.
- Admin hide/flag actions need browser QA even though endpoint/UI wiring exists.
- Parent catalog/profile tab shake/reset behavior needs browser/device confirmation.
- No non-manual review screen/surface blocker remains after Phase 16B-3. Remaining blockers are manual browser/device QA only.
