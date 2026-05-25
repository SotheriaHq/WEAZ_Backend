# Market Ranking Local MVP Simulation

Status: Phase 7D local MVP readiness simulation. Ranking is disabled.
Date: 2026-05-25

## Purpose

This document records the local/single-environment simulation that replaces the earlier external QA/UAT assumption for the MVP workflow.

This is not production approval, external QA approval, enterprise governance, or live personalization. It proves only that the local backend can apply the aggregate migrations, keep deterministic fallback behavior, preserve suppression filtering, and rehearse the ranking kill switch before ranking implementation begins.

## Current backend state

- Backend commit: `7f2e2313fb48d1b9c428924ff7d0250d22378b11`.
- Ranking flag default: `MARKET_RANKING_ENABLED=false`.
- Deterministic fallback default: `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`.
- Served ranking metadata remains `deterministic-v1`.
- Served personalization metadata remains `disabled`.
- Aggregate tables are not read for served ordering.
- `/market/sections` and `/market/sections/:key` return `Cache-Control: private, no-store`.

## Local database readiness

Local database target label:

```text
localhost:5432/threadly/public
```

No database secret values are recorded in this document.

Commands run:

```text
npx prisma validate
npx prisma generate
npx prisma migrate status
npx prisma migrate deploy
npx prisma migrate status
npx prisma validate
npx prisma generate
```

Result:
- `npx prisma validate` passed.
- `npx prisma generate` passed.
- initial `npx prisma migrate status` reported two pending aggregate migrations:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`.
- `npx prisma migrate deploy` initially hit Prisma advisory-lock timeout `P1002`.
- read-only lock inspection showed stale local Prisma advisory-lock sessions.
- stale advisory-lock sessions were terminated locally with `pg_terminate_backend(...)`.
- `npx prisma migrate deploy` then applied both aggregate migrations successfully.
- final `npx prisma migrate status` reported: `Database schema is up to date!`.

Destructive reset was not used.

## Local backup / restore point

Backup method:
- `pg_dump` custom-format dump against the local PostgreSQL database.
- Prisma's `?schema=public` URI query parameter is not accepted by `pg_dump`, so the dump command used the database URL without query parameters and passed `--schema=public` explicitly.
- Password handling used the local Postgres client mechanism; secrets were not printed.

Backup path pattern:

```text
backups/threadly-local-ranking-readiness-YYYYMMDD-HHmmss.dump
```

Latest local backup evidence:

```text
backups/threadly-local-ranking-readiness-20260525-100020.dump
```

Backup committed: No. The existing `backups/` folder is gitignored.

Restore approach:

```text
pg_restore --clean --if-exists --dbname=<local-threadly-database-url-without-query-params> backups/threadly-local-ranking-readiness-YYYYMMDD-HHmmss.dump
```

Limitations:
- This is a local restore point only.
- It does not replace a hosted QA/UAT backup.
- It must not be committed.
- Before production rollout, hosted database backup and restore rehearsal must be revisited.

## Local owner simulation

Because this is a solo MVP workflow, owner approval is simulated locally:

| Responsibility | Simulated owner |
|---|---|
| Engineering owner | Shawn / solo project owner |
| Product owner | Shawn / solo project owner |
| QA owner | Shawn / solo project owner |

This is local MVP owner simulation only. Before multi-user production rollout, real owner assignment and governance must be revisited.

## Local monitoring substitute

No production dashboard or alert stack was provisioned in Phase 7D.

Local MVP substitute:
- use backend request logs with `x-request-id`;
- capture request duration from existing request logger output;
- enable Prisma slow-query logging when needed:

```text
PRISMA_LOG_QUERIES=true
PRISMA_SLOW_QUERY_MS=100
```

- manually capture response metadata;
- manually capture `Cache-Control` headers;
- manually capture item IDs before/after flag changes;
- manually capture suppression fixture evidence;
- manually capture deterministic fallback evidence.

Limitations:
- No dashboard exists.
- No alert thresholds are wired to infrastructure.
- No `Server-Timing` metric is emitted.
- This substitute is acceptable only for local MVP readiness, not hosted production rollout.

## Local evidence template

```text
Date:
Local machine:
Backend commit:
Database target label:
Backup method:
Migration status:
Ranking flags before:
Ranking flags during:
Ranking flags after:
GET /market/sections status:
GET /market/sections cache-control:
GET /market/sections metadata:
GET /market/sections item IDs:
GET /market/sections/fresh-drops status:
GET /market/sections/fresh-drops cache-control:
Suppression fixture:
Suppression result:
Fallback evidence:
Pass/Fail:
Notes:
```

## Local rollback rehearsal record

```text
Date: 2026-05-25
Local machine: Threadly local Windows workspace
Backend commit: 7f2e2313fb48d1b9c428924ff7d0250d22378b11
Database target label: localhost:5432/threadly/public
Backup method: pg_dump custom-format dump, stored under ignored backups/
Migration status: final prisma migrate status reports database schema is up to date
Ranking flags before: MARKET_RANKING_ENABLED=false, MARKET_RANKING_FALLBACK_DETERMINISTIC=true
Ranking flags during: isolated local backend on 127.0.0.1:3041 with MARKET_RANKING_ENABLED=true, MARKET_RANKING_FALLBACK_DETERMINISTIC=true
Ranking flags after: MARKET_RANKING_ENABLED=false on the existing local backend
GET /market/sections status: 200
GET /market/sections cache-control: private, no-store
GET /market/sections metadata: version=phase1.v1, personalization=disabled, cachePolicy=private-no-store
GET /market/sections item IDs: captured from fresh-drops, hot-right-now, latest-collections, shop-by-style, custom-ready, new-designers-to-watch
GET /market/sections/fresh-drops status: 200
GET /market/sections/fresh-drops cache-control: private, no-store
GET /market/sections/fresh-drops metadata: ranking=deterministic-v1, personalization=disabled
Suppression fixture: guest anonymous session product suppression for 11111111-1111-4111-8111-111111111103
Suppression result: target absent from fresh-drops after suppression; suppression deleted after rehearsal
Fallback evidence: enabled-before-implementation response kept identical first fresh-drops IDs and deterministic/non-personalized metadata
Pass/Fail: Pass for local MVP simulation
Notes: External QA/UAT approval, production monitoring, and enterprise owner assignment remain out of scope for this local MVP gate.
```

Baseline fresh-drops first IDs:

```text
11111111-1111-4111-8111-111111111103
11111111-1111-4111-8111-111111111102
11111111-1111-4111-8111-111111111101
0e2e0000-0000-4000-8000-000000000119
0e2e0000-0000-4000-8000-000000000118
```

Enabled-before-implementation first IDs:

```text
11111111-1111-4111-8111-111111111103
11111111-1111-4111-8111-111111111102
11111111-1111-4111-8111-111111111101
0e2e0000-0000-4000-8000-000000000119
0e2e0000-0000-4000-8000-000000000118
```

Rollback first IDs:

```text
11111111-1111-4111-8111-111111111103
11111111-1111-4111-8111-111111111102
11111111-1111-4111-8111-111111111101
0e2e0000-0000-4000-8000-000000000119
0e2e0000-0000-4000-8000-000000000118
```

## Verdict

Ready for ranking implementation locally: Yes.

Reason:
- local database access works;
- local restore point exists;
- aggregate migrations are applied locally;
- deterministic fallback is verified with ranking disabled;
- enabled-before-implementation still serves deterministic fallback;
- suppression filtering is preserved;
- cache headers remain private/no-store;
- documentation distinguishes local MVP simulation from hosted QA/UAT or production approval.

Ranking remains disabled. Phase 7D does not implement ranking, personalize ordering, or read aggregate tables for served ordering.
