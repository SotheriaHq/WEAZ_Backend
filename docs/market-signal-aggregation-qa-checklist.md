# Market Signal Aggregation QA Checklist

Status: Phase 4 ranking-readiness checklist. Ranking is not live.
Date: 2026-05-24

## Migration checklist

- Confirm `npx prisma validate` passes.
- Confirm `npx prisma generate` passes.
- Confirm migrations through `20260524150000_add_market_signal_idempotency_aggregation` are applied in QA/UAT before aggregate QA.
- Confirm `20260524170000_widen_market_signal_aggregate_key` is applied before max-length section/block/target signal testing.
- Do not run destructive reset commands to clear advisory locks.
- If local `migrate status` reports pending migrations because of advisory-lock timeout, apply through the normal deploy/UAT migration path once the lock clears.

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

## Release blockers

- Pending aggregate migrations in target environment.
- Any suppressed item reappearing in market section output.
- Aggregate update failure that blocks signal ingestion.
- User reset deleting global aggregate counters.
- Personalized/ranked output shipping without a feature flag and fallback.
