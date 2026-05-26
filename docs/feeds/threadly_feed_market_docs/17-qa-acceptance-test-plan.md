# QA and Acceptance Test Plan

## Phase 13C web admin governance UI QA - 2026-05-26

Phase 13C acceptance requires:

- web `/admin/market-governance` route is guarded by existing admin route
  protection and `MARKET_GOVERNANCE_READ`;
- admin sidebar entry is hidden unless the read permission is available;
- web admin API client methods match the Phase 13B backend endpoints;
- Overview shows ranking enabled state, default-disabled state, deterministic
  fallback state, shadow mode, active profile/formula, config read status,
  last rollback, and Phase 14 requirement;
- rollback rehearsal requires release permission, confirms before running, and
  displays non-mutating evidence;
- rollback requires rollback permission, confirmation, and a reason;
- Market Sections tab supports bounded edits and backend validation errors;
- Ranking Profiles tab keeps deterministic fallback locked on and rollout locked
  at `0`;
- Formulas tab uses allowlisted numeric weight inputs from `0` to `1`;
- Suggestion Blocks tab uses supported context, target type, source, fallback
  source, and item-limit controls;
- Audit Log tab paginates and keeps before/after state collapsed by default;
- missing write permissions hide or disable mutation controls;
- web TypeScript, build, lint, and diff checks pass;
- backend Phase 13B validation still passes;
- mobile baseline validation still passes;
- docs and UI do not claim final release readiness before Phase 14.

## Phase 13B admin governance runtime QA - 2026-05-26

Phase 13B backend runtime acceptance requires:

- Prisma schema validation and client generation pass after migration
  `20260526042133_add_market_governance_config`;
- Admin/SuperAdmin role metadata is present on governance controller routes;
- read endpoints require `MARKET_GOVERNANCE_READ`;
- section and ranking profile writes require `MARKET_GOVERNANCE_WRITE`;
- formula writes require `MARKET_RANKING_FORMULA_WRITE`;
- suggestion block writes require `MARKET_SUGGESTIONS_WRITE`;
- rollback requires `MARKET_RANKING_ROLLBACK`;
- rehearsal requires `MARKET_GOVERNANCE_RELEASE`;
- Admin without explicit permission is rejected by `AdminPermissionGuard`;
- every mutation writes an audit log in the same transaction;
- audit failure fails the mutation;
- invalid section keys, formula weights, suggestion contexts, and unsafe rollout
  settings return controlled errors;
- empty or failing config reads return code defaults;
- rollback without a prior formula fails safely;
- rollback rehearsal is non-mutating;
- existing auth, market suggestion, ranking, section, suppression, and user
  preference tests still pass.

Phase 13B did not include web admin governance UI acceptance. Phase 13C now
covers that UI gate. Phase 14 is still required before any final release claim.

## Phase 13A admin governance contract QA - 2026-05-26

Phase 13A is docs-only and does not implement admin governance runtime. Phase
13B cannot pass until tests cover:

- non-admin users receive 403 from every market governance endpoint;
- admins without explicit market governance permissions receive 403;
- `SuperAdmin` can perform allowed reads, writes, formula activation, and
  rollback;
- all writes validate safe ranges for section limits, ranking weights,
  exploration percent, brand max share, aggregate timeout, rollout percent, and
  suggestion item limits;
- deterministic fallback cannot be disabled by admin config;
- invalid section keys, contexts, source types, and profile keys return
  controlled 400 responses;
- every mutation writes an admin audit log with actor, action, target,
  previous state, new state, and request metadata where available;
- audit write failure fails the governance mutation;
- config read failure uses code defaults and public market routes still render;
- formula rollback restores the previous active version without deleting
  history;
- web admin route visibility and actions match the user's role and permission
  grants;
- docs and UI do not claim admin governance has final release clearance before
  Phase 14.

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

## Phase 5 release-gate QA - 2026-05-24

Phase 5 does not implement ranking. It hardens the release gate that must pass before aggregate-driven ranking code is written or enabled.

Docs added/updated:
- `docs/market-ranking-release-plan.md`
  - defines disabled-by-default ranking flags, shadow rollout, deterministic fallback, rollback triggers, owner placeholders, monitoring requirements, kill-switch behavior, and the Redis/BullMQ decision gate.
- `docs/market-signal-aggregation-qa-checklist.md`
  - now lists exact aggregate migration names, required order, backup requirement, `migrate deploy` path, post-migration SQL checks, rollback guidance, advisory-lock handling, and destructive-reset warning.

Phase 5 validation must include:
- `npx prisma validate`;
- `npx prisma generate`;
- `npx prisma migrate status`;
- `npm run build`;
- `git diff --check`;
- patch terminology search for changed docs.

Acceptance before ranking implementation:
- QA/UAT has applied `20260524150000_add_market_signal_idempotency_aggregation`;
- QA/UAT has applied `20260524170000_widen_market_signal_aggregate_key`;
- feature flags are implemented and tested with ranking disabled by default;
- deterministic fallback is proven when flags are disabled or aggregate reads fail;
- monitoring exists for latency, aggregate read failures, empty sections, fallback activation, suppression violations, signal ingestion, dedupe, aggregation failures, repeated item rate, and brand concentration;
- rollback owners are named and rollback is rehearsed.

Current blocker:
- local `npx prisma migrate status` still reports the two aggregate migrations pending. Do not use destructive reset to clear this; apply migrations through the normal development or deploy path once the advisory lock is clear.

## Phase 6 ranking flag tests - 2026-05-24

Phase 6 does not implement ranking. It adds code-level ranking flag parsing and proves deterministic fallback remains the served behavior.

Backend tests added/updated:
- `src/market/market-ranking-config.service.spec.ts`
  - verifies ranking defaults disabled;
  - verifies shadow mode defaults true;
  - verifies deterministic fallback defaults true;
  - verifies invalid values fall back or clamp safely;
  - verifies section keys are normalized, deduped, and bounded.
- `src/market/market-section.service.spec.ts`
  - verifies deterministic ordering when ranking is explicitly disabled;
  - verifies deterministic fallback remains served when ranking is enabled before implementation exists;
  - verifies aggregate tables are not read for ordering in the fallback path.

Validation command:
- `npm test -- market-ranking-config market-section --runInBand`

Ranking remains deferred. These tests prove the feature-flag guardrail, not personalized ordering.

## Phase 7 operational QA - 2026-05-24

Phase 7 does not implement ranking. It documents the monitoring and rollback rehearsal gates that must pass before any aggregate-driven ranking implementation starts.

Docs added/updated:
- `docs/market-ranking-monitoring-plan.md`
  - defines required metrics, dashboard filters, alert thresholds, log fields, fallback activation tracking, suppression violation monitoring, empty-section monitoring, repeated-item monitoring, brand concentration monitoring, aggregate read monitoring, signal ingest/dedupe monitoring, and owner placeholders.
- `docs/market-ranking-rollback-rehearsal.md`
  - defines QA/UAT prerequisites, baseline ranking flag values, enable/disable sequence, deterministic fallback expectations, aggregate read failure simulation plan, suppression verification, empty-section fallback verification, cache checks, pass/fail criteria, and rehearsal record template.
- `docs/market-ranking-release-plan.md`
  - now includes Phase 7 operational gate status.
- `docs/market-signal-aggregation-qa-checklist.md`
  - now includes Phase 7 migration, monitoring, and rollback-readiness checks.

Phase 7 validation must include:
- `npx prisma validate`;
- `npx prisma generate`;
- `npx prisma migrate status`;
- `npm test -- market-ranking-config market-section --runInBand` if no code changed but fallback tests remain the closest focused coverage;
- `npm run build`;
- `git diff --check`;
- patch terminology search for changed docs.

Acceptance before ranking implementation:
- QA/UAT applies the pending aggregate migrations;
- monitoring dashboard and alert thresholds are available or an approved QA/UAT manual substitute exists;
- owner placeholders are replaced or explicitly carried as release blockers;
- rollback rehearsal is executed and passes;
- ranking remains disabled until those gates are complete.

## Phase 7 operational readiness QA - 2026-05-24

Phase 7 operational readiness adds one focused backend fallback test and tightens the operational QA checklist without enabling ranking.

Backend test coverage:
- `src/market/market-section.service.spec.ts`
  - verifies market home previews remain deterministic when ranking is enabled before implementation exists;
  - verifies section metadata stays `ranking: deterministic-v1` and `personalization: disabled`;
  - verifies `marketSignalAggregateDaily.findMany` is not called for served market home ordering.

Operational QA additions:
- rollback rehearsal now has a step-by-step QA/UAT execution checklist;
- monitoring plan now records current backend logging foundations and missing dashboard/alert infrastructure;
- owner placeholders are explicitly release blockers, not assigned owners.

Phase 7 operational verification must include:
- `npx prisma validate`;
- `npx prisma generate`;
- `npx prisma migrate status`;
- `npm test -- market-ranking-config market-section --runInBand`;
- `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- `git diff --check`;
- search changed docs/code for inaccurate live-ranking/personalization claims and new user-facing follow/follower language.

## Phase 7 local MVP QA - 2026-05-25

Phase 7 local MVP acceptance checks:
- clean backend, web, and mobile workspaces before work;
- local database access;
- local restore point or acceptable restore path;
- aggregate migrations applied locally;
- deterministic fallback with ranking disabled;
- deterministic fallback when ranking is enabled before implementation;
- suppression fixture filters a visible product from fresh drops;
- rollback keeps deterministic metadata and item ordering;
- cache headers remain private/no-store;
- docs clearly distinguish local MVP simulation from hosted QA/UAT or production approval.

Evidence captured:
- baseline fresh-drops IDs:
  - `11111111-1111-4111-8111-111111111103`;
  - `11111111-1111-4111-8111-111111111102`;
  - `11111111-1111-4111-8111-111111111101`;
  - `0e2e0000-0000-4000-8000-000000000119`;
  - `0e2e0000-0000-4000-8000-000000000118`.
- enabled-before-implementation fresh-drops IDs matched the baseline.
- rollback fresh-drops IDs matched the baseline.
- suppression fixture target `11111111-1111-4111-8111-111111111103` was absent after guest suppression.

Final Phase 7 local MVP validation must include:
- `npx prisma validate`;
- `npx prisma generate`;
- `npx prisma migrate status`;
- `npm test -- market-ranking-config market-section --runInBand`;
- `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- `git diff --check`;
- search changed docs/code for inaccurate live-ranking, live-personalization, external-QA-approved, or production-ready claims;
- search touched docs/code for new user-facing follow/follower/following language.

## Phase 8 backend aggregate ranking QA - 2026-05-25

Phase 8 QA proves aggregate ranking is implemented behind safety flags while deterministic fallback remains safe.

Implemented test coverage:
- ranking disabled returns deterministic order;
- ranking disabled does not call the aggregate reader;
- ranking enabled and allowlisted section can use aggregate order;
- ranking enabled but non-allowlisted section remains deterministic;
- aggregate read failure falls back to deterministic order;
- aggregate read timeout falls back to deterministic order;
- empty aggregate result falls back to deterministic order;
- shadow mode computes but does not alter served order;
- metadata distinguishes deterministic, aggregate, fallback, and shadow states;
- suppression filtering still applies before ranking;
- brand diversity cap is enforced by the scorer when enough alternatives exist;
- cache headers remain `private, no-store` on market section routes;
- section detail limit/cursor behavior remains bounded;
- duplicate items are deduped before ranking.

Commands:
- `npm test -- market-ranking market-section --runInBand`

Expected behavior after Phase 8:
- default env still serves deterministic V1 output;
- `MARKET_RANKING_ENABLED=true` is required before aggregate ranking is considered;
- `MARKET_RANKING_SECTION_KEYS` must explicitly allow a section;
- `MARKET_RANKING_SHADOW_MODE=true` computes but serves deterministic order;
- failures never produce user-visible section errors.

Deferred QA:
- production monitoring dashboard verification;
- hosted alert verification;
- production backup/restore rehearsal;
- web/mobile ranking-specific UI checks;
- admin governance checks.

## Phase 9 client ranking contract QA - 2026-05-25

Phase 9 QA verifies that clients can consume the Phase 8 metadata contract without claiming live personalization or redesigning market surfaces.

Expected client behavior:
- web and mobile API types include `ranking`, `personalization`, `fallbackUsed`, `fallbackReason`, `rankingVersion`, `shadowMode`, and `rankingEnabled`;
- API normalization tolerates older section responses with missing metadata;
- `fallbackReason` and `rankingVersion` tolerate `null`;
- web MarketPlace keeps neutral market copy and must not claim personalization unless the backend serves `ranking=aggregate-v1` with `personalization=aggregate-contextual`;
- existing web signal batching remains bounded and keeps `clientEventId` support;
- mobile signal runtime keeps queue cap `100`, batch cap `25`, AppState background/inactive flush, and bounded retry behavior;
- mobile MarketScreen remains locally sectioned and is not migrated to backend-ranked sections in Phase 9.

Validation commands:
- backend `npm test -- market-ranking market-section --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs/code search for false live-ranking, full-personalization, ML, or production-ready claims;
- touched files search for new user-facing follow/follower/following language.

## Phase 10 View All and pagination QA - 2026-05-25

Phase 10 QA verifies that section detail pagination is bounded and safe for web View All flows while ranking remains disabled by default.

Backend tests added/updated:
- section detail clamps oversized limits to the 60-item backend maximum;
- section detail trims stable cursor values before querying Prisma;
- malformed cursors are rejected before Prisma is queried;
- stale Prisma cursor errors are returned as controlled bad requests;
- empty eligible section detail responses return safe empty items and pagination metadata;
- existing tests continue to cover section detail cursor metadata, unsupported section keys, duplicate removal, suppression filtering, ranking metadata, cache headers, and deterministic fallback.

Web validation:
- `/market/sections/:sectionKey` route fetches `getMarketSectionDetail` with `limit=24`;
- Load More uses `pagination.nextCursor` and stops when `hasNextPage=false`;
- stale requests are aborted on route change/unmount;
- returned items are de-duplicated before append;
- section detail records section view, item impression, and item open signals through the bounded web signal queue;
- UI copy remains neutral and does not claim personalization.

Mobile validation:
- mobile API/types already support section detail and Phase 8 metadata;
- mobile full section detail screen remains deferred;
- mobile signal queue contract must continue to pass.

Validation commands:
- backend `npx prisma validate`;
- backend `npx prisma generate`;
- backend `npm test -- market-ranking market-section --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs/code search for false ranking-live, full-personalization, ML, production-ready, suggestions, or admin-governance claims;
- touched files search for new user-facing follow/follower/following language.

## Phase 11A suggestion contract QA - 2026-05-25

Phase 11A is a docs/design gate. It does not add a suggestion endpoint, UI block, or runtime behavior.

Audit evidence required before Phase 11B:
- product detail surfaces identified:
  - backend `GET products/:id` and `GET store/products/:id` through `src/store/store.controller.ts`;
  - web `/products/:id` via `src/pages/catalog/ProductDetailsPage.tsx` and inline product detail via `src/components/catalog/InlineProductDetail.tsx`;
  - mobile `app/products/[productId].tsx` via `src/features/market/components/MarketCommerceViewer.tsx`.
- collection detail surfaces identified:
  - backend `GET collections/:id` and store collection helpers in `src/collections/collections.controller.ts` and `src/collections/collections.service.ts`;
  - web `/collections/:id` via `src/pages/catalog/CollectionRouter.tsx` and `src/components/catalog/InlineStoreCollectionView.tsx`;
  - mobile `app/collection-viewer.tsx` via `src/features/market/components/CollectionCommerceViewer.tsx`.
- brand/store surfaces identified:
  - backend public storefront and brand product routes in `src/store/store.controller.ts`;
  - web `/brand/:slug`, `/store/:brandId`, and profile/catalog routes;
  - mobile `app/catalog/[brandId].tsx` and `app/catalog/index.tsx`.
- search-empty surfaces identified:
  - backend `GET /v1/search` and `GET /v1/search/suggest`;
  - web `src/pages/SearchResultsPage.tsx`;
  - mobile `app/search.tsx`.
- market section detail status identified:
  - web Phase 10 route exists at `/market/sections/:sectionKey`;
  - mobile dedicated section detail remains deferred.

Phase 11B backend tests to add:
- `GET /market/suggestions` validates supported contexts and target types;
- invalid context/target type/cursor returns a controlled client error;
- limit is clamped;
- product detail suggestions exclude the current product;
- collection detail suggestions exclude unavailable/broken-media items;
- brand detail suggestions respect open-store and product availability constraints;
- search-empty suggestions use query-relaxed fallback when exact matches are empty;
- active item/brand/category/suggestion-block suppressions filter candidates;
- no duplicate item IDs inside one block;
- duplicate items across blocks are avoided where feasible;
- empty data returns safe empty blocks;
- cache header is `private, no-store`;
- suggestion signals use existing batched signal DTO values and `suggestionBlockKey`.

Phase 11B web validation to add:
- product detail suggestion block lazy-loads after primary detail content;
- collection detail suggestion block lazy-loads after primary collection content;
- search empty state can render suggestion blocks without blocking existing search retry/error behavior;
- stale suggestion requests are aborted on route change/unmount;
- hide/not-interested removes the local suggestion card/block and calls existing suppression endpoint;
- visible copy does not claim personalization unless backend metadata explicitly supports it.

Phase 11B mobile validation to add:
- API types match backend `MarketSuggestionResponse`;
- any mobile suggestion UI uses approved `AppText`, `Button`, `Card`, `StableImage`, and list primitives;
- no nested unbounded `ScrollView`/`FlatList` regression is introduced;
- AppState signal queue behavior remains unchanged;
- local moodboard suggestion row is either left untouched or deliberately migrated in a separate scope.

Validation commands for Phase 11A:
- backend `npm test -- market-ranking market-section --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs search for false claims about live suggestions, live ranking, full personalization, ML, production readiness, or admin governance;
- touched files search for new user-facing follow/follower/following language.

## Phase 11C suggestion UI polish QA - 2026-05-25

Phase 11C adds only safe deferred UI wiring:
- web `CatalogShopTab.tsx` renders `BRAND_DETAIL` suggestions below visitor Store content when `brandId` exists and the store is not explicitly closed;
- mobile `MobileMarketSuggestionBlocks.tsx` renders bounded horizontal rails for product detail, collection detail, and search-empty contexts;
- mobile MarketScreen remains untouched;
- mobile suggestion UI does not add Not interested controls yet;
- `MARKET_SECTION_DETAIL`, suggestion View All pages, admin governance, ML/embeddings, and cart/checkout suggestions remain deferred.

Validation requirements:
- backend `npx prisma validate`;
- backend `npx prisma generate`;
- backend `npm test -- market-suggestion market-ranking market-section --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs/code search for false suggestion personalization, ML, ranking-live, production-ready, or admin-governance claims;
- touched files search for new user-facing follow/follower/following relationship language.

## Phase 11B suggestion runtime QA - 2026-05-25

Backend tests added:
- `src/market/market-suggestion.controller.spec.ts`
  - verifies `GET /market/suggestions` uses `Cache-Control: private, no-store`;
  - verifies authenticated user identity is derived from the request and anonymous session is forwarded.
- `src/market/market-suggestion.service.spec.ts`
  - verifies product detail suggestions return More Like This, More From This Brand, and Fresh Alternatives;
  - verifies product detail suggestions exclude the current product;
  - verifies oversized limits clamp to the backend maximum;
  - verifies blank search-empty queries are rejected safely;
  - verifies suppressions filter suggestion candidates;
  - verifies no-media candidates are excluded;
  - verifies duplicate items across blocks are avoided where feasible;
  - verifies collection detail and brand detail return safe blocks;
  - verifies market section detail returns a safe deferred response;
  - verifies metadata stays deterministic and does not expose score or aggregate internals;
  - verifies collection candidates are limited to published, public, non-deleted collections.

Web validation:
- `MarketApi.ts` includes suggestion types and `getMarketSuggestions`;
- `MarketSuggestionBlocks.tsx` lazy-loads, aborts stale requests, tracks suggestion view/click/hide events, and removes hidden cards locally;
- product detail, inline product detail, collection detail, and search-empty surfaces integrate the reusable block without blocking primary content.

Mobile validation:
- `src/api/MarketApi.ts` includes suggestion types and `getMarketSuggestions`;
- no mobile UI wiring is added in Phase 11B, so the runtime signal queue contract must remain unchanged.

Required commands:
- backend `npx prisma validate`;
- backend `npx prisma generate`;
- backend `npm test -- market-suggestion market-ranking market-section --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs/code search for false suggestion personalization, ML, ranking-live, production-ready, or admin-governance claims.

## Phase 12 user market/feed controls QA - 2026-05-25

Backend tests added/updated:
- `src/market/market-suppression.service.spec.ts`
  - verifies authenticated suppression listing is scoped to the server-derived user ID;
  - verifies authenticated listing cannot be widened with a client-supplied anonymous session;
  - verifies guest suppression listing is scoped by `anonymousSessionId`;
  - verifies listing without authenticated or guest scope is rejected;
  - verifies restore/delete returns a controlled not-found error for another owner's suppression.
- `src/users/feed-preferences.service.spec.ts`
  - continues to verify reset marker creation without deleting raw signals, seen rows, suppressions, or global aggregates.
- `src/users/feed-preferences.controller.spec.ts`
  - continues to verify private/no-store reset headers and server-derived user context.

Web validation:
- `Settings -> Market & Feed` lists server suppressions from `GET /market/suppressions`;
- restore calls `DELETE /market/suppressions/:id` and rolls back optimistic removal on failure;
- reset calls `POST /user/preferences/feed/reset` with a confirmation dialog and non-destructive copy;
- unauthenticated users see a sign-in prompt instead of account-level preference controls.

Mobile validation:
- `src/api/MarketApi.ts` exposes `getMarketSuppressions`, `deleteMarketSuppression`, and `resetFeedPreferences`;
- `Settings -> Market preferences` lists hidden content, restores individual suppressions, and confirms reset;
- the screen uses existing mobile UI primitives and does not alter the market signal queue.

Required commands:
- backend `npx prisma validate`;
- backend `npx prisma generate`;
- backend `npm test -- auth market-suggestion market-ranking market-section market-suppression user-preferences --runInBand`;
- backend `npm run build`;
- web `npm exec tsc -- -b --pretty false`;
- web `npm run build`;
- web `npm run lint` if available;
- mobile `npm exec tsc -- --noEmit`;
- mobile `npm run test:market-signal-queue-contract`;
- changed docs/code search for false suggestion personalization, ML, ranking-live, production-ready, or admin-governance claims;
- touched files search for new user-facing follow/follower/following relationship language.
