# Reviews Screen Architecture Checklist

Phase: 16B-2
Updated: 2026-05-18
Scope: Buyer, brand, and admin review lifecycle screens across web/mobile, with seeded/manual QA tracking.

## Audit Questions

| Question | Answer | Evidence |
| --- | --- | --- |
| Which buyer review screens exist? | Order-history prompt surfaces, review submit/edit sheets/modals, delete confirmation, product review summary, and brand Reviews tab exist on web/mobile. | Web: `fthreadly/src/pages/orders/MyOrders.tsx`, `fthreadly/src/components/reviews/*`; Mobile: `threadly-mobile/app/orders/index.tsx`, `threadly-mobile/components/reviews/*` |
| Which brand review screens exist? | Public brand Reviews tab exists on web/mobile. Dedicated brand dashboard review-management screen is deferred. | Web: `fthreadly/src/components/profile/tabs/ReviewsTab.tsx`; Mobile: `threadly-mobile/components/catalog/BrandReviewsTab.tsx` |
| Which admin review screens exist? | Phase 16B-2 adds a lifecycle admin Reviews screen at `/admin/reviews`. Legacy product-review moderation remains under existing moderation surfaces. | `fthreadly/src/pages/admin/AdminReviewsPage.tsx`, `fthreadly/src/App.tsx`, `bthreadly/src/reviews/admin-reviews.controller.ts` |
| Is there a My Reviews screen? | No dedicated buyer My Reviews route exists. Existing edit/delete is available through prompt/product/brand review cards. | Deferred; no `/reviews/my`, `/account/reviews`, or mobile `app/reviews` route was added. |
| Is there an admin moderation screen? | Yes for lifecycle reviews on web admin. Manual browser QA is still pending. | `AdminReviewsPage.test.tsx` passed; route `/admin/reviews`. |
| Is there a feature flag UI for review public display? | Yes, integrated into web admin Settings under `Review Rules`. | `fthreadly/src/pages/admin/AdminSettingsPage.tsx` |
| Can brand users report/flag reviews, or is that deferred? | Deferred for lifecycle reviews. No brand delete UI exists. | No lifecycle brand report/flag endpoint/UI found; documented deferral. |
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
| Buyer/customer | Optional My Reviews management screen | Let buyer manage submitted reviews outside order/product context. | FAIL | No dedicated web or mobile My Reviews route found. | NO - documented deferral | DEFERRED |

## Brand/Vendor

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Brand/vendor | Public brand Reviews tab | Display public verified reviews on brand profile/catalog. | PASS | Web/mobile brand Reviews tab components | NO | PARTIAL - implemented, manual QA pending |
| Brand/vendor | Brand dashboard Reviews screen or documented deferral | Give vendors a safe read-only view of buyer reviews. | FAIL | No lifecycle brand dashboard review-management route found. | NO - documented deferral | DEFERRED |
| Brand/vendor | Product/design/collection review breakdown or documented deferral | Filter/review feedback by target. | FAIL | No lifecycle vendor breakdown UI found. | NO - documented deferral | DEFERRED |
| Brand/vendor | Brand report/flag review action if supported, or documented deferral | Allow a vendor escalation path without delete power. | FAIL | Lifecycle brand report/flag endpoint/UI not found. | NO - documented deferral | DEFERRED |
| Brand/vendor | Confirm no brand delete buyer review UI exists | Ensure vendors cannot delete buyer lifecycle reviews. | PASS | Delete controls are reviewer-owned; no brand lifecycle delete UI found. | NO | PARTIAL - code audited, manual QA pending |

## Admin/Super Admin

| User type | Screen/surface | Purpose | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- | --- |
| Admin/super admin | Admin Reviews Moderation screen | List lifecycle reviews with filters and moderation actions. | FAIL | Added `GET /admin/reviews/lifecycle`; added `fthreadly/src/pages/admin/AdminReviewsPage.tsx`; `AdminReviewsPage.test.tsx` passed | NO | PASS |
| Admin/super admin | Admin Review Detail modal/page | Inspect full lifecycle review details and source IDs. | FAIL | Added detail modal and `GET /admin/reviews/lifecycle/:id`; web build passed | NO | PASS |
| Admin/super admin | Admin hide/approve/flag action UI | Moderate lifecycle reviews without hard delete. | PARTIAL | Added web action buttons; approve wiring covered by `AdminReviewsPage.test.tsx`; backend focused suite passed | NO | PARTIAL - hide/flag manual QA pending |
| Admin/super admin | Admin Review Feature Flags screen or integration into existing System Config UI | Control review lifecycle/public display flags and edit window safely. | PARTIAL | Added `Review Rules` tab to `AdminSettingsPage.tsx`; web build passed | NO | PASS |
| Admin/super admin | Admin Review Analytics screen or documented deferral | Show higher-level review analytics. | FAIL | No review analytics screen found. | NO - documented deferral | DEFERRED |

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
| `npx jest src/reviews src/bagging src/store src/custom-orders --runInBand` | PASS - 12 suites, 96 tests |
| `npm run build` in backend | PASS |
| `npm run test -- ReviewApi.test.ts ReviewFormModal.test.tsx AdminReviewsPage.test.tsx` | PASS - 3 files, 6 tests |
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
- Dedicated buyer My Reviews, brand dashboard review management, brand lifecycle report/flag, and admin analytics are documented deferrals, not completed surfaces.
