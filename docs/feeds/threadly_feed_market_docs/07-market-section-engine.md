# Market Section Engine

## Phase 0 alignment note - 2026-05-23

- No shared backend market section endpoint exists today.
- Backend product market is `GET /products/market` and alias `GET /store/products/market`; backend design feed is `GET /collections/market`.
- Web `MarketPlace.tsx` still builds sections client-side after loading up to 4800 products.
- Mobile `MarketScreen.tsx` builds a good local section model: hero, live themes, fresh row, moodboard row, latest collections, product grids, editorial cards, and custom-ready row.
- View All is not a general backend-driven section route on either web or mobile.

Implementation standard: create the backend section contract first, then adapt web and mobile to the same DTO. Do not keep expanding local section builders as the primary architecture.

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
