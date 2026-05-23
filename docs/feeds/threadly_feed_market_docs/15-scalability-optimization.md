# Scalability and Optimization

## Phase 0 alignment note - 2026-05-23

- The web `MarketPlace.tsx` 4800-row load pattern is the highest immediate scalability risk.
- Product market supports cursor pagination, but web currently aggregates many pages before rendering the main experience.
- Design feed cursor pagination exists, but ranking is chronological and category wiring is incomplete.
- Product/detail suggestions should not issue N+1 requests. Use server-side relation includes/joins or batched `in` queries.
- Redis should be treated as required for production-scale queues, shared counters, seen/suppression sets, and rate/cooldown state. In-process fallbacks are acceptable only for local/dev or non-critical counters.
- Personalized responses must use cache keys that include viewer context or must be marked private/no-store. Shared CDN caching is unsafe for personalized payloads.

Phase 1 performance target: section preview payloads should be small, cursor-backed, and render without loading the full catalog into the client.

## Core performance principle

Do not move large candidate sets to the client for ranking. Backend should return ranked, paginated sections and suggestions.

## Current risk

The web Market page currently allows loading up to 4800 products client-side. This should be replaced with backend-ranked section APIs.

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
