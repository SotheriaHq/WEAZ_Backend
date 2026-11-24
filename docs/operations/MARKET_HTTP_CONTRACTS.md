# Market HTTP rollout contracts

## Home requests

Market home uses two parallel requests, as confirmed on 23 November 2026:

1. `GET /market/page` returns composed sections.
2. `GET /market/catalog?includeFacets=1` returns the catalogue, sort availability and filter counts.

`availableSorts` on a first page (or any page without a verified cursor) reflects the Market-wide evidence floors. A continuation whose verified cursor fixes an ordered sort (`newest`, `price_asc`, `price_desc`) does not repeat those whole-catalogue probes; its `availableSorts` lists only the always-available ordered sorts. Clients keep the sort menu from the first page and must not hide evidence-backed sorts because a continuation omitted them. Score-sorted continuations still evaluate availability on every page.

The section request does not wait for catalogue hydration. Both requests accept the same canonical filter vocabulary. `limit` means section count (1–8) on `/market/page`, and product count (1–60) on `/market/catalog`; clients must not reuse one value blindly.

Responses are private/no-store. Optional authentication identifies the principal from the verified JWT, never a query-supplied user ID. A validated anonymous session token may supply guest suppression context and does not become a catalogue filter. It is ignored for ownership when a verified user is present. Unknown, repeated singleton or malformed controls are rejected rather than silently omitted.

## Flags and retained routes

`MARKET_PIPELINE_V2_SURFACES` starts empty. `HOME`, `CATALOG` and `SEE_ALL` are independently selected surfaces. Empty or malformed configuration retains the previous routes; it does not activate a partial feature.

`/market/sections` maps pipeline sections to the retained response contract when HOME is enabled and the old preview-capacity `limit` is absent. Old preview-capacity requests retain their original meaning. The adapter preserves filter input and never serializes internal scopes, exposure receipts or candidate sources.

`/market/sections/:key` uses the trusted server-owned section definition for an enabled known section. Legacy numeric/UUID cursors may use the retained route. A signed pipeline cursor must never be interpreted by the retained reader after a flag change, unknown key or unavailable definition; the client receives `INVALID_CURSOR` and must refresh. Other new filter controls cannot silently disappear on the retained route.

## Facets

- `GET /market/facets?surface=CATALOG` uses catalogue eligibility.
- `GET /market/facets?surface=SEE_ALL&sectionKey=...` uses the current server-resolved product source, fixed filters and fallback filter layers for that section.
- Non-product lists reject product-facet requests. Their counts must not be substituted with catalogue-wide values.
- Page controls (`cursor`, `sort`, `limit`, `includeFacets`) are rejected by standalone facet requests. Use `includeFacets=1` on a product page when requesting both together.

## Live source-order lists

Almost Gone, More Like This and other mutable source-order lists use live keyset pagination, as confirmed on 23 November 2026. They do not promise a frozen copy of all stock, tags, curator placements or collection completeness. A card may become ineligible or move while the user scrolls. Clients must merge by entity type and ID, avoid showing duplicates, and refresh/re-anchor when the response requests it. Preserve the section response `meta`, `sort` and pagination fields through compatibility adapters. Do not calculate a checksum by materializing the complete candidate universe on each request. Price-sorted lists retain their stricter price-fence behavior and the “Prices updated” notice.

Trending cooldown re-entry compares the raw trend ratio with the immutable score from the first entry of the current consecutive run. Missing or expired evidence does not become zero or grant an early re-entry exception.

## Delivery and deadlines

Read capture is read-only and repeatable-read. Monotonic budgets propagate to database capture and media authorization. The deadline path requires PostgreSQL 17 or later for the transaction-level timeout; a missing capability is a safe retryable service error, not a successful empty result. Verify the actual target server version before enabling this surface. Do not raise timeouts to disguise a query-plan regression.

Exposure writes occur after read capture, use only a server-minted opaque receipt, and are bounded by admission, acquisition and remaining transaction budgets. A cancelled or expired request does not start an exposure write. A write failure does not invalidate an already-composed public response. This server-side exposure record measures delivered candidates; client impression/view signals remain a separate contract.

The page endpoint observes both an aborted request and a prematurely closed response, and removes listeners when work settles. Database work is not abandoned behind a timeout race.

## Verification before activation

Run the coordinated Market unit, type, build, lint, source and PostgreSQL checks against the final integrated revision. Verify flags-off routing, flags-on filtering, guest/user isolation, signed-cursor rollback rejection, section/facet scope, media withdrawal between capture and signing, real Redis failure recovery and physical database query counts. Fixture query plans are local engineering evidence; they do not establish the production latency or capacity target. Keep all rollout flags off until the batch is approved for release.
