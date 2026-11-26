# Market pipeline V2

The pipeline is written behind the existing default-off surface selector. This is not WP-05 acceptance or release approval. Personal and regional ranking remain off; retention is unchanged. Existing dispatch remains available during the client adoption cycle.

## Contracts

`MarketPipelineComposer` consumes `PipelinePorts` and optional `PipelineCandidateCache`. `compose(specs, context)` validates the same strict specs intended for draft preview/publish, then resolves sources, scores a bounded preview pool, applies suppression/dedupe/diversity/tenure, rehydrates and returns public cards. Registries are closed; no query, expression, executable policy, experiment, actor identity or formula can come from a section definition.

`captureMarketPipelinePage` batches the real source SQL inside the catalogue read-only repeatable-read runner. Its request-local in-memory ports implement `retrieve(PipelineSourceRequest)`. Every read applies the WP03 canonical filters, all `fixedFilterLayers` with AND, the source restriction, current suppression and canonical eligibility **before** limiting. Source objects describe catalogue/new publication, low stock, curated placement, similarity/complements context, public looks, qualifying new brands, active category tiles and public context-matching Runway designs. A source cannot be implemented by filtering a completed catalogue page. A stale cached ID still passes the original source query. Candidate limits are maxima, so an adapter using the catalogue reader's 61-row cap can return fewer than the requested 100–300.

`hydrate(candidates, asOf, signal, request)` receives no more than twice preview capacity (24). It must use the same captured database view/time as source retrieval for price/order consistency and the WP03 public card capture contract; local gateway signing runs after the read transaction. The composer rechecks `isEligibleProduct(product, asOf)` for each product. The adapter supplies a `ProductEligibilityRow` and a public-only `MarketSectionItemDto`; inactive/pending taxonomy, private collection metadata and owner identity cannot enter the DTO. Media files must be attached to the selected public entity. `MarketPipelineMediaResolver` rechecks each original source in the shared `MarketPublicMediaService` authorization transaction, captures current ready files and active-version variants, then signs gateway URLs locally after the transaction. No legacy upload query is used. Hydration checks membership for the exact source request; an item valid in a second source cannot survive a revoked first source. If signing fails the adapter omits the card, never returns a raw private bucket URL. LOW_STOCK also requires live tracked, standard-checkout SKU evidence within 1–3 units.

Each rendered section includes an internal `scope` with the exact effective source and original/fallback fixed-filter layers. **Remove this object from public JSON.** Use it to build a trusted versioned WP03 See All scope. Public See All metadata retains the original section key/version and effective template; it is not a cursor or a client-controlled SQL restriction. The facade must persist/bind the effective source identity so a later request cannot silently switch section meaning. All full-set sort/price/cursor work stays in WP03; preview scoring is never used to sort a loaded See All page.

## Evidence and R1

The context's epoch is a captured READY `market.features.v1.r1` generation with schema/policy version 1, `sourceAsOf <= asOf`, source age at most two hours and a future `acceptUntil`. The adapter sets `complete` only after checking the actual immutable coverage objects, their required/observed windows and the matching parameters. Nullable or unavailable values never prove a zero. Global popularity also needs at least eight products with real intent; trend rows require at least five authenticated actors, with a spec allowed to raise the floor. Quality requires complete exposure-normalized evidence. Current R1 worker output has unavailable long-window popularity/trend/quality: Fresh Drops is the honest fallback, not a Popular/Hot/Starter label over recency.

Personal templates are structurally unavailable at 24-hour retention and remain unavailable in this WP05 implementation even with longer retention or personal/regional flags. They can only gain producers under their own later package/legal gates. No affinity, recently-viewed history, per-viewer impression discounts or regional reads are performed. Suppressions are current preferences, copied per request and applied after every cache hit; the source adapter must also apply the live predicate before limiting. A failed suppression read must fail closed at context construction rather than fabricate empty preferences.

`defaultPipelineSpecs()` preserves Adire (canonical approved tag), ready-to-wear/in-stock, made-to-order, public looks and Runway discovery. When the facade's complete first catalogue page proves there are 0–7 eligible products, use `defaultPipelineSpecs(count)` for a single truthful Explore the Market section with minimum one. Do not derive that count from an incomplete page or an unavailable database. An empty catalogue renders no fake cards. The 30→60→90-day release extension stays a source restriction.

## Bounds and cache

At most 32 input specs, eight rendered sections, 96 bounded in-memory source/hydration port calls, 300 candidates per source and 24 hydration rows per call. Operations receive cancellation and a 250ms cap inside a 550ms overall elapsed budget. These are application limits, **not a proof of twelve database round trips or production SLO compliance**. The real adapter must batch where appropriate, cancel the actual database operation on `AbortSignal`, enforce the existing read-only/timeout/admission runner, and account for upload authorization reads. A non-cooperative adapter may continue work after a timeout; it must not be accepted in production. Cache work has an independent 30ms cap and consumes the same page deadline. Failures omit/fallback a section without returning internal error text.

Shared cache holds only `{id, score}`; no hydrated DTO, price, suppression, viewer ID, history or file URL. Only unfiltered HOME nonpersonal/nonregional requests are admitted.

**Where the cache sits.** The cache is consulted at capture, before the source query, not inside the composer.
- One `HMGET` reads every admitted page key in a single round trip, with a 30 ms wait.
- A hit narrows that source's SQL to the cached IDs. Every source predicate, current eligibility, the renderable-cover rule and current suppression still run, so a hit never authorizes a card.
- An empty cached pool is a miss, so the first product of a new catalogue appears immediately.
- On a miss the scored pool is written after the read transaction has released its connection, alongside media authorization. Each write is bounded to 30 ms, and a failure or timeout is an ordinary miss.
- See All keyset pages never read or write shared pools.

**Which cards are captured.** The real composer runs once in planning mode over the captured candidate rows. It applies the same fallbacks, new-release windows, page-level dedupe, diversity and repeat rules, and records the cards it would place plus two reserves per rail. Only those cards are captured and signed.
- At most `8 rails × (12 preview + 2 reserve) = 112` cards per page.
- Product sources use the catalogue renderable-cover rule (an approved, ready cover or a current variant), so a planned card is a card that can render.
- A card that still fails final media or eligibility checks is replaced from the rail's reserve.
- Composition stops at the requested section limit in both passes. Keys hash the full validated spec/version, source, independent fixed-filter hashes and immutable epoch/source generation (or a six-hour recency bucket). User filters/context bypass shared cache. Every read rechecks source membership and hydration; a cache hit is not authorization. `BoundedPipelineCandidateCache` provides a bounded local fallback (256 entries default; 120 seconds maximum). `RedisPipelineCandidateCache` implements the same bounds with a 25ms command wait and a five-failure/10-second circuit. One bounded hash and one bounded expiry sorted set retain at most 256 fields. At most four provider commands remain unsettled; timeout does not release admission until the underlying operation actually settles. An atomic Lua write removes expired fields before admission; continuous traffic cannot permanently fill the hash with expired entries. This adapter still requires a real Redis proof and connection lifecycle integration.

Ranking is deterministic for captured inputs. Score ties use IDs; recency preview ties within one UTC day rotate by a section/epoch hash while full See All remains chronological. Candidate-relative percentile blends, MMR diversity, brand/category caps, up to two new-designer slots and bounded weighted exploration run only over the bounded preview pool. Exploration records the exact conditional weight/sum probability for its draw; this is **not** an end-to-end logging propensity or an IPS evaluation guarantee. At most two controlled page repeats appear, only for allowed templates and after the first two surviving positions. Global tenure reads only prior six-hour exposure buckets so a write cannot change ranking inside the current epoch. The server page builder mints an opaque in-process exposure receipt after membership-gated hydration. `writePipelineExposures(db, receipt)` accepts that receipt only, rechecks live product eligibility, writes no actor identifiers and uses the unique section/product/epoch key for retry idempotency. Forged JSON receipts are rejected. Its caller must run the write outside the read transaction with a database timeout. Cooldown re-entry compares the raw trend ratio with the immutable trend ratio from the first exposure of the current consecutive run. That first exposure's epoch snapshot is read through the same captured query as tenure. A product returns early only at 1.5 times that first-entry ratio. Missing, expired or detached first-entry evidence grants no early return.

## Injectable service and route integration

Register `MarketPipelineService` beside `MarketCatalogReadService`, `MarketPublicMediaService` and `MarketCatalogService`. Optionally bind `MARKET_PIPELINE_CACHE` to a lifecycle-managed `RedisPipelineCandidateCache`. Keep the rollout surface selector empty by default. Do not construct viewer identity from request bodies; pass the existing authenticated user or validated anonymous-session identity.

- `getPage({viewer, surface, filters, productId?, specs?, signal?})` returns serialized public JSON.
- `preparePage(input)` is the internal delivery hook returning `{public, trusted, exposureReceipt, context}`. Serialize only `public`; pass the receipt to the bounded exposure writer when that writer is integrated. Never expose the receipt, trusted scope or context through HTTP.
- `getScope({key, viewer, specs?, surface?, productId?, signal?})` resolves the effective fallback without applying a new user sort/filter override, then constructs a source-bound versioned catalogue scope. The original fixed filter is passed as `fixedFilters`; additional fallback filters remain independent AND layers in `scope.filterLayers`. It never supplies preview product IDs as a complete universe.
- `getSection({...input, key, query: URLSearchParams})` returns `kind: catalogue | legacy`. Product price/newest sorts delegate to the canonical catalogue reader with the same source and filter layers. Dedicated source-order keysets cover curator positions, scarcity, similarity and the four nonproduct sources. No preview ID universe is used. A custom TREND actor floor above five remains on the existing dispatch until the shared immutable-epoch scope represents that higher floor.
- Exported `marketPipelinePublicSpecs` and `marketPipelineSpecHash` validate definitions before producing public mapping/version hashes. Neither permits source SQL or body-supplied scope objects.

The 550ms absolute monotonic deadline starts before capture and propagates through the read runner, shared media authorization and composer. Do not race a database promise and abandon it. The database runner must enforce its remaining statement/transaction budget and fail after cancellation/deadline; the page builder refuses to return a response after its deadline. Strict in-flight cancellation and combined cold/hit SLOs remain subject to actual driver/workload proof.

## Full-set source-order reads

The source resolver probes validated source/fallback definitions independently of home preview rendering. A source does not disappear because it was below the home section cap or because a preview media lookup returned a short page. `explore-market` is explicitly resolvable for the small-catalogue default. Source-only key SQL omits full public product projections, tags and dimension arrays across the universe. SQL applies the exact source, original/fallback fixed layers, user filters, active taxonomy and current suppression before keyset seeking and a maximum 61 transferred IDs. Only those IDs are captured and hydrated with current media authorization.

Curated keys use placement position, publication date and ID. Scarcity uses the actual positive tracked stock and ID; similarity uses its defined formula followed by publication date and ID. LOOKS uses the actual pin, completeness ratio, date and ID rather than an unstable `row_number` ordinal. Category, new-designer and Runway keys follow their source ordering. The schema has no positional field on approved complement pairs; that approved set currently uses deterministic publication date and ID, rather than an invented curator position.

Source cursors have a separate HMAC domain from catalogue/price cursors and bind viewer/preference context, filters, original spec and effective source. The previous verification key remains supported. A constant-size pair of database aggregate change checksums over eligible IDs and ordering tuples detects mutable source changes and reanchors the page with `Updated`. These checksums detect change only; current SQL authorization remains authoritative. Fingerprint cost and the full-set source key query still require workload measurement. Explicit price sorts use the catalogue's existing price-boundary/fence implementation.

Public items never carry ranking diagnostics: `explore`, `samplingProbability` and `repeatOf` stay server-side.

Each API process keeps a bounded memory (20,000 rows, expiring at epoch end) of exposure rows it has committed. A page whose rows were all written this epoch skips the write transaction. Rows are remembered only after commit, so a rolled-back write is retried on the next view. Skips under burst are logged at debug level, not warn.

`/market/page`, `/market/sections` and `/market/sections/:key` all abort database and media work when the client disconnects, and remove their listeners when the work settles.

See All resolves new-release windows with the Home rule: it widens 30→60 days below 8 candidates and →90 below 4, then applies `minItems` to the settled window. "View all" therefore lists the same window the rail showed.

The page section limit is applied before both public serialization and exposure-receipt creation. An omitted rail therefore cannot receive a served exposure merely because it was composed internally. Public section JSON now includes the layout, a null nonpersonal reason and a safe section route/label. Real Redis tests can use a strict disposable `mkt:cand:v2:test:<32-hex>` storage namespace; application defaults remain unchanged.

## Earlier PostgreSQL source verification

The disposable-database fixture passed 123 assertions and 12 EXPLAIN checks across all 11 source shapes and a combined batch. It exercised real PostgreSQL source predicates, fixed/user layer AND, active taxonomy, tag aliases including banned/cyclic aliases, collection dimensions, public source restrictions, and parameter typing. It exposed and verified corrections for untyped JSON parameters and accidental ORDER BY ordinal zero. Fixture cleanup verified the disposable database was absent. These checks establish correctness of the tested shapes; they do not establish production-scale p95 latency.

LOOKS now preserves curator pins, descending eligible/total completeness, descending creation time and ID through a source-order rank. COMPLEMENTS shares the exact catalogue source helper and permits same-brand different active categories or valid different active garment types. FROM_RUNWAY validates meaningful collection dimensions and canonical approved aliases; product-only price/stock/size/colour filters fail closed for nonpurchasable designs.

## Remaining acceptance checks

Colocated suites cover spec boundaries, fallback chains, deterministic ranking, media denial, scarcity, exact-source membership, cache isolation, expiry/capacity, receipt forgery, full-set delegation and port budgets. Run the repository Jest runner, full backend types/build and scoped lint after integration. Unit evidence is pending the serialized check slot.

Integrated since the first draft: source-order and nonproduct See All readers, controller/facade routing, the bounded exposure writer, the first-entry trend-ratio escape, capture-phase cache narrowing and the composer planning pass.

Still open:
- real Redis Lua, connection and `HMGET` proof against the integrated revision
- the physical query-count and cancellation proof
- stable fallback restore behaviour across a pagination epoch change
- the optional 7-day intent producer (the schema provides only 3- and 28-day intent)
- combined cold/hit concurrency, latency and heap workload
- exact-head CI Missing secondary required ranking evidence is unavailable, never measured zero. Scarcity can still use live stock without its explicitly optional intent term. No personalization, regional feature activation, live database changes, commits, pushes, merges or deployments are part of this implementation.
