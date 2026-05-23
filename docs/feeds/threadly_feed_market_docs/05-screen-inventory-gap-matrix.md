# Screen Inventory and Gap Matrix

## Available screens/components observed

| Platform | Screen/component | Evidence/notes | Status |
|---|---|---|---|
| Web | `src/pages/MarketPlace.tsx` | Market page with hero, featured, fresh drops, filters, grid, product overlay | Available, needs refactor |
| Web | `src/pages/Market.tsx` | Market-related route exists from search result | Requires validation |
| Web | `InlineProductDetail` | Product detail overlay/component exists | Available, needs suggestions |
| Web | `InlineStoreCollectionView` | Collection/store view component exists | Available, needs suggestions |
| Web | `CollectionRouter` | Collection route exists | Available, needs section/suggestion integration |
| Web | `CatalogShopTab` | Store/catalog shopping surface exists | Available, needs suggestion integration |
| Web | `SearchBarWithSuggestions` | Search suggestions exists | Available, separate from market suggestions |
| Mobile | `MarketScreen.tsx` | Main market screen with local rows | Available, needs backend section engine |
| Mobile | `UnifiedProductCard` | Shared mobile product card rendering | Available |
| Backend | `products/market` endpoint | Product market endpoint exists | Available, needs section endpoint |
| Backend | `collections/market`/`getMarketFeed` path | Design market feed exists | Available, needs ranking |
| Backend | Product view counter | Buffered view count exists | Available, needs broader signal system |

## Missing screens / views required

### User-facing screens

| Screen | Platform | Required for V1 | Purpose |
|---|---|---:|---|
| Market Section Detail / View All | Web + Mobile | Yes | Full section browsing |
| Product Detail Suggestions area | Web + Mobile | Yes | More Like This, Complete the Look |
| Collection Detail Suggestions area | Web + Mobile | Yes | Related collections/products |
| Brand Store Suggestions area | Web + Mobile | Yes | Similar brands, more from brand |
| Search Empty Suggestions | Web + Mobile | Yes | Recovery from no results |
| Feed Preferences | Web + Mobile | Yes | Reset/manage personalization |
| Style Interests | Web + Mobile | Yes | Update preference profile |
| Hidden Content | Web + Mobile | Yes | Unhide designs/products |
| Muted Brands | Web + Mobile | Yes | Manage suppressed brands |
| Location Preferences | Web + Mobile | Yes | Enable/disable location personalization |
| Notification Preferences | Web + Mobile | Yes | Manage alerts |
| Device & Security | Web + Mobile | Yes | Review/revoke devices |

### Admin screens

| Screen | Required for V1 | Purpose |
|---|---:|---|
| Feed Category Manager | Yes | Manage Discover/African/Casual/For You/etc. |
| Market Section Manager | Yes | Manage Hot Right Now/Fresh Drops/etc. |
| Suggestion Block Manager | Yes | Manage suggestion blocks per screen |
| Ranking Profile Manager | Yes | Manage formula weights safely |
| Formula Version History | Yes | Compare changes |
| Audit Log | Yes | Trace config history |
| Taxonomy/Style Manager | Yes | Manage tags/categories/styles |
| New Brand Exposure Monitor | Yes | Track fairness allocation |
| Analytics Dashboard | V1-lite | View section/suggestion performance |

## Missing backend endpoints

| Endpoint | Purpose |
|---|---|
| `GET /feed/designs` | Ranked design feed |
| `POST /feed/signals` | Record feed signals |
| `POST /feed/suppressions` | Hide/mute content |
| `GET /market/sections` | Market home section payload |
| `GET /market/sections/:key` | View All detail payload |
| `GET /market/suggestions` | Context-aware suggestions |
| `POST /market/suggestions/events` | Suggestion analytics |
| `POST /market/suggestions/suppressions` | Hide suggestion item/block |
| `GET /user/preferences/feed` | Read user preferences |
| `PATCH /user/preferences/feed` | Update preferences |
| `POST /user/preferences/feed/reset` | Soft reset |
| `GET /admin/market-sections` | Admin management |
| `GET /admin/suggestion-blocks` | Admin management |
| `GET /admin/ranking-profiles` | Admin management |

## Phase 0 alignment note - 2026-05-23

- Web `/market-place` is real but currently client-heavy: it can request up to 40 pages of 120 products and then sort/filter locally.
- Web `/market` and `/` currently route to the design market/feed surface, not a section-first product market.
- Mobile Discover already has a section-first market UX, but it is locally composed in `MarketScreen.tsx`.
- Mobile Home uses a cached cursor design feed through `MarketFeedScreen.tsx` and `collections/market`.
- Product detail, collection detail, brand/store, and search-empty suggestion blocks are not present as shared market suggestion blocks.
- Hidden content exists on web as localStorage state only; no backend suppression model was found.
- Search suggestions exist on web and mobile, but they are search autocomplete/recovery, not the planned context-aware market suggestion engine.

Phase 1 should prioritize the backend section contract and cursor-backed View All path before extending product/collection/brand detail surfaces.
