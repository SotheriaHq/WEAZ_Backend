# Market Signal Aggregation QA Checklist

Status: Phase 7 migration, monitoring, and rollback-readiness QA checklist. Ranking is not live.
Date: 2026-05-24

## Migration execution checklist

Required aggregate migrations, in order:

1. `20260524150000_add_market_signal_idempotency_aggregation`
2. `20260524170000_widen_market_signal_aggregate_key`

Prerequisite:
- `20260524120000_add_market_signal_suppression_foundation` must already be applied because it creates the Phase 2 signal, seen, suppression, and reset tables.

Pre-migration requirements:
- Take a QA/UAT database backup before applying either aggregate migration.
- Confirm the application version being deployed contains both migration folders and the matching Prisma schema.
- Confirm `npx prisma validate` passes.
- Confirm `npx prisma generate` passes.
- Run `npx prisma migrate status` and record whether the two aggregate migrations are pending or already applied.
- Do not run `prisma migrate reset`, manual table drops, or destructive reset commands to clear an advisory lock.

Execution:
- QA/UAT/deploy environments must use `npx prisma migrate deploy`.
- Development environments may use the normal local workflow only after the advisory lock clears.
- Apply the two aggregate migrations in timestamp order. Do not apply `20260524170000_widen_market_signal_aggregate_key` before `20260524150000_add_market_signal_idempotency_aggregation`.

Post-migration validation:
- Run `npx prisma migrate status` and confirm no pending migrations remain.
- Run `npx prisma validate`.
- Run `npx prisma generate`.
- Verify `market_signal_batch_receipts` exists.
- Verify `market_signal_aggregate_daily` exists.
- Verify `market_signal_aggregate_daily.aggregateKey` is `VARCHAR(512)`.
- Verify aggregate uniqueness exists for daily aggregate identity.
- Run focused market signal, aggregation, suppression, and feed preference tests.

Suggested SQL checks for QA/UAT:

```sql
SELECT to_regclass('public.market_signal_batch_receipts') AS batch_receipts_table;
SELECT to_regclass('public.market_signal_aggregate_daily') AS aggregate_daily_table;

SELECT character_maximum_length
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'market_signal_aggregate_daily'
  AND column_name = 'aggregateKey';

SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename IN ('market_signal_batch_receipts', 'market_signal_aggregate_daily')
ORDER BY tablename, indexname;
```

Rollback guidance:
- If migration deployment fails before schema changes are applied, stop the rollout, keep ranking disabled, and redeploy the previous application version if needed.
- If schema changes were applied and the application must roll back, restore from the pre-migration backup or use an explicitly reviewed forward-fix migration. Do not use destructive reset.
- Signal ingestion can remain active only if raw signal writes and suppression filters still pass validation after rollback. Ranking must remain disabled.

Advisory-lock handling:
- If `npx prisma migrate status` or local apply reports a Prisma advisory-lock timeout, do not force reset the database.
- Check for long-running local database sessions, stop the conflicting local process if safe, then rerun `npx prisma migrate status`.
- For QA/UAT, use the deploy pipeline and database operational procedure to clear stale locks.
- As of Phase 7 local validation on 2026-05-24, `npx prisma migrate status` still reports these migrations as pending locally:
  - `20260524150000_add_market_signal_idempotency_aggregation`
  - `20260524170000_widen_market_signal_aggregate_key`

## Signal ingestion checklist

- Authenticated signal batch derives user ID from JWT context.
- Guest signal batch requires `anonymousSessionId`.
- Batch size above 50 is rejected.
- Metadata above 2048 bytes is rejected.
- Invalid `targetType`, `signalType`, or `surface` is rejected.
- Signal ingestion response includes received, persisted, deduplicated, and aggregation metadata.

## Idempotency checklist

- Duplicate `clientEventId` inside one batch is skipped.
- Duplicate `batchId` replay is skipped when a receipt exists.
- Recently persisted `clientEventId` for the same user/session is skipped.
- Events without `clientEventId` are fingerprint-deduped inside the same batch.
- Concurrent duplicate batch replay remains a known hardening gap until a queued/transactional path is added.

## Aggregation checklist

- Section impression increments `sectionImpressions`.
- Item impression increments `itemImpressions` and `seenItems`.
- Product open increments `itemOpens` and `productOpens`.
- View All click increments `viewAllClicks`.
- Suppression creates a suppression counter.
- `latestSeenAt` updates for view-like events.
- Daily bucket uses UTC midnight.
- Anonymous buckets do not attach to authenticated users.
- Reset does not delete global aggregate counters.

## Suppression checklist

- Item suppression hides matching market section item.
- Brand/category/section suppressions are represented in suppression scope.
- Suppression delete restores eligibility.
- Suppression endpoints use `Cache-Control: private, no-store`.
- Guest suppression requires `anonymousSessionId`.

## Reset checklist

- Reset endpoint requires authentication.
- Reset endpoint uses server-derived user ID.
- Reset creates a `PersonalizationReset` marker.
- Reset does not delete raw signals, seen rows, suppressions, or global aggregate rows.
- Future ranking must ignore/downweight user personalization signals older than reset marker.

## Mobile queue checklist

- Queue cap is 100.
- Flush batch size is 25.
- Flush interval is 5 seconds.
- AppState background/inactive triggers flush.
- Unmount cleanup flushes without leaving intervals/subscriptions alive.
- Failed flush requeues within the cap.
- Queue is in-memory only; app restart drops unsent events.

## Web queue checklist

- Market section signals include `clientEventId`.
- Visibility/pagehide/unmount flush exists.
- Intersection observers disconnect on unmount.
- Not-interested removes the item locally and persists suppression.
- Fallback market rendering remains bounded.

## Ranking-readiness checklist

- Ranking design gate is accepted.
- Aggregate migrations are applied in QA/UAT.
- Aggregate tests pass.
- Cache headers remain safe.
- Suppression and reset semantics are documented.
- Redis/BullMQ decision is explicit.
- Feature flag and rollback path are defined before ranking code starts.
- Ranking flags default disabled in code.
- Deterministic fallback remains served when ranking flags are absent or disabled.
- Deterministic fallback remains served if ranking is enabled before implementation exists.
- Aggregate tables are not read for served ordering.

## Release blockers

- Pending aggregate migrations in target environment.
- Any suppressed item reappearing in market section output.
- Aggregate update failure that blocks signal ingestion.
- User reset deleting global aggregate counters.
- Personalized/ranked output shipping without a feature flag and fallback.
- Monitoring dashboard and alert thresholds not implemented or not verified in QA/UAT.
- Rollback rehearsal not executed after aggregate migrations are applied.
- `<engineering-owner>`, `<product-owner>`, and `<qa-owner>` placeholders not replaced or explicitly accepted as release blockers.

## Phase 6 ranking flag checklist

- `MarketRankingConfigService` returns safe defaults.
- Invalid boolean values fall back safely.
- Invalid numeric values fall back or clamp safely.
- Section keys are normalized, deduped, and bounded.
- `/market/sections` remains deterministic without ranking env values.
- `/market/sections` remains deterministic with `MARKET_RANKING_ENABLED=false`.
- `/market/sections` remains deterministic with `MARKET_RANKING_ENABLED=true` until ranking implementation exists.
- Suppression filtering still applies after flag wiring.
- Cache headers remain `Cache-Control: private, no-store`.

## Phase 7 operational readiness checklist

Migration readiness:
- `npx prisma validate` passes.
- `npx prisma generate` passes.
- `npx prisma migrate status` is recorded before QA/UAT rollout.
- QA/UAT applies the pending aggregate migrations with `npx prisma migrate deploy`.
- No destructive reset is used to clear local advisory locks or pending migration state.

Monitoring readiness:
- `docs/market-ranking-monitoring-plan.md` is reviewed and accepted.
- Dashboard requirements cover market latency, aggregate read latency/failures, empty sections, fallback activation, suppression violations, repeated items, brand concentration, signal ingest, dedupe, aggregation failures, and batch replays.
- Alert thresholds are configured in the chosen observability stack or a documented manual substitute exists for QA/UAT.
- Required log fields include request ID, section key, ranking flags, fallback reason, aggregate read timing, suppression counts, repeated item count, top-brand share, duration, status code, and deployment ID.

Rollback rehearsal readiness:
- `docs/market-ranking-rollback-rehearsal.md` is reviewed and accepted.
- Baseline flag values keep ranking disabled and deterministic fallback enabled.
- QA/UAT captures baseline `/market/sections` and `/market/sections/:key` responses before any flag rehearsal.
- Suppressed-content verification passes during the rehearsal.
- Empty-section fallback behavior is verified during the rehearsal.
- Cache headers remain private/no-store.
- Rehearsal result is recorded with environment, deployment ID, migration status, flags, fallback evidence, monitoring evidence, pass/fail result, and owner sign-off.

## Phase 7B operational gate checklist

Backend verification:
- `npx prisma validate` passes.
- `npx prisma generate` passes.
- `npx prisma migrate status` is recorded and pending aggregate migrations are identified.
- `MarketRankingConfigService` defaults ranking disabled.
- `MarketSectionService` returns deterministic fallback even if `MARKET_RANKING_ENABLED=true` before ranking implementation exists.
- `MarketSectionService` does not read `marketSignalAggregateDaily` for served ordering.
- Suppression filtering still applies.
- Market section cache headers remain private/no-store.

Web verification:
- web market section types tolerate `metadata.ranking` and `metadata.personalization` as informational strings;
- web does not claim market sections are personalized;
- web signal batching remains bounded and accepts dedupe/aggregation response fields;
- stashed auth/design work remains untouched.

Mobile verification:
- mobile market signal queue remains bounded to 100 events;
- flush batch size remains 25 events;
- AppState background/inactive flush remains wired;
- mobile does not assume ranked/personalized market section output;
- stashed auth work remains untouched.

Operational blockers:
- apply pending aggregate migrations in QA/UAT;
- provision monitoring dashboards and alerts or obtain explicit owner-approved QA manual substitute;
- replace `<engineering-owner>`, `<product-owner>`, and `<qa-owner>` placeholders;
- execute and pass rollback rehearsal before ranking implementation starts.

## Phase 7D local MVP simulation checklist

Phase 7D replaces the external QA/UAT assumption with a local MVP simulation only.

Completed locally on 2026-05-25:
- clean backend, web, and mobile workspaces confirmed before changes;
- local database access confirmed;
- `pg_dump` local restore point created under ignored `backups/`;
- initial migrate status recorded both aggregate migrations as pending;
- stale local Prisma advisory-lock sessions were cleared without destructive reset;
- `npx prisma migrate deploy` applied:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- final migrate status reports schema is up to date;
- deterministic baseline was captured;
- suppression fixture was verified;
- ranking enable-before-implementation was rehearsed locally and remained deterministic;
- rollback was verified;
- cache headers stayed private/no-store.

Owner simulation:
- Engineering owner: Shawn / solo project owner;
- Product owner: Shawn / solo project owner;
- QA owner: Shawn / solo project owner.

Remaining non-local blockers:
- hosted production monitoring/alerts are still not implemented;
- hosted backup/restore rehearsal is still not complete;
- real owner governance should be revisited before multi-user production rollout.
