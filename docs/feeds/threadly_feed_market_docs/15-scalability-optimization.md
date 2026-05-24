# Scalability and Optimization

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
- long View All grids still need dedicated web/mobile virtualization;
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
- virtualize long View All grids;
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
