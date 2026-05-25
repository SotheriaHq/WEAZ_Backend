# Market Section Engine

## Phase 0 alignment note - 2026-05-23

- Phase 0 found no shared backend market section endpoint.
- Backend product market compatibility endpoints were `GET /products/market` and alias `GET /store/products/market`; backend design feed was `GET /collections/market`.
- Phase 0 found web `MarketPlace.tsx` building sections client-side after loading up to 4800 products.
- Mobile `MarketScreen.tsx` builds a good local section model: hero, live themes, fresh row, moodboard row, latest collections, product grids, editorial cards, and custom-ready row.
- Phase 0 found View All was not a general backend-driven section route on either web or mobile.

Implementation standard: create the backend section contract first, then adapt web and mobile to the same DTO. Do not keep expanding local section builders as the primary architecture.

## Phase 1 implemented contract - 2026-05-24

Phase 1 added the first additive backend section foundation without replacing legacy endpoints.

Endpoints:

```text
GET /market/sections
GET /market/sections/:key?cursor=<cursor>&limit=<bounded-limit>
```

Cache policy:

```text
Cache-Control: private, no-store
```

Implemented sections:

| Key | Source | Layout | V1 ranking |
|---|---|---|---|
| `fresh-drops` | PRODUCT | HORIZONTAL_RAIL | `createdAt desc`, `id desc` |
| `hot-right-now` | PRODUCT | HORIZONTAL_RAIL | `viewsCount desc`, `threadsCount desc`, `createdAt desc`, `id desc` |
| `latest-collections` | COLLECTION | COLLECTION_RAIL | `createdAt desc`, `id desc` |
| `shop-by-style` | MIXED | CATEGORY_GRID | active category `order asc`, `slug asc` |
| `custom-ready` | PRODUCT | PRODUCT_GRID | custom-order products, `createdAt desc`, `id desc` |
| `new-designers-to-watch` | BRAND | BRAND_RAIL | open stores with marketable products, `createdAt desc`, `id desc` |

Response shape:

```text
MarketSectionsResponse
- generatedAt
- sections[]
- metadata.version = phase1.v1
- metadata.personalization = disabled
- metadata.cachePolicy = private-no-store

MarketSection
- key
- title
- subtitle
- emotionalLabel
- layout
- sourceType
- items[]
- viewAll.enabled
- viewAll.key
- viewAll.route
- viewAll.label
- pagination.limit
- pagination.hasNextPage
- pagination.nextCursor
- metadata.ranking = deterministic-v1
- metadata.personalization = disabled

MarketSectionItem
- id
- sourceId
- sourceType
- entityType
- title
- subtitle
- description
- brand
- media
- price
- priceRange
- availability
- category
- tags
- stats
- target
- createdAt
- updatedAt
```

Safety behavior:
- home response hides sections with no valid cards;
- detail response rejects unsupported keys with a controlled `404`;
- product cards require active, non-deleted, non-archived, marketable inventory/custom-order availability, open store, and usable image data;
- store collection cards require at least one visible product with usable media;
- brand cards require an open store with at least one marketable product and a logo or product image;
- duplicate item IDs are removed within each section response;
- preview/detail limits are bounded server-side.

Deferred:
- admin-managed section config;
- ranking profiles and formula versions;
- personalized For You;
- cross-section dedupe across the whole home response;
- mobile rendering migration to this contract.

## Phase 9 client ranking metadata contract - 2026-05-25

Phase 9 updates web and mobile clients to understand the Phase 8 section metadata without changing the visible market UI or enabling ranking by default.

Backend section metadata fields now supported by clients:

```text
MarketSection.metadata
- ranking: deterministic-v1 | aggregate-v1
- personalization: disabled | aggregate-contextual
- fallbackUsed: boolean
- fallbackReason: string | null
- rankingVersion: aggregate-v1 | null
- shadowMode: boolean
- rankingEnabled: boolean
- minimumItems: number
- previewItemLimit: number
```

Client handling rules:
- old section responses without ranking metadata must still render;
- `fallbackReason` and `rankingVersion` may be `null`;
- shadow mode must not be presented as served personalization;
- clients must not show personalized copy unless `ranking=aggregate-v1` and `personalization=aggregate-contextual`;
- mobile still keeps its local section-first MarketScreen rendering until a later backend-section migration phase;
- suggestions, admin governance UI, and new ranking formulas remain deferred.

## Phase 10 View All and pagination hardening - 2026-05-25

Phase 10 makes the existing section detail endpoint safe enough for web View All flows without enabling ranking by default or changing the market section ranking formula.

Backend detail contract:

```text
GET /market/sections/:key?cursor=<cursor>&limit=<bounded-limit>&anonymousSessionId=<guest-session>
```

Implemented behavior:
- `limit` is clamped server-side to the safe detail maximum of 60;
- empty or missing cursors are ignored;
- malformed cursors are rejected with a controlled bad request before Prisma is queried;
- stale Prisma cursors are translated into a controlled bad request instead of an internal server error;
- unsupported section keys still return the existing controlled not-found response;
- response pagination remains `pagination.limit`, `pagination.hasNextPage`, and `pagination.nextCursor`;
- section metadata keeps the Phase 8/9 ranking fields and remains backward compatible;
- active user or anonymous suppressions still filter section detail output where safe;
- `Cache-Control` remains `private, no-store`.

Web View All behavior:
- Market section previews render a bounded View All CTA when `section.viewAll.enabled=true`;
- `/market/sections/:sectionKey` fetches `getMarketSectionDetail` with cursor pagination and a 24-item page size;
- Load More appends de-duplicated items and stops when `hasNextPage=false`;
- stale section detail requests are aborted on route change/unmount;
- section detail records section impressions, item impressions, and item opens through the existing bounded signal queue;
- the UI does not claim personalization unless backend metadata serves aggregate ranking.

Mobile status:
- mobile already has typed `getMarketSectionDetail` support and ranking metadata normalization;
- a dedicated mobile section detail screen remains deferred because MarketScreen is still intentionally local-section rendered.

Still deferred:
- mobile full backend-section migration;
- long-list virtualization tuning beyond the current bounded web Load More page;
- suggestions;
- admin section/ranking governance UI;
- production rollout claims.

## Decision

The Market screen is not a flat feed and should not be category-first. It should be:

```text
section-first, category-supported, socially ranked, commerce-aware, fairness-balanced
```

## Market section model

```text
MarketSection
- id
- key
- title
- subtitle
- emotionalLabel
- sourceType: PRODUCT | COLLECTION | BRAND | DESIGN | MIXED
- rankingProfileId
- visibilityRules
- fallbackSectionKey
- position
- status: DRAFT | ACTIVE | PAUSED | ARCHIVED
- supportsViewAll
- previewItemCount
- viewAllLabel
- viewAllRouteSlug
- detailLayoutType: GRID | LIST | MASONRY | REELS
- preserveDiversityInDetail
- newBrandReservedRatio
- guestEnabled
- requiresAuthentication
- createdBy
- updatedBy
```

## Default Market sections

| Section | Purpose |
|---|---|
| Hot Right Now | recent social + commerce velocity |
| Fresh Drops | new products/collections |
| Picked For You | personalized commerce |
| New Designers to Watch | new-brand fairness |
| Shop by Style | category browsing |
| Loved Near You | local social proof |
| Shop the Look | outfit/complement discovery |
| Almost Gone | scarcity/low stock |
| Still Thinking About These? | viewed/saved/carted recovery |
| More From Brands You Like | brand affinity |
| Style Picks of the Week | editorial/admin picks |

## Section visibility formula

```text
section_visibility_score =
  (0.25 × user_relevance)
+ (0.20 × available_inventory_strength)
+ (0.20 × freshness_strength)
+ (0.15 × social_heat)
+ (0.10 × commerce_intent_match)
+ (0.10 × fairness_need)
```

Render when:

```text
section_visibility_score >= 0.35
AND valid_items_count >= minimum_section_items
```

## Section order formula

```text
section_order_score =
  (0.30 × user_relevance)
+ (0.20 × section_freshness)
+ (0.20 × expected_engagement)
+ (0.15 × commerce_opportunity)
+ (0.10 × novelty_value)
+ (0.05 × admin_priority)
```

## Market item score

```text
market_item_score =
  (0.22 × commerce_intent_score)
+ (0.18 × user_affinity_score)
+ (0.16 × social_proof_score)
+ (0.14 × freshness_score)
+ (0.12 × inventory_score)
+ (0.10 × brand_quality_score)
+ (0.08 × fairness_boost)
+ (0.05 × category_variety_bonus)
- suppression_penalty
- sold_out_penalty
- repetition_penalty
```

## View All requirement

Every renderable section can optionally support View All.

| Area | Requirement |
|---|---|
| Homepage preview | top N ranked items |
| View All | same ranking profile + cursor pagination |
| Back behavior | preserve Market home scroll position |
| Empty state | show caught-up or fallback |
| Analytics | track View All clicks |
| Mobile | CTA always visible |
| Web | visible but subtle; stronger on hover/focus |

## View All CTAs

| Section | CTA |
|---|---|
| Hot Right Now | See What’s Hot |
| Fresh Drops | View All Drops |
| New Designers to Watch | Meet More Designers |
| Loved Near You | Explore Near You |
| Shop the Look | See More Looks |
| Almost Gone | View Before It’s Gone |
| Still Thinking About These? | Continue Browsing |
| Picked For You | See More Picks |

## Category support

Market home must include a `Shop by Style` section, but the whole market home must not be category-only.

Rules:
- mixed sections should include category diversity;
- category pages can be category-first;
- main screen should avoid showing only one kind of thing.

## Section diversity caps

```text
No more than 3 consecutive products from the same category.
No more than 3 consecutive products from the same brand.
A 10-item horizontal section should try to include at least 3 categories.
A 6-item section should try to include at least 2 categories.
```
