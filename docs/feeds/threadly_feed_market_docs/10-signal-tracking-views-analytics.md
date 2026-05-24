# Signal Tracking, Views, and Analytics

## Phase 0 alignment note - 2026-05-23

- Backend has product view counting, but no feed/market/suggestion signal models were found.
- Backend has a collection `View` model, but no general seen-item, suppression, dwell, section impression, suggestion impression, or ranking feedback model.
- Mobile `trackMobileEvent` currently defaults to no-op and logs only when analytics is enabled/debugged; there is no durable queue or AppState flush.
- Web hidden content is localStorage-backed; this does not provide cross-device suppression or ranking feedback.
- Search requests have cancellation support; market/detail requests generally need signal propagation before batched signal work begins.

Phase 2 added bounded backend batch ingestion and web flush behavior. Mobile durable/offline queueing and server-side async queue hardening remain deferred. Signals must stay bounded, privacy-aware, and safe to drop without breaking user flows.

## Signal principles

- Signals must never block scrolling or primary rendering.
- Signals should be batched where possible.
- Signal capture should work for guest session and authenticated user.
- Guest signals should be session-scoped unless consent/account exists.
- Signals should be used for scoring, analytics, suppression, and QA.

## Required models

```text
UserFeedSignal
- id
- userId nullable for guest
- anonymousSessionId nullable
- targetType
- targetId
- signalType
- value
- sectionKey
- suggestionBlockKey
- screenContext
- sessionId
- createdAt
```

```text
UserSeenItem
- id
- userId nullable
- anonymousSessionId nullable
- targetType
- targetId
- surface
- sectionKey
- suggestionBlockKey
- seenAt
- sessionId
```

```text
MarketSectionSignal
- id
- userId nullable
- sectionKey
- signalType
- value
- screenContext
- sessionId
- createdAt
```

```text
SuggestionSignal
- id
- userId nullable
- blockKey
- targetType
- targetId
- signalType
- value
- screenContext
- sessionId
- createdAt
```

## Feed signals

| Signal | Meaning |
|---|---|
| IMPRESSION | Item returned/rendered |
| VIEW | Item visible past threshold |
| DWELL_SHORT | 1.5–3s |
| DWELL_MEDIUM | 3–6s |
| DWELL_LONG | 6s+ |
| SCROLL_SKIP | <1.5s or fast velocity |
| LIKE | like/reaction |
| SAVE | save/wishlist |
| COMMENT | comment |
| THREAD | thread participation |
| SHARE | share/send |
| PROFILE_TAP | brand/user profile tap |
| PRODUCT_VIEW | product detail view |
| ADD_TO_CART | cart action |
| PURCHASE | purchase completion |
| HIDE | hidden content |
| NOT_INTERESTED | negative preference |

## Market section signals

| Signal | Meaning |
|---|---|
| MARKET_SECTION_VIEW | section visible |
| MARKET_SECTION_SCROLL | horizontal scroll inside section |
| MARKET_SECTION_VIEW_ALL_CLICK | opens section detail |
| MARKET_SECTION_DETAIL_VIEW | lands on View All |
| MARKET_SECTION_DETAIL_SCROLL | scrolls detail |
| MARKET_SECTION_DISMISS | hides section |
| MARKET_SECTION_BACK_TO_HOME | returns to market home |

## Suggestion signals

| Signal | Meaning |
|---|---|
| SUGGESTION_BLOCK_VIEW | block became visible |
| SUGGESTION_ITEM_VIEW | item in block visible |
| SUGGESTION_ITEM_CLICK | item opened |
| SUGGESTION_ITEM_WISHLIST | wishlist action |
| SUGGESTION_ITEM_CART_ADD | cart action |
| SUGGESTION_ITEM_HIDE | item hidden |
| SUGGESTION_BLOCK_HIDE | block hidden |
| SUGGESTION_VIEW_ALL_CLICK | suggestion detail opened |

## Existing view counter integration

Current ProductViewCounterService is useful for buffered product view count increments. It should remain for aggregate product `viewsCount`, but should not be the only analytics mechanism.

Required upgrade:
- keep lightweight counter for product `viewsCount`;
- add append/event signals for recommendation intelligence;
- periodically aggregate signals into summary tables.

## Aggregates

Avoid computing ranking from raw event tables on every request.

Recommended aggregate tables:
- `ProductSignalAggregateDaily`
- `DesignSignalAggregateDaily`
- `BrandSignalAggregateDaily`
- `MarketSectionAggregateDaily`
- `SuggestionBlockAggregateDaily`
- `UserTasteProfile`
- `UserBrandAffinity`
- `UserCategoryAffinity`

## Memory leak prevention

Web:
- disconnect `IntersectionObserver` on unmount;
- flush open dwell timers on unmount;
- cancel pending suggestion requests on route change;
- avoid observing duplicate DOM nodes.

Mobile:
- clear intervals in `useEffect` cleanup;
- flush visible item timers on background;
- cancel stale fetches;
- avoid nested FlatLists without fixed dimensions where possible.

Backend:
- clear timers on module destroy;
- cap in-memory buffers;
- Redis optional, not required;
- never use unbounded maps keyed by user/session without TTL.

## Phase 2 implemented foundation - 2026-05-24

Implemented models:
- `UserFeedSignal`
- `UserSeenItem`
- `MarketSectionSignal`
- `SuggestionSignal`
- `UserContentSuppression`
- `PersonalizationReset`

Implemented endpoints:
- `POST /market/signals/batch`
- `POST /market/suppressions`
- `GET /market/suppressions`
- `DELETE /market/suppressions/:id`
- `POST /user/preferences/feed/reset`

Implemented limits:
- backend signal batch max: 50 events;
- web in-memory queue max: 100 events;
- web client flush batch max: 25 events;
- web interval flush: 5 seconds;
- metadata max before pruning: 2048 UTF-8 bytes;
- target/session IDs max: 128 chars;
- section/suggestion keys max: 80 chars.

Implemented semantics:
- authenticated identity is server-derived from the request, not accepted from the client body;
- guest clients must send `anonymousSessionId`;
- seen records are created for impression/view/open-style item events;
- suppression records can target items, brands, categories, sections, and suggestion blocks;
- market section output excludes active matching suppressions where section DTO metadata supports it;
- `batchId` is accepted for traceability, but strict duplicate-batch idempotency is deferred.

Deferred:
- Redis/BullMQ async signal queue;
- daily aggregate jobs;
- taste/profile updates;
- seen-content ranking dedupe;
- mobile durable queue and AppState flush;
- suggestion block runtime instrumentation.
