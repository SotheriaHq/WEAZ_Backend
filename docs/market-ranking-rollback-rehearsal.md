# Market Ranking Rollback Rehearsal

Status: Phase 7 rollback rehearsal plan. Ranking is disabled.
Date: 2026-05-24

## Purpose

Define the QA/UAT rehearsal that proves Threadly can disable future market ranking and return to deterministic fallback without breaking market rendering, suppressions, or signal ingestion.

This plan does not enable ranking, implement ranking, query aggregates for served ordering, or add Redis/BullMQ.

## Prerequisites

- QA/UAT database backup exists.
- Aggregate migrations are applied in QA/UAT:
  - `20260524150000_add_market_signal_idempotency_aggregation`
  - `20260524170000_widen_market_signal_aggregate_key`
- `npx prisma migrate status` reports no pending migrations in QA/UAT.
- `npx prisma validate` passes.
- `npx prisma generate` passes.
- `npm run build` passes.
- Monitoring dashboard from `docs/market-ranking-monitoring-plan.md` exists or is represented by a documented manual substitute for rehearsal.
- Owner placeholders are assigned or explicitly accepted as release blockers:
  - `<engineering-owner>`
  - `<product-owner>`
  - `<qa-owner>`

## Feature flag values before rehearsal

Baseline values:

```text
MARKET_RANKING_ENABLED=false
MARKET_RANKING_SHADOW_MODE=true
MARKET_RANKING_SECTION_KEYS=
MARKET_RANKING_MAX_PERSONALIZED_SECTIONS=1
MARKET_RANKING_FALLBACK_DETERMINISTIC=true
MARKET_RANKING_EXPLORATION_PERCENT=10
MARKET_RANKING_BRAND_MAX_SHARE=35
MARKET_RANKING_AGGREGATE_TIMEOUT_MS=150
```

Expected baseline behavior:
- `/market/sections` serves deterministic V1 ordering.
- `/market/sections/:key` serves deterministic V1 ordering.
- response metadata remains `ranking: deterministic-v1` and `personalization: disabled`.
- suppressions still filter eligible output.
- signal ingestion can continue independently.

## Rehearsal sequence

1. Confirm clean build and migration status.
2. Capture baseline `/market/sections` response with ranking disabled.
3. Capture baseline `/market/sections/fresh-drops` response with ranking disabled.
4. Create or use an existing QA suppression for one visible product/brand/category.
5. Confirm suppressed content is excluded from `/market/sections`.
6. Set `MARKET_RANKING_ENABLED=true` in the QA runtime only if the runtime supports non-production env changes.
7. Keep ranking implementation absent. This should still return deterministic fallback because Phase 6 does not implement ranking.
8. Confirm `/market/sections` response remains deterministic and suppression-aware.
9. Set `MARKET_RANKING_ENABLED=false`.
10. Confirm response remains deterministic and stable after rollback.
11. Record fallback activation metrics or manual evidence.
12. Restore baseline env values.

If env changes require deployment, use a QA-only deployment and record commit/deployment ID. Do not run this against production without explicit release approval.

## Enable/disable expectations

When `MARKET_RANKING_ENABLED=false`:
- deterministic ordering is served;
- aggregate reads for ordering do not run;
- suppressions still apply;
- cache remains private/no-store;
- no user-visible error is shown.

When `MARKET_RANKING_ENABLED=true` before ranking exists:
- deterministic fallback remains served;
- aggregate reads for ordering do not run;
- response metadata remains deterministic/non-personalized;
- no shadow-ranked result is served.

## Aggregate read failure simulation plan

Current Phase 7 state does not read aggregates for ordering, so there is no production aggregate-read failure path to trigger.

For rehearsal:
- use tests or manual inspection to confirm `marketSignalAggregateDaily` is not called by market section serving;
- document this as the expected pre-ranking behavior;
- once ranking implementation exists, simulate aggregate read failure by forcing the aggregate reader to timeout or throw in QA and verify deterministic fallback.

Do not break the QA database, revoke schema permissions, or drop aggregate tables to simulate failure.

## Suppressed content verification

Verify with one of:

- authenticated QA user suppression;
- anonymous QA session suppression;
- seeded suppression fixture.

Required checks:
- item suppression removes matching target;
- brand suppression removes matching brand items;
- category suppression removes matching category items where metadata exists;
- section suppression hides the matching section;
- deleting suppression restores eligibility.

Any suppressed content appearing in market output fails the rehearsal.

## Empty-section fallback verification

Verify:

- empty sections are hidden safely on market home;
- section detail returns bounded pagination or a controlled empty list;
- no broken cards are returned;
- no unhandled exception occurs;
- deterministic fallback remains available when ranking flags are disabled.

## Cache and response verification

Required:
- `/market/sections` returns `Cache-Control: private, no-store`;
- `/market/sections/:key` returns `Cache-Control: private, no-store`;
- metadata remains deterministic/non-personalized until ranking is implemented;
- no ranked or personalized claim is returned.

## Rollback owner placeholders

| Responsibility | Owner |
|---|---|
| Start rehearsal | `<qa-owner>` |
| Change ranking flags | `<engineering-owner>` |
| Approve product quality after rehearsal | `<product-owner>` |
| Decide rollback during incident | `<engineering-owner>` |
| Communicate user-facing incident if needed | `<product-owner>` |

Owner placeholders must be replaced before production rollout.

## Pass criteria

- QA/UAT migrations are applied.
- Deterministic baseline responses are captured.
- Ranking flag disable path returns deterministic output.
- Ranking flag enable-before-implementation still returns deterministic output.
- Suppressions remain respected.
- Empty sections hide or fall back safely.
- Cache headers remain private/no-store.
- Fallback activation can be observed or manually recorded.
- Owner placeholders are resolved or explicitly listed as blockers.

## Phase 7B QA/UAT execution checklist

Use this checklist in QA/UAT only. Do not run it against production and do not use destructive database reset.

1. Backup confirmation
   - Confirm a restorable QA/UAT database backup exists.
   - Record backup ID in the rehearsal record.

2. Migration status confirmation
   - Run `npx prisma migrate status`.
   - Confirm these migrations are applied:
     - `20260524150000_add_market_signal_idempotency_aggregation`;
     - `20260524170000_widen_market_signal_aggregate_key`.
   - If either migration is pending, stop the rehearsal and apply migrations through the deploy path with `npx prisma migrate deploy`.

3. Baseline deterministic capture
   - Set `MARKET_RANKING_ENABLED=false`.
   - Set `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`.
   - Capture `GET /market/sections`.
   - Capture one detail route such as `GET /market/sections/fresh-drops`.
   - Record response item IDs, `metadata.personalization`, section `metadata.ranking`, and cache headers.

4. Suppression fixture setup
   - Create a QA-only suppression for a known product, brand, category, or section using the existing suppression endpoint.
   - Re-run the same market section request.
   - Confirm the suppressed target is absent.

5. Ranking flag enable-before-implementation rehearsal
   - In QA only, set `MARKET_RANKING_ENABLED=true`.
   - Keep `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`.
   - Re-run the same baseline requests.
   - Confirm served ordering remains deterministic and aggregate tables are not used for served ordering.

6. Disable/rollback rehearsal
   - Set `MARKET_RANKING_ENABLED=false`.
   - Re-run the same baseline requests.
   - Confirm the item order and metadata match deterministic fallback expectations.

7. Cache header verification
   - Confirm `/market/sections` returns `Cache-Control: private, no-store`.
   - Confirm `/market/sections/:key` returns `Cache-Control: private, no-store`.

8. Result record
   - Complete the rehearsal record template in this document.
   - Mark pass/fail.
   - Attach owner sign-off or explicitly list unresolved owner placeholders as blockers.

## Fail criteria

- Any ranking flag changes served ordering before approved ranking implementation.
- Any aggregate table is read for served ordering before ranking implementation.
- Suppressed content appears.
- Empty sections return broken cards.
- Cache headers become public/cacheable.
- Rollback requires code revert instead of flag disable.
- Owner placeholders remain unresolved for production release.

## Rehearsal record template

```text
Date:
Environment:
Deployment ID:
Database backup ID:
Migrate status result:
Ranking flags before:
Ranking flags during:
Ranking flags after:
Baseline sections captured:
Suppression fixture:
Fallback evidence:
Monitoring evidence:
Pass/Fail:
Owner sign-off:
Notes:
```

## Phase 7D local MVP rehearsal result

Phase 7D ran a local/single-environment rehearsal because external QA/UAT access is unavailable.

Local prerequisites:
- local database connection was available;
- current local backup was created with `pg_dump` under ignored `backups/`;
- destructive reset was not used;
- both aggregate migrations were applied locally with `npx prisma migrate deploy` after stale local Prisma advisory-lock sessions were terminated;
- final `npx prisma migrate status` reported the schema is up to date.

Local rehearsal:
- baseline used the existing local backend on port `3040` with ranking disabled;
- enable-before-implementation used an isolated local backend on `127.0.0.1:3041` with `MARKET_RANKING_ENABLED=true` and deterministic fallback enabled;
- rollback returned to the existing local backend with ranking disabled;
- the temporary `3041` process was stopped after capture.

Evidence:
- `/market/sections` returned status `200`, `Cache-Control: private, no-store`, `metadata.personalization=disabled`, and `metadata.cachePolicy=private-no-store`;
- `/market/sections/fresh-drops` returned status `200`, `Cache-Control: private, no-store`, `metadata.ranking=deterministic-v1`, and `metadata.personalization=disabled`;
- first fresh-drops IDs matched across baseline, enabled-before-implementation, and rollback captures;
- guest product suppression for `11111111-1111-4111-8111-111111111103` removed the target from fresh drops and was deleted after rehearsal.

Local pass/fail:
- Pass for local MVP simulation.

Scope limit:
- This is not external QA/UAT approval.
- This is not production monitoring approval.
- This is not enterprise owner sign-off.
- Ranking remains disabled and not live.

## Phase R1 rollback behavior

Phase R1 adds aggregate ranking code but keeps rollback flag-based:

1. Set `MARKET_RANKING_ENABLED=false`.
2. Keep `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`.
3. Confirm `/market/sections` and `/market/sections/:key` return deterministic V1 metadata.
4. Confirm suppressions are still applied.
5. Confirm `Cache-Control: private, no-store` remains present.

Expected fallback cases without operator action:
- aggregate table is empty: deterministic fallback with `fallbackReason=aggregate-empty`;
- aggregate read fails: deterministic fallback with `fallbackReason=aggregate-read-failed`;
- aggregate read times out: deterministic fallback with `fallbackReason=aggregate-timeout`;
- ranking services are unavailable in a test/module context: deterministic fallback with `fallbackReason=ranking-services-unavailable`;
- shadow mode is enabled: ranked candidates may be computed but deterministic order is served.

R1 rollback does not delete raw signals, seen rows, suppressions, reset markers, batch receipts, or aggregate rows.
