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
