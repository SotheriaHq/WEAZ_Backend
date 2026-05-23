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

Current behavior:
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
| Web loads up to 4800 products | `MARKET_LOAD_MAX_ROWS = 4800` | latency, memory, CPU | backend paginated sections |
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
- Phase 1 remains blocked until the Phase 0B canonical docs commit is pushed to `origin/main`.

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
- `MarketPlace.tsx` still implements the high-risk `120 x 40 = 4800` max-row client aggregation pattern.
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
- Web market must be refactored before personalization, because the current 4800-row client aggregation pattern is not a safe foundation.

### Unvalidated assumptions

- Production Redis availability, SLA, memory limits, and eviction policy are not confirmed from repo files.
- Final Terms/Privacy wording was not found in this audit.
- Any external analytics vendor contract is not configured in the inspected mobile analytics client.
- Real production data distribution for categories, store collections, standalone products, and design media readiness is not known from code alone.

### Blockers before Phase 1

- Move or register the feeds docs pack inside a Git repository so Phase 0 documentation changes can be committed and pushed.
- Decide whether `collections/market` should expose category filtering in Phase 1 or whether category filtering moves only to the new section endpoint.
- Define the backend section DTO before web/mobile implementation to prevent a second round of platform drift.
- Add or confirm Redis production availability before using Redis for seen/suppression/rate/counter workloads beyond optional local fallbacks.

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
