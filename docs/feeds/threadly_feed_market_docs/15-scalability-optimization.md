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
- Keep Redis optional.
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
- metadata is pruned above 2048 bytes instead of storing unbounded JSON;
- signal/suppression/reset tables have indexes for user/session, target, section, suggestion block, createdAt, brand, and expiry lookups;
- market section suppression lookup is capped and applied to bounded section DTO output;
- personalized/requester-aware market section responses remain `Cache-Control: private, no-store`.

Production hardening still required:
- move signal ingestion from direct bounded Prisma `createMany` into Redis/BullMQ or another durable queue;
- add aggregate jobs before using raw event tables for ranking;
- add strict batch idempotency when a durable queue/idempotency store is available;
- add mobile persistent queue only after choosing the storage abstraction;
- add monitoring for queue lag, DB write volume, and suppression table growth.
