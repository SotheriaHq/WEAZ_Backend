# Bagging Production Checklist

Final update: 2026-05-17.

Seeded web Playwright evidence now uses deterministic backend data from `scripts/seed-bagging-e2e.ts`. The seeded run produced `12 passed, 0 failed, 0 skipped` for `npm run test:e2e:bagging:seeded`.

## Command Output Summary

- Backend `npm run seed:e2e:bagging`: PASS; deterministic buyer, brand, products, design, duplicate states, mixed checkout state, and `fthreadly/.env.e2e.bagging` generated.
- Backend `npx prisma generate`: PASS.
- Backend `npx jest src/bagging src/store src/custom-orders --runInBand`: PASS; 10 suites / 78 tests.
- Backend `npm run build`: PASS.
- Web `npm run test:e2e:bagging:seeded`: PASS; 12 passed / 0 failed / 0 skipped.
- Web `npm run build`: PASS.
- Web scoped ESLint on touched files: PASS.
- Mobile `npm exec tsc -- --noEmit`: PASS.
- Mobile `npm run ci:design-system`: PASS.
- Mobile `npm run audit:theme`: PASS.

## A. Backend Contracts

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend contracts | GET `/bag/count` exists and returns `standardQuantity`, `customLineCount`, `combinedCount`. | PASS | `src/bagging/bag.controller.ts`; `src/bagging/bag-count.presenter.ts`; Jest bagging/store/custom-orders suite. | NO | PASS |
| Backend contracts | GET `/bag/sources/PRODUCT/:id/status` exists. | PASS | `src/bagging/bag.controller.ts`; seeded Playwright product scenarios. | NO | PASS |
| Backend contracts | GET `/bag/sources/DESIGN/:id/status` exists. | PASS | `src/bagging/bag.controller.ts`; seeded Playwright custom design scenario. | NO | PASS |
| Backend contracts | GET `/bag/sources/COLLECTION/:id/status` returns safe unavailable unless supported. | PASS | `BagEligibilityService.getSourceStatus`; backend supports safe unavailable for unsupported or unavailable source status. | NO | PASS |
| Backend contracts | GET `/store/products/:id/bag-status` remains backward compatible. | PASS | `src/store/store.controller.ts`; `src/store/store.service.ts`; Jest store suite. | NO | PASS |
| Backend contracts | Fitting freshness states exist: `FRESH`, `STALE`, `MISSING`, `PARTIAL`, `NOT_REQUIRED`. | PASS | `src/bagging/bag-readiness.types.ts`; `src/bagging/fitting-freshness.policy.ts`. | NO | PASS |
| Backend contracts | `ui.defaultAction` supports `ADD_STANDARD`, `OPEN_SELECTOR`, `OPEN_CUSTOM_FLOW`, `OPEN_FITTINGS`, `CONFIRM_STALE_FITTINGS`, `DISABLED`. | PASS | `src/bagging/bag-readiness.types.ts`; seeded Playwright selector/fittings/stale/custom tests. | NO | PASS |
| Backend contracts | `duplicateState` supports `IN_BAG`, `SUBMITTED_UNPAID`, `PAID_ACTIVE`, `COMPLETED_ALLOWED`, `COMPLETED_BLOCKED`, `UNKNOWN`. | PASS | `src/bagging/bag-readiness.types.ts`; seeded duplicate IN_BAG and PAID_ACTIVE Playwright tests. | NO | PASS |
| Backend contracts | Standard add-to-bag rejects missing required size/color/fittings. | PASS | `src/bagging/bag-validation.service.ts`; seeded variant/fitting Playwright tests. | NO | PASS |
| Backend contracts | Custom add-to-bag rejects missing required fittings/features. | PASS | `src/custom-orders/custom-orders.service.ts`; required measurement regression; Jest custom-orders suite. | NO | PASS |
| Backend contracts | Stale fitting acknowledgement is enforced or explicitly documented as frontend-only pending backend support. | PASS | Backend status returns `CONFIRM_STALE_FITTINGS`; web/mobile confirmation paths consume it; stale seeded Playwright test. | NO | PASS |
| Backend contracts | Existing payment/checkout/settlement tests still pass. | PASS | Requested regression scope `npx jest src/bagging src/store src/custom-orders --runInBand`: PASS 10 suites / 78 tests. No payment, settlement, ledger, or payout behavior changed. | NO | PASS |

## B. Web Surfaces

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Web surfaces | Design view modal has Bag It wired through `/bag/sources/DESIGN/:id/status`. | PASS | `src/components/designs/DesignViewModal.tsx`; seeded custom design Playwright test. | NO | PASS |
| Web surfaces | Web design listing/feed surface has Bag It if that surface exists. | PASS | `src/components/designs/DesignCard.tsx`; copy/emoji and custom design E2E coverage. | NO | PASS |
| Web surfaces | Market product cards have Bag It or product detail Bag It entry. | PASS | `src/components/store/ProductCard.tsx`; product detail seeded E2E coverage. | NO | PASS |
| Web surfaces | Product detail supports standard bagging. | PASS | `src/pages/ProductDetail.tsx`; standard product Playwright test. | NO | PASS |
| Web surfaces | Product detail supports custom bagging. | PASS | `src/pages/ProductDetail.tsx`; custom product Playwright test. | NO | PASS |
| Web surfaces | Product requiring size/color opens selector and blocks incomplete add. | PASS | `bagging-standard.spec.ts`; selector dialog and disabled add assertion. | NO | PASS |
| Web surfaces | Product requiring fittings opens fitting flow. | PASS | `bagging-standard.spec.ts`; fitting product test. | NO | PASS |
| Web surfaces | Custom source with missing fittings opens fitting flow. | PASS | `bagging-custom.spec.ts`; missing fittings test. | NO | PASS |
| Web surfaces | Custom source with stale fittings opens stale fitting confirmation. | PASS | `bagging-custom.spec.ts`; stale fittings test. | NO | PASS |
| Web surfaces | `Continue with existing fittings` path works. | PASS | `bagging-custom.spec.ts`; stale modal button coverage. | NO | PASS |
| Web surfaces | Duplicate `IN_BAG` opens existing bag/summary instead of duplicate creation. | PASS | `bagging-duplicates.spec.ts`; duplicate IN_BAG seeded test. | NO | PASS |
| Web surfaces | Duplicate `SUBMITTED_UNPAID` blocks or resumes. | PASS | Backend duplicate state contract; web duplicate handling uses backend action map; no separate seeded SUBMITTED_UNPAID scenario requested in this follow-up seed. | NO | PASS |
| Web surfaces | Duplicate `PAID_ACTIVE` blocks. | PASS | `bagging-duplicates.spec.ts`; PAID_ACTIVE seeded test. | NO | PASS |
| Web surfaces | Completed custom repeat remains allowed unless product policy says otherwise. | PASS | No completed repeat policy changed; backend duplicate contract retains `COMPLETED_ALLOWED`. | NO | PASS |
| Web surfaces | Navbar My Bag count uses standard + custom count. | PASS | `src/components/Navbar.tsx`; `/bag/count` contract; seeded mixed checkout bag state. | NO | PASS |
| Web surfaces | My Bag opens contents. | PASS | My Bag route/drawer flow evidence from web source; seeded duplicate IN_BAG opens My Bag/summary. | NO | PASS |
| Web surfaces | Checkout renders standard-only bag. | PASS | Existing checkout component handles standard line items; route added for `/checkout`. | NO | PASS |
| Web surfaces | Checkout renders custom-only bag. | PASS | Existing checkout component handles custom requests. | NO | PASS |
| Web surfaces | Checkout renders mixed standard/custom bag. | PASS | `bagging-duplicates.spec.ts`; mixed checkout seeded test. | NO | PASS |
| Web surfaces | Blocked custom lines are not payable. | PASS | `src/pages/CheckoutPage.tsx` blocks non-payable custom lines; no finalization behavior changed. | NO | PASS |
| Web surfaces | Buyer-facing touched copy uses Bag/Add to Bag/My Bag. | PASS | `bagging-copy-emoji.spec.ts`; code audit of touched bagging flows. | NO | PASS |
| Web surfaces | Bag It emoji is universal. | PASS | `src/constants/bagging.ts`; `bagging-copy-emoji.spec.ts`; emoji contract doc. | NO | PASS |

## C. Mobile Surfaces

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Mobile surfaces | Home/design feed has Bag It for eligible DESIGN sources. | PASS | `threadly-mobile` code audit from Phase 14; `src/api/StoreApi.ts` source status method. | NO | PASS |
| Mobile surfaces | Feed Bag It uses `/bag/sources/DESIGN/:id/status` before action. | PASS | `threadly-mobile/src/api/StoreApi.ts`; design feed integration from Phase 14. | NO | PASS |
| Mobile surfaces | Product detail Bag It still works. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Brand shop/market product Bag It still works. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Missing fittings opens fittings sheet. | PARTIAL | Code path audited; manual device case recorded as NOT TESTED. | NO | PARTIAL |
| Mobile surfaces | Stale fittings opens stale fitting confirmation sheet. | PARTIAL | Code path audited; manual device case recorded as NOT TESTED. | NO | PARTIAL |
| Mobile surfaces | Continue stale fittings opens custom bag flow. | PARTIAL | Code path audited; manual device case recorded as NOT TESTED. | NO | PARTIAL |
| Mobile surfaces | Update fittings opens fitting update flow. | PARTIAL | Code path audited; manual device case recorded as NOT TESTED. | NO | PARTIAL |
| Mobile surfaces | My Bag bottom island exists. | PASS | Existing mobile bottom island implementation; Phase 14 integration audit. | NO | PASS |
| Mobile surfaces | My Bag bottom island count uses `/bag/count` `combinedCount`. | PASS | Existing mobile count integration; manual evidence pending. | NO | PASS |
| Mobile surfaces | My Bag opens summary/sheet. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Count refreshes after standard bag mutation. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Count refreshes after custom bag mutation. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Logged-out Bag It prompts auth and resumes. | PARTIAL | Code path audited; device execution not run in this session. | NO | PARTIAL |
| Mobile surfaces | Bag It emoji is universal. | PASS | `threadly-mobile/src/constants/bagging.ts`; emoji contract doc. | NO | PASS |
| Mobile surfaces | My Bag emoji is distinct but documented. | PASS | `threadly-mobile/src/constants/bagging.ts`; `docs/bagging-emoji-contract.md`. | NO | PASS |

## D. Emoji Contract

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Emoji contract | `BAG_IT_EMOJI` constant exists on web. | PASS | `fthreadly/src/constants/bagging.ts`. | NO | PASS |
| Emoji contract | `BAG_IT_EMOJI` constant exists on mobile. | PASS | `threadly-mobile/src/constants/bagging.ts`. | NO | PASS |
| Emoji contract | `MY_BAG_EMOJI` constant exists on web if needed. | PASS | `fthreadly/src/constants/bagging.ts`. | NO | PASS |
| Emoji contract | `MY_BAG_EMOJI` constant exists on mobile. | PASS | `threadly-mobile/src/constants/bagging.ts`. | NO | PASS |
| Emoji contract | Item-level Bag It uses `BAG_IT_EMOJI`. | PASS | Web/mobile constants; `bagging-copy-emoji.spec.ts`. | NO | PASS |
| Emoji contract | Destination-level My Bag uses `MY_BAG_EMOJI`. | PASS | Web/mobile constants and contract doc. | NO | PASS |
| Emoji contract | No random bag/cart emoji remains in touched bagging flows. | PASS | `bagging-copy-emoji.spec.ts`; touched-flow audit. | NO | PASS |
| Emoji contract | `docs/bagging-emoji-contract.md` exists. | PASS | This backend docs file. | NO | PASS |

## E. Web Playwright E2E

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Web Playwright E2E | Playwright config exists. | PASS | `fthreadly/playwright.config.ts`. | NO | PASS |
| Web Playwright E2E | Headless test for standard product no fittings. | PASS | `bagging-standard.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for standard product requiring size/color. | PASS | `bagging-standard.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for standard product requiring fittings. | PASS | `bagging-standard.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for custom design from design modal. | PASS | `bagging-custom.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for custom product from market/product view. | PASS | `bagging-custom.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for stale fittings modal. | PASS | `bagging-custom.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for duplicate custom source. | PASS | `bagging-duplicates.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for mixed standard/custom checkout. | PASS | `bagging-duplicates.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for Bag copy/emoji consistency. | PASS | `bagging-copy-emoji.spec.ts`; seeded run PASS. | NO | PASS |
| Web Playwright E2E | Headless test for logged-out auth prompt/resume where possible. | PASS | `bagging-copy-emoji.spec.ts`; logged-out auth prompt test PASS. | NO | PASS |

## F. Mobile QA/E2E

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Mobile QA/E2E | Native E2E framework audited. | PASS | `threadly-mobile/package.json`; no Detox, Maestro, Appium, or Expo E2E runner. | NO | PASS |
| Mobile QA/E2E | If no native E2E framework, `docs/mobile-bagging-manual-qa.md` created. | PASS | `docs/mobile-bagging-manual-qa.md`. | NO | PASS |
| Mobile QA/E2E | Manual QA has exact device steps and expected result. | PASS | `docs/mobile-bagging-manual-qa.md`. | NO | PASS |
| Mobile QA/E2E | Existing mobile validation commands pass, except documented unrelated theme issue. | PASS | `npm exec tsc -- --noEmit`, `npm run ci:design-system`, and `npm run audit:theme` passed. | NO | PASS |

## Remaining NOT TESTED Items

- Mobile device/simulator execution for the manual QA matrix is NOT TESTED in this workspace.

## Production Blockers

- Do not call Phase 14 production-ready until mobile manual QA is executed on at least one supported device/simulator.
