# Canonical catalogue and the transitional product route

The legacy `/products/market` and `/store/products/market` aliases select the
canonical catalogue only when `MARKET_PIPELINE_V2_SURFACES` includes `CATALOG`.
The default remains empty. Both aliases share the same controller mapping and
the same authenticated viewer; query parameters cannot impersonate a viewer.

## Supported translation

First-page and signed-cursor requests translate `sortBy`/`sort`, `gender`,
`minPrice`/`maxPrice`, `sizes`, `colors`, `tags`, `onSale`/`isOnSale` and public
`collectionId` restrictions. Default order remains newest and page size remains
40 for this transitional route. Arrays support bracket notation; repeated
scalar controls, mixed array encodings, conflicting aliases and unknown fields
are rejected. Canonical bounds and same-variant size/colour rules apply.

Search, category slugs, featured-state filters, offset pages after page 1,
page sizes above 60 and old UUID/numeric cursors stay explicitly on the V1
implementation because they cannot be translated faithfully by this facade.
Combining these modes with a signed canonical cursor returns a refresh error.
A failed canonical query is never retried on V1. After a rollback, an existing
canonical cursor similarly returns a refresh error rather than changing reader.

## Response parity and bounds

The canonical reader captures an exact matching total in its read-only,
repeatable-read transaction. Frozen sorts count the same covered snapshot set
as their keyset reader; the count is not inferred from a short page. Empty
results report a genuine zero. Counts outside JavaScript's safe integer range
are refused rather than rounded.

The facade maps public fields explicitly: flat prices, brand identity, stock,
selling options, approved category/garment metadata, active style-detail
bindings, sale dates and the approved image gallery. It never spreads an
internal product, owner or supplier-cost record into the response. Every image
is signed only after its current product association and asset version pass
the public-media check. Removed/rejected media is omitted; a removed cover
cannot authorize a card. Raw storage URLs and provider fields are not returned.

At most 61 products are captured per read. Product media has a required view
slot and a unique `(productId, viewSlot)` constraint. The trusted media batch
bound is `61 × (number of ContentMediaViewSlot values + 1 logo)`; with the
current eight slots that is 549 files. This preserves all approved views,
without silently clipping a gallery. Per-product option capture probes at
most 513 variants and 257 active style bindings. More than 512 variants or
256 bindings returns `CATALOGUE_OPTIONS_LIMIT`, without truncating selectors.
These are request-memory bounds, not a traffic-capacity claim.

## Verification and rollback

Run the catalogue/facade unit suite, module-cycle check, backend typecheck and
guarded PostgreSQL source-scope fixture before enabling the surface. The fixture
must create only its random loopback database and verify that it is dropped.
Generated-schema fixture results do not establish migration-trigger correctness
or a workload latency target; migration and load checks remain separate.

Clear `CATALOG` from the surface list to restore legacy dispatch for compatible
old requests. Signed canonical continuations ask the caller to refresh.
The web and native client integrations remain separate work packages; this
facade does not claim their UI, hardware or release verification.
