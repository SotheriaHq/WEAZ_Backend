# Context-Aware Market Suggestion Engine

## Phase 11B runtime implementation - 2026-05-25

Status: first runtime implementation complete. Suggestions are deterministic V1 blocks, not ML, embeddings, admin-configured recommendations, or full personalization.

Implemented backend runtime:
- `GET /market/suggestions` is registered in the market module through `MarketSuggestionController`.
- `MarketSuggestionService` supports `PRODUCT_DETAIL`, `COLLECTION_DETAIL`, `BRAND_DETAIL`, `SEARCH_EMPTY`, and a safe deferred response for `MARKET_SECTION_DETAIL`.
- `MarketSuggestionQueryDto` validates the shared query contract and the service clamps suggestion limits to 12.
- responses use `Cache-Control: private, no-store`;
- authenticated user identity is derived from the request and guests can pass `anonymousSessionId`;
- active suppressions filter candidate items and suggestion blocks;
- products, collections, and brands are filtered for availability, open store status, usable media, archived/deleted state, and bounded query size;
- suggestion items align with `MarketSectionItemDto`;
- response metadata stays `personalization: disabled`.

Implemented V1 contexts:

| Context | Runtime behavior | Status |
|---|---|---|
| `PRODUCT_DETAIL` | More Like This, More From This Brand, Fresh Alternatives | Implemented |
| `COLLECTION_DETAIL` | Pieces From This Edit, More From This Brand, Similar Collections | Implemented |
| `BRAND_DETAIL` | Best From This Brand, Latest Collections, Designers to Watch fallback | Implemented in backend, web UI deferred |
| `SEARCH_EMPTY` | Try These Instead, Fresh Market Picks, Latest Collections | Implemented |
| `MARKET_SECTION_DETAIL` | Safe empty response with `fallbackReason=deferred-context` | Deferred |

Implemented web integration:
- `src/api/MarketApi.ts` includes suggestion response types and `getMarketSuggestions`.
- `src/components/market/MarketSuggestionBlocks.tsx` lazy-loads suggestion blocks, aborts stale requests, hides itself on empty/error responses, tracks suggestion block/item view and click signals, and calls existing suppression APIs for Not interested.
- `ProductDetailsPage.tsx` and `InlineProductDetail.tsx` render product-detail suggestions below primary content.
- `InlineStoreCollectionView.tsx` renders collection-detail suggestions below collection content.
- `SearchResultsPage.tsx` augments non-empty search-empty states with suggestion blocks.

Implemented mobile support:
- `threadly-mobile/src/api/MarketApi.ts` includes suggestion response types and `getMarketSuggestions`.
- Mobile runtime UI integration remains deferred; the existing market signal queue is unchanged.

Still deferred:
- admin suggestion configuration/governance;
- ML, embeddings, visual similarity, and collaborative filtering;
- cart/checkout suggestions;
- brand/store UI suggestion block on web;
- mobile product/collection/search UI wiring;
- suggestion block View All/detail pages;
- production suggestion monitoring dashboard.

## Phase 11A contract gate - 2026-05-25

Status: contract/design gate complete. Phase 11B now implements the first runtime endpoint and low-risk web surfaces described above.

Phase 11A confirms that suggestions must be context-aware market blocks, not a generic global widget. The shared contract is designed for product detail, collection detail, brand/store, search-empty, and market section detail surfaces. Phase 11B can implement this contract without changing ranking defaults or claiming full personalization.

## Current implementation evidence

Backend:
- `src/market/market.module.ts` currently registers section, signal, suppression, ranking config, aggregate reader, and scorer services. It does not register a market suggestion controller/service.
- `src/market/dto/market-section.dto.ts` defines the reusable `MarketSectionItemDto` card shape that suggestion items should align with.
- `src/market/dto/market-signal.dto.ts` already accepts `suggestionBlockKey` on signal and suppression payloads.
- `prisma/schema.prisma` already includes `SuggestionSignal`, `UserContentSuppression.suggestionBlockKey`, `MarketSignalTargetType.SUGGESTION_BLOCK`, and `MarketSignalSurface.SUGGESTION_BLOCK`.
- `src/search/search.controller.ts` exposes `GET /v1/search` and `GET /v1/search/suggest`, but those are search/autocomplete endpoints, not market suggestion blocks.

Web:
- Product detail route: `src/App.tsx` route `/products/:id`, page `src/pages/catalog/ProductDetailsPage.tsx`.
- Inline product detail surface: `src/components/catalog/InlineProductDetail.tsx`.
- Store collection route: `src/App.tsx` route `/collections/:id`, page `src/pages/catalog/CollectionRouter.tsx`, component `src/components/catalog/InlineStoreCollectionView.tsx`.
- Brand/store routes: `src/App.tsx` routes `/brand/:slug`, `/store/:brandId`, and `/profile/:id`, rendered through catalog/profile surfaces.
- Search empty surface: `src/pages/SearchResultsPage.tsx`.
- Market section detail route: `src/App.tsx` route `/market/sections/:sectionKey`, page `src/pages/MarketSectionPage.tsx`.
- Market API client: `src/api/MarketApi.ts`.

Mobile:
- Market API client: `src/api/MarketApi.ts`.
- Product detail route: `app/products/[productId].tsx`, rendered by `src/features/market/components/MarketCommerceViewer.tsx`.
- Collection detail route: `app/collection-viewer.tsx`, rendered by `src/features/market/components/CollectionCommerceViewer.tsx`.
- Brand/store route: `app/catalog/[brandId].tsx`, rendered by `app/catalog/index.tsx` and `components/catalog/BrandShopTab`.
- Search empty surface: `app/search.tsx`.
- Market home: `app/(tabs)/discover.tsx`, rendered by `src/features/market/components/MarketScreen.tsx`.
- Mobile currently has a local moodboard suggestion row in `MarketScreen.tsx`; it is not backend-driven and should be treated as legacy/local behavior until Phase 11B+.

## Contract decision

Add one backend market suggestion endpoint in Phase 11B:

```text
GET /market/suggestions
```

Supported query params:

```text
context
targetId
targetType
sectionKey
query
limit
cursor
anonymousSessionId
```

Rules:
- authenticated user identity must be derived from the request, not accepted from query/body;
- guests may pass `anonymousSessionId` for suppression-aware filtering;
- default cache policy is `Cache-Control: private, no-store`;
- limit must be clamped server-side;
- invalid context/targetType/cursor should return controlled client errors;
- empty eligible results should return an empty `blocks` array or empty block items, not a broken card.

## Supported contexts

```text
PRODUCT_DETAIL
COLLECTION_DETAIL
BRAND_DETAIL
SEARCH_EMPTY
MARKET_SECTION_DETAIL
```

Deferred contexts:

```text
CART
CHECKOUT_SUCCESS
WISHLIST
```

## Supported target types

```text
PRODUCT
COLLECTION
BRAND
CATEGORY
SECTION
QUERY
```

`DESIGN` can appear as an item/entity type because the market section DTO already supports design-like cards, but `targetType=DESIGN` is deferred unless Phase 11B confirms a stable design target path is needed for direct suggestion contexts.

## Response DTO contract

```text
MarketSuggestionResponse
- generatedAt: ISO string
- context: PRODUCT_DETAIL | COLLECTION_DETAIL | BRAND_DETAIL | SEARCH_EMPTY | MARKET_SECTION_DETAIL
- targetType: PRODUCT | COLLECTION | BRAND | CATEGORY | SECTION | QUERY | null
- targetId: string | null
- query: string | null
- sectionKey: string | null
- blocks: MarketSuggestionBlock[]
- metadata:
  - version: suggestion-v1
  - personalization: disabled | aggregate-contextual
  - cachePolicy: private-no-store
  - fallbackUsed: boolean
  - fallbackReason: string | null
  - requestedLimit: number
  - effectiveLimit: number
```

Phase 11B must not set `personalization=aggregate-contextual` unless aggregate-driven suggestion ordering is actually used and documented. Deterministic context matching should return `personalization=disabled`.

## Block DTO contract

```text
MarketSuggestionBlock
- blockKey: string
- title: string
- subtitle: string | null
- reason: string | null
- layout: HORIZONTAL_RAIL | PRODUCT_GRID | COLLECTION_RAIL | BRAND_RAIL | MIXED_RAIL
- sourceType: PRODUCT | COLLECTION | DESIGN | BRAND | MIXED
- items: MarketSuggestionItem[]
- pagination:
  - limit: number
  - hasNextPage: boolean
  - nextCursor: string | null
- metadata:
  - strategy: string
  - fallbackUsed: boolean
  - fallbackReason: string | null
  - generatedFrom: PRODUCT | COLLECTION | BRAND | CATEGORY | SECTION | QUERY | FALLBACK
```

Use emotional but accurate labels such as:
- More Like This
- More From This Brand
- Fresh Alternatives
- Similar Collections
- Designers to Watch
- Try These Instead

Do not use visible copy that overclaims personalization, ML, or recommendation certainty.

## Item DTO contract

Suggestion items should align with `MarketSectionItemDto` so web and mobile can reuse card mappers:

```text
MarketSuggestionItem
- id
- sourceId
- sourceType: PRODUCT | COLLECTION | DESIGN | BRAND | MIXED
- entityType: PRODUCT | COLLECTION | DESIGN | BRAND | CATEGORY
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
- metadata:
  - reason: string | null
  - score: number | null
```

`metadata.score` is optional and must not expose raw internal weights in production responses. It may be omitted from normal client responses if not needed.

## Shared exclusion and safety rules

Every Phase 11B strategy must:
- apply active user or anonymous-session suppressions through `MarketSuppressionService`;
- exclude the current target item from its own suggestions;
- exclude unavailable, archived, deleted, closed-store, or broken-media items;
- dedupe items inside each block;
- avoid duplicate target items across blocks where feasible;
- return only bounded previews;
- use explicit Prisma `select` or existing lightweight DTO mapping;
- avoid N+1 lookups;
- keep primary detail/search pages usable if suggestions fail;
- keep cache headers private/no-store while requester or guest context affects output.

## Strategy matrix

| Context | Phase 11B strategy | Required data | Fallback | Status |
|---|---|---|---|---|
| PRODUCT_DETAIL | same category, same brand alternatives, fresh alternatives | product id, brand id, category, tags, price/media/availability | fresh-drops products, then empty block | Phase 11B |
| PRODUCT_DETAIL | complementary/custom-ready items | category/tags and custom-ready availability | hide block if insufficient data | Deferred unless query remains cheap |
| COLLECTION_DETAIL | products/designs from same brand and similar category/style | collection id, owner/brand id, linked products, category/tags | latest collections or fresh drops | Phase 11B |
| COLLECTION_DETAIL | other collections from same brand | owner/brand id, visible store/design collections | hide block if same-brand pool is empty | Phase 11B |
| BRAND_DETAIL | best available brand products and latest brand collections | brand id, open store status, visible products/collections | fresh drops/new designers | Phase 11B |
| BRAND_DETAIL | similar brands | brand tags/categories/location if available | new designers to watch | Deferred until brand similarity rules are approved |
| SEARCH_EMPTY | query-relaxed category/tag/product alternatives | query string, search parser, category/tag match | hot-right-now, fresh-drops, popular categories | Phase 11B |
| MARKET_SECTION_DETAIL | adjacent section suggestions | current section key and section catalog | latest/fresh sections | Deferred unless low-risk after core contexts |

## Context details

### PRODUCT_DETAIL

Recommended blocks:
- More Like This: products in the same category/tag neighborhood, excluding the current product.
- More From This Brand: other available products or collections from the same brand.
- Fresh Alternatives: recent products with usable media when category/brand pools are thin.

Insertion points:
- web `ProductDetailsPage.tsx`: below product review/primary detail body or below product actions once primary content has rendered.
- web `InlineProductDetail.tsx`: below the inline detail body before returning to the parent collection view.
- mobile `MarketCommerceViewer.tsx`: below the primary detail/action sheet content, lazy-loaded after product/design fetch.

### COLLECTION_DETAIL

Recommended blocks:
- Pieces From This Edit: linked products from the same store collection where available.
- More From This Brand: other visible store/design collections from the same owner.
- Similar Collections: category/tag-related store collections.

Insertion points:
- web `InlineStoreCollectionView.tsx`: below product grid/gallery and collection bagging controls.
- web `CollectionRouter.tsx`: pass collection context into the child suggestion component in Phase 11B.
- mobile `CollectionCommerceViewer.tsx`: below the collection product list/actions.

### BRAND_DETAIL

Recommended blocks:
- Best From This Brand: available products from the brand.
- Latest Collections: recent visible collections from the brand.
- Designers to Watch: generic fallback for guest/new brands only when same-brand inventory is thin.

Insertion points:
- web catalog/profile/store pages rendered from `Catalog.tsx`/`ProfileLayout.tsx`, preferably near the Store tab or after visible catalog sections.
- mobile `app/catalog/index.tsx` and `BrandShopTab`, below the shop/collection list.

### SEARCH_EMPTY

Recommended blocks:
- Try These Instead: relaxed query/category/tag matches.
- Fresh Drops: generic product fallback.
- Designers to Watch: brand discovery fallback when product matches are empty.

Insertion points:
- web `SearchResultsPage.tsx`: replace or augment the current "Try broader terms" empty-state area after no results.
- mobile `app/search.tsx`: augment the `resultState.status === 'empty'` card after search results fail to match.

### MARKET_SECTION_DETAIL

Recommended blocks:
- Keep Exploring: adjacent section links or bounded section cards.

Phase 11B should defer this context unless the core detail/search contexts are stable first. Phase 10 already made section detail pagination usable; suggestions should not complicate that path until the core suggestion engine is proven.

## Suggestion signal requirements

Existing Prisma enum support:
- `SUGGESTION_BLOCK_VIEW`
- `SUGGESTION_ITEM_VIEW`
- `SUGGESTION_ITEM_CLICK`
- `SUGGESTION_ITEM_WISHLIST`
- `SUGGESTION_ITEM_CART_ADD`
- `SUGGESTION_ITEM_HIDE`
- `SUGGESTION_BLOCK_HIDE`
- `SUGGESTION_VIEW_ALL_CLICK`

Phase 11B event mapping:
- block enters viewport -> `SUGGESTION_BLOCK_VIEW`;
- item enters viewport -> `SUGGESTION_ITEM_VIEW`;
- item opens -> `SUGGESTION_ITEM_CLICK`;
- item hidden -> `SUGGESTION_ITEM_HIDE`;
- block dismissed -> `SUGGESTION_BLOCK_HIDE`;
- suggestion block View All -> `SUGGESTION_VIEW_ALL_CLICK`;
- wishlist/cart actions -> existing wishlist/cart suggestion signal types.

DTO gap:
- The user-facing prompt names `SUGGESTION_ITEM_OPEN` and `SUGGESTION_DISMISS`; the codebase currently uses `SUGGESTION_ITEM_CLICK` and `SUGGESTION_BLOCK_HIDE`. Phase 11B should either map the prompt language to the existing enum names or add new enum values only if a migration is justified.
- Phase 11B maps item open behavior to the existing `SUGGESTION_ITEM_CLICK` enum and does not add a migration for aliases.

## Suppression behavior

Existing suppression support can cover Phase 11B:
- item hide: `POST /market/suppressions` with target `PRODUCT`, `COLLECTION`, `DESIGN`, or `BRAND` where applicable;
- brand hide: target `BRAND` or `brandId`;
- category hide: target `CATEGORY` or `categoryId`;
- block hide: target `SUGGESTION_BLOCK` and/or `suggestionBlockKey`.

Phase 11B reuses the existing suppression endpoint and does not add a suggestion-specific suppression endpoint.

## Phase 11B implementation file map

Backend:
- add `src/market/dto/market-suggestion.dto.ts`;
- add `src/market/market-suggestion.controller.ts`;
- add `src/market/market-suggestion.service.ts`;
- wire the controller/service into `src/market/market.module.ts`;
- reuse `src/market/dto/market-section.dto.ts` for item-card shape alignment;
- reuse `src/market/market-suppression.service.ts`;
- reuse `src/market/market-signal.service.ts` and `src/market/market-signal-aggregation.service.ts` for suggestion events;
- use `src/store/store.service.ts`, `src/collections/collections.service.ts`, and `src/search/search.service.ts` as data sources where safe.

Web:
- add market suggestion API methods/types in `src/api/MarketApi.ts`;
- add a small suggestion block component/hook only after the backend endpoint exists;
- integrate first into `src/pages/catalog/ProductDetailsPage.tsx`, `src/components/catalog/InlineProductDetail.tsx`, `src/components/catalog/InlineStoreCollectionView.tsx`, `src/pages/SearchResultsPage.tsx`, and brand/catalog surfaces if scope permits;
- preserve Phase 10 View All and signal behavior.

Mobile:
- add API methods/types in `src/api/MarketApi.ts`;
- defer deep UI wiring unless it is small and uses approved mobile primitives;
- candidate future surfaces: `MarketCommerceViewer.tsx`, `CollectionCommerceViewer.tsx`, `app/catalog/index.tsx`, `app/search.tsx`;
- keep the local moodboard row in `MarketScreen.tsx` until backend-driven suggestions can replace it deliberately.

## Deferred items

- admin suggestion block configuration;
- suggestion formula admin UI;
- ML, embeddings, collaborative filtering, and visual similarity;
- cart and checkout-success suggestions;
- mobile full backend-section migration;
- production monitoring dashboard specific to suggestions;
- cross-device suppression management UI beyond existing suppression records.
