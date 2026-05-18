# Reviews UI Manual QA

Created: 2026-05-18.

Manual QA was not executed on a browser session, Android emulator, iOS simulator, or physical device during this coding pass. Automated validation covered API normalization, web review form validation, backend review/bagging/store/custom-order tests, web build, mobile TypeScript, mobile design-system CI, and mobile theme audit. Production readiness still requires the manual rows below to be executed against a database with `20260518170000_add_review_lifecycle` applied and completed-order review prompts seeded by real completion flows.

| Platform | Scenario | Device/browser | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Completed order prompt appears | NOT RUN | Sign in as buyer with completed standard/custom order prompts; open `/orders`. | Optional review prompt card appears without blocking order navigation. | Not executed manually. | NOT TESTED | Component/API coverage only: `ReviewApi.test.ts`, `ReviewFormModal.test.tsx`. |
| Web | Submit review | NOT RUN | Click prompt `Write review`, choose star rating, choose satisfaction, enter optional text, submit. | `POST /reviews` succeeds, prompt disappears, success toast appears. | Not executed manually. | NOT TESTED | Automated form validation verifies payload shape. |
| Web | Skip review | NOT RUN | Click prompt `Skip`. | `POST /reviews/prompts/:id/skip` succeeds and prompt disappears. | Not executed manually. | NOT TESTED | API test verifies endpoint/header. |
| Web | Edit review within 24 hours | NOT RUN | Open a product/brand review owned by the buyer before `editWindowExpiresAt`; click Edit; save. | Edit modal opens, PATCH succeeds, review card updates without full profile reload. | Not executed manually. | NOT TESTED | Requires seeded review visible in public list. |
| Web | Edit not available after 24 hours | NOT RUN | Open a buyer-owned review after `editWindowExpiresAt`. | Edit control is hidden and backend rejects direct PATCH. | Not executed manually. | NOT TESTED | Backend tests cover expired edit rejection. |
| Web | Delete own review after 24 hours | NOT RUN | Open a buyer-owned review after 24 hours; click Delete; confirm. | DELETE soft-deletes review, card disappears, public summary count updates locally. | Not executed manually. | NOT TESTED | Requires seeded expired review visible in public list. |
| Web | Brand cannot delete buyer review | NOT RUN | Sign in as brand owner; open catalog Reviews tab. | Buyer review cards do not show delete controls. | Not executed manually. | NOT TESTED | UI gates controls by `reviewerId`; backend forbids non-reviewer delete. |
| Web | Product review summary displays | NOT RUN | Open product detail with `reviews.publicDisplay.product.enabled`. | Product review summary/list renders from `/reviews/product/:productId`. | Not executed manually. | NOT TESTED | Web build passed. |
| Web | Brand Reviews tab displays | NOT RUN | Open catalog Reviews tab with `reviews.publicDisplay.brand.enabled`. | Summary, satisfaction distribution, verified badges, list, empty/error states render without resetting parent tab. | Not executed manually. | NOT TESTED | Uses isolated lifecycle `ReviewsTab`. |
| Web | Collection/design public reviews hidden when flags OFF | NOT RUN | Open collection/design public surfaces with default flags. | No public collection/design review list is exposed. | Not executed manually. | NOT TESTED | Backend flags default OFF; no UI surface added for these lists. |
| Web | Parent catalog/profile tab does not shake/reset | NOT RUN | Paginate/refresh review list, edit/delete review in Reviews tab. | Active tab and parent scroll remain stable. | Not executed manually. | NOT TESTED | Needs browser QA. |
| Web | Review list pagination does not reset active tab | NOT RUN | Use review list pagination/lazy load if enabled. | Active catalog tab remains Reviews. | Not executed manually. | NOT TESTED | Backend currently returns `nextCursor: null`. |
| Web | Review card buttons do not trigger parent navigation | NOT RUN | Click Edit/Delete inside a review card rendered in catalog context. | Only review action fires; parent card navigation does not trigger. | Not executed manually. | NOT TESTED | Buttons stop propagation on web cards. |
| Mobile | Completed order prompt appears | NOT RUN | Sign in on native app; open Orders with completed prompts. | Optional prompt cards appear above order stats. | Not executed on device/simulator. | NOT TESTED | Mobile TypeScript/design/theme passed. |
| Mobile | Submit review | NOT RUN | Tap prompt `Write review`, choose rating/satisfaction, submit sheet. | `POST /reviews` succeeds, sheet closes, prompt disappears. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |
| Mobile | Skip review | NOT RUN | Tap prompt `Skip`. | Prompt disappears and does not loop. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |
| Mobile | Edit review within 24 hours | NOT RUN | Open buyer-owned brand/product review before `editWindowExpiresAt`; tap Edit. | Review form sheet opens and PATCH updates card locally. | Not executed on device/simulator. | NOT TESTED | Requires seeded review. |
| Mobile | Edit not available after 24 hours | NOT RUN | Open expired buyer-owned review. | Edit action is hidden. | Not executed on device/simulator. | NOT TESTED | Requires seeded expired review. |
| Mobile | Delete own review after 24 hours | NOT RUN | Open buyer-owned review; tap Delete; confirm sheet. | DELETE soft-deletes review and removes card locally. | Not executed on device/simulator. | NOT TESTED | Requires seeded review. |
| Mobile | Brand cannot delete buyer review | NOT RUN | Sign in as brand; open catalog Reviews tab. | Delete action is absent. | Not executed on device/simulator. | NOT TESTED | Requires brand auth session. |
| Mobile | Product review summary displays | NOT RUN | Open native market product viewer. | Product-only review summary appears in metadata sheet when product public reviews are enabled. | Not executed on device/simulator. | NOT TESTED | `MarketCommerceViewer` now renders compact product ReviewsTab. |
| Mobile | Brand Reviews tab displays | NOT RUN | Open native catalog Reviews tab. | Lifecycle brand summary/list renders. | Not executed on device/simulator. | NOT TESTED | `BrandReviewsTab` now delegates to lifecycle `ReviewsTab`. |
| Mobile | Collection/design public reviews hidden when flags OFF | NOT RUN | Open design/collection market viewer with default flags. | No public collection/design review list appears. | Not executed on device/simulator. | NOT TESTED | Design placeholder was removed from market viewer. |
| Mobile | Parent catalog/profile tab does not shake/reset | NOT RUN | Interact with Reviews tab and edit/delete sheets. | Tab content remains stable; parent does not reload all tabs. | Not executed on device/simulator. | NOT TESTED | Needs emulator/device QA. |
| Mobile | Review list pagination does not reset active tab | NOT RUN | Use pagination/lazy load if enabled. | Active Reviews tab remains selected. | Not executed on device/simulator. | NOT TESTED | Backend currently returns `nextCursor: null`. |
| Mobile | Review card buttons do not trigger parent navigation | NOT RUN | Tap Edit/Delete inside review card. | Only sheet action opens. | Not executed on device/simulator. | NOT TESTED | Needs emulator/device QA. |

## Manual QA Blockers

- No browser/manual UI session was run for web.
- No Android emulator, iOS simulator, or physical device QA was run for mobile.
- Seeded completed-order review prompt data is still required for end-to-end prompt/edit/delete verification.
