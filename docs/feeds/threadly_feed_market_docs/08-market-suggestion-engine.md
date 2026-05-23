# Context-Aware Market Suggestion Engine

## Phase 0 alignment note - 2026-05-23

- Suggestions must be context-aware market suggestion blocks, not a generic global widget.
- Mobile has a local `For your moodboard` suggestion row scored by `src/recommendations/recommendationScoring.ts`; it is not backend-driven and has no shared suppression or event ingestion.
- Web and mobile search have autocomplete/suggestion behavior, but product detail, collection detail, brand/store, and search-empty market suggestion blocks are not implemented as a shared engine.
- No backend `market/suggestions` endpoint, suggestion event model, suggestion suppression model, or admin suggestion block config exists today.

Phase 4 remains the right placement for the full suggestion engine, after Phase 1 section contracts and Phase 2 signals/suppressions exist.

## Decision

Implement a **Context-Aware Market Suggestion Engine**, not a generic global suggestion widget.

Scope:
- Market-related screens only.
- Cart suggestions are V2.
- Suggestions lazy-load.
- Suggestions have separate analytics.
- Super admin can manage suggestion blocks.
- Users can hide suggestion items or blocks.
- New brands receive reserved suggestion exposure.

## Purpose

The engine answers:

```text
Given a screen context, user context, excluded IDs, and section purpose,
which market-related items should this user see next?
```

## Supported contexts

```text
MARKET_HOME
MARKET_SECTION_DETAIL
PRODUCT_DETAIL
COLLECTION_DETAIL
BRAND_STORE
SEARCH_EMPTY
WISHLIST
```

V2:

```text
CART
CHECKOUT_SUCCESS
```

## Candidate types

```text
PRODUCT
COLLECTION
BRAND
DESIGN
```

## Candidate shape

```text
RecommendationCandidate
- id
- type
- title
- brandId
- brandName
- categoryIds
- tags
- colors
- fabrics
- occasions
- styleKeywords
- createdAt
- updatedAt
- mediaReady
- hasValidImage
- stats: threads, comments, likes, saves, views, orders, wishlist
- viewerState: saved, wishlisted, threaded, bagged, viewed
- commerce: hasPrice, orderable, inStock, customOrderEnabled, storeOpen, brandVerified
```

## Suggestion block model

```text
MarketSuggestionBlock
- id
- key
- title
- subtitle
- screenContext
- sectionType
- rankingProfileId
- enabled
- displayOrder
- previewLimit
- viewAllEnabled
- newBrandReservedRatio
- guestEnabled
- authRequired
- status
```

## V1 blocks by screen

### Product detail

| Block | Purpose |
|---|---|
| More Like This | similar style/category/tags/price |
| Complete the Look | complementary products |
| New Designers to Watch | fairness exposure |

### Collection detail

| Block | Purpose |
|---|---|
| More From This Style | related collections |
| Pieces That Match This Edit | products that complement collection |
| Fresh From New Designers | new brand discovery |

### Brand/store page

| Block | Purpose |
|---|---|
| More From This Brand | inventory depth |
| Similar Brands to Explore | discovery |
| Fresh Drops From New Designers | fairness |

### Search empty

| Block | Purpose |
|---|---|
| Try These Instead | nearby tags/categories |
| Hot Right Now | generic social fallback |
| Fresh Drops | generic freshness fallback |

## Suggestion formula

```text
suggestion_score =
  (0.25 × context_match)
+ (0.20 × commerce_readiness)
+ (0.15 × social_proof)
+ (0.15 × user_affinity)
+ (0.10 × freshness)
+ (0.10 × brand_quality)
+ (0.05 × new_brand_fairness)
- duplication_penalty
- suppression_penalty
- unavailable_penalty
```

## New-brand reserved slots

```text
new_brand_reserved_ratio = 10% to 20%
```

Eligibility:

```text
brand profile complete
AND valid media
AND active sellable items
AND no policy flags
```

## Duplication prevention

Suggestions must exclude the current item, products already visible on the screen, products already shown in another suggestion block, suppressed products/brands/categories, and unavailable products unless the section explicitly supports custom-order or restock context.

## Lazy-load rule

```text
Primary content first.
Suggestion blocks after primary render.
Below-the-fold suggestion blocks load when near viewport.
```

## User-facing labels

Use emotional names:
- More Like This
- Complete the Look
- You May Love These
- Fresh From New Designers
- Style Ideas For You
- Keep Exploring
- Looks That Match This
- Meet More Designers

Avoid generic labels like `Suggested For You`, `Recommended Products`, and `More Items`.

## Analytics

Track separately:
- suggestion block impression;
- suggestion item impression;
- suggestion item click;
- suggestion hide;
- suggestion View All click;
- suggestion wishlist/cart action;
- suggestion conversion contribution.
