# Market Ranking Release Plan

Status: Phase 7 operational readiness gate. Ranking is currently disabled.
Date: 2026-05-24

## 1. Purpose

This plan defines the feature flags, rollout controls, rollback path, monitoring requirements, and infrastructure decision gate required before Threadly uses signal aggregates to rank market or feed content.

This document is a release gate, not a ranking implementation. It must be accepted before any code uses aggregate counters to reorder `/market/sections`, `/market/sections/:key`, or feed results.

## 2. Current state

- Ranking is disabled.
- `/market/sections` and `/market/sections/:key` remain deterministic and suppression-aware.
- Raw market/feed signals are captured through bounded batch ingestion.
- Daily aggregates exist as a foundation for future ranking.
- Phase 6 adds code-level env ranking flags through `MarketRankingConfigService`.
- Phase 7 adds monitoring and rollback rehearsal specifications; it does not enable ranking.
- Redis/BullMQ is deferred for the market signal path.
- The Phase 3 and Phase 4 aggregate migrations must be applied in QA/UAT before aggregate QA is considered complete.

## 3. Required feature flags

The future ranking implementation must ship behind disabled-by-default controls:

| Flag | Required default | Purpose |
|---|---:|---|
| `MARKET_RANKING_ENABLED` | `false` | Master switch for aggregate-driven ranking. |
| `MARKET_RANKING_SHADOW_MODE` | `true` | Compute candidate ranked output without serving it to users. |
| `MARKET_RANKING_SECTION_KEYS` | empty | Limits ranking to explicitly approved sections. |
| `MARKET_RANKING_MAX_PERSONALIZED_SECTIONS` | `1` | Caps blast radius during first rollout. |
| `MARKET_RANKING_FALLBACK_DETERMINISTIC` | `true` | Forces deterministic ordering when ranking reads fail or flags are disabled. |

Existing backend patterns that can support this later:
- `SystemConfigService.getBoolean(...)` for admin-managed boolean config.
- The existing `FeatureFlag` bootstrap pattern used by review features.

Phase 6 implementation:
- `src/market/market-ranking-config.service.ts` reads the ranking env flags with safe defaults.
- `MarketSectionService` reads the config but still serves deterministic V1 output.
- Tests prove ranking defaults disabled, invalid values fall back/clamp safely, section keys are normalized/bounded, deterministic fallback remains served when ranking is disabled, and deterministic fallback remains served even when `MARKET_RANKING_ENABLED=true` before ranking exists.
- Aggregate tables are not read for served ordering.

Admin-managed ranking flags remain deferred until audit-backed governance is added.

## 4. Suggested environment variables

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

Environment values should be mirrored into admin config only after an audit trail exists for ranking changes.

## 5. Rollout stages

1. **Disabled baseline**
   - Serve existing deterministic ordering.
   - Keep signal ingestion, suppression, reset markers, and aggregates active.

2. **Shadow mode**
   - Compute ranked candidates for one internal/test section.
   - Do not serve ranked order to users.
   - Compare ranked output against deterministic output for repetition, empty sections, brand concentration, latency, and suppression violations.

3. **Internal allowlist**
   - Serve ranking only to internal QA accounts or sessions.
   - Keep `MARKET_RANKING_MAX_PERSONALIZED_SECTIONS=1`.
   - Disable immediately on any rollback trigger.

4. **Small production percentage**
   - Enable for one approved section and a small user percentage.
   - Keep deterministic fallback on every request.
   - Monitor backend, product, and infrastructure metrics continuously.

5. **Measured expansion**
   - Expand section keys only after QA acceptance and metric review.
   - Do not enable ranking globally until queue/worker capacity and monitoring are proven.

## 6. Rollback behavior

Rollback triggers:
- increased `/market/sections` latency;
- empty section rate spike;
- suppressed content appearing;
- repeated item spike;
- one-brand domination;
- aggregate query failure;
- user complaints tied to feed quality;
- backend error-rate increase;
- signal ingestion or aggregation failure increase.

Rollback action:
- set `MARKET_RANKING_ENABLED=false`;
- keep `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`;
- return deterministic ordering for all market/feed surfaces;
- stop aggregate-driven ranking reads;
- keep signal ingestion active if it remains healthy;
- keep suppression filters active;
- keep reset markers intact.

Rollback must not delete raw signals, seen rows, suppressions, reset markers, or global aggregate rows.

## 7. Owner and responsibility matrix

| Responsibility | Owner |
|---|---|
| Feature flag enable/disable | `<engineering-owner>` |
| Product acceptance and rollout approval | `<product-owner>` |
| QA/UAT migration verification | `<qa-owner>` |
| Monitoring dashboard readiness | `<engineering-owner>` |
| Rollback decision during incident | `<engineering-owner>` with `<product-owner>` informed |
| User-facing support note if needed | `<product-owner>` |

Owner placeholders must be replaced before ranking ships.

## 8. Monitoring requirements

Backend:
- `/market/sections` latency p50/p95/p99;
- aggregate read latency;
- aggregate query failure rate;
- empty section rate;
- fallback activation count;
- suppression violation count;
- signal ingest count;
- signal dedupe count;
- aggregation failure count;
- batch replay count.

Product:
- repeated item rate;
- brand concentration;
- section engagement;
- hide/not-interested rate;
- reset rate;
- conversion/open rate.

Infrastructure:
- database CPU, memory, connection count, and slow queries;
- queue lag if Redis/BullMQ later exists;
- worker failure count if workers later exist.

Minimum dashboard requirement before enablement:
- one dashboard showing latency, errors, fallback activations, empty sections, suppression violations, signal ingestion, dedupe, aggregation failures, and repeated item rate.

## 9. QA acceptance before enabling

Ranking cannot be enabled until:
- `npx prisma migrate status` shows no pending aggregate migrations in QA/UAT;
- aggregate QA checklist passes;
- shadow mode output is generated without serving ranked order;
- deterministic fallback is tested by disabling the ranking flag;
- suppression violations are zero in QA;
- reset markers are respected by the proposed ranking logic;
- one-brand domination and repeated item rates are within accepted thresholds;
- owner placeholders are replaced;
- rollback process is rehearsed in QA/UAT.

## 10. Kill-switch behavior

The master kill switch is `MARKET_RANKING_ENABLED=false`.

Expected behavior when the kill switch is off:
- no aggregate-driven ordering is served;
- deterministic Phase 1 section ordering is used;
- section eligibility filters still apply;
- suppressions still apply;
- signal ingestion may continue;
- aggregate writes may continue if healthy;
- no user-visible error is shown.

## 11. Redis/BullMQ decision gate

Current status: **deferred**.

Threadly has Redis-backed queue infrastructure elsewhere, but the market signal path does not yet have a dedicated safe queue, worker, retry policy, dead-letter policy, or deployment gate. Phase 5 does not add Redis/BullMQ.

Ranking may start only in shadow or low-volume mode while synchronous aggregation remains bounded. High-volume aggregate-driven ranking is blocked until a queue/worker path is approved.

Queue adoption becomes mandatory before expanding ranking if any threshold is met:
- sustained signal volume exceeds 100,000 events/day;
- sustained signal ingest exceeds 10 events/second for 15 minutes;
- signal batch p95 latency exceeds 250 ms for 15 minutes;
- `/market/sections` p95 latency exceeds 500 ms because of aggregate reads;
- database CPU exceeds 70% for 15 minutes during market traffic;
- aggregate update failure rate exceeds 1% for 15 minutes;
- ranking expansion requires more than one personalized section.

Required Redis/BullMQ design inputs before adoption:
- queue names;
- Redis connection and eviction policy;
- worker deployment process;
- retry and dead-letter policy;
- job idempotency key strategy;
- queue lag alerts;
- local/test fallback behavior.

## 12. Open decisions

- Final ranking owner names.
- Whether ranking flags should later mirror from environment config into `SystemConfig`, `FeatureFlag`, or both for audited admin governance.
- Initial section key for shadow mode.
- Exact production rollout percentage.
- Accepted thresholds for repeated item rate and brand concentration.
- Whether anonymous aggregate data can ever merge into authenticated user state.
- Whether signal ingestion should continue during every rollback scenario or pause on high DB load.

## 13. Phase 6 implemented code gate

Implemented:
- env-backed `MarketRankingConfigService`;
- safe defaults:
  - ranking enabled: `false`;
  - shadow mode: `true`;
  - section keys: empty list;
  - max personalized sections: `1`;
  - deterministic fallback: `true`;
  - exploration percent: `10`;
  - brand max share: `35`;
  - aggregate timeout: `150ms`;
- clamping/normalization for invalid numeric and section-key values;
- no-op wiring into `MarketSectionService`;
- deterministic fallback tests.

Still not implemented:
- ranking formulas;
- aggregate reads for ordering;
- shadow-ranked response generation;
- admin flag UI;
- Redis/BullMQ market ranking worker.

## 14. Phase 7 operational gate

Phase 7 adds the operational evidence required before ranking implementation can start. It does not change served ordering, read aggregate tables for `/market/sections`, or enable personalization.

Added:
- `docs/market-ranking-monitoring-plan.md`;
- `docs/market-ranking-rollback-rehearsal.md`.

Migration status:
- local validation on 2026-05-24 still reports these migrations as pending:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- QA/UAT must apply them with `npx prisma migrate deploy`;
- destructive reset remains forbidden.

Monitoring status:
- required dashboard metrics, alert thresholds, log fields, fallback tracking, suppression violation monitoring, empty-section monitoring, repeated-item monitoring, brand concentration monitoring, aggregate read monitoring, and signal ingest/dedupe monitoring are specified;
- dashboards and alerts are not implemented in this repository.

Rollback rehearsal status:
- the QA/UAT rehearsal now defines baseline flags, enable/disable sequence, expected deterministic fallback behavior, aggregate read failure simulation, suppression verification, empty-section verification, cache checks, and pass/fail criteria;
- the rehearsal is not complete until it runs in QA/UAT after the pending aggregate migrations are applied.

Remaining release blockers:
- apply both aggregate migrations in QA/UAT;
- implement or provision the monitoring dashboard and alerts;
- replace `<engineering-owner>`, `<product-owner>`, and `<qa-owner>`;
- execute and pass rollback rehearsal;
- keep ranking disabled until the above gates are complete.

## 15. Phase 7B readiness verification

Phase 7B verified the operational gate without implementing ranking.

Current status:
- ranking remains disabled by default through `MarketRankingConfigService`;
- `/market/sections` and `/market/sections/:key` still serve deterministic fallback output;
- aggregate tables are not read for served ordering;
- suppression filtering still applies through `MarketSuppressionService`;
- cache headers remain `Cache-Control: private, no-store` for market section routes.

Migration status:
- `npx prisma validate` passes;
- `npx prisma generate` passes;
- local `npx prisma migrate status` still reports:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- the migration files are committed and present in `prisma/migrations`;
- no migration drift was reported by `migrate status`; the blocker is unapplied local/QA/UAT migrations.

Monitoring implementability:
- the backend has request ID logging, structured HTTP duration logs, optional Prisma slow-query logs, and a review-specific structured logging precedent;
- no market ranking dashboard, alerting stack, shared metrics sink, or `Server-Timing` instrumentation is implemented;
- a QA manual substitute is not accepted by default and must be explicitly approved by owner placeholders before use.

Owner assignment required before production ranking rollout:
- `<engineering-owner>`, `<product-owner>`, and `<qa-owner>` remain explicit release blockers;
- no owner names should be inferred or invented from repository history.

Rollback rehearsal:
- `docs/market-ranking-rollback-rehearsal.md` now contains an executable QA/UAT checklist;
- rehearsal is blocked until QA/UAT migrations are applied and owner placeholders are resolved or explicitly carried as blockers.

Verdict:
- ready for ranking implementation: **No**;
- required next action: apply pending aggregate migrations in QA/UAT, provision monitoring/alerts or approve a manual QA substitute, assign owners, and pass rollback rehearsal.
