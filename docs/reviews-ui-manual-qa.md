# Reviews UI Manual QA

Updated: 2026-05-18.

## Environment Evidence

| Check | Result | Evidence |
| --- | --- | --- |
| Review lifecycle migration applied locally | PASS | `npx prisma migrate status` returned: `Database schema is up to date!` |
| Deterministic review seed data | PASS | `npm run seed:e2e:reviews` completed and wrote `docs/reviews-e2e-seed-data.md` |
| Backend focused regression | PASS | `npx jest src/reviews src/bagging src/store src/custom-orders --runInBand`: 12 suites, 96 tests passed |
| Web review focused tests | PASS | `npm run test -- ReviewApi.test.ts ReviewFormModal.test.tsx AdminReviewsPage.test.tsx`: 3 files, 6 tests passed |
| Web build | PASS | `npm run build` completed |
| Mobile static validation | PASS | `npm exec tsc -- --noEmit`, `npm run ci:design-system`, and `npm run audit:theme` passed |

Manual browser/device execution was not completed in this coding pass. Rows that require browser, Android emulator, iOS simulator, or physical device execution remain `NOT TESTED` and are production blockers.

## Web QA Matrix

| Platform | Scenario | Device/browser | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Web | Completed order prompt appears | NOT RUN | Sign in as `e2e.reviews.buyer@threadly.test`; open `/orders`. | Optional review prompt card appears without blocking order navigation. | Not executed manually. | NOT TESTED | Seeded prompt IDs in `docs/reviews-e2e-seed-data.md`; component/API tests passed. |
| Web | Submit review | NOT RUN | Click prompt `Write review`, choose star rating and satisfaction, enter optional text, submit. | `POST /reviews` succeeds, prompt disappears, success toast appears. | Not executed manually. | NOT TESTED | `ReviewFormModal.test.tsx` verifies valid submit payload. |
| Web | Skip review | NOT RUN | Click prompt `Skip`. | `POST /reviews/prompts/:id/skip` succeeds and prompt disappears. | Not executed manually. | NOT TESTED | `ReviewApi.test.ts` verifies endpoint and idempotency header. |
| Web | Edit review within 24 hours | NOT RUN | Open seeded editable review as buyer before `editWindowExpiresAt`; save edit. | PATCH succeeds, review card updates locally, countdown is not reset. | Not executed manually. | NOT TESTED | Backend lifecycle tests passed. |
| Web | Edit not available after 24 hours | NOT RUN | Open seeded expired review as buyer. | Edit control is hidden and backend rejects direct PATCH. | Not executed manually. | NOT TESTED | Backend lifecycle tests passed. |
| Web | Delete own review after 24 hours | NOT RUN | Open seeded expired review as buyer; click Delete; confirm. | DELETE soft-deletes review, card disappears, public summary updates. | Not executed manually. | NOT TESTED | Backend lifecycle tests passed. |
| Web | Brand cannot delete buyer review | NOT RUN | Sign in as `e2e.reviews.brand@threadly.test`; open brand Reviews tab. | Buyer review cards do not show delete controls. | Not executed manually. | NOT TESTED | UI gates controls by reviewer ownership; backend forbids non-reviewer delete. |
| Web | Product review summary displays | NOT RUN | Open seeded product with public approved review. | Product review summary/list renders from `/reviews/product/:productId`. | Not executed manually. | NOT TESTED | Web build passed. |
| Web | Brand Reviews tab displays | NOT RUN | Open seeded brand catalog/profile Reviews tab. | Summary, satisfaction distribution, verified badge, list, empty/error states render. | Not executed manually. | NOT TESTED | Web build passed. |
| Web | Collection/design public reviews hidden when flags OFF | NOT RUN | Open collection/design public surfaces with default flags. | No public collection/design review list is exposed. | Not executed manually. | NOT TESTED | Backend defaults keep collection/design public flags OFF. |
| Web | Parent catalog/profile tab does not shake/reset | NOT RUN | Interact with Reviews tab list, edit, and delete flows. | Active tab and parent scroll remain stable. | Not executed manually. | NOT TESTED | Needs browser QA. |
| Web | Review list pagination does not reset active tab | NOT RUN | Use review list pagination/lazy load if enabled. | Active catalog tab remains Reviews. | Not executed manually. | NOT TESTED | Backend public review list currently returns `nextCursor: null`. |
| Web | Review card buttons do not trigger parent navigation | NOT RUN | Click Edit/Delete inside review cards rendered in catalog context. | Only review action fires. | Not executed manually. | NOT TESTED | Web review cards stop propagation in code. |
| Web admin | Admin moderation screen lists reviews | NOT RUN | Sign in as `e2e.reviews.admin@threadly.test`; open `/admin/reviews`. | Lifecycle review table loads seeded approved/hidden/flagged/pending/deleted reviews. | Not executed manually. | PARTIAL | Automated `AdminReviewsPage.test.tsx` verifies list rendering. Manual browser QA pending. |
| Web admin | Admin hide/approve/flag works | NOT RUN | Use `/admin/reviews` action buttons and detail modal. | Status changes call lifecycle hide/approve/flag endpoints; no hard delete exists. | Not executed manually. | PARTIAL | Automated test verifies Approve endpoint wiring; backend lifecycle endpoints exist. Manual hide/flag QA pending. |
| Web admin | Admin review detail opens | NOT RUN | Click `View detail` on a review row. | Modal shows IDs, timestamps, reviewer, brand, target, deleted/hidden state. | Not executed manually. | PARTIAL | `AdminReviewsPage.tsx` implementation and build passed. |
| Web admin | Admin feature flags visible | NOT RUN | Open `/admin/settings`, select `Review Rules`. | Review capture/public-display/moderation flags and edit-window input are visible. | Not executed manually. | PARTIAL | `AdminSettingsPage.tsx` implementation and build passed. |

## Mobile QA Matrix

| Platform | Scenario | Device/browser | Steps | Expected result | Actual result | Status | Evidence note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Mobile | Completed order prompt appears | NOT RUN | Sign in on native app; open Orders with completed prompts. | Optional prompt cards appear above order stats. | Not executed on device/simulator. | NOT TESTED | Mobile static validation passed. |
| Mobile | Submit review | NOT RUN | Tap prompt `Write review`, choose rating/satisfaction, submit sheet. | `POST /reviews` succeeds, sheet closes, prompt disappears. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |
| Mobile | Skip review | NOT RUN | Tap prompt `Skip`. | Prompt disappears and does not loop. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |
| Mobile | Edit within 24 hours | NOT RUN | Open buyer-owned brand/product review before `editWindowExpiresAt`; tap Edit. | Review form sheet opens and PATCH updates card locally. | Not executed on device/simulator. | NOT TESTED | Requires seeded review. |
| Mobile | Edit hidden after 24 hours | NOT RUN | Open expired buyer-owned review. | Edit action is hidden. | Not executed on device/simulator. | NOT TESTED | Requires seeded expired review. |
| Mobile | Delete own review after 24 hours | NOT RUN | Open buyer-owned review; tap Delete; confirm sheet. | DELETE soft-deletes review and removes card locally. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |
| Mobile | Brand cannot delete buyer review | NOT RUN | Sign in as brand; open catalog Reviews tab. | Delete action is absent. | Not executed on device/simulator. | NOT TESTED | Requires brand auth session. |
| Mobile | Product review summary displays | NOT RUN | Open native market product viewer. | Product-only review summary appears when product public reviews are enabled. | Not executed on device/simulator. | NOT TESTED | Static validation only. |
| Mobile | Brand Reviews tab displays | NOT RUN | Open native catalog Reviews tab. | Lifecycle brand summary/list renders. | Not executed on device/simulator. | NOT TESTED | Static validation only. |
| Mobile | Collection/design public reviews hidden when flags OFF | NOT RUN | Open design/collection market viewer with default flags. | No public collection/design review list appears. | Not executed on device/simulator. | NOT TESTED | Static validation only. |
| Mobile | Parent catalog/profile tab does not shake/reset | NOT RUN | Interact with Reviews tab and edit/delete sheets. | Tab content remains stable; parent does not reload all tabs. | Not executed on device/simulator. | NOT TESTED | Requires emulator/device. |

## Manual QA Blockers

- Web browser QA has not been executed against the seeded review data.
- Android emulator/iOS simulator/manual mobile QA has not been executed.
- Production-ready status cannot be claimed until prompt submit/skip, edit-after-24h, delete-anytime, brand-cannot-delete, and admin hide/approve/flag flows are manually verified.
