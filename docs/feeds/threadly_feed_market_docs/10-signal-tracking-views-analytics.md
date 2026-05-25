# Signal Tracking, Views, and Analytics

## Phase 0 alignment note - 2026-05-23

- Backend has product view counting, but no feed/market/suggestion signal models were found.
- Backend has a collection `View` model, but no general seen-item, suppression, dwell, section impression, suggestion impression, or ranking feedback model.
- Mobile `trackMobileEvent` currently defaults to no-op and logs only when analytics is enabled/debugged; there is no durable queue or AppState flush.
- Web hidden content is localStorage-backed; this does not provide cross-device suppression or ranking feedback.
- Search requests have cancellation support; market/detail requests generally need signal propagation before batched signal work begins.

Phase 2 added bounded backend batch ingestion and web flush behavior. Phase 3 added DB-backed idempotency receipts, client event IDs, daily aggregate counters, and mobile runtime flushing. Redis/BullMQ remains deferred for the market signal path until deployment config can support it safely. Signals must stay bounded, privacy-aware, and safe to drop without breaking user flows.

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
- clientEventId
- batchId
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
- clientEventId
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
- clientEventId
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
- clientEventId
- createdAt
```

```text
MarketSignalBatchReceipt
- id
- userId nullable
- anonymousSessionId nullable
- batchId
- received
- persisted
- createdAt
```

```text
MarketSignalAggregateDaily
- aggregateKey
- bucketDate
- userId nullable
- anonymousSessionId nullable
- surface
- sectionKey
- suggestionBlockKey
- targetType
- targetId
- sectionImpressions
- itemImpressions
- productOpens
- itemOpens
- clicks
- viewAllClicks
- suppressions
- seenItems
- eventCount
- latestSeenAt
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
- Redis optional only for local/non-critical fallback paths;
- for market signal ingestion Phase 3 uses synchronous DB aggregation behind a service abstraction; Redis/BullMQ is not forced without safe runtime config;
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
- metadata max: 2048 UTF-8 bytes, rejected when exceeded;
- target/session IDs max: 128 chars;
- section/suggestion keys max: 80 chars.

Implemented semantics:
- authenticated identity is server-derived from the request, not accepted from the client body;
- guest clients must send `anonymousSessionId`;
- seen records are created for impression/view/open-style item events;
- suppression records can target items, brands, categories, sections, and suggestion blocks;
- market section output excludes active matching suppressions where section DTO metadata supports it;
- Phase 2 accepted `batchId` for traceability only; Phase 3 adds durable duplicate batch replay checks.

Deferred:
- Redis/BullMQ async signal queue;
- daily aggregate jobs;
- taste/profile updates;
- seen-content ranking dedupe;
- mobile durable queue and AppState flush;
- suggestion block runtime instrumentation.

## Phase 3 implemented foundation - 2026-05-24

Implemented now:
- optional `clientEventId` on signal events for durable client-side event identity;
- `MarketSignalBatchReceipt` to skip duplicate batch replays for the same authenticated user or anonymous session;
- service-level dedupe for duplicate `clientEventId` values inside one batch and recently persisted client event IDs;
- `MarketSignalAggregateDaily` for daily section impression, item impression, open, click, view-all, suppression, and seen counters;
- bounded synchronous aggregation after raw signal writes;
- mobile runtime signal queue with 100-event memory cap, 25-event flush batches, 5-second interval flush, AppState background/inactive flush, unmount flush, and bounded retry on network failure;
- web signal events now include client event IDs.

Not implemented:
- signal-driven ranking or personalized ordering;
- Redis/BullMQ market signal producer/consumer;
- durable persisted mobile offline queue;
- admin ranking governance UI;
- suggestion engine ranking.

Phase 3 idempotency is practical but not absolute: `batchId` replay protection is durable through `MarketSignalBatchReceipt`; `clientEventId` duplicate checks are bounded to a recent replay window; events without client IDs are deduped only inside the current batch by fingerprint.

## Phase 11A suggestion signal contract - 2026-05-25

Phase 11A is a contract gate only. It confirms that the existing signal foundation can support future context-aware market suggestion blocks, but no suggestion endpoint or suggestion UI block is live yet.

Existing enum support in `prisma/schema.prisma`:
- `MarketSignalSurface.SUGGESTION_BLOCK`;
- `MarketSignalTargetType.SUGGESTION_BLOCK`;
- `MarketSignalType.SUGGESTION_BLOCK_VIEW`;
- `MarketSignalType.SUGGESTION_ITEM_VIEW`;
- `MarketSignalType.SUGGESTION_ITEM_CLICK`;
- `MarketSignalType.SUGGESTION_ITEM_WISHLIST`;
- `MarketSignalType.SUGGESTION_ITEM_CART_ADD`;
- `MarketSignalType.SUGGESTION_ITEM_HIDE`;
- `MarketSignalType.SUGGESTION_BLOCK_HIDE`;
- `MarketSignalType.SUGGESTION_VIEW_ALL_CLICK`.

Phase 11B should use this mapping:

| Suggestion interaction | Existing signal |
|---|---|
| block becomes visible | `SUGGESTION_BLOCK_VIEW` |
| item becomes visible | `SUGGESTION_ITEM_VIEW` |
| item opens | `SUGGESTION_ITEM_CLICK` |
| item hide/not interested | `SUGGESTION_ITEM_HIDE` plus a suppression record |
| block dismissed | `SUGGESTION_BLOCK_HIDE` plus a suggestion-block suppression when supported |
| block View All clicked | `SUGGESTION_VIEW_ALL_CLICK` |
| item wishlist action | `SUGGESTION_ITEM_WISHLIST` |
| item cart/bag action | `SUGGESTION_ITEM_CART_ADD` |

DTO/enum gap to resolve in Phase 11B:
- the product prompt uses `SUGGESTION_ITEM_OPEN` and `SUGGESTION_DISMISS`;
- the current codebase uses `SUGGESTION_ITEM_CLICK` and `SUGGESTION_BLOCK_HIDE`;
- Phase 11B should prefer the existing enum names unless a migration for additional aliases is justified.

Suggestion signal payload rules:
- include `suggestionBlockKey` for every suggestion block/item event;
- include `sectionKey` only when the suggestion appears inside market section context;
- keep `screenContext` aligned with `PRODUCT_DETAIL`, `COLLECTION_DETAIL`, `BRAND_DETAIL`, `SEARCH_EMPTY`, or `MARKET_SECTION_DETAIL`;
- keep metadata below the existing 2048-byte limit;
- never include raw search secrets, payment data, or private user notes in metadata;
- batch through the existing `POST /market/signals/batch` endpoint.

## Phase 11B suggestion signal runtime - 2026-05-25

Phase 11B reuses the existing batched signal endpoint and does not add a separate suggestion event endpoint.

Implemented web events:
- suggestion block visible: `SUGGESTION_BLOCK_VIEW`;
- suggestion item visible: `SUGGESTION_ITEM_VIEW`;
- suggestion item opened: `SUGGESTION_ITEM_CLICK`;
- suggestion item hidden: `SUGGESTION_ITEM_HIDE` plus `POST /market/suppressions`.

Client behavior:
- `MarketSuggestionBlocks` uses the existing bounded `useMarketSignals` queue;
- events include `suggestionBlockKey`;
- stale suggestion requests are aborted on unmount or parameter change;
- empty or failed suggestion responses do not block the parent detail/search page.

Backend behavior:
- `SuggestionSignal` rows remain populated through `POST /market/signals/batch`;
- suppression records can filter future suggestion candidates through `MarketSuppressionService`;
- no aggregate-driven suggestion ranking is implemented in Phase 11B.

## Phase 4 aggregate QA result - 2026-05-24

Phase 4 did not activate ranking. It validated the Phase 3 pipeline and added a design gate for future ranking.

Confirmed by tests:
- raw signal batches still persist accepted events;
- duplicate `clientEventId` values in one batch are skipped;
- duplicate `batchId` replays are skipped when a receipt exists;
- events without client IDs are fingerprint-deduped inside the same batch;
- section impressions, item impressions, product opens, View All clicks, suppressions, seen counts, and latest seen timestamps aggregate into daily UTC buckets;
- anonymous aggregate buckets stay separate from authenticated user buckets;
- reset markers do not delete raw signals, seen rows, suppressions, or global aggregate counters.

Readiness fix:
- `MarketSignalAggregateDaily.aggregateKey` was widened from `VARCHAR(320)` to `VARCHAR(512)` because max-length anonymous session, section key, suggestion block key, target type, and target ID values can exceed the original 320-character budget.

Still not implemented:
- feed or market personalization;
- aggregate-driven reordering;
- Redis/BullMQ market signal worker;
- ranking profile/formula admin governance.

## Phase 5 release-gate result - 2026-05-24

Phase 5 does not change signal capture, aggregation, or ranking behavior. It defines the release controls required before aggregates can influence ordering.

Confirmed:
- raw signals and aggregate counters remain a future-ranking foundation only;
- aggregate tables are not read by market section ordering;
- suppression and reset semantics remain unchanged;
- the two aggregate migrations must be applied in QA/UAT before aggregate QA is complete.

Release controls now documented:
- ranking feature flags must default to disabled;
- shadow mode must run before served ranking;
- deterministic fallback must remain available on every ranked request;
- signal ingestion may continue during rollback only while healthy;
- aggregate-driven reads must stop when the kill switch is off;
- Redis/BullMQ remains deferred until the thresholds in `docs/market-ranking-release-plan.md` require queue adoption.
