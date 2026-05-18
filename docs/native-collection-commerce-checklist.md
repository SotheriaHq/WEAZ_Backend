# Native Collection Commerce Checklist

## Phase 16C&D Merged Completion Gate

Manual runtime QA was not executed in this phase. Automated/static validation passed, and manual collection cases were added to `docs/mobile-bagging-manual-qa.md` as `NOT TESTED`.

## Validation Summary

- Backend `npm run seed:e2e:bagging`: PASS; deterministic collection IDs/routes were written to `../fthreadly/.env.e2e.bagging`.
- Backend `npx prisma generate`: PASS.
- Backend `npx jest src/bagging src/store src/custom-orders src/reviews --runInBand`: PASS; 13 suites / 105 tests.
- Backend `npm run build`: PASS.
- Web `npm run test:e2e:bagging:seeded`: PASS; 14 passed / 0 failed / 0 skipped.
- Web `npm run build`: PASS.
- Web focused `npm run test -- src/api/BagApi.test.ts`: PASS; 4 tests.
- Web scoped ESLint on changed files: PASS.
- Mobile `npm exec tsc -- --noEmit`: PASS.
- Mobile `npm run ci:design-system`: PASS.
- Mobile `npm run audit:theme`: PASS.

## Backend Collection Data Model

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend collection data model | Collection model identified. | PASS | `prisma/schema.prisma`: `StoreCollection` is the store-commerce collection model; legacy `Collection` and `Design` remain separate design/catalog entities. | NO | PASS |
| Backend collection data model | Product relation identified. | PASS | `prisma/schema.prisma`: `StoreCollectionProduct` links `StoreCollection` to `Product`; `Product.collectionId` remains the primary collection pointer. | NO | PASS |
| Backend collection data model | Collection detail source identified. | PASS | `src/collections/collections.service.ts`: existing detail source plus new public list source for market sections. | NO | PASS |
| Backend collection data model | Collection can include existing/new products. | PASS | Existing store collection product-link endpoints remain; deterministic seed links existing seeded products. | NO | PASS |
| Backend collection data model | Collection product shape documented. | PASS | `docs/collection-bagging-backend-contract.md`; `src/bagging/bagging.types.ts`. | NO | PASS |
| Backend collection data model | Store/design/legacy collection differences documented if applicable. | PASS | `docs/collection-bagging-backend-contract.md`; `rules/AGENT_RULES.md` entity rule. | NO | PASS |
| Backend collection data model | Collection ownership/brand relationship identified. | PASS | `StoreCollection.ownerId`; collection status derives brand context from owner/products and blocks own-brand bagging. | NO | PASS |

## Backend Collection Readiness

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend collection readiness | `GET /bag/sources/COLLECTION/:collectionId/status` exists. | PASS | `src/bagging/bagging.controller.ts`; `src/bagging/bag-eligibility.service.ts`. | NO | PASS |
| Backend collection readiness | Response includes collection metadata. | PASS | `CollectionBagStatusContract.collection` in `src/bagging/bagging.types.ts`; Jest collection status coverage. | NO | PASS |
| Backend collection readiness | Response includes product-level readiness. | PASS | `CollectionBagStatusContract.products`; readiness reuses product eligibility. | NO | PASS |
| Backend collection readiness | Response includes product-level blocked reasons. | PASS | `CollectionBagProductStatus.reason`, measurement, selector, stock, and action fields. | NO | PASS |
| Backend collection readiness | Response includes price range and total. | PASS | `collection.priceRange`; `summary.totalPrice`; seed and Playwright fixtures cover collection rows. | NO | PASS |
| Backend collection readiness | Response includes all eligible count. | PASS | `summary.eligibleCount`. | NO | PASS |
| Backend collection readiness | Response includes blocked count. | PASS | `summary.blockedCount`. | NO | PASS |
| Backend collection readiness | Response includes already-in-bag count. | PASS | `summary.alreadyInBagCount`. | NO | PASS |
| Backend collection readiness | Response includes size/color-required states. | PASS | Product rows expose `OPEN_SELECTOR`, `requiresSize`, `requiresColor`, `availableSizes`, and `availableColors`. | NO | PASS |
| Backend collection readiness | Response includes fitting-required states. | PASS | Product rows expose `OPEN_FITTINGS`, required/missing measurement keys, and freshness state. | NO | PASS |
| Backend collection readiness | Response includes stale fitting states. | PASS | Product rows expose `CONFIRM_STALE_FITTINGS`; `summary.staleFittingsCount`. | NO | PASS |
| Backend collection readiness | Response includes out-of-stock states. | PASS | Product rows expose `stockState` and `DISABLED` reason. | NO | PASS |
| Backend collection readiness | Response includes own-brand blocked state. | PASS | Owner requests return disabled collection/product readiness; mutations use the same server-side status. | NO | PASS |
| Backend collection readiness | Response includes logged-out/auth-required state where applicable. | PASS | Public status is safe; collection `ui.defaultAction` can be `AUTH_REQUIRED` when auth is required for mutation-specific readiness. | NO | PASS |
| Backend collection readiness | Response includes feature flags for collection reviews if applicable. | PASS | `featureFlags.collectionReviewsEnabled` is returned and defaults to false unless backend config enables public collection reviews. | NO | PASS |

## Backend Collection Mutations

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend collection mutations | `POST /bag/collections/:collectionId/bag-all` exists. | PASS | `src/bagging/bagging.controller.ts`; `CollectionBaggingService.bagAll`. | NO | PASS |
| Backend collection mutations | `POST /bag/collections/:collectionId/bag-selected` exists. | PASS | `src/bagging/bagging.controller.ts`; `CollectionBaggingService.bagSelected`. | NO | PASS |
| Backend collection mutations | Bag All validates every product server-side. | PASS | `CollectionBaggingService` calls collection status and standard bag validation before transaction writes. | NO | PASS |
| Backend collection mutations | Bag Selected validates selected products server-side. | PASS | `BagCollectionSelectedDto`; selected IDs only are evaluated for mutation. | NO | PASS |
| Backend collection mutations | Already-in-bag products are skipped, not duplicated. | PASS | Mutation response includes `skipped`; Jest duplicate prevention coverage. | NO | PASS |
| Backend collection mutations | Blocked selected products prevent invalid mutation. | PASS | Service returns structured `blocked` and does not create invalid rows. | NO | PASS |
| Backend collection mutations | Out-of-stock products cannot be bagged. | PASS | Product readiness/validation is reused; blocked rows are returned for stock failures. | NO | PASS |
| Backend collection mutations | Missing size/color blocks or returns resolver state. | PASS | Status returns `OPEN_SELECTOR`; selected mutation requires selections for those products. | NO | PASS |
| Backend collection mutations | Missing fittings blocks or opens resolver state. | PASS | Status returns `OPEN_FITTINGS`; selected mutation blocks missing fitting requirements. | NO | PASS |
| Backend collection mutations | Stale fittings require acknowledgement where existing product flow requires it. | PASS | Status returns `CONFIRM_STALE_FITTINGS`; mutation accepts `acknowledgements.staleFittingsAccepted`. | NO | PASS |
| Backend collection mutations | Own-brand collection bagging is blocked. | PASS | Owner-disabled readiness is reused by mutations; product/collection disabled reasons remain server-owned. | NO | PASS |
| Backend collection mutations | Logged-out users are protected by auth. | PASS | Mutation routes use `JwtAuthGuard`; public status is read-only. | NO | PASS |
| Backend collection mutations | Response returns added/skipped/blocked summary. | PASS | `CollectionBagMutationResult` returns `added`, `skipped`, `blocked`, and count summary. | NO | PASS |
| Backend collection mutations | Mutation is transaction-safe enough to avoid partial corruption. | PASS | Multi-row create/update is performed through Prisma transaction after blocker detection. | NO | PASS |
| Backend collection mutations | Bag count compatibility remains intact. | PASS | Mutation summary includes `combinedBagCount`; `/bag/count` remains unchanged; seeded web E2E passed. | NO | PASS |

## Backend Seeded Collection Data

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Backend seeded collection data | All-eligible collection seeded. | PASS | `scripts/seed-bagging-e2e.ts`; `THREADLY_E2E_COLLECTION_ALL_ELIGIBLE_ID`. | NO | PASS |
| Backend seeded collection data | Mixed-blocker collection seeded. | PASS | `scripts/seed-bagging-e2e.ts`; `THREADLY_E2E_COLLECTION_MIXED_ID`. | NO | PASS |
| Backend seeded collection data | Already-in-bag collection seeded. | PASS | `scripts/seed-bagging-e2e.ts`; `THREADLY_E2E_COLLECTION_ALREADY_IN_BAG_ID`. | NO | PASS |
| Backend seeded collection data | Out-of-stock collection product seeded. | PASS | Mixed collection includes deterministic out-of-stock product membership. | NO | PASS |
| Backend seeded collection data | Size/color-required collection product seeded. | PASS | Mixed collection includes deterministic variant-required product membership. | NO | PASS |
| Backend seeded collection data | Fitting-required collection product seeded. | PASS | Mixed collection includes deterministic fitting-required product membership. | NO | PASS |
| Backend seeded collection data | Stale-fitting collection product seeded. | PASS | Mixed collection includes deterministic stale-fitting product membership. | NO | PASS |
| Backend seeded collection data | Env/docs expose seeded collection IDs/routes. | PASS | `../fthreadly/.env.e2e.bagging`; `fthreadly/docs/bagging-e2e-fixtures.md`. | NO | PASS |

## Native Market Collection Sections

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Native market collection sections | Latest Collections section exists. | PASS | `threadly-mobile/src/features/market/components/MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Trending/Most Interacted Collections exists only if backend metrics exist. | PASS | No backend collection trending metrics exist; no fake trending collection row was added. | NO | PASS |
| Native market collection sections | If trending metrics do not exist, this is documented as deferred and not faked. | PASS | This checklist and `docs/native-collection-commerce-performance.md`. | NO | PASS |
| Native market collection sections | Collection section loading state exists. | PASS | Market initial skeleton and collection row state in `MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Collection section empty state exists. | PASS | Latest Collections empty state in `MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Collection section error/retry state exists. | PASS | Latest Collections retry button in `MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Collection card shows cover media. | PASS | `StableImage` collection card rendering. | NO | PASS |
| Native market collection sections | Collection card shows title. | PASS | Collection card title in `MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Collection card shows brand. | PASS | Collection card brand label in `MarketScreen.tsx`. | NO | PASS |
| Native market collection sections | Collection card shows product count. | PASS | Collection card product count label. | NO | PASS |
| Native market collection sections | Collection card shows price range. | PASS | Collection card price range label. | NO | PASS |
| Native market collection sections | Collection card opens Collection Commerce Viewer. | PASS | Card routes to `/collection-viewer?collectionId=...`. | NO | PASS |

## Native Collection Commerce Viewer

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Native Collection Commerce Viewer | Route exists. | PASS | `threadly-mobile/app/collection-viewer.tsx`; `_layout.tsx` stack registration. | NO | PASS |
| Native Collection Commerce Viewer | Full native screen exists. | PASS | `src/features/market/components/CollectionCommerceViewer.tsx`. | NO | PASS |
| Native Collection Commerce Viewer | Back returns to Market. | PASS | Viewer honors `returnTo`; manual runtime back behavior remains in manual QA. | NO | PASS |
| Native Collection Commerce Viewer | Collection metadata renders. | PASS | Viewer renders title, brand, description, product count, price range, availability summary. | NO | PASS |
| Native Collection Commerce Viewer | Collection product list/grid renders. | PASS | Viewer renders product cards from backend `products`. | NO | PASS |
| Native Collection Commerce Viewer | Product selection state works. | PASS | Selection state and selected total are implemented in viewer. | NO | PASS |
| Native Collection Commerce Viewer | Bag All action exists. | PASS | Sticky action bar calls `bagCollectionAll`. | NO | PASS |
| Native Collection Commerce Viewer | Bag Selected action exists. | PASS | Sticky action bar calls `bagCollectionSelected`. | NO | PASS |
| Native Collection Commerce Viewer | Individual product Bag It exists. | PASS | Product cards call existing `useMobileBagging().bagProduct`. | NO | PASS |
| Native Collection Commerce Viewer | Product drilldown opens Product Commerce Viewer. | PASS | Product card routes to `/products/[productId]` with collection `returnTo`. | NO | PASS |
| Native Collection Commerce Viewer | Product back returns to Collection Viewer. | PASS | Product drilldown passes collection viewer as return route; runtime confirmation remains manual QA. | NO | PASS |
| Native Collection Commerce Viewer | Collection back returns to Market. | PASS | Collection viewer uses `returnTo` or router back. | NO | PASS |
| Native Collection Commerce Viewer | Blocker panel exists. | PASS | Viewer groups backend blocker states. | NO | PASS |
| Native Collection Commerce Viewer | Loading state exists. | PASS | Viewer loading state and timed initial load are implemented. | NO | PASS |
| Native Collection Commerce Viewer | Empty-products state exists. | PASS | Viewer handles an empty products array. | NO | PASS |
| Native Collection Commerce Viewer | Error/retry state exists. | PASS | Viewer error and retry states are implemented. | NO | PASS |
| Native Collection Commerce Viewer | No comments UI. | PASS | No comments component or composer exists in collection viewer. | NO | PASS |
| Native Collection Commerce Viewer | Review placeholder hidden unless feature flag allows. | PASS | `featureFlags.collectionReviewsEnabled` gates any review note; no public collection review list is exposed by default. | NO | PASS |

## Native Collection Gallery Viewer

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Native Collection Gallery Viewer | Route exists. | PASS | `threadly-mobile/app/collection-gallery.tsx`; `_layout.tsx` stack registration. | NO | PASS |
| Native Collection Gallery Viewer | Collection Viewer links to Gallery. | PASS | `CollectionCommerceViewer` Gallery action routes to `/collection-gallery`. | NO | PASS |
| Native Collection Gallery Viewer | Gallery loads collection media. | PASS | `CollectionGalleryViewer` loads collection bag status/detail. | NO | PASS |
| Native Collection Gallery Viewer | Gallery flattens collection cover/product media. | PASS | Gallery builds a flattened media array from collection cover and product media. | NO | PASS |
| Native Collection Gallery Viewer | Gallery supports swipe/flip. | PASS | Horizontal paged `FlatList` gallery. | NO | PASS |
| Native Collection Gallery Viewer | Gallery shows media count. | PASS | Gallery pagination/count overlay. | NO | PASS |
| Native Collection Gallery Viewer | Gallery shows minimal metadata overlay. | PASS | Overlay renders collection title/brand. | NO | PASS |
| Native Collection Gallery Viewer | Gallery shows current product context if media belongs to product. | PASS | Product-owned media carries product name/id context. | NO | PASS |
| Native Collection Gallery Viewer | Gallery has back to Collection Viewer. | PASS | Back action returns to supplied collection route. | NO | PASS |
| Native Collection Gallery Viewer | Gallery has Shop Collection CTA. | PASS | CTA routes back to collection viewer. | NO | PASS |
| Native Collection Gallery Viewer | Gallery handles empty media. | PASS | Empty-media state exists. | NO | PASS |
| Native Collection Gallery Viewer | Gallery handles failed media. | PASS | `StableImage` fallback and explicit failed-media copy. | NO | PASS |
| Native Collection Gallery Viewer | Gallery has loading/error states. | PASS | Loading and retry states in `CollectionGalleryViewer`. | NO | PASS |
| Native Collection Gallery Viewer | Gallery has no comments UI. | PASS | No comments component or composer exists in gallery viewer. | NO | PASS |

## Save, Share, And Message Behavior

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Save/share/message behavior | Collection share works. | PASS | Viewer uses React Native `Share`; runtime share sheet remains manual QA. | NO | PASS |
| Save/share/message behavior | Collection message brand works. | PASS | Viewer routes to message flow with brand context. | NO | PASS |
| Save/share/message behavior | Collection save/wishlist works if API supports it. | PASS | `SavedItemsApi` `COLLECTION` target is used with loading protection. | NO | PASS |
| Save/share/message behavior | If collection save API does not exist, safe placeholder/disabled state is documented. | PASS | Collection save API exists; no placeholder needed. | NO | PASS |
| Save/share/message behavior | Logged-out save/message prompts auth. | PASS | Viewer redirects to auth with `next` collection route. | NO | PASS |
| Save/share/message behavior | Own-brand message is blocked. | PASS | Viewer disables own-brand message with explanation. | NO | PASS |
| Save/share/message behavior | Errors show clear toast/message. | PASS | Viewer stores action errors and retry messages. | NO | PASS |

## Performance

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Performance | Collection status request timed. | PASS | Backend, web, and mobile dev/test timing logs; `docs/native-collection-commerce-performance.md`. | NO | PASS |
| Performance | Bag All request timed. | PASS | Backend, web, and mobile dev/test timing logs. | NO | PASS |
| Performance | Bag Selected request timed. | PASS | Backend, web, and mobile dev/test timing logs. | NO | PASS |
| Performance | Gallery initial load timed. | PASS | `CollectionGalleryViewer` dev/test initial-load timing. | NO | PASS |
| Performance | Avoid frontend N+1 product-status calls. | PASS | Collection viewer consumes one collection status payload with product readiness. | NO | PASS |
| Performance | Avoid duplicate collection status calls. | PASS | Viewer load is callback-driven, not render-driven; no per-product source status calls were added. | NO | PASS |
| Performance | Bag count refresh is de-duped after mutation. | PASS | Collection mutations refresh My Bag count once through existing `useBagCount` integration. | NO | PASS |
| Performance | Cache invalidates after bag mutation/auth change/app foreground. | PASS | No long-lived eligibility cache is retained; mutation refreshes collection status and bag count immediately. | NO | PASS |

## Automated QA

| Area | Requirement | Current status: PASS / FAIL / PARTIAL / NOT TESTED | Evidence | Fix required: YES / NO | Final status |
| --- | --- | --- | --- | --- | --- |
| Automated QA | Backend Jest covers collection status. | PASS | `src/bagging/bag-eligibility.service.spec.ts`. | NO | PASS |
| Automated QA | Backend Jest covers Bag All. | PASS | `src/bagging/collection-bagging.service.spec.ts`. | NO | PASS |
| Automated QA | Backend Jest covers Bag Selected. | PASS | `src/bagging/collection-bagging.service.spec.ts`. | NO | PASS |
| Automated QA | Backend Jest covers blocked states. | PASS | `src/bagging/collection-bagging.service.spec.ts`. | NO | PASS |
| Automated QA | Backend Jest covers duplicate prevention. | PASS | `src/bagging/collection-bagging.service.spec.ts`; `CartItem` duplicate skip path. | NO | PASS |
| Automated QA | Backend Jest covers own-brand/auth behavior. | PARTIAL | Auth is enforced by `JwtAuthGuard` on mutation routes; own-brand disabled readiness is implemented. No dedicated controller auth spec was added in this phase. | NO | PARTIAL |
| Automated QA | Web seeded Playwright bagging tests still pass. | PASS | `npm run test:e2e:bagging:seeded`: 14 passed / 0 skipped. | NO | PASS |
| Automated QA | Add web Playwright collection regression tests if web exposes collection bagging. | PASS | `tests/e2e/bagging/bagging-collections.spec.ts`; existing collection surface now uses collection bagging endpoints. | NO | PASS |
| Automated QA | Mobile TypeScript passes. | PASS | `npm exec tsc -- --noEmit`: PASS. | NO | PASS |
| Automated QA | Mobile design-system CI passes. | PASS | `npm run ci:design-system`: PASS. | NO | PASS |
| Automated QA | Mobile theme audit passes. | PASS | `npm run audit:theme`: PASS. | NO | PASS |
| Automated QA | Mobile component/unit tests added if project test setup supports them. | PASS | Mobile repo has no native component test runner; static validation plus backend/web automation used instead. | NO | PASS |
| Automated QA | Manual QA rows are updated but remain NOT TESTED unless actually executed. | PASS | `docs/mobile-bagging-manual-qa.md` includes collection rows marked `NOT TESTED`. | NO | PASS |

## Audit Questions

| Question | Answer | Evidence |
| --- | --- | --- |
| What collection model is used? | Store-commerce collection bagging uses `StoreCollection`; design/gallery content remains separate through legacy `Collection` and `Design`. | `prisma/schema.prisma`; `docs/collection-bagging-backend-contract.md`. |
| How are products linked to collection? | `StoreCollectionProduct` links collections to products; `Product.collectionId` remains a primary membership pointer. | `prisma/schema.prisma`. |
| Does collection detail already include products? | Yes. This phase also added a public market list endpoint and collection bag status returns normalized product readiness. | `src/collections/collections.service.ts`; `src/bagging/bag-eligibility.service.ts`. |
| What market endpoint provides collection sections? | New public `GET /store-collections` backs native Latest Collections. | `src/collections/store-collections.controller.ts`; `threadly-mobile/src/api/StoreApi.ts`. |
| Are there backend metrics for trending/most-interacted collections? | No. Trending/most-interacted collections were not faked and remain a later metrics-backed enhancement. | No collection metrics endpoint found; documented here. |
| What exact product fields are available for collection products? | Collection status returns product id, name, media, price/currency, size/color options, measurement requirements, freshness, stock, default action, and source status. | `src/bagging/bagging.types.ts`. |
| Does existing standard bag support multiple product inserts in one flow? | Previously no. This phase added collection bulk mutations that create/update standard bag items transactionally. | `src/bagging/collection-bagging.service.ts`. |
| What happens if one product in collection needs size/color? | Product row returns `OPEN_SELECTOR`; mutation blocks until selected size/color is supplied for that product. | Backend status and collection mutation tests. |
| What happens if one product in collection needs fittings? | Product row returns `OPEN_FITTINGS`; mutation blocks and reports missing measurement keys. | Backend status and collection mutation tests. |
| What happens if one product is stale-fitting? | Product row returns `CONFIRM_STALE_FITTINGS`; mutation requires stale fitting acknowledgement for that path. | Backend status/mutation implementation. |
| What happens if one product is already in bag? | Product row returns `ALREADY_IN_BAG`; mutation skips it and returns a skipped summary instead of duplicating. | Backend mutation tests. |
| What happens if one product is out of stock? | Product row is disabled and mutation blocks it. | Backend readiness/mutation implementation. |
| What native route preserves Market to Collection to Product to Collection navigation? | `/collection-viewer?collectionId=...&returnTo=...` plus product drilldown with collection `returnTo`. | `app/collection-viewer.tsx`; `CollectionCommerceViewer.tsx`. |
| What APIs exist for collection save/share/message? | Save uses `SavedItemsApi` `COLLECTION`; share uses React Native `Share`; message routes to existing message flow with brand context. | `CollectionCommerceViewer.tsx`. |
| Which automated tests cover the flow without manual QA? | Backend Jest covers contract/mutations; web Playwright covers seeded collection regression; mobile static validation covers TypeScript/design/theme. | Validation summary above. |

## Remaining Blockers

- Android/iOS manual runtime QA is still `NOT TESTED` and must be executed before production-ready signoff.
- No backend collection trending metrics exist, so Trending/Most Interacted Collections are intentionally deferred instead of faked.
