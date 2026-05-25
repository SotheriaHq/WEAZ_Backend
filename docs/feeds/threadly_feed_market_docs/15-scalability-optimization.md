# Scalability and Optimization

## Phase 11C suggestion UI scalability - 2026-05-25

- Web brand/store suggestions reuse the lazy `MarketSuggestionBlocks` component instead of loading catalog-wide data in the browser.
- Mobile product, collection, and search-empty suggestions use one bounded rail component with a default limit of 6 items per request.
- Mobile collection suggestions are a FlatList footer with horizontal rails only; Phase 11C does not introduce nested vertical lists or a MarketScreen migration.
- Suggestion failures do not trigger parent screen refetch loops.
- The mobile signal queue remains the existing bounded in-memory runtime: no persisted offline queue or extra background worker was added.

## Phase 0 alignment note - 2026-05-23

- The Phase 0 web `MarketPlace.tsx` 4800-row load pattern was the highest immediate scalability risk.
- Product market supports cursor pagination, but web currently aggregates many pages before rendering the main experience.
- Design feed cursor pagination exists, but ranking is chronological and category wiring is incomplete.
- Product/detail suggestions should not issue N+1 requests. Use server-side relation includes/joins or batched `in` queries.
- Redis should be treated as required for production-scale queues, shared counters, seen/suppression sets, and rate/cooldown state. In-process fallbacks are acceptable only for local/dev or non-critical counters.
- Personalized responses must use cache keys that include viewer context or must be marked private/no-store. Shared CDN caching is unsafe for personalized payloads.

Phase 1 performance target: section preview payloads should be small, cursor-backed, and render without loading the full catalog into the client.

## Phase 1 scalability result - 2026-05-24

- Web `MarketPlace.tsx` no longer uses the 120 x 40 / 4800-row product aggregation loop as the primary market home data path.
- Primary web market home load is now `GET /market/sections`.
- Fallback product loading is capped to one `/store/products/market` request with `limit=24`.
- Web passes `AbortSignal` to the section request and fallback request so stale market home requests can be cancelled on unmount/navigation.
- Backend section preview/detail queries are bounded and return preview-card DTOs instead of full product/detail payloads.
- `/market/sections` and `/market/sections/:key` use `Cache-Control: private, no-store` until personalized/public cache boundaries are split deliberately.

Remaining scalability work:
- product market direct category filtering still needs deeper category semantics hardening;
- long View All grids still need dedicated mobile support and web virtualization if page sizes grow beyond bounded Load More;
- cross-section dedupe and diversity caps across the whole home response are not implemented yet;
- aggregate jobs and durable signal queue hardening are deferred to Phase 3+.

## Core performance principle

Do not move large candidate sets to the client for ranking. Backend should return ranked, paginated sections and suggestions.

## Current risk

Before Phase 1, the web Market page allowed loading up to 4800 products client-side. Phase 1 replaced the primary path with backend section previews and left only a bounded 24-product fallback.

## Backend optimization requirements

- Use cursor pagination.
- Use indexed filters.
- Do not rank all rows synchronously on every request.
- Use aggregate tables for signal-heavy metrics.
- Use lightweight deterministic scoring for V1.
- Precompute daily/hourly aggregates.
- Keep Redis optional for local/non-critical paths, but treat it as required before production queue scale.
- Avoid paid infra dependency.
- Use bounded query limits.
- Return minimal DTOs for previews.
- Hydrate detail only on detail page.

## Suggested endpoints

```text
GET /market/sections
GET /market/sections/:key
GET /market/suggestions
POST /market/signals
POST /market/suggestions/events
POST /market/suppressions
```

Phase 11A selected `GET /market/suggestions` as the shared market suggestion contract. `POST /market/suggestions/events` remains deferred because suggestion events can use the existing batched `POST /market/signals/batch` endpoint with suggestion signal types and `suggestionBlockKey`.

## Caching

| Layer | Strategy |
|---|---|
| Guest market sections | short TTL cache |
| Auth market sections | cache per user/session where safe |
| Ranking profiles | in-memory TTL + invalidation on admin publish |
| Category/section configs | in-memory TTL |
| Suggestions | lazy-load + short TTL |
| Signals | async/batched writes |
| Product views | keep buffered counter |

## Database indexes

Required likely indexes:
- product status/store visibility/category/gender/createdAt;
- product brandId/createdAt;
- product viewsCount/updatedAt for popular fallback;
- collection status/domain/visibility/updatedAt;
- signal targetType/targetId/createdAt;
- signal userId/createdAt;
- suppression userId/targetType/targetId;
- section aggregate sectionKey/date;
- suggestion aggregate blockKey/date.

## Client optimization

Web:
- no 4800-row aggregate load;
- lazy-load below-fold sections;
- use bounded cursor-backed View All pages before adding any long-grid virtualization;
- cancel stale requests;
- disconnect observers;
- preserve scroll state.

Mobile:
- use FlatList/FlashList patterns;
- fixed card dimensions;
- avoid nesting heavy scroll views where possible;
- lazy-load section rows;
- keep image caching stable;
- flush signals on app background.

## Memory leak prevention

- No unbounded Maps for dwell timers.
- No orphaned intervals.
- No persistent observers after unmount.
- No duplicate event listeners.
- No pending promises updating unmounted components.
- No server in-memory user cache without TTL and max size.

## Low-cost implementation

V1 must avoid paid recommendation APIs, heavy ML, paid geolocation services, external analytics as dependency, and full-text search replacement unless already available. Use PostgreSQL, Prisma, optional Redis, deterministic formulas, scheduled aggregates, browser APIs, and Expo APIs.

## Phase 2 scalability result - 2026-05-24

Implemented:
- signal writes are batched through `POST /market/signals/batch`;
- backend batch limit is 50 events;
- web queue is bounded to 100 events and flushes at 25 events per request;
- metadata above 2048 bytes is rejected instead of storing unbounded JSON;
- signal/suppression/reset tables have indexes for user/session, target, section, suggestion block, createdAt, brand, and expiry lookups;
- market section suppression lookup is capped and applied to bounded section DTO output;
- personalized/requester-aware market section responses remain `Cache-Control: private, no-store`.

Production hardening still required:
- move signal ingestion from direct bounded Prisma `createMany` into Redis/BullMQ or another durable queue;
- move synchronous aggregate updates to a worker/job path before using signal volume for ranking;
- harden idempotency with queue-level job IDs and monitoring;
- add mobile persistent queue only after choosing the storage abstraction;
- add monitoring for queue lag, DB write volume, and suppression table growth.

## Phase 3 scalability result - 2026-05-24

Implemented:
- raw signal ingestion remains batch-based and bounded;
- `clientEventId` and `MarketSignalBatchReceipt` reduce wasted duplicate writes from client retries and batch replays;
- `MarketSignalAggregateDaily` stores daily counter summaries for section impressions, item impressions, product opens, item opens, clicks, view-all clicks, suppressions, seen items, and total events;
- aggregation runs behind `MarketSignalAggregationService` and updates aggregate rows by stable `aggregateKey`;
- mobile MarketScreen now has a bounded runtime queue with AppState flush and low-risk section/item/open instrumentation;
- web signals now include client event IDs for backend idempotency.

Redis/BullMQ decision:
- existing backend queue infrastructure is Redis-backed and useful for worker-driven jobs, but Phase 3 did not add a market signal queue because the current market module does not have a safe dedicated queue/worker/runtime gate;
- the implemented fallback is synchronous DB aggregation after raw writes, with failures logged and raw signals retained;
- moving aggregation to Redis/BullMQ remains the next hardening step before using signal volume for ranking at production scale.

Still not implemented:
- signal-driven feed ordering;
- hourly aggregate rollups;
- queue lag monitoring;
- durable mobile offline storage;
- ranking profile cache invalidation.

## Phase 4 scalability readiness - 2026-05-24

Phase 4 keeps ranking disabled and validates whether aggregates are safe to depend on later.

Readiness updates:
- aggregate counter tests now cover section impressions, item impressions, opens, View All clicks, suppressions, seen counts, UTC daily buckets, anonymous/user separation, and reset retention;
- `aggregateKey` storage is widened to 512 characters to avoid max-length key failures;
- the QA checklist requires Phase 3 and Phase 4 migrations to be applied before aggregate UAT;
- ranking design must use aggregate tables, bounded candidate pools, hard suppression filters, diversity caps, and deterministic fallback.

Redis/BullMQ status:
- not implemented for market signals in Phase 4;
- still recommended before high-volume production ranking uses signal volume;
- current synchronous aggregation remains acceptable only as a bounded foundation and QA path.

## Phase 5 release scalability gate - 2026-05-24

Phase 5 keeps ranking disabled and defines the scalability controls required before aggregate-driven ranking can ship.

Implemented in documentation:
- `docs/market-ranking-release-plan.md` defines disabled-by-default ranking flags, shadow mode, deterministic fallback, rollout stages, rollback behavior, monitoring requirements, kill-switch behavior, and owner placeholders;
- `docs/market-signal-aggregation-qa-checklist.md` defines the exact aggregate migration order, backup requirement, deployment command, post-migration SQL checks, rollback guidance, advisory-lock handling, and destructive-reset warning.

Required before ranking:
- apply both aggregate migrations in QA/UAT with `npx prisma migrate deploy`;
- prove deterministic fallback when ranking flags are disabled or aggregate reads fail;
- monitor `/market/sections` latency p50/p95/p99, aggregate read latency, aggregate query failures, empty section rate, fallback activation, suppression violations, signal ingestion, dedupe, aggregation failures, batch replays, repeated item rate, and brand concentration;
- replace owner placeholders for engineering, product, and QA rollback decisions.

Redis/BullMQ status:
- still deferred for the market signal path;
- current synchronous aggregation remains acceptable only for bounded QA and low-volume shadow mode;
- queue/worker adoption becomes mandatory before high-volume ranking if signal volume, latency, database load, aggregate failures, or personalized-section count exceeds the thresholds in `docs/market-ranking-release-plan.md`.

## Phase 6 fallback scalability guard - 2026-05-24

Phase 6 adds code-level ranking flags without changing market query behavior.

Confirmed:
- ranking flags do not add aggregate reads to `/market/sections` or `/market/sections/:key`;
- deterministic V1 section queries remain the only served ordering path;
- invalid flag values fall back or clamp safely;
- section-key allowlists are normalized and bounded before any future ranking implementation can consume them.

Remaining scalability blockers before ranking:
- apply pending aggregate migrations in QA/UAT;
- add monitoring for aggregate read latency and fallback activation;
- keep Redis/BullMQ deferred until the release-plan thresholds require queue adoption.

## Phase 7 operational scalability gate - 2026-05-24

Phase 7 keeps ranking disabled and documents the operational controls required before aggregate-driven ranking can be implemented or enabled.

Implemented in documentation:
- `docs/market-ranking-monitoring-plan.md` defines dashboard requirements, alert thresholds, log fields, fallback activation tracking, suppression violation monitoring, empty-section monitoring, repeated-item monitoring, brand concentration monitoring, aggregate read latency monitoring, signal ingest/dedupe monitoring, and owner placeholders;
- `docs/market-ranking-rollback-rehearsal.md` defines the QA/UAT rehearsal sequence for proving deterministic fallback, suppression preservation, empty-section fallback, cache safety, and flag-based rollback behavior.

Confirmed:
- aggregate tables are still not read for served ordering;
- `/market/sections` and `/market/sections/:key` remain deterministic;
- Redis/BullMQ remains deferred for the market signal path;
- local migration status still reports the two aggregate migrations pending.

Remaining scalability blockers before ranking:
- apply pending aggregate migrations in QA/UAT with `npx prisma migrate deploy`;
- provision monitoring dashboards and alerts in the chosen observability stack;
- replace owner placeholders;
- execute and pass rollback rehearsal.

## Phase 7 operational scalability verification - 2026-05-24

Phase 7 operational verification keeps ranking disabled and confirms the scalability gate is still blocked on operations, not code-path ranking behavior.

Confirmed:
- market section routes still use bounded deterministic queries;
- aggregate tables are not read for served ordering;
- suppression filtering remains the only user-specific eligibility change in market section output;
- cache headers remain private/no-store;
- web and mobile clients do not require aggregate-ranked response fields.

Monitoring readiness:
- existing backend logging can supply request ID and coarse latency evidence;
- optional Prisma slow-query logging can support migration/aggregate QA investigation;
- no production-grade market ranking dashboard, alerting, metrics sink, or fallback activation metric exists yet.

Scalability gate remains blocked until:
- QA/UAT applies pending aggregate migrations;
- monitoring and alerting are provisioned or an owner-approved QA manual substitute is accepted;
- rollback rehearsal proves deterministic fallback under flag changes;
- owner placeholders are replaced.

## Phase 7 local MVP scalability simulation - 2026-05-25

Phase 7 validates only local MVP readiness.

Confirmed:
- aggregate migrations are now applied in the local database;
- deterministic market section queries remain the served ordering path;
- aggregate tables are still not read for served ordering;
- suppression filtering remains an eligibility filter only;
- cache headers remain private/no-store;
- local monitoring substitute is manual evidence capture using request IDs, request duration logs, Prisma slow-query logs when enabled, metadata capture, cache-header capture, item-ID capture, suppression evidence, and fallback evidence.

Scalability limitations:
- no production dashboard exists;
- no alert stack exists;
- no shared metrics sink exists;
- Redis/BullMQ remains deferred;
- local owner simulation does not replace production governance.

Local ranking implementation can start after validation because the local MVP gate passed, but production rollout remains blocked until hosted monitoring, alerting, backup/restore rehearsal, and real owner governance are revisited.

## Phase 8 aggregate ranking scalability note - 2026-05-25

Phase 8 introduces aggregate reads for market ranking only behind safety flags.

Scalability controls implemented:
- aggregate reader runs only when ranking is enabled, the section key is allowlisted, and deterministic fallback is enabled;
- aggregate lookup is bounded to current section candidate IDs;
- aggregate lookup uses explicit Prisma `select`;
- aggregate lookup uses a bounded lookback window;
- aggregate lookup has a timeout guard from `MARKET_RANKING_AGGREGATE_TIMEOUT_MS`;
- failures and timeouts return deterministic fallback instead of user-visible errors;
- ranking works on the already-bounded section candidate set and does not fetch thousands of products;
- brand diversity cap prevents a single brand from filling the ranked result when enough alternatives exist.

Still deferred:
- Redis/BullMQ market ranking workers;
- production metrics sink and dashboard;
- hosted alerting;
- server-side percentile latency counters;
- admin-managed ranking config;
- production rollout beyond local/MVP use.

Default production posture:
- ranking disabled;
- no section allowlist;
- shadow mode on;
- deterministic fallback on.

## Phase 10 View All scalability result - 2026-05-25

Implemented:
- web View All uses `GET /market/sections/:key` with `limit=24` and cursor-based Load More;
- web section detail appends de-duplicated items instead of loading every page at once;
- web section detail aborts stale requests on route change/unmount;
- backend section detail clamps limits to the server maximum of 60;
- backend rejects malformed cursors and translates stale Prisma cursors into controlled client errors;
- cache headers remain `private, no-store`;
- ranking remains disabled by default and no new aggregate ranking formula is introduced.

Still deferred:
- mobile dedicated section detail route/screen;
- web scroll restoration after product-modal/back navigation;
- virtualization if product teams later request larger page sizes or infinite scrolling;
- suggestions and admin governance.

## Phase 11A suggestion scalability contract - 2026-05-25

Phase 11A is documentation/contract only. It defines how Phase 11B should keep suggestions bounded and safe:

- use `GET /market/suggestions` with a small, clamped `limit`;
- reuse `MarketSectionItemDto`-aligned card fields instead of hydrating full product, collection, brand, or design detail payloads;
- use context-specific candidate pools, not full-catalog client-side ranking;
- query products, collections, brands, categories, and search data with explicit Prisma `select` or existing service DTOs;
- apply suppressions server-side before returning candidate blocks;
- exclude the current target and duplicate cards before pagination metadata is computed;
- use cursor pagination only for block View All/detail expansion;
- return `Cache-Control: private, no-store` while requester or anonymous-session suppressions affect output;
- allow the parent product/detail/search page to render before below-fold suggestion blocks load;
- batch suggestion impressions/clicks/hides through `POST /market/signals/batch`;
- keep mobile UI wiring conservative because `MarketScreen` still has local section composition and a local moodboard suggestion row.

Phase 11B must not:
- move large suggestion candidate sets to web/mobile;
- compute suggestion ranking from raw signal rows per request;
- add ML/embedding infrastructure;
- require Redis/BullMQ for the first low-volume deterministic implementation;
- claim full personalization from deterministic context matching.

## Phase 11B suggestion scalability result - 2026-05-25

Implemented:
- `GET /market/suggestions` uses small bounded candidate pools and clamps the effective limit to 12;
- backend product, collection, and brand candidates use explicit Prisma `select` projections instead of full-detail hydration;
- suggestion items reuse `MarketSectionItemDto`-aligned card fields;
- candidate queries fetch at most a small overfetch window for suppression/dedupe, not full catalog pages;
- web suggestion blocks lazy-load below primary product, collection, and search-empty content;
- web stale suggestion requests are aborted with `AbortController`;
- web suggestion impressions/clicks/hides reuse the existing bounded signal queue;
- mobile adds only API/types in Phase 11B to avoid introducing nested list risk before a dedicated mobile suggestion design pass.

Not implemented:
- Redis/BullMQ suggestion queue;
- aggregate-driven suggestion ranking;
- suggestion-specific cache layer;
- mobile persisted offline suggestion queue;
- production suggestion dashboard.
