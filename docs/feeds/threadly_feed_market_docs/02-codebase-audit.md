# Codebase Audit: Current State, Stale V1 Issues, and Validation Checklist

## Repositories reviewed

| Layer | Repo found |
|---|---|
| Backend | `PatrickOloye/threadly-backend` |
| Web | `PatrickOloye/Threadly-frotnend` |
| Mobile | `PatrickOloye/threadly-mobile` |

## Evidence-backed findings

### Backend design feed / market feed

Observed file: `src/collections/collections.service.ts`

Current `getMarketFeed`:
- accepts `cursor`, `limit`, `tag`, `category`, and `requesterId`;
- filters `domain = DESIGN`, `status = PUBLISHED`, `visibility = PUBLIC`;
- requires ready media;
- orders by `updatedAt desc`, then `id desc`;
- uses `requesterId` only to hydrate threaded state, not to rank feed content.

Implication:
- design feed / market design feed is chronological, not personalized.
- same candidate ordering can be served to many users.
- existing reactions/comments/thread counts are hydrated but not used for ranking.

### Backend product market endpoint

Observed file: `src/store/store.controller.ts`

Endpoint:
- `GET products/market` and `GET store/products/market`
- supports optional JWT, throttling, pagination/cursor, filters, category, gender, price, sizes, colors, tags, sale, featured, search, and sort.

Implication:
- product market has useful filter primitives.
- ranking is still exposed as query sort modes, not section/profile driven market intelligence.

### Backend product detail view counting

Observed file: `src/store/product-view-counter.service.ts`

Phase 0 behavior before Phase 1:
- buffers product view count increments;
- uses Redis if `REDIS_URL` is set;
- falls back to in-process buffer;
- flushes every 10 seconds;
- caps local buffer at 5000 keys;
- clears timers on module destroy.

Implication:
- good low-cost foundation for view-count buffering.
- not enough for context-aware suggestions because it only increments product views, not section views, suggestion impressions, dwell, hides, etc.

### Web Market page

Observed file: `src/pages/MarketPlace.tsx`

Current behavior:
- loads `/store/products/market`;
- requests pages of 120;
- can loop up to 40 pages;
- maximum rows = 4800;
- sorts and filters client-side;
- has static filters: `FOR_YOU`, `MENSWEAR`, `WOMENSWEAR`, `EVERYBODY`, `ON_SALE`;
- builds Fresh Drops locally;
- has hero products from recency-sorted products;
- uses load-more client-side visible count.

Implication:
- high latency/memory risk.
- web and mobile market behavior can drift.
- not suitable for production-grade personalized or admin-configurable section rendering.
- `For You` on web is currently a static client filter label, not true personalization.

### Mobile Market screen

Observed file: `src/features/market/components/MarketScreen.tsx`

Current behavior:
- already has section-like local rows: hero carousel, blazing row, horizontal card row, latest collections, product grid, editorial card, loading/empty/error rows;
- builds combined product/design content items locally;
- `Blazing Now` is built from category counts or fallback popularity;
- row order is locally composed in `buildRows`.

Implication:
- mobile already points toward the right UX model.
- backend should take over section rendering and ranking so web/mobile remain consistent.
- `Blazing Now` needs real social/commerce velocity, not just local category count.

## Stale V1 issues

| Issue | Current evidence | Risk | Required resolution |
|---|---|---|---|
| Chronological design feed | `orderBy updatedAt desc, id desc` | identical feeds | Feed scoring + seeded shuffle |
| Requester identity not used for ranking | `requesterId` only hydrates threaded state | no personalization | user context in candidate scoring |
| Web loaded up to 4800 products before Phase 1 | `MARKET_LOAD_MAX_ROWS = 4800` in Phase 0 | latency, memory, CPU | backend paginated sections, implemented in Phase 1 |
| Web filters are hardcoded | `FOR_YOU`, `MENSWEAR`, etc. | not admin-driven | DB-managed categories/sections |
| Mobile sections are local | `buildRows()` | platform drift | backend section DTO |
| Blazing uses local category counts | `buildBlazingTrends()` | weak social proof | velocity score |
| Product view counter only counts views | `ProductViewCounterService` | insufficient analytics | signal/event models |
| No suggestion suppression found | no shared model observed | poor user control | UserSuggestionSuppression |
| No section analytics found | no section event model observed | cannot optimize sections | MarketSectionSignal |
| No ranking profile/version model found | current formulas are code/static | hard to govern | RankingProfile + FormulaVersion |

## Required repo validation before implementation

Before code changes, confirm actual Prisma schema models for Product, Collection, Brand, WishlistItem, CartItem, Order, Reaction, Comment, Thread/Patch; indexes on product filters and collection feed fields; existing admin role/permission model; whether Redis is available in production or must be optional only; current web/mobile route maps; and current Terms/Privacy wording.

## Phase 0 audit result - 2026-05-23

### Verdict

Ready for Phase 1: **No**.

Reason: the implementation path is technically clear, but the feeds documentation pack is not inside `threadly-backend`, `Threadly-frotnend`, or `threadly-mobile`, so the required single commit/push to `origin/main` cannot include these documentation changes without changing repository ownership.

### Documentation folder

- Real path: `docs/feeds and market research/threadly_feed_market_docs/threadly_feed_market_docs`.
- Files found: `00-index.md` through `19-glossary.md`.
- Repo ownership: workspace-level folder, not tracked by any of the three allowed Git repositories.

### Phase 0B ownership update

- Canonical repo path: `bthreadly/docs/feeds/threadly_feed_market_docs/`.
- Backend owns the canonical copy because the backend defines shared APIs, schemas, ranking contracts, signal ingestion, and cross-platform feed/market contracts.
- The original workspace docs path remains a non-canonical source copy unless it is intentionally deleted later.
- Phase 0B resolved the documentation ownership blocker by committing the canonical copy under the backend repo.

### Backend ground truth

Files inspected:
- `bthreadly/prisma/schema.prisma`
- `bthreadly/prisma/migrations/*`
- `bthreadly/prisma/seed.ts`
- `bthreadly/prisma/seed_brand.ts`
- `bthreadly/package.json`
- `bthreadly/src/app.module.ts`
- `bthreadly/src/auth/auth.module.ts`
- `bthreadly/src/queue/queue.config.ts`
- `bthreadly/src/collections/collections.controller.ts`
- `bthreadly/src/collections/collections.service.ts`
- `bthreadly/src/store/store.controller.ts`
- `bthreadly/src/store/store.service.ts`
- `bthreadly/src/store/product-view-counter.service.ts`
- `bthreadly/src/users/patching.controller.ts`
- `bthreadly/src/users/patching.service.ts`
- `bthreadly/src/users/user-profile.controller.ts`
- `bthreadly/src/users/user-profile.service.ts`
- `bthreadly/src/brands/brands.controller.ts`
- `bthreadly/src/brands/brands.service.ts`
- `bthreadly/src/brands/brand-metrics.service.ts`
- `bthreadly/src/admin/constants/permissions.ts`
- `bthreadly/src/admin/guards/admin-permission.guard.ts`
- `bthreadly/src/admin/system-config/system-config.controller.ts`

Findings:
- `getMarketFeed` is chronological only: `updatedAt desc`, then `id desc`.
- `requesterId` affects viewer hydration only, specifically threaded state; it does not affect ranking.
- `collections/market` accepts `cursor`, `limit`, `tag`, and `counts`; the service has a `category` option, but the controller does not expose/pass `category`.
- Product market routes are duplicated/aliased as `products/market` and `store/products/market`.
- Product market supports cursor and page pagination, but `limit` is capped at 120 and ranking is exposed as sort modes (`newest`, `price_asc`, `price_desc`, `popular`), not profile-driven ranking.
- Product market category filtering is wired through collection membership category slug, not direct `Product.categoryId/category.slug`, so standalone categorized products can be missed.
- `ProductViewCounterService` uses Redis when `REDIS_URL` exists and falls back to an in-process `Map`; this is a useful low-cost counter foundation but not a feed signal system.
- No feed signal, seen-item, suggestion suppression, ranking profile, formula version, or admin config audit-log models were found.
- `AdminAuditLog` and generic admin permissions exist, including system settings, feature flags, product moderation, collection moderation, and audit read permissions, but no feed/ranking-specific permission exists.
- Redis is optional for product view counts, but not optional for BullMQ queue features because the queue module builds a Redis connection.
- Index coverage is partial. Product has useful single/compound indexes for brand, active status, category, category type, createdAt, price, and views, but the planned market needs additional compound indexes for active/deleted/category/status/brand/createdAt-style lookups.

### Web ground truth

Files inspected:
- `fthreadly/package.json`
- `fthreadly/src/App.tsx`
- `fthreadly/src/pages/Market.tsx`
- `fthreadly/src/pages/MarketPlace.tsx`
- `fthreadly/src/api/MarketApi.ts`
- `fthreadly/src/api/StoreApi.ts`
- `fthreadly/src/api/SearchApi.ts`
- `fthreadly/src/hooks/useSearch.ts`
- `fthreadly/src/hooks/useSearchSuggestions.ts`
- `fthreadly/src/query/queryClient.ts`
- `fthreadly/src/query/queryKeys.ts`
- `fthreadly/src/query/queries.ts`
- `fthreadly/src/components/designs/DesignCard.tsx`
- `fthreadly/src/pages/catalog/ProductDetailsPage.tsx`
- `fthreadly/src/components/catalog/InlineProductDetail.tsx`
- `fthreadly/src/components/catalog/CatalogShopTab.tsx`
- `fthreadly/src/pages/SearchResultsPage.tsx`
- `fthreadly/src/pages/settings/HiddenContentSettings.tsx`
- `fthreadly/src/pages/settings/SettingsHome.tsx`
- `fthreadly/src/pages/admin/AdminSettingsPage.tsx`
- `fthreadly/src/pages/admin/AdminProductsPage.tsx`

Findings:
- `/` and `/market` route to `Market` in design mode. `/market-place` routes to `MarketPlace`.
- Phase 0 found `MarketPlace.tsx` implementing the high-risk `120 x 40 = 4800` max-row client aggregation pattern.
- `MarketPlace` builds hero, Fresh Drops, custom-order, filters, and visible load-more locally after pulling large product batches.
- Web `For You` is a static filter label, not personalized ranking.
- Market filters are hardcoded in `MarketPlace` and partially hardcoded in `Market`.
- `Market.tsx` passes `category` to the market API, but backend currently ignores category for `collections/market`.
- Search suggestions use `AbortController`, but market/product/detail loading mostly uses manual flags or no cancellation.
- Scroll restoration for market pages was not found.
- Product detail, collection detail, brand/store, and search empty surfaces do not have market suggestion blocks yet.
- Hidden content on web is localStorage-backed, not backend suppression/seen tracking.
- Admin has generic settings and featured product/design tools, but no ranking/section/suggestion governance screen.

### Mobile ground truth

Files inspected:
- `threadly-mobile/package.json`
- `threadly-mobile/app.json`
- `threadly-mobile/app/(tabs)/index.tsx`
- `threadly-mobile/app/(tabs)/discover.tsx`
- `threadly-mobile/app/products/[productId].tsx`
- `threadly-mobile/app/collection-viewer.tsx`
- `threadly-mobile/app/catalog/[brandId].tsx`
- `threadly-mobile/app/search.tsx`
- `threadly-mobile/src/api/MarketApi.ts`
- `threadly-mobile/src/api/StoreApi.ts`
- `threadly-mobile/src/api/SearchApi.ts`
- `threadly-mobile/src/features/feed/api/feedApi.ts`
- `threadly-mobile/src/features/feed/components/MarketFeedScreen.tsx`
- `threadly-mobile/src/features/feed/components/MarketFeedList.tsx`
- `threadly-mobile/src/features/feed/hooks/useFeedScrollRestore.ts`
- `threadly-mobile/src/features/market/components/MarketScreen.tsx`
- `threadly-mobile/src/features/market/components/MarketCommerceViewer.tsx`
- `threadly-mobile/src/features/market/components/CollectionCommerceViewer.tsx`
- `threadly-mobile/src/recommendations/recommendationScoring.ts`
- `threadly-mobile/src/analytics/mobileAnalytics.ts`
- `threadly-mobile/src/query/QueryProvider.tsx`
- `threadly-mobile/src/query/queryClient.ts`
- `threadly-mobile/src/query/queryKeys.ts`
- `threadly-mobile/src/query/queryPersistor.ts`
- `threadly-mobile/src/utils/notificationRouting.ts`
- `threadly-mobile/src/notifications/pushTokenRegistration.ts`

Findings:
- Home (`app/(tabs)/index.tsx`) renders `MarketFeedScreen`, a cached cursor-driven design feed using `collections/market`.
- Discover (`app/(tabs)/discover.tsx`) renders `MarketScreen`, which composes a section-first market UX locally.
- Mobile `MarketScreen` builds hero, live themes, Fresh on Threadly, For your moodboard, Latest Collections, product grids, editorial cards, and custom-ready rows locally.
- Mobile is ahead of web in section-first UX, but it is not backend-driven.
- `For your moodboard` suggestions are local only, powered by `recommendationScoring.ts`, not by a shared backend suggestion contract.
- Mobile uses `FlatList` for the vertical feed/market shell and nested horizontal `FlatList`/`ScrollView` rows. The Runway feed uses tuned FlatList props; Discover market has nested horizontal lists and local row composition that should be watched as data grows.
- `trackMobileEvent` currently defaults to a no-op unless analytics is explicitly enabled; there is no durable signal queue or flush path.
- Feed viewability emits local analytics events, but no backend ingestion endpoint is wired.
- Search uses `AbortController`; market/detail product requests generally do not.
- Query focus is wired to `AppState` through TanStack Query, but no dwell/signal queue cleanup exists because dwell/signal queues do not exist yet.
- Expo Go limitations remain: push notifications are skipped in Android Expo Go and require EAS/dev-build support.

### Patch relationship audit

Current patch meaning:
- `PatchConnection` is the unified accepted relationship model for user-to-brand and brand-to-brand patching.
- `BrandPatch` is the brand-to-brand request/response workflow.
- `CollectionCollab`, mapped to database table `CollectionPatch`, represents brand collaboration/patching on collections.

Code locations:
- `bthreadly/prisma/schema.prisma`
- `bthreadly/src/users/patching.controller.ts`
- `bthreadly/src/users/patching.service.ts`
- `bthreadly/src/users/user-profile.controller.ts`
- `bthreadly/src/users/user-profile.service.ts`
- `bthreadly/src/brands/brands.controller.ts`
- `bthreadly/src/brands/brands.service.ts`
- `fthreadly/src/context/BrandPatchContext.tsx`
- `fthreadly/src/components/settings/tabs/PatchesSettings.tsx`
- `threadly-mobile/src/hooks/useBrandPatchStatus.ts`
- `threadly-mobile/src/features/feed/components/MarketFeedScreen.tsx`

Remaining legacy terminology:
- `Follow` model still exists in Prisma but no active API usage was found.
- `NotificationType.FOLLOW` exists as legacy notification compatibility; backend formatter already maps it to patch copy.
- Backend brand metrics expose `followersCount` as a compatibility alias for patch count.
- Web/mobile notification settings still include `Follows` copy/keys.
- Some UI copy says “Follow” in empty states or launch prompts.

### Validated assumptions

- Backend has enough catalog primitives to build a section engine, but no section engine exists yet.
- Product view counting can be reused as a low-cost pattern for counters, but broader signal ingestion must be new.
- Admin/audit primitives exist but feed/ranking governance requires new models and permissions.
- Mobile UX direction is closer to the desired section-first market architecture than web.
- Web market had to be refactored before personalization, because the Phase 0 4800-row client aggregation pattern was not a safe foundation.

### Unvalidated assumptions

- Production Redis availability, SLA, memory limits, and eviction policy are not confirmed from repo files.
- Final Terms/Privacy wording was not found in this audit.
- Any external analytics vendor contract is not configured in the inspected mobile analytics client.
- Real production data distribution for categories, store collections, standalone products, and design media readiness is not known from code alone.

### Historical blockers before Phase 1

- Resolved in Phase 0B: the feeds docs pack was moved into the backend repository.
- Resolved in Phase 1: `collections/market` exposes category passthrough.
- Resolved in Phase 1: the backend section DTO was defined before web/mobile implementation.
- Still deferred to Phase 2+: add or confirm Redis production availability before using Redis for seen/suppression/rate/counter workloads beyond optional local fallbacks.

### Known risks

- Current web market loading can create slow page loads and high memory use at realistic catalog sizes.
- Product category filtering currently risks missing products that are categorized directly but not attached to categorized store collections.
- Personalized responses must not be cached in shared caches.
- Local-only hidden/suggestion controls will not protect users consistently across devices.
- Legacy `follow/follower` names can leak into user-facing copy if not tracked during implementation.

### Commands run

- `Get-Content -Raw project-memory/INDEX.md`
- `Get-Content -Raw rules/AGENT_RULES.md`
- `Get-Content -Raw AGENTS.md`
- `Get-Content -Raw CLAUDE.md`
- `Get-Content -Raw LAST_SESSION.md`
- `git remote -v; git branch --show-current; git status --short --branch`
- `git fetch origin; git pull --ff-only; git status --short --branch`
- `git -C threadly-mobile worktree prune`
- `rg --files ...`
- `rg -n ...`
- `Get-Content -Raw package.json`
- targeted `Get-Content` line-range reads for backend, web, and mobile files listed above.

### Research notes

- Prisma official docs recommend avoiding N+1 through relation query strategies or batched `in` queries where appropriate: https://www.prisma.io/docs/orm/prisma-client/queries/query-optimization-performance
- NestJS official caching docs note in-memory cache as the default and Redis/Keyv-backed stores for shared cache behavior: https://docs.nestjs.com/techniques/caching
- TanStack Query official docs support infinite queries with cursor metadata and warn to avoid overlapping fetches for one infinite query: https://tanstack.com/query/v5/docs/react/guides/infinite-queries
- TanStack Query cancellation docs provide `AbortSignal` to query functions; Threadly should pass it through API layers for stale market requests: https://tanstack.dev/query/v5/docs/framework/angular/guides/query-cancellation
- React Native FlatList docs recommend stable keys, `getItemLayout` for fixed-size rows, viewability callbacks, and careful virtualization tuning: https://reactnative.dev/docs/flatlist
- Expo notification docs state remote push notifications are unavailable in Expo Go on Android from SDK 53, confirming the current code guard: https://docs.expo.dev/versions/latest/sdk/notifications/
- MDN Cache-Control docs require `private` for personalized content and `no-store` when responses must not be stored: https://developer.mozilla.org/docs/Web/HTTP/Reference/Headers/Cache-Control
- FTC privacy guidance reinforces clear disclosure for personal data use: https://www.ftc.gov/business-guidance/privacy-security/consumer-privacy

## Phase 1 implementation result - 2026-05-24

Ready for Phase 2: **Yes, with Phase 1 limits preserved**.

Implemented backend findings:
- `collections/market` now accepts and passes `category` from controller to `CollectionsService.getMarketFeed`.
- New additive backend endpoints exist:
  - `GET /market/sections`
  - `GET /market/sections/:key`
- Existing endpoints remain in place:
  - `GET /collections/market`
  - `GET /products/market`
  - `GET /store/products/market`
- `MarketSectionDto` and related item, metadata, view-all, and pagination DTOs are explicit in `src/market/dto/market-section.dto.ts`.
- Section queries are bounded and use Prisma `select` payloads for previews/detail.
- Home sections hide when empty. Detail endpoint returns a controlled `404` for unsupported section keys.
- Cache headers for both new section routes are `Cache-Control: private, no-store`.

Implemented web findings:
- `MarketPlace.tsx` now calls `/market/sections` as the primary market home source.
- The old 120 x 40 / 4800-row aggregation loop was removed from the primary path.
- If `/market/sections` fails or returns no product cards, fallback is capped to one `/store/products/market` request with `limit=24`.
- Web section fetches use `AbortSignal` cancellation on unmount/navigation.
- The visible static `For You` filter label on this touched surface was changed to `Discover` to avoid implying personalization.

Implemented mobile findings:
- Mobile rendering remains local-section based in Phase 1.
- `threadly-mobile/src/api/MarketApi.ts` now exposes typed `getMarketSections` and `getMarketSectionDetail` methods for later migration.

Known Phase 1 limits:
- Ranking is deterministic V1 only: newest, view/thread count, latest collection, active category, custom-ready, and new brand ordering.
- No personalized For You ranking exists yet.
- No signal ingestion, seen tracking, suppression model, ranking profile, formula version, admin section config, or suggestion engine was implemented.
- Product market direct category semantics outside the new section contract remain a later hardening item.

## Phase 2 implementation result - 2026-05-24

Ready for Phase 3: **Yes, after Phase 2 commits are pushed**, with ranking personalization still deferred.

Implemented backend findings:
- Prisma now includes V1 signal and control models: `UserFeedSignal`, `UserSeenItem`, `MarketSectionSignal`, `SuggestionSignal`, `UserContentSuppression`, and `PersonalizationReset`.
- Migration `20260524120000_add_market_signal_suppression_foundation` creates the signal/suppression/reset tables, enums, and query indexes.
- New endpoints:
  - `POST /market/signals/batch`
  - `POST /market/suppressions`
  - `GET /market/suppressions`
  - `DELETE /market/suppressions/:id`
  - `POST /user/preferences/feed/reset`
- Signal ingestion is batch-based with a 50-event server maximum and 2048-byte metadata pruning.
- Authenticated `userId` is derived from the server request context. Guest events and suppressions require `anonymousSessionId`.
- `/market/sections` and `/market/sections/:key` now exclude active user/session suppressions where safe.
- Cache headers remain safe: market sections and control/reset endpoints are private/no-store; signal ingestion is no-store.

Implemented web findings:
- `src/hooks/useMarketSignals.ts` adds a bounded in-memory signal queue with 100-event max queue, 25-event client batch size, 5-second interval flush, visibility/pagehide flush, and cleanup on unmount.
- `MarketPlace.tsx` instruments section impressions, item impressions, product opens, and not-interested actions for the Phase 1 section surface.
- Web suppression calls `POST /market/suppressions`, removes the item locally, and offers an undo action using `DELETE /market/suppressions/:id`.
- Web still keeps the Phase 1 capped product fallback and does not migrate product-detail suggestions or admin screens in this phase.

Implemented mobile findings:
- `threadly-mobile/src/api/MarketApi.ts` now exposes typed signal batch, suppression create/delete, and feed preference reset API methods.
- Mobile runtime instrumentation and durable/offline signal queues remain deferred.

Known Phase 2 limits:
- `batchId` is accepted for client idempotency correlation, but strict duplicate batch de-dupe is deferred until a queue/idempotency store is added.
- Signals write directly through bounded Prisma `createMany` calls in this phase; Redis/BullMQ ingestion is deferred to Phase 2B/Phase 3 hardening.
- Seen tracking is recorded but not used for heavy dedupe or ranking yet.
- Suppression affects market section output only where the section DTO has enough item metadata.
- No ranking profile, formula versioning, ML, admin ranking UI, or full suggestion engine was implemented.

## Phase 3 and Phase 4 re-audit result - 2026-05-24

Phase 3 verified:
- backend added `clientEventId`, `MarketSignalBatchReceipt`, `MarketSignalAggregateDaily`, duplicate batch replay checks, recent client-event dedupe, synchronous aggregate updates, and explicit reset retention policy;
- web market signals now carry client event IDs through the existing bounded signal queue;
- mobile added `src/services/marketSignals.ts` and light `MarketScreen` runtime instrumentation with bounded queue, 25-event flushes, 5-second interval, AppState background/inactive flush, and bounded retry;
- Redis/BullMQ remains deferred for the market signal path;
- aggregate counters are not used for ranking.

Phase 4 verified:
- `MarketSignalService` persists raw accepted events and skips duplicate event IDs, duplicate batch replays, recent duplicate client IDs, and same-batch no-ID fingerprints;
- `MarketSignalAggregationService` summarizes section impressions, item impressions, opens, View All clicks, suppressions, seen counts, and latest seen timestamps into daily UTC aggregate buckets;
- authenticated aggregate buckets use the server-derived user ID and do not attach the anonymous session;
- reset creates a marker and does not delete raw signals, seen rows, suppressions, or global aggregate counters;
- market section output remains deterministic/non-personalized and suppression-aware where item metadata supports it.

Phase 4 hardening:
- `MarketSignalAggregateDaily.aggregateKey` was widened to `VARCHAR(512)` because max-length aggregate inputs can exceed the original `VARCHAR(320)` budget.

Ready for ranking implementation: **No** until the ranking design gate is accepted, aggregate migrations are applied in QA/UAT, a feature flag/rollback path exists, and production queue/monitoring decisions are made.

## Phase 5 release-gate audit result - 2026-05-24

Phase 5 re-audit confirmed:
- ranking is still not live;
- aggregate tables are not used by `MarketSectionService` to order `/market/sections` or `/market/sections/:key`;
- market section output remains deterministic/non-personalized and suppression-aware where section item metadata supports filtering;
- `FeedPreferencesService` reset behavior remains marker-based and does not delete raw signals, seen rows, suppressions, or global aggregate counters;
- `MarketSignalAggregateDaily.aggregateKey` is `VARCHAR(512)` in Prisma schema and the widening migration;
- local `npx prisma migrate status` still reports the two aggregate migrations pending:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`.

Phase 5 documentation changes:
- `docs/market-ranking-release-plan.md` defines the feature flag strategy, rollout stages, rollback behavior, owner placeholders, monitoring requirements, kill-switch behavior, and Redis/BullMQ decision gate;
- `docs/market-signal-aggregation-qa-checklist.md` now includes migration execution order, backup requirements, deploy commands, post-migration SQL checks, rollback guidance, advisory-lock handling, and destructive-reset warnings.

Ready for ranking implementation: **No** until QA/UAT migrations are applied, disabled-by-default ranking flags are implemented and tested, deterministic fallback is proven, monitoring exists, owner placeholders are replaced, and rollback is rehearsed.

## Phase 6 ranking flag foundation result - 2026-05-24

Phase 6 implementation confirmed:
- `src/market/market-ranking-config.service.ts` reads `MARKET_RANKING_*` env values with safe defaults, clamping, and section-key normalization;
- `src/market/market-section.service.ts` reads ranking config in a no-op path;
- `/market/sections` and `/market/sections/:key` still serve deterministic V1 ordering;
- aggregate tables are not read for ordering;
- tests prove default disabled ranking config, safe invalid value handling, bounded section keys, deterministic fallback when ranking is disabled, deterministic fallback if ranking is enabled before implementation exists, suppression filtering, and cache headers.

Ready for ranking implementation: **No**. Phase 6 closes the code-level flag foundation only. Remaining blockers are QA/UAT aggregate migrations, owner placeholders, monitoring dashboard, rollback rehearsal, and actual ranking implementation behind the disabled-by-default flags.

## Phase 7 operational readiness audit result - 2026-05-24

Phase 7 re-audit confirmed:
- ranking remains disabled;
- `/market/sections` and `/market/sections/:key` still serve deterministic ordering;
- aggregate tables are not read for served ordering;
- pending aggregate migrations remain locally:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- `npx prisma validate` and `npx prisma generate` pass against the current schema;
- QA/UAT must apply pending migrations with `npx prisma migrate deploy` before aggregate QA or rollback rehearsal.

Phase 7 documentation changes:
- `docs/market-ranking-monitoring-plan.md` specifies required metrics, dashboard filters, alert thresholds, log fields, fallback tracking, suppression violation monitoring, empty-section monitoring, repeated-item monitoring, brand concentration monitoring, aggregate read monitoring, signal ingest/dedupe monitoring, and owner placeholders;
- `docs/market-ranking-rollback-rehearsal.md` specifies the QA/UAT rehearsal prerequisites, flag sequence, deterministic fallback expectations, aggregate read failure simulation plan, suppression verification, empty-section fallback verification, cache checks, owner placeholders, and pass/fail criteria;
- `docs/market-ranking-release-plan.md` and `docs/market-signal-aggregation-qa-checklist.md` now include Phase 7 status and remaining operational blockers.

Ready for ranking implementation: **No**. Phase 7 closes documentation for monitoring and rollback rehearsal only. Remaining blockers are applying QA/UAT migrations, provisioning monitoring/alerts, replacing owner placeholders, executing and passing rollback rehearsal, and then implementing ranking behind disabled-by-default flags.

## Phase 7 operational readiness verification result - 2026-05-24

Phase 7 operational verification confirmed:
- backend `npx prisma validate` and `npx prisma generate` pass;
- local `npx prisma migrate status` still reports pending aggregate migrations:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- migration files are committed and present in `prisma/migrations`;
- ranking remains disabled by default through `MarketRankingConfigService`;
- `/market/sections` and `/market/sections/:key` still serve deterministic fallback output;
- aggregate tables are not read for served market ordering;
- suppression filtering and private/no-store cache headers remain covered by focused tests;
- web market code does not claim personalized sections and tolerates dedupe/aggregation response fields;
- mobile market signal queue remains bounded and does not assume ranked output.

Monitoring audit:
- backend has request ID HTTP logging, structured request duration logs, optional Prisma slow-query logs, and a review observability precedent;
- no market ranking dashboard, alert integration, shared metrics sink, or `Server-Timing` instrumentation is implemented;
- no QA manual monitoring substitute is accepted by default.

Ready for ranking implementation: **No**. Remaining blockers are QA/UAT migration application, monitoring/alert readiness or explicitly approved manual QA substitute, owner assignment, and passed rollback rehearsal.

## Phase 7 local MVP readiness simulation result - 2026-05-25

Phase 7 corrected the earlier external QA/UAT assumption for the current solo MVP workflow and ran a local readiness simulation.

Verified locally:
- backend, web, and mobile were clean on `main` before work;
- local database target `localhost:5432/threadly/public` was reachable;
- `npx prisma validate` and `npx prisma generate` passed;
- a current local `pg_dump` restore point was created under ignored `backups/`;
- initial local migration status reported the two aggregate migrations pending;
- stale local Prisma advisory-lock sessions were terminated safely without destructive reset;
- `npx prisma migrate deploy` applied both aggregate migrations;
- final local migration status reports the database schema is up to date;
- `/market/sections` and `/market/sections/fresh-drops` still return deterministic/non-personalized metadata;
- ranking enabled before implementation, on an isolated local process, still returned deterministic fallback;
- guest product suppression still filtered the target from fresh drops;
- cache headers remained private/no-store.

Ready for ranking implementation locally: **Yes**.

Scope limit:
- this is local MVP simulation only;
- it is not external QA/UAT approval;
- it is not production monitoring approval;
- it is not enterprise governance sign-off;
- ranking remains disabled and not live.

## Phase numbering reconciliation result - 2026-05-25

The feed/market roadmap now uses normal phase numbers for future work. Temporary `R` labels are retained only as historical traceability in the roadmap.

Corrected status evidence:
- Phase 3 is **IMPLEMENTED**: Prisma schema, migration `20260524150000_add_market_signal_idempotency_aggregation`, `MarketSignalBatchReceipt`, `MarketSignalAggregateDaily`, `MarketSignalService`, `MarketSignalAggregationService`, web `clientEventId` emission, and mobile `src/services/marketSignals.ts` all exist.
- Phase 4 is **IMPLEMENTED** for aggregate schema/key hardening: migration `20260524170000_widen_market_signal_aggregate_key` widens `MarketSignalAggregateDaily.aggregateKey` to `VARCHAR(512)`, and aggregate tests cover max-length key behavior.
- Phase 5 is **DOCS ONLY**: `docs/market-ranking-release-plan.md` and `docs/market-signal-aggregation-qa-checklist.md` define migration QA, release flags, rollback, monitoring, and Redis/BullMQ gates, but do not change runtime ordering.
- Phase 6 is **IMPLEMENTED**: `src/market/market-ranking-config.service.ts` and focused tests provide disabled-by-default ranking flags, deterministic fallback, safe clamping, section-key normalization, and no aggregate ordering reads.
- Phase 7 is the local MVP readiness simulation that applied aggregate migrations locally and validated fallback/suppression/cache behavior without making ranking live.
- Phase 8 is backend aggregate ranking behind disabled-by-default safety flags.
- Phase 8B is the workspace safety gate after backend ranking.
- Phase 9 is web/mobile ranking metadata contract integration.

Next normal phase:
- Phase 10 is Market section View All and pagination hardening.
- Phase 10 has not started.
