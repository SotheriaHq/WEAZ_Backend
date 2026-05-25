# Market Ranking Monitoring Plan

Status: Phase 7 operational readiness plan. Ranking is disabled.
Date: 2026-05-24

## Purpose

Define the monitoring, dashboard, alerting, and logging requirements that must exist before any aggregate-driven market ranking is enabled. This is an operational specification only. It does not implement dashboards, alerts, ranking logic, aggregate reads for ordering, or Redis/BullMQ.

## Current state

- `MarketRankingConfigService` exists and defaults ranking off.
- `/market/sections` and `/market/sections/:key` remain deterministic.
- Aggregate tables are not read for served ordering.
- Local `npx prisma migrate status` still reports pending aggregate migrations:
  - `20260524150000_add_market_signal_idempotency_aggregation`
  - `20260524170000_widen_market_signal_aggregate_key`
- Owner placeholders remain unresolved:
  - `<engineering-owner>`
  - `<product-owner>`
  - `<qa-owner>`

## Dashboard requirements

Before ranking can be enabled, create a dashboard with:

- market API latency and error rate;
- ranking flag state and rollout scope;
- fallback activation count;
- empty section rate;
- suppression violation count;
- repeated item rate;
- brand concentration rate;
- aggregate read latency and failure rate;
- signal ingest, dedupe, and batch replay counts;
- aggregation success/failure counts;
- database load and slow queries;
- rollback action timeline.

The dashboard must support filtering by:
- environment;
- section key;
- user type: guest, authenticated, internal QA;
- app surface: web, mobile, API;
- release version or deployment ID.

## Metrics

### Backend API

| Metric | Type | Required labels |
|---|---|---|
| `market_sections_request_count` | counter | route, status, sectionKey, rankingEnabled, fallbackUsed |
| `market_sections_latency_ms` | histogram | route, sectionKey, rankingEnabled, fallbackUsed |
| `market_sections_error_count` | counter | route, status, reason |
| `market_sections_empty_count` | counter | sectionKey, reason |
| `market_sections_fallback_count` | counter | sectionKey, reason |
| `market_sections_suppression_violation_count` | counter | sectionKey, targetType, suppressionType |

### Ranking flags

| Metric | Type | Required labels |
|---|---|---|
| `market_ranking_flag_state` | gauge | flag, value, environment |
| `market_ranking_shadow_mode_count` | counter | sectionKey, enabled |
| `market_ranking_section_scope_count` | gauge | environment |

### Aggregate reads

| Metric | Type | Required labels |
|---|---|---|
| `market_aggregate_read_count` | counter | sectionKey, aggregateType, status |
| `market_aggregate_read_latency_ms` | histogram | sectionKey, aggregateType |
| `market_aggregate_read_failure_count` | counter | sectionKey, aggregateType, reason |
| `market_aggregate_timeout_count` | counter | sectionKey, aggregateType |

### Signal ingestion and aggregation

| Metric | Type | Required labels |
|---|---|---|
| `market_signal_ingest_count` | counter | userType, surface, status |
| `market_signal_batch_size` | histogram | userType, surface |
| `market_signal_dedupe_count` | counter | userType, reason |
| `market_signal_batch_replay_count` | counter | userType |
| `market_signal_aggregation_success_count` | counter | aggregateType |
| `market_signal_aggregation_failure_count` | counter | aggregateType, reason |

### Product quality

| Metric | Type | Required labels |
|---|---|---|
| `market_repeated_item_rate` | gauge | sectionKey, userType |
| `market_brand_concentration_rate` | gauge | sectionKey, userType |
| `market_hide_not_interested_rate` | gauge | sectionKey, userType |
| `market_reset_rate` | gauge | userType |
| `market_open_rate` | gauge | sectionKey, userType |

## Alert thresholds

Initial alert thresholds before broader ranking rollout:

| Alert | Threshold | Action |
|---|---|---|
| Market p95 latency | `> 500 ms` for 15 minutes | Disable ranking flag if ranking is enabled. |
| Market p99 latency | `> 1000 ms` for 5 minutes | Disable ranking flag and review DB load. |
| Aggregate read failure rate | `> 1%` for 15 minutes | Disable aggregate-driven reads. |
| Aggregate read p95 latency | `> 150 ms` for 15 minutes | Keep deterministic fallback active. |
| Empty section rate | `> 2x baseline` for 15 minutes | Disable ranking for affected section keys. |
| Suppression violations | `> 0` confirmed cases | Disable ranking and investigate before re-enable. |
| Repeated item rate | `> 20%` above baseline | Keep ranking in shadow mode. |
| Brand concentration | one brand exceeds `35%` of a section response | Keep ranking in shadow mode or reduce rollout scope. |
| Signal aggregation failures | `> 1%` for 15 minutes | Pause ranking expansion. |
| DB CPU | `> 70%` for 15 minutes during market traffic | Keep ranking disabled or roll back. |

Thresholds must be reviewed against QA/UAT baseline data before production enablement.

## Required log fields

Every future ranked market request should log a compact structured record with:

- `requestId`;
- `userId` or anonymous marker, never raw anonymous session payload in shared logs;
- `anonymousSessionIdHash` when applicable;
- `route`;
- `sectionKey`;
- `rankingEnabled`;
- `shadowMode`;
- `fallbackUsed`;
- `fallbackReason`;
- `deterministicFallbackAvailable`;
- `candidateCount`;
- `servedItemCount`;
- `suppressedItemCount`;
- `aggregateReadCount`;
- `aggregateReadLatencyMs`;
- `aggregateReadFailureReason`;
- `repeatedItemCount`;
- `topBrandId`;
- `topBrandShare`;
- `durationMs`;
- `statusCode`;
- `deploymentId`.

Do not log raw metadata, private profile fields, payment data, message content, or exact free-form user input.

## Fallback activation tracking

Fallback activation must be counted when:

- `MARKET_RANKING_ENABLED=false`;
- `MARKET_RANKING_FALLBACK_DETERMINISTIC=true`;
- aggregate read fails;
- aggregate read exceeds timeout;
- ranking section key is not allowlisted;
- ranked candidate pool is empty;
- suppression filtering removes every ranked candidate;
- ranking result fails validation.

Fallback tracking must include `fallbackReason` and `sectionKey`.

## Suppression violation monitoring

A suppression violation is any response that serves:

- suppressed item target;
- suppressed brand;
- suppressed category;
- suppressed section;
- suppressed suggestion block, once suggestion blocks exist.

Required checks:
- QA assertions for seeded suppressions;
- runtime debug counter for filtered vs served targets;
- incident review for every confirmed violation;
- ranking disabled until the violation class is fixed.

## Empty section monitoring

Track empty sections by:

- section key;
- candidate count before filters;
- candidate count after visibility filters;
- candidate count after suppressions;
- fallback reason;
- environment.

Alert when a core section goes empty above baseline. A ranked section must fall back to deterministic candidates or hide safely without broken cards.

## Repeated item monitoring

Track repeated items within:

- one section response;
- one market home response;
- a user's recent session window;
- cross-device authenticated session where available.

Initial rule:
- repeated item rate cannot exceed 20% above deterministic baseline during shadow mode.

## Brand concentration monitoring

Track:

- top brand share per section;
- top three brand share per section;
- count of unique brands per section;
- new-brand exposure count.

Initial guard:
- no single brand should exceed 35% of a ranked section response unless the candidate pool is too small and deterministic fallback would do the same.

## Aggregate read latency monitoring

Future aggregate reads must report:

- count of aggregate rows queried;
- lookback window;
- query duration;
- timeout count;
- failure reason.

If aggregate read p95 exceeds 150 ms or failures exceed 1%, ranking remains disabled or falls back.

## Signal ingest and dedupe monitoring

Track:

- accepted events;
- persisted events;
- deduped events by reason;
- rejected events by validation reason;
- batch replay count;
- aggregation success/failure count;
- anonymous vs authenticated split.

Signal ingestion must not block deterministic market rendering.

## Owner placeholders

| Responsibility | Owner |
|---|---|
| Dashboard creation | `<engineering-owner>` |
| Alert threshold approval | `<engineering-owner>` |
| Product quality metric approval | `<product-owner>` |
| QA/UAT monitoring verification | `<qa-owner>` |
| Incident rollback decision | `<engineering-owner>` |
| User-facing rollout communication | `<product-owner>` |

These placeholders are release blockers until replaced.

## Release gate

Ranking implementation must not be enabled until:

- this monitoring plan is implemented in the chosen observability stack;
- QA/UAT aggregate migrations are applied;
- deterministic fallback can be observed through metrics;
- suppression violations are monitored;
- owner placeholders are replaced;
- rollback rehearsal passes.

## Phase 7B implementability audit

Current backend foundations:
- `src/common/middleware/request-logger.middleware.ts` assigns and returns `x-request-id`, records method, path, status, duration, and IP through Nest `Logger`;
- `src/prisma/prisma.service.ts` can emit slow-query logs when `PRISMA_LOG_QUERIES=true` and `PRISMA_SLOW_QUERY_MS` is configured;
- `src/reviews/reviews-observability.service.ts` provides a local precedent for structured metric-like logger events;
- market signal and suppression services already use Nest `Logger` for service-level warnings.

Missing infrastructure:
- no shared metrics sink was found for market ranking metrics;
- no production dashboard definition is implemented in this repository;
- no alerting integration is implemented in this repository;
- no `Server-Timing` header or per-route market latency metric is implemented for ranking readiness;
- no approved QA manual substitute has been recorded.

Phase 7B decision:
- do not add a full monitoring stack inside this phase;
- keep this document as the required implementation contract for the chosen observability stack;
- allow QA/UAT to use a manual evidence substitute only after `<engineering-owner>`, `<product-owner>`, and `<qa-owner>` explicitly accept it for that environment.

Owner assignment required before production ranking rollout:
- `<engineering-owner>` must own dashboard and alert implementation;
- `<product-owner>` must approve product quality thresholds for repetition, brand concentration, suppression violations, and engagement;
- `<qa-owner>` must own QA/UAT evidence capture and rehearsal sign-off.

These placeholders are intentional release blockers. They must not be interpreted as assigned owners.

## Phase 7D local MVP monitoring substitute

External QA/UAT monitoring remains unavailable. For the local/single-environment MVP workflow, Phase 7D accepts a manual local monitoring substitute only for ranking implementation readiness.

Local substitute:
- backend request logs provide `x-request-id`;
- backend request logs provide request duration evidence;
- Prisma slow-query logs can be enabled locally with:

```text
PRISMA_LOG_QUERIES=true
PRISMA_SLOW_QUERY_MS=100
```

- cache headers are captured manually with local HTTP requests;
- response metadata is captured manually;
- item IDs are captured before, during, and after ranking-flag rehearsal;
- suppression fixture evidence is captured manually;
- fallback evidence is captured manually.

Owner simulation for local MVP:
- Engineering owner: Shawn / solo project owner;
- Product owner: Shawn / solo project owner;
- QA owner: Shawn / solo project owner.

Limitations:
- no production dashboard is provisioned;
- no alerting stack is provisioned;
- no metrics sink is implemented;
- no production `Server-Timing` or fallback counter is implemented;
- this substitute must not be treated as hosted production readiness.

## Phase R1 lightweight backend logging

Phase R1 does not add a dashboard, metrics sink, or alerting stack.

It does add compact backend debug logs for the ranking path:
- ranking skipped because disabled;
- ranking skipped because a section is not allowlisted;
- aggregate read success;
- aggregate read failure;
- aggregate read timeout;
- deterministic fallback used;
- shadow mode computed but not served;
- aggregate ranking served.

Log payloads are intentionally small and may include:
- section key;
- ranking flag state;
- shadow mode state;
- fallback reason;
- candidate count;
- served item count;
- aggregate count;
- duration in milliseconds.

Log payloads must not include raw user metadata, anonymous session IDs, payment data, secrets, or full market response payloads.

Production monitoring remains required before any broad rollout. The R1 logs are a local/MVP diagnostic foundation, not a replacement for the dashboard and alerts described above.
