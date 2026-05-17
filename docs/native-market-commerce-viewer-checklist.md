# Native Market Commerce Viewer Checklist

Created: 2026-05-17. Updated after Phase 15 implementation and validation.

This checklist is the Phase 15 gate for the native market commerce viewer, mobile Bag It QA, and bagging response-time hardening. `Current status` records the pre-implementation audit. `Final status` records the implemented and validated state. Runtime mobile flows remain `PARTIAL` or `NOT TESTED` where no simulator/device was available.

## 1. Native Market Viewer Entry Points

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Native market viewer entry points | Market product card opens the new commerce viewer. | FAIL | Implemented: `threadly-mobile/src/features/market/components/MarketScreen.tsx` keeps product taps on `/products/[productId]`; `threadly-mobile/app/products/[productId].tsx` now delegates to `MarketCommerceViewer`. `npm exec tsc -- --noEmit`: PASS. | YES | PASS |
| Native market viewer entry points | Market design card opens the correct viewer/flow. | FAIL | Implemented: `MarketScreen.tsx` routes DESIGN items to `/market-viewer` with `sourceType=DESIGN`; viewer calls source-aware bagging. | YES | PASS |
| Native market viewer entry points | Brand shop product card can still open product viewer. | FAIL | Implemented: `threadly-mobile/components/catalog/BrandShopTab.tsx` routes product taps to `/products/[productId]`. | YES | PASS |
| Native market viewer entry points | Product detail route either becomes the new viewer or delegates to it. | FAIL | Implemented: `threadly-mobile/app/products/[productId].tsx` renders `MarketCommerceViewer` directly. | YES | PASS |
| Native market viewer entry points | Back button returns user to previous market context. | PARTIAL | Implemented: `MarketCommerceViewer.handleBack` uses `router.canGoBack()` and falls back to `/(tabs)/discover`. Runtime manual QA unavailable. | YES | PARTIAL |
| Native market viewer entry points | No collapse icon is used as the top-left navigation control. | PARTIAL | Implemented: top-left control is a back arrow in `MarketCommerceViewer`; collapse affordance is only on the metadata sheet handle. | YES | PASS |

## 2. Viewer Layout

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Viewer layout | Full-screen media-first layout. | FAIL | Implemented: `MarketCommerceViewer` renders a full-screen horizontal media `FlatList` under overlay controls. Theme audit: PASS. | YES | PASS |
| Viewer layout | Product/collection media is the main focus. | FAIL | Implemented: media fills viewport; metadata is an overlay sheet. | YES | PASS |
| Viewer layout | Top-left back button. | PARTIAL | Implemented in `MarketCommerceViewer` top controls. | YES | PASS |
| Viewer layout | Top-right share button. | FAIL | Implemented with React Native `Share` in `MarketCommerceViewer.handleSharePress`; runtime share sheet not manually tested. | YES | PARTIAL |
| Viewer layout | Floating Bag It action. | FAIL | Implemented as persistent floating `bagAction` in `MarketCommerceViewer`. | YES | PASS |
| Viewer layout | Floating Wishlist/save action. | FAIL | Implemented with product wishlist and design saved-item APIs; runtime manual QA unavailable. | YES | PARTIAL |
| Viewer layout | Floating Message Brand action. | FAIL | Implemented to route to `/messages/[threadId]` with `brandId`; runtime manual QA unavailable. | YES | PARTIAL |
| Viewer layout | Optional share action if not already top-right. | FAIL | Top-right share action implemented, so no duplicate share action needed. | YES | PASS |
| Viewer layout | No comment UI for products. | PASS | New product route uses `MarketCommerceViewer`; no product comment UI added. | NO | PASS |
| Viewer layout | No comment UI for collections. | FAIL | Market DESIGN route now uses `MarketCommerceViewer`, which contains no collection comment UI. Existing legacy collection routes were not changed. | YES | PASS |
| Viewer layout | Collection review area is placeholder only if required. | PARTIAL | `MarketCommerceViewer` includes a small review summary placeholder for DESIGN sources only; no comment composer/thread UI. | YES | PASS |

## 3. Collapsible Metadata Sheet

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Collapsible metadata sheet | Metadata sheet is expanded by default. | FAIL | `MarketCommerceViewer` initializes `sheetExpanded` to `true`. | YES | PASS |
| Collapsible metadata sheet | Metadata sheet can collapse. | FAIL | Sheet handle toggles `sheetExpanded`. Runtime manual QA unavailable. | YES | PARTIAL |
| Collapsible metadata sheet | Collapsed state reveals more media. | FAIL | Collapsed sheet height is reduced to 116px in `MarketCommerceViewer`. | YES | PASS |
| Collapsible metadata sheet | Expanded state shows full product metadata. | PARTIAL | Expanded sheet shows brand, title, price, stock/custom status, description, options, and fitting state. | YES | PASS |
| Collapsible metadata sheet | Sheet has drag handle or clear collapse/expand affordance. | FAIL | Sheet handle and guidance text implemented. | YES | PASS |
| Collapsible metadata sheet | Sheet has guidance text such as "Swipe down to view more image" or "Swipe up for product details." | FAIL | Implemented text: `Collapse details for full view` and `Swipe up for product details`. | YES | PASS |
| Collapsible metadata sheet | Sheet does not permanently block critical product media. | FAIL | Sheet is collapsible and overlays media instead of replacing it. | YES | PASS |
| Collapsible metadata sheet | Floating actions remain accessible when sheet is collapsed. | FAIL | Floating action cluster is outside the sheet and repositioned above current sheet height. | YES | PASS |

## 4. Media Gallery

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Media gallery | Supports multiple product images. | PARTIAL | `buildProductMedia` uses cover image plus product images. | YES | PASS |
| Media gallery | Supports horizontal swipe. | PARTIAL | Full-screen horizontal paging `FlatList` implemented. Runtime manual QA unavailable. | YES | PARTIAL |
| Media gallery | Shows pagination dots/count. | FAIL | Viewer shows a count pill when more than one media item exists. | YES | PASS |
| Media gallery | Handles missing media. | PARTIAL | Empty media fallback renders the Bag It emoji and preview-unavailable text. | YES | PASS |
| Media gallery | Handles image loading. | PASS | `MediaSlide` shows `ActivityIndicator` while resolving media. | NO | PASS |
| Media gallery | Handles image failure fallback. | PASS | `StableImage` `onError` switches to fallback. | NO | PASS |
| Media gallery | Uses theme-compliant surfaces. | PARTIAL | New viewer uses `theme.colors` and `tokens`; `npm run audit:theme`: PASS. | YES | PASS |

## 5. Commerce Actions

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Commerce actions | Bag It uses `BAG_IT_EMOJI` and `BAG_IT_LABEL`. | PARTIAL | `MarketCommerceViewer` imports and renders both constants. | YES | PASS |
| Commerce actions | Bag It shows price where appropriate. | FAIL | Viewer CTA renders `BAG_IT_EMOJI`, `BAG_IT_LABEL`, and product/design price label when known. | YES | PASS |
| Commerce actions | Bag It follows backend eligibility/defaultAction. | PASS | Viewer calls `bagProduct`/`bagSource`; existing `useMobileBagging` routes backend `ui.defaultAction`. Backend tests: 78 passed. | NO | PASS |
| Commerce actions | Wishlist/save works. | PARTIAL | Product wishlist and DESIGN saved APIs wired in `handleSavePress`; runtime manual QA unavailable. | YES | PARTIAL |
| Commerce actions | Share works. | PARTIAL | Native `Share.share` wired in `handleSharePress`; runtime share sheet unavailable. | YES | PARTIAL |
| Commerce actions | Message brand works. | PARTIAL | `handleMessagePress` routes to brand conversation and auth prompt when logged out; runtime manual QA unavailable. | YES | PARTIAL |
| Commerce actions | Own-brand restriction works. | PARTIAL | Viewer blocks Bag It/Message when backend `userState.isOwner` or active brand matches. Runtime manual QA unavailable. | YES | PARTIAL |
| Commerce actions | Logged-out user gets auth prompt and resume flow. | PASS | Bag It uses existing `BagFlowProvider` auth prompt/resume path. Runtime manual QA unavailable, so mobile evidence remains partial. | NO | PARTIAL |
| Commerce actions | Standard product bagging works. | PASS | Viewer uses `bagProduct`; backend and web seeded bagging tests passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Custom product bagging works. | PASS | Viewer uses `bagProduct` and existing custom flow; backend and web seeded tests passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Design bagging works where source eligibility supports it. | PASS | Viewer and Market card use `bagSource({ sourceType: 'DESIGN' })`; no `/store/cart` call for DESIGN. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Required size/color selector works. | PASS | Existing `BagFlowProvider` selector path retained; web seeded selector test passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Required fittings flow works. | PASS | Existing fittings path retained; web seeded fittings test passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Stale fittings confirmation works. | PASS | Existing stale confirmation path retained; web seeded stale test passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Already-in-bag state works. | PASS | Existing summary path retained; web seeded duplicate IN_BAG test passed. Mobile runtime not executed. | NO | PARTIAL |
| Commerce actions | Out-of-stock state works. | PARTIAL | Viewer disables backend `DISABLED` state and shows disabled reason; runtime out-of-stock QA unavailable. | YES | PARTIAL |
| Commerce actions | Disabled CTA state works. | PARTIAL | Viewer disables CTA for backend disabled state, loading state, and own-brand state. Runtime manual QA unavailable. | YES | PARTIAL |

## 6. Product Types/States

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Product types/states | Standard product with no fittings. | PARTIAL | Viewer routes to existing backend-directed `bagProduct`; web seeded standard test passed. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Standard product requiring size/color. | PARTIAL | Existing selector flow retained; web seeded variant test passed. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Standard product requiring fittings. | PARTIAL | Existing fitting flow retained; web seeded fitting test passed. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Custom-order-enabled product. | PARTIAL | Viewer supports backend custom default action. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Product out of stock. | PARTIAL | Viewer respects backend disabled/default action. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Product already in bag. | PARTIAL | Existing already-in-bag summary path retained. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Product from brand shop. | FAIL | Brand shop product taps route to `/products/[productId]`, which delegates to the new viewer. Runtime manual QA unavailable. | YES | PARTIAL |
| Product types/states | Product from market row/grid. | FAIL | Market product taps route to the new delegated product viewer. Runtime manual QA unavailable. | YES | PARTIAL |
| Product types/states | Collection/design item where custom order is available. | PARTIAL | Market DESIGN taps route to source-aware viewer; DESIGN Bag It uses `/bag/sources/DESIGN/:id/status`. Mobile runtime not executed. | YES | PARTIAL |
| Product types/states | Collection/design item where custom order is unavailable. | PARTIAL | Viewer displays unavailable/disabled status from backend source eligibility. Mobile runtime not executed. | YES | PARTIAL |

## 7. Bagging Performance

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| Bagging performance | `/bag/count` duration measured. | PASS | Backend `BagCountPresenter` logs `bagging.count.duration`; mobile `MobileStoreApi.getBagCount` logs `mobile.count_request.duration`. | NO | PASS |
| Bagging performance | `/bag/sources/:sourceType/:sourceId/status` duration measured. | PASS | Backend source status timing and mobile `getSourceBagStatus` timing are present. | NO | PASS |
| Bagging performance | `/store/products/:id/bag-status` duration measured. | PARTIAL | Added mobile `getProductBagStatus` timing; backend product status timing already present. | YES | PASS |
| Bagging performance | Repeated duplicate requests avoided where possible. | FAIL | Added 8 second status cache and in-flight de-dupe in `useMobileBagging`. | YES | PASS |
| Bagging performance | Bag It click-to-sheet/modal response does not trigger unnecessary duplicate API calls. | PARTIAL | Viewer logs Bag It action duration; status requests are de-duped; post-mutation refresh remains force-fresh. | YES | PASS |
| Bagging performance | Bag count refresh does not spam backend. | PARTIAL | Added in-flight de-dupe in `BagCountContext`; removed extra Market-screen refresh after Bag It. | YES | PASS |

## 8. QA/Testing

| Area | Requirement | Current status | Evidence | Fix required | Final status |
| --- | --- | --- | --- | --- | --- |
| QA/testing | Mobile TypeScript passes. | NOT TESTED | `npm exec tsc -- --noEmit`: PASS. `npm run ci:design-system` also runs TypeScript and passed. | YES | PASS |
| QA/testing | Mobile design-system CI passes. | NOT TESTED | `npm run ci:design-system`: PASS. | YES | PASS |
| QA/testing | Mobile theme audit passes. | NOT TESTED | `npm run audit:theme`: PASS. | YES | PASS |
| QA/testing | Mobile manual QA matrix is executed and recorded. | NOT TESTED | Matrix recorded in `docs/mobile-bagging-manual-qa.md`; not executed because no Android SDK/emulator/adb and no iOS simulator tooling in this workspace. | YES | NOT TESTED |
| QA/testing | Web seeded Playwright remains passing after any shared API changes. | NOT TESTED | `npm run test:e2e:bagging:seeded`: 12 passed, 0 failed, 0 skipped. | YES | PASS |
| QA/testing | Backend focused bagging tests remain passing. | NOT TESTED | `npx jest src/bagging src/store src/custom-orders --runInBand`: 10 suites passed, 78 tests passed. | YES | PASS |

## Validation Summary

- Backend `npm run seed:e2e:bagging`: PASS; seeded buyer/brand, 9 products, 1 custom design source, existing standard/custom lines, and paid active custom order.
- Backend `npx prisma generate`: PASS.
- Backend `npx jest src/bagging src/store src/custom-orders --runInBand`: PASS, 10 suites and 78 tests.
- Backend `npm run build`: PASS.
- Web `npm run test:e2e:bagging:seeded`: PASS, 12 passed, 0 skipped.
- Web `npm run build`: PASS.
- Mobile `npm exec tsc -- --noEmit`: PASS.
- Mobile `npm run ci:design-system`: PASS.
- Mobile `npm run audit:theme`: PASS.

## Remaining NOT TESTED Items

- Android manual QA matrix: NOT TESTED because no `adb`, Android SDK platform tools, or Android emulator binary are available in this workspace.
- iOS manual QA matrix: NOT TESTED because `xcrun`/iOS simulator tooling is unavailable in this Windows workspace.

## Production Blockers

- Phase 15 cannot be called production-ready until the critical mobile manual QA matrix is executed on at least one Android device/emulator and iOS is either executed or explicitly waived.
- No critical code-level FAIL remains in the checklist, but several commerce flows are intentionally `PARTIAL` because they have code/static/regression evidence without native runtime evidence.
