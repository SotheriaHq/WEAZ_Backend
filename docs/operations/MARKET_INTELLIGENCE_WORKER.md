# Market Intelligence worker

Prepared implementation; integration, full verification and release acceptance remain pending. No application database migration or deployment is implied.

## Worker integration

`QueueWorkerModule` imports `MarketIntelligenceWorkerModule` from `src/market/intelligence/market-intelligence-worker.module.ts`. It imports the existing queue configuration and registers BullMQ queue `market-intelligence`. The API must not import this module or its scheduler. Existing queue names and producers are preserved.

The existing PM2 worker's `node_args` includes `--max-old-space-size=512`, preserving its preload arguments and `max_memory_restart: '700M'`. Measure the integrated process before release; the package does not claim a worker-wide RSS or heap baseline.

Configuration:

| Variable | R1 default / behavior |
|---|---|
| `MARKET_FEATURES_V1` | `true` when absent, matching the approved global 15-minute producer; `false` is the operational rollback switch; invalid strings fail closed |
| `SEARCH_LEXICON_V1` | `false`; requires WP-06's real rebuild provider before enabling |
| `MARKET_RAW_SIGNAL_RETENTION_HOURS` | `24`; another value blocks optional feature production without disabling privacy cleanup |
| `MARKET_PERSONAL_V1` / `MARKET_REGIONAL_V1` | `false`; setting either true blocks optional feature production; no affinity or regional producer exists in this module |

Privacy and price jobs remain scheduled when optional features are disabled. Scheduler registration failures fail worker bootstrap visibly; they are not silently accepted as working privacy enforcement.

## Scheduling and finite work

| Job | Cadence | Bounds |
|---|---|---|
| `market:features:refresh` | 15 minutes | 500 products per upsert statement, at most 100,000 products; one repeatable-read transaction; then atomic snapshot publication |
| `market:epoch:rotate` | 00/06/12/18 UTC | Publishes another immutable generation in the current six-hour bucket; bounded expiry cleanup |
| `market:effective-price:sweep` | 10 minutes | Up to 20 independent 2,000-product chunks, 30-second loop deadline, using due effective-price boundary index |
| `market:privacy:cleanup` | Every minute and at worker boot | Round robin over eight data classes; eight passes maximum; 2,000 rows per statement; 30-second loop deadline |
| `market:retention:sweep` | 03:10 UTC | Same idempotent privacy enforcement, plus bounded old-snapshot/exposure cleanup |
| `market:search:lexicon:rebuild` | Hourly | Calls WP-06's injected rebuild port with a 30-second deadline and 10,000-row ceiling; missing provider fails visibly |

The processor has concurrency 1. BullMQ owns renewable job locks; transaction-scoped PostgreSQL advisory locks prevent duplicate database work across different job IDs or worker instances. Locks release automatically on rollback/disconnect; no tokenless Redis lock deletion exists. Every database statement has a 3-second server timeout and 500-millisecond lock timeout. Transactions have a 90-second ceiling (10 seconds for small cleanup/price chunks). A dead/blocked statement cannot commit progress ahead of its result. An interrupted feature refresh rolls back all pages and its watermark; retries recompute authoritative state instead of incrementing counters.

The queue can delay a one-minute cleanup while another finite job executes. The cadence is not a proof of an exact 24-hour physical-deletion ceiling. Observe end-to-end lag under realistic load before activation. At 10,000 products the required heap/freshness soak is a release check, not a statement inferred from chunk size. The 100,000-product cap deliberately fails a whole refresh rather than publishing a partial catalogue. Increasing it requires capacity evidence.

## Features and immutable publication

The canonical state is `market.features.v1.r1`, exported with its exact parameter object. `market.features.watermark` in `system_config` stores the fully committed source instant and product count; `market.features.snapshot` records the published epoch and generation. Neither stores actors.

Current features use the shared product eligibility SQL, positive stocked variants, valid integer JSON stock fallback and aggregate stock only when no variant/size-stock authority exists. `minVariantStock` is the minimum positive available variant; `lowStockVariants` counts stocks 1–3. Products without any positive stock have null minimum and zero low-stock variants. Custom-order eligibility is preserved by the shared eligibility rule.

`savesCount` is the current authoritative `WishlistItem` set, excluding the product brand owner, ACTIVE members of that brand, nonactive users and platform operators. Its coverage describes a complete point-in-time set, not 28-day save events. Saved counts are frozen in the immutable snapshot; later saves/removals affect the next generation only.

The worker never infers exact multi-day actors from scalar daily totals. Under R1, `actors7d`, `actors28d`, `intent3d`, `intent28d`, `impressions28d`, `decayedPopularity`, `trendScore` and `qualityScore` remain null with explicit unavailable coverage; `trendEligible=false`. Long-window trend/popularity/quality policies must take their honest fallback. There is no invented quality prior or missing-impression zero.

Snapshot publication runs after each completed 15-minute refresh and at six-hour rotation, in one repeatable-read transaction: lock state, check admission, create BUILDING manifest, claim `writerXid`, copy all matching live rows in 2,000-row statements, transition READY, and move generation/current pointer. G3 guards verify membership, lineage, ownership, row count and atomic commit. Any error rolls back the entire publication. Each six-hour bucket may contain several immutable generations; existing cursors keep their original generation. `acceptUntil` is the bucket end and `cleanupAfter` is one hour later, so readers must cap cursor acceptance to the manifest lifetime. Expired/current generations are never rewritten. Cleanup deletes at most 2,000 snapshots per statement and detaches at most 2,000 exposure references before deleting an empty noncurrent manifest; it separately prunes exposure older than 14 days. Optional-feature rollback retains cleanup.

Publication admission enforces at least ten minutes between READY generations within the same bucket, at most 32 manifests per bucket, at most 64 retained manifests per state and at most 100,000 products per generation. Unchanged live source timestamps/membership do not publish another same-bucket generation. The true oldest source instant must be at most two hours old; copying an old feature never changes its `sourceAsOf`. Readers must apply the exported `MARKET_FEATURE_MAX_SOURCE_AGE_MS` to actual frozen source timestamps for all feature-based sorts and existing cursors, in addition to manifest expiry.

The storage circuit estimates every retained/prospective snapshot as UTF-8 JSON coverage bytes plus 1,536 bytes for fixed fields, tuple overhead and ranking indexes. It defaults to 512 MiB. `MARKET_SNAPSHOT_STORAGE_BUDGET_MIB` accepts a strict integer 1–4096; values above 512 require a bounded `MARKET_SNAPSHOT_STORAGE_SIZING_REF` pointing to a reviewed workload-sizing report. No larger allowance or report is configured by this implementation. Invalid settings or exhausted count/storage/freshness budgets return an operational backlog reason and preserve accepted snapshots. They never block newest sorting or checkout. The count and byte checks share the state-row lock with publication, so concurrent publishers cannot both spend the same allowance.

This estimate is an admission circuit, not measured physical disk usage: PostgreSQL compression, fill factor, page/index overhead, vacuum and bloat require actual relation-size monitoring and capacity evidence. At the default budget a sufficiently large catalogue can exhaust storage before a six-hour bucket expires; the honest outcome is a stale-sort fallback until expiry cleanup recovers room. Do not raise the default or relabel stale timestamps to conceal that limit. Cleanup attempts at most ten 2,000-row chunks per privacy run with a ten-second loop deadline; a small transaction is limited to ten seconds. Verify measured producer/cleanup throughput and generation storage before rollout.

## Purchase source contract

The approved global purchase producer reads authoritative `OrderItem` joined to `Order`, not identified client telemetry. It sums positive quantities whose order is PAID with `paidAt` in the inclusive 28-day source window, excludes CANCELLED/RETURNED orders and any `StandardOrderRefund` (including uncertain/pending refunds), and requires an active nonoperator buyer outside the seller's owner/ACTIVE-member accounts. Null or erased buyers are excluded. No buyer identifiers or contribution rows are written to features or manifests.

Completeness is fail closed. A retained financial-source audit must establish continuous history or actual known-empty inception before `system_config['market.sales.source.coverage']` is configured. Do not derive that claim from the oldest surviving order. The strict JSON contract is:

```json
{
  "version": 1,
  "source": "Order/OrderItem",
  "observedFrom": "2026-01-01T00:00:00.000Z",
  "verifiedAt": "2026-11-20T00:00:00.000Z",
  "evidenceRef": "verified-retained-financial-source-report"
}
```

`observedFrom` must cover the 28-day window. For a proven later system inception only, optional `knownEmptyBefore` can equal that inception instant. Dates must be canonical millisecond UTC; future dates, unknown fields and missing evidence references fail closed. Missing/invalid evidence leaves `units28d=null` with SOURCE_UNAVAILABLE. No source-history attestation has been fabricated or inserted by this implementation. Revoke or correct the attestation if source completeness changes, then refresh before admitting the sort.

`marketPlatformPaidOrderFloorSql(asOf)` returns `count` capped at 50 qualifying distinct platform orders using the same conservative source rules. Execute under the same request read snapshot and timeout as sort admission; require count 50, complete feature evidence and enough eligible candidates. Unit totals are not an order-count proxy. No paid-date/status index is present in the audited schema: evaluate actual plans on representative financial tables before enabling this source/sort. A timeout is unavailable, never a zero result. Authoritative source coverage is an integration requirement; a complete 28-day count is not claimed by preparing the query.

## Privacy enforcement and outage recovery

The SQL sweep deletes raw feed, section, suggestion, seen and batch-receipt rows strictly older than the server's 24-hour cutoff; seen rows also expire when `seenAt` is older. It removes every per-identity daily aggregate and all R1 affinity rows, regardless of their creation time. Daily rows with both identities null remain. User preferences, suppressions, resets, commercial records and ordinary product counters are outside this sweep.

Each data class commits independently. Round-robin passes avoid starving affinity/aggregate erasure behind a large event backlog. `SKIP LOCKED` is followed by an existence check, so locked expired rows report backlog rather than a false clean sweep. The committed `market.privacy.cleanup` result records completion time, deleted count, status and pending class names without identities. The last successful timestamp plus repeated backlog/failure must drive operational alerts and recovery. Physical deletion cannot be guaranteed during a worker/database outage; ingestion/read-cutoff integration below remains mandatory. Backup restores must run cleanup before enabling telemetry consumers and new ingestion; deleted identities are not reconstructed.

Redis cleanup scans only `mkt:seen:*`, at most ten COUNT-100 scans per job and a five-second loop deadline. It preserves compliant positive TTLs and atomically deletes immortal or over-24-hour TTL keys; it never extends a TTL. Cursor storage contains no viewer identity. Shared queue-client commands have per-operation wait deadlines. A timed-out cleanup command may finish later, but its only behavioral mutation deletes invalid retained data. A scan is not a replacement for correct writer TTLs or erasure hooks.

Required existing-module integration, owned separately:

1. Signal ingestion now holds the existing account row lock used by account deletion through the fresh actor check, canonical insert, projections, global aggregation and receipt in one transaction. An erased actor is rejected after lock acquisition. Guests use a transaction-scoped advisory lock for their anonymous session so parallel retry batches cannot claim the same event. Acquisition is bounded by250ms lock timeout, statements1500ms, transaction5000ms and pool wait500ms. Projection/aggregation failures roll back the entire batch; accepted receipts cannot outlive failed writes. The sweep removes old identity rows.
2. Existing replay and batch-receipt reads now use a fresh server 24-hour cutoff, including post-insert reconciliation. Runway behavior sources and derived ordering use the same absolute limit described below. Other identified readers must keep the cutoff even while cleanup is unavailable.
3. Clamp `mkt:seen:*` writer TTL to at most 24 hours; remove keys during account erasure/reset as applicable. Do not extend retention through read refreshes or renamed identifiers.
4. Keep privacy and exact price correctness during optional feature rollback. Do not roll back the maintenance worker or its read/TTL guards while ingestion continues. During prolonged cleanup failure, suspend new telemetry collection through the existing collection path until recovery is verified; do not silently retain a growing backlog.
5. Monitor cleanup success age, pending classes/oldest expired age, queue wait, failed/stalled jobs and feature source freshness. Establish a measured deletion-lag budget and alert/escalation procedure before claiming retention enforcement. The current job result alone does not measure oldest-row age; observability integration must add that actual gauge.

The legacy daily-rebuild API now refuses under R1 before reading raw history or writing aggregates. A closed UTC day cannot remain fully available inside a rolling 24-hour retention window after rebuilding starts, including the midnight boundary. Rebuilding from a surviving partial day would fabricate completeness, and replacing totals could overwrite concurrent increments. Retained global totals and ordinary incremental production continue; a replacement rebuild requires an independently verified complete anonymized source and transactional coordination.

### Runway behavior cache and session compatibility under R1

The existing behavior-derived Runway affinity uses only contributions inside the latest server 24-hour window. Manual interest preferences and ranking formulas are preserved. Cache payloads carry `runway-r1-v1`, canonical `sourceWindowStart`/`sourceWindowEnd`, and `retentionHours: 24`. The cache expires at the earlier of its 30-second refresh deadline or its oldest contribution plus 24 hours. Invalid/legacy payloads, malformed weights or targets, pre-reset sources, inactive actors, and expired proof are rejected on read even if deletion has failed. A completed build is checked again after persistence.

Runway feed sessions carry the same version in their query scope, rejecting old cursor snapshots. Their usual 30-minute lifetime is capped by the absolute behavior deadline. Actor/deadline checks after asynchronous construction and before returning a page prevent a slow query or write from carrying old behavior over that boundary. No historical source, preference, purchase record, or ranking formula is deleted or rewritten by this compatibility change. Shared public candidate caches remain independent of viewer affinity.

The actual `UserSeenItem` store is an append-only impression event ledger; it is not a per-viewer seen counter. There is no existing `mkt:seen:*` producer in these integrations, so the Redis cleanup proof does not establish writer TTL compliance for a nonexistent producer. Any later producer must enforce the absolute TTL contract at its write boundary. The shared account lock above orders ingestion against account erasure; this does not replace read cutoffs, cleanup or future signal validation rules.

Global aggregation uses one parameterized batched `INSERT ... ON CONFLICT` for at most50 submitted events, with deterministic database lock order. Every existing counter is incremented atomically. `GREATEST` preserves `latestSeenAt` when delayed contributions arrive after newer contributions. No actor identifier is stored in the global rows or their bound JSON payload.

New global aggregate keys use a versioned SHA-256 hash of a canonical JSON tuple. Literal delimiters inside section/block/target identifiers cannot merge distinct buckets. Existing aggregate rows are preserved; readers group their explicit target/section/date columns and do not depend on the historical key format. Already ambiguous historical rows cannot be reliably split and are not rewritten or reconstructed from expired raw behavior.

## Lexicon integration

WP-06 implements `MarketLexiconRebuilder.rebuild({deadline,maxRows})` and supplies the `MARKET_LEXICON_REBUILDER` token using `MarketIntelligenceWorkerModule.withLexicon({imports,provider})`. Use `useExisting`/`useFactory` to retain Nest dependency injection. The provider must implement bounded rebuild, atomic blob replacement and preservation of the last good lexicon on error. Admin taxonomy/synonym/brand writers can enqueue the exported lexicon job name with empty data through the same queue. A stub is not scheduled as a successful rebuild.

## Verification

Prepared checks:

```text
node scripts/test-market-intelligence-contracts.cjs
node scripts/test-market-intelligence-postgres.cjs
node --max-old-space-size=512 scripts/test-market-intelligence-postgres.cjs --heap
node scripts/test-market-intelligence-redis.cjs
node scripts/test-market-intelligence-ingest-postgres.cjs
```

The contract script passes 59 checks, including exact admission count/age/interval and storage-setting boundaries. The final guarded PostgreSQL/heap run passes 44 actual checks. It guards loopback only, creates a random disposable database, applies actual G2/G3 SQL, uses the real Prisma adapter/service, then drops only that exact generated database. Cases cover stock/saves/current-staff exclusion, missing versus complete purchase evidence, platform order floor, immutable snapshot, transaction lock release, failure after an earlier 500-row page with watermark rollback, clock-driven sale expiry, locked-row backlog, privacy class preservation, storage/count/age refusal and preservation of accepted snapshots.

The 10,000-product run used the 512 MiB V8 ceiling: refresh 13,175 ms, snapshot 13,360 ms, combined 26,540 ms and measured heap 99,017,496 bytes (about 94.4 MiB), below the 256 MiB fixture gate. This is a single local fixture observation, not a peak-allocation/long-running freshness/leak soak, full-worker memory baseline or ARM64 capacity proof. An earlier concurrent-load run hit the unchanged 3-second statement timeout and failed safely; phase labels were added and the rerun passed without relaxing limits. Capacity acceptance must account for that contention result.

The Redis proof uses a random prefix on a loopback-only test endpoint, never FLUSH or application keys. `MARKET_INTELLIGENCE_REDIS_TEST_URL` can name that local endpoint. Nine actual BullMQ scheduler-idempotency, maintenance-preserving rollback, deduplication and retry checks pass. The separate pipeline cache proof passes27 checks for actual Lua admission/expiry/reclamation, public payloads, failure circuit and recovery; both disposable cache keys are removed afterward. Two initial cache runs safely hit the unchanged25ms command limit under host contention, so these correctness results establish no workload latency SLO.

The focused ingestion suite passes40 tests, followed by24 aggregate-key/provider tests. The guarded actual PostgreSQL ingestion rehearsal passes31 proofs, including both account-erasure orderings, guest batch/event retry races, projection/aggregate rollback, bounded lock acquisition and recovery, monotonic freshness, deterministic counter row order and delimiter-key separation. Its minimal current table/enum contract executes actual production services/Prisma against PostgreSQL; it is not an additional migration replay. The disposable database is dropped and its absence verified. The privacy sweep now uses the actual mapped aggregate primary key `_id`; a prior minimal fixture's `id` spelling had masked that discrepancy.

Snapshot publication also computes a global completeness summary once in the worker, before READY and current-pointer publication. It augments the existing `market.features.snapshot` checkpoint and binds version, epoch ID, generation, source instant, expiry and row count. Requests must validate that identity and use a bounded live eligible-product probe for evidence floors; a stale worker total is not current-market evidence. G3 parameter equality and READY immutability guards remain unchanged. Missing or mismatched summary metadata means unavailable evidence and an honest fallback. The revised contracts pass72 checks; the focused worker rehearsal passes45 actual PostgreSQL checks including summary identity/coverage and the mapped aggregate primary-key correction. Combined request/worker integration remains part of the coordinated verification gate.

Still required: coordinated integrated backend types/lint/build and review, worker-summary integration, SQL-oracle comparison at scale, freshness p95 ≤20 minutes, cooling-history behavior when a lawful long-window source exists, cleanup just-after-sweep/prolonged-outage/restore/rollback proofs and workload source/index plans. Personal/regional activation and the WP-06 lexicon implementation are separate gates. This package is not marked complete by writing disabled foundations.
