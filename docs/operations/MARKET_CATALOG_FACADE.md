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

While `CATALOG` is enabled, the route is strict: any query key outside the
supported list above (including cache-busting keys such as `_` or `t`) returns
`400 INVALID_FILTER` for every request on this route, including requests that
would otherwise stay on V1. No WIEZ client sends extra keys. With the surface
off, the V1 route keeps its previous behaviour and ignores unknown keys.

The legacy `gender` value is translated to the canonical audience, not compared
for equality. `MALE` becomes Menswear (`MALE` and `EVERYBODY` products),
`FEMALE` becomes Womenswear (`FEMALE` and `EVERYBODY`) and `EVERYBODY` becomes
Unisex (`EVERYBODY` only). This intentionally differs from V1, which matched
`gender` exactly: gender-neutral pieces belong in the Menswear and Womenswear
lists. A request served by V1 (including a fallback below) keeps exact matching.

Search, category slugs, featured-state filters, offset pages after page 1,
page sizes above 60 and old UUID/numeric cursors stay explicitly on the V1
implementation because they cannot be translated faithfully by this facade.
Combining these modes with a signed canonical cursor returns a refresh error.

Offset pagination and the canonical reader do not mix. A request with no `page`
or `page=1` is served by the canonical reader, and `page=2` or later by V1. The
two readers use different orders and eligibility rules, so a client that reads
page 1 canonically and then requests `page=2` can see repeated or missing
products. The canonical response always reports `page: 1` and a `totalPages`
derived from the canonical total; continue with its `nextCursor`, never with
`page`. No WIEZ client sends `page`: web requests only `limit` and `sortBy`, and
the native app continues with cursors.

A failed canonical query is never retried on V1. After a rollback, an existing
canonical cursor similarly returns a refresh error rather than changing reader.
The one exception is a request without any signed cursor that the canonical
reader refused before any database work: the process-local bulkhead was full
(`CATALOGUE_BUSY` at the first admission) or the cursor secret/namespace is
missing or invalid (`CATALOGUE_CURSOR_UNAVAILABLE`). The existing V1
implementation answers such a request, and a structured
`market.legacy_facade.v1_fallback` warning names the reason, at most once per
reason per minute with a count of the fallbacks since the previous warning.
A rejection at the later media-authorization admission, any query error, and
any request carrying a signed cursor still return the canonical error.

One canonical page uses two bulkhead admissions in sequence: the read capture
transaction, then a separate short media-authorization transaction that
revalidates media withdrawn between capture and signing. The first slot is
released before the second is requested, so a request never holds two slots
at once.

A card that cannot be serialized completely (no approved gallery, price,
availability or signed cover) is omitted from the page with a structured
`market.legacy_facade.items_dropped` warning listing product IDs; the other
cards are still returned. The total stays the canonical count.

## Response parity and bounds

The canonical reader captures an exact matching total in its read-only,
repeatable-read transaction. Frozen sorts count the same covered snapshot set
as their keyset reader; the count is not inferred from a short page. Empty
results report a genuine zero. Counts outside JavaScript's safe integer range
are refused rather than rounded. Results, totals and facet counts require the
same renderable cover as card capture: the first usable product image must be
an approved, ready product image file or a current-version variant of it.

A full scan reads one look-ahead row that is never hydrated or used as the
cursor anchor, so `hasNextPage` is true only when at least one matching row
exists after the cursor. A card withdrawn between capture and signing can
still leave a later page shorter than requested.

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
