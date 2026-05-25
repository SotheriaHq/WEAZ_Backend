# Edge Cases and Fallbacks

## Phase 0 alignment note - 2026-05-23

- New/anonymous users: backend feed currently works chronologically without personalization; keep that as the non-personalized fallback while ranked profiles mature.
- Empty categories: `collections/market` category is not wired through the controller, and product category filtering is collection-membership based. Phase 1 must avoid empty screens caused by taxonomy mismatch.
- Slow network: web market currently risks large client loads; replace with small section previews and cursor-backed View All before adding heavier ranking.
- Redis unavailable: product view counting falls back to in-process buffers, but BullMQ queues require Redis. Signal ingestion design must explicitly state what degrades locally and what requires Redis.
- App background: mobile has AppState-driven query focus and bagging behaviors, but no dwell/signal queue exists to flush or clear yet.
- Auth missing: patch, save, bag, hide, and preference controls must gracefully require sign-in without blocking public browsing.

## Launch and low-data cases

| Scenario | Required behavior |
|---|---|
| First user opens app | show newest published content |
| Less than 5 users | no personalization dependency; use newest + seeded shuffle |
| No products/designs | empty state with brand upload CTA |
| No signals | hide For You; show Discover/Explore |
| User finishes all content | caught-up state + fallback refresh |
| SIT/test small dataset | allow controlled repeat after caught-up notice |

## Category/section config cases

| Scenario | Required behavior |
|---|---|
| Admin archives default category | block unless replacement default selected |
| Category has no data | fallback category |
| Section has no data | hide or fallback |
| Section removed mid-session | existing loaded items stay; next refresh uses new config |
| Formula invalid | save draft only; cannot publish |
| Formula version changes | new sessions use new version |
| Old link to archived category | redirect to Discover/Explore |
| Old link to paused section | friendly fallback |

## User interaction cases

| Scenario | Required behavior |
|---|---|
| User blocks visible brand | remove items immediately |
| User hides suggestion block | do not show block again for configured window |
| User opens hidden item link | show hidden warning + undo |
| User resets feed | current session continues; next fetch uses reset |
| Guest logs in mid-scroll | preserve current items; next page uses identity |
| User denies location | use non-location ranking |
| User has too many suppressions | broaden fallback pool |

## Market cases

| Scenario | Required behavior |
|---|---|
| Product sold out after feed loaded | mark sold out; suppress future ranking |
| Product archived/deleted after suggestion loaded | remove gracefully |
| Brand closes store | products/suggestions hidden |
| Custom-order out of stock | show only where custom-order eligible |
| Product lacks image | exclude from visual sections |
| Collection empty | do not show collection card |
| New brand has no sellable items | no fairness boost |

## Suggestions

| Scenario | Required behavior |
|---|---|
| Main content already shows product | exclude from suggestions |
| Suggestion duplicates another block | exclude from later block |
| Guest user | generic trending/fresh |
| Product detail has no similar items | fallback to Fresh Drops/New Designers |
| Complete the Look has insufficient complements | hide block |
| User hides suggestion item | suppress item |
| User hides suggestion block | suppress block/context |

## Phase 11A suggestion fallback contract - 2026-05-25

Phase 11A defines the fallback rules for Phase 11B. Runtime suggestion behavior is still pending.

| Scenario | Phase 11B required behavior |
|---|---|
| Unsupported suggestion context | return controlled 400 and do not affect the parent screen |
| Missing required target for detail context | return controlled 400 or an empty safe response, depending on existing controller pattern |
| Product/collection/brand target not found | return empty `blocks` or controlled 404 without breaking primary detail content |
| Current target would appear in suggestions | exclude it |
| Candidate has no usable media | exclude it from visual blocks |
| Candidate is archived, deleted, inactive, closed-store, or unavailable | exclude it |
| User or guest suppresses item/brand/category/block | exclude matching candidates or block |
| All candidates are suppressed | return empty block items or hide the block |
| Search-empty query is too narrow | relax to category/tag/fresh fallback |
| Search-empty query is blank | do not call market suggestions; use existing search suggestions/default prompt |
| Duplicate candidate appears in multiple blocks | keep earliest block placement and exclude from later blocks where feasible |
| Suggestion endpoint is slow/fails | hide block or show local retry; never block product/detail/search page rendering |
| Invalid cursor | controlled 400 or safe empty page, never server crash |
| Oversized limit | clamp to Phase 11B backend maximum |
| Ranking flags are off | deterministic context/fallback strategy only |
| Aggregate data missing | deterministic fallback strategy only |

## Network and performance

| Scenario | Required behavior |
|---|---|
| Signal API fails | queue locally, do not block UI |
| Suggestion API fails | hide block or show retry |
| Section API slow | show skeleton; timeout to fallback |
| Duplicate cursor request | stable response, no duplicates |
| Route changes during fetch | cancel request |
| Component unmount | clear observers/timers |

## Admin governance

| Scenario | Required behavior |
|---|---|
| Unauthorized admin attempts edit | deny and log |
| Admin saves bad weight config | reject with validation |
| Super admin rollback formula | new sessions use previous version |
| Missing fallback after deletion | block publish |

## Phase 2 edge-case handling - 2026-05-24

Implemented:
- signal API is batch-based, so the web client does not send one request per impression;
- web signal failures requeue the current batch within the bounded in-memory queue and do not block rendering;
- web observers disconnect on unmount;
- web flushes queued signals on interval, visibility hidden, pagehide, and cleanup;
- guest signals/suppressions fail closed unless `anonymousSessionId` is present;
- suppressing an item removes it locally immediately and restores the previous local state if the backend call fails;
- market section responses remain private/no-store and exclude active suppressions without enabling personalization ranking.

Still deferred:
- server-side queue retry/dead-letter handling;
- suppression-aware fallbacks when a user hides so much content that a section becomes empty;
- hidden-item link warning and restore flow.

## Phase 3 edge-case handling - 2026-05-24

Implemented:
- mobile now has a bounded runtime signal queue that flushes every 5 seconds, on background/inactive AppState, and on MarketScreen unmount;
- mobile signal failures requeue the current batch at the front of the bounded 100-event memory queue, so failed calls do not block browsing or create unbounded memory growth;
- mobile queue is not persisted across process death; this avoids adding a risky storage dependency before a deliberate durable offline design;
- duplicate `clientEventId` values in one backend batch are skipped;
- duplicate `batchId` replays for the same user/session are skipped using `MarketSignalBatchReceipt`;
- reset behavior is explicit: it records a reset marker but does not delete raw signals, seen items, suppressions, or global aggregates.

Still deferred:
- Redis/BullMQ market signal retry/dead-letter handling;
- persisted offline mobile queue;
- hidden-item deep-link warning and restore flow;
- suppression-aware content broadening when a user hides enough content to empty a section.

## Phase 4 readiness edge cases - 2026-05-24

Validated or documented:
- Phase 3 aggregate migration must be applied in QA/UAT before aggregate QA can be trusted;
- local migration apply may remain blocked by a Postgres advisory lock, so destructive reset must not be used just to unblock it;
- aggregation failure must not block raw signal persistence or market rendering;
- aggregate keys must fit the schema budget for max-length session, section, block, and target values;
- reset must not destroy global counters shared by the platform;
- anonymous aggregate data must not attach to a logged-in user without an accepted merge design;
- ranked output must fall back to deterministic Phase 1 section ordering if aggregate reads fail.

Still deferred:
- concurrent duplicate batch replay hardening under true race conditions;
- queued retry/dead-letter handling;
- aggregate-driven ranking rollout and rollback controls.

## Phase 5 release-gate fallbacks - 2026-05-24

Documented before ranking implementation:
- ranking must be disabled by default;
- deterministic Phase 1 section ordering must remain the fallback when ranking flags are off, aggregate reads fail, or latency exceeds threshold;
- rollback must keep suppression filters active;
- rollback must not delete raw signals, seen rows, suppressions, reset markers, or global aggregate counters;
- empty-section spikes, repeated item spikes, one-brand domination, suppressed content appearing, aggregate query failures, user complaints, or error-rate increases must trigger rollback review;
- signal ingestion can remain active during rollback only if it is healthy and not increasing database risk.

Still deferred:
- code-level ranking feature flags;
- ranking shadow-mode implementation;
- production monitoring dashboards and alerts;
- Redis/BullMQ market signal worker and dead-letter handling.

## Phase 10 View All and pagination edge cases - 2026-05-25

Implemented:
- malformed section detail cursors are rejected with a controlled bad request instead of reaching Prisma;
- stale Prisma cursors are translated into a controlled bad request instead of a server crash;
- oversized section detail limits are clamped to the backend maximum;
- unsupported section keys continue to return a controlled not-found response;
- empty section detail responses return an empty `items` array with safe pagination metadata;
- suppressions continue to filter section detail output where safe;
- web View All requests are aborted on route change/unmount;
- web Load More de-duplicates returned items and stops when `hasNextPage=false`;
- web section detail keeps neutral copy and does not claim personalization.

Still deferred:
- hidden-item deep-link warning and restore flow;
- dedicated mobile section detail screen;
- scroll restoration for web section detail after returning from product detail;
- virtualized long section detail grids if future page sizes increase.
