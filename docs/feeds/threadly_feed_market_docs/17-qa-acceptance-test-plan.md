# QA and Acceptance Test Plan

## Phase 0 alignment note - 2026-05-23

Phase 1 must include regression tests for:
- backend section preview endpoint pagination, category filtering, auth/anonymous behavior, and cache headers;
- backend product market category semantics, especially direct product category versus collection category membership;
- web market no longer loading the 4800-row aggregate path;
- web and mobile rendering the same section contract;
- View All using cursor-backed pagination;
- request cancellation for stale web/mobile market requests;
- patch terminology in new user-facing feed/market copy;
- non-personalized fallback behavior.

Safe commands identified during Phase 0:
- backend: `npm run build`, `npm test`, `npm run test:e2e` where environment supports DB/test services;
- web: `npm run build`, `npm run lint`, `npm run test`;
- mobile: `npm exec tsc -- --noEmit`, `npm run ci:phase8` where Expo/native dependencies and scripts are available.

## Phase 1 implemented validation - 2026-05-24

Backend tests added:
- `src/collections/collections.controller.spec.ts`
  - proves `collections/market` passes `category`, `cursor`, `limit`, `tag`, `counts`, and requester ID to `CollectionsService.getMarketFeed`.
- `src/market/market-section.service.spec.ts`
  - verifies active section previews;
  - hides empty home sections;
  - dedupes duplicate item IDs inside one section;
  - bounds preview item queries;
  - bounds section detail pagination and emits cursor metadata;
  - rejects unsupported section keys with `NotFoundException`.
- `src/market/market-section.controller.spec.ts`
  - verifies `Cache-Control: private, no-store` metadata on both section endpoints;
  - verifies controller query forwarding.

Commands run for Phase 1:
- backend `npm test -- collections.controller market-section --runInBand`: passed;
- backend `npm run build`: passed;
- web `npm exec tsc -- -b --pretty false`: passed;
- web `npm run build`: passed with existing Vite chunk-size warning;
- mobile `npm exec tsc -- --noEmit`: passed.

Deferred tests:
- real DB/API e2e coverage for `/market/sections` and `/market/sections/:key`;
- browser route test proving request counts on `/market-place`;
- mobile runtime test consuming backend sections;
- long View All virtualization and scroll restoration tests;
- signal, seen, suppression, personalization, and admin governance tests.

## Backend API tests

### Feed
- returns Discover for new authenticated user.
- hides For You for guest.
- enables For You after threshold.
- applies suppression.
- applies seen-content dedupe.
- uses cursor pagination without duplicates.
- applies category fallback.

### Market sections
- returns active sections only.
- hides empty sections.
- applies preview item count.
- supports View All pagination.
- preserves ranking profile.
- excludes unavailable products.
- reserves new-brand slots where configured.
- avoids duplicate products across sections when required.

### Suggestions
- returns suggestions for product detail.
- returns Similar Picks and Complete the Look separately.
- excludes current product.
- excludes already visible products.
- lazy-load endpoint can fail without primary content failing.
- user can hide suggestion item.
- user can hide suggestion block.
- guest receives generic trending/fresh.

### Admin
- super admin can create/edit/publish category.
- unauthorized admin denied.
- invalid formula rejected.
- default category cannot be archived without replacement.
- audit log created for config changes.
- formula version rollback works.

### User settings
- reset feed creates reset marker.
- hidden content can be restored.
- muted brand can be restored.
- location preference disables location scoring.
- notification preferences persist.

## Web E2E tests

- Market page loads without pulling thousands of products.
- section previews render.
- View All CTA visible subtly and accessible.
- View All opens section detail and back restores scroll.
- product detail lazy-loads suggestions.
- suggestion hide removes block/item.
- no duplicate cards in main + suggestions.
- filters/categories do not break section rendering.
- search empty shows suggestions.
- component unmount cancels observers/timers.

## Mobile E2E/manual tests

- MarketScreen sections render from backend config.
- Hero/fresh/blazing/new-designer sections render.
- View All route works.
- Product detail suggestions render.
- suggestion hide works.
- guest sees generic suggestions.
- app background flushes dwell timers.
- FlatList does not duplicate rows.
- low-data test environment shows caught-up state.

## Performance tests

- market home response below agreed target.
- section detail pagination below agreed target.
- suggestions below-fold do not block main render.
- signal emission does not block UI.
- no memory growth after repeated navigation.
- no duplicate interval leaks.

## Edge-case tests

- empty market.
- less than 5 users.
- first user.
- archived category link.
- paused section link.
- product deleted after loaded.
- brand store closed.
- user logs in mid-scroll.
- location denied.
- network failure during suggestions.
- signal endpoint unavailable.

## Phase 2 tests added - 2026-05-24

Backend tests added/updated:
- `src/market/market-signal.service.spec.ts`
  - accepts a valid batch;
  - uses server-derived authenticated `userId`;
  - supports guest `anonymousSessionId`;
  - rejects oversized batches;
  - rejects invalid signal/target types;
  - creates seen records for impression/view-style events.
- `src/market/market-suppression.service.spec.ts`
  - creates guest suppressions;
  - rejects guest suppressions without `anonymousSessionId`;
  - builds suppression scope for target, brand, category, and section filters;
  - deletes suppressions as restore;
  - returns controlled not-found errors.
- `src/market/market-section.service.spec.ts`
  - verifies active suppressions exclude section items.
- `src/market/market-cache.controller.spec.ts`
  - verifies signal ingestion is `Cache-Control: no-store`;
  - verifies suppression endpoints are `Cache-Control: private, no-store`.
- `src/users/feed-preferences.service.spec.ts`
  - verifies reset marker creation.
- `src/users/feed-preferences.controller.spec.ts`
  - verifies reset cache headers and server-derived user context.

Commands run for Phase 2:
- backend `npx prisma validate`: passed;
- backend `npx prisma generate`: passed;
- backend `npm test -- market-signal market-suppression market-section market-cache feed-preferences --runInBand`: passed;
- backend `npm run build`: passed;
- web `npm exec tsc -- -b --pretty false`: passed;
- web `npm run build`: passed with existing Vite chunk-size warning;
- mobile `npm exec tsc -- --noEmit`: passed.

Deferred tests:
- real API e2e for signal/suppression/reset endpoints against a database;
- Playwright test proving web signals are batched and observers clean up after navigation;
- mobile runtime tests for future AppState queue flushing;
- durable queue retry/dead-letter tests;
- suppression-aware empty-section fallback tests beyond current bounded filtering.

## Phase 3 tests added - 2026-05-24

Backend tests added/updated:
- `src/market/market-signal.service.spec.ts`
  - deduplicates duplicate `clientEventId` values inside one batch;
  - skips duplicate `batchId` replays using `MarketSignalBatchReceipt`;
  - skips recently persisted client event IDs for the same guest;
  - keeps server-derived user identity;
  - rejects oversized metadata;
  - preserves guest `anonymousSessionId` support and seen-item creation.
- `src/market/market-signal-aggregation.service.spec.ts`
  - aggregates section impressions, item impressions, product opens, seen counts, and event counts into daily buckets;
  - aggregates suppression counters without changing ranking behavior.
- `src/users/feed-preferences.service.spec.ts`
  - verifies reset marker creation;
  - verifies reset does not delete raw signals, seen rows, suppressions, or global aggregates.

Mobile contract test added:
- `scripts/test-market-signal-queue-contract.js`
  - verifies queue cap, batch size, interval flush, AppState flush, client event IDs, bounded retry, MarketScreen instrumentation, and no user-facing follow language in touched MarketScreen code.

Commands run for Phase 3:
- backend `npx prisma generate`: passed;
- backend `npx prisma validate`: passed;
- backend `npx prisma migrate status`: migration `20260524150000_add_market_signal_idempotency_aggregation` pending locally;
- backend `npx prisma migrate dev`: failed with Prisma `P1002` advisory-lock timeout; no destructive action run;
- backend `npm test -- market-signal market-suppression market-section market-cache feed-preferences --runInBand`: passed;
- backend `npm run build`: passed;
- web `npm exec tsc -- -b --pretty false`: passed;
- web `npm run build`: passed with existing Vite chunk-size warning;
- web `npm run lint`: passed with existing warnings only;
- mobile `npm exec tsc -- --noEmit`: passed;
- mobile `npm run test:market-signal-queue-contract`: passed;
- mobile `npm run audit:design-system`: passed.

Deferred tests:
- backend real database e2e for duplicate batch replay under concurrent requests;
- Redis/BullMQ retry/dead-letter tests after market signal queue infrastructure exists;
- React Native integration test that simulates AppState transitions instead of static contract checks;
- Playwright/Vitest coverage for web pagehide/visibility flushing.

## Phase 4 ranking-readiness QA - 2026-05-24

Backend tests strengthened:
- `src/market/market-signal.service.spec.ts`
  - verifies same-batch fingerprint dedupe for events without `clientEventId`;
  - verifies recent duplicate lookup uses the authenticated server user, not the client-provided anonymous session.
- `src/market/market-signal-aggregation.service.spec.ts`
  - verifies View All clicks increment aggregate counters;
  - verifies latest seen timestamp updates for view-like item events;
  - verifies anonymous aggregate buckets do not attach to authenticated user buckets;
  - verifies max-length aggregate keys remain inside the widened 512-character schema budget.

New QA docs:
- `docs/market-ranking-design-gate.md`
  - defines conservative ranking rules and acceptance criteria before implementation.
- `docs/market-signal-aggregation-qa-checklist.md`
  - defines migration, ingestion, idempotency, aggregation, suppression, reset, web queue, mobile queue, and ranking-readiness checks.

Phase 4 validation must include:
- `npx prisma validate`;
- `npx prisma generate`;
- `npx prisma migrate status`;
- focused backend market signal/suppression/aggregation/feed-preferences tests;
- `npm run build`;
- `git diff --check`.

Ranking remains deferred. These tests prove readiness of the signal pipeline, not personalized ordering.
