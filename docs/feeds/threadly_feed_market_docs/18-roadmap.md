# Roadmap and Implementation Sequencing

## Phase 0 - Documentation and validation

- locate and verify the feeds documentation pack;
- audit backend, web, and mobile implementation state;
- validate codebase models, routes, indexes, scripts, cache, admin, and patch semantics;
- align this documentation pack to repo reality;
- resolve documentation Git ownership before starting Phase 1.

Current Phase 0 result on 2026-05-23:
- backend/web/mobile audit complete;
- original docs pack found outside the allowed repos;
- Phase 0B canonical path is `bthreadly/docs/feeds/threadly_feed_market_docs/`;
- Phase 0B resolved documentation ownership by committing the canonical docs pack under the backend repo.

## Phase 1 - Stop static/client-heavy rendering and define shared section contract

Status: completed on 2026-05-24, with deterministic V1 behavior only.

- create backend market section preview DTO and cursor-backed View All endpoint;
- stop web `MarketPlace.tsx` from loading up to 4800 products client-side;
- fix or replace category filtering so it is wired end to end;
- preserve old product/design endpoints temporarily as compatibility sources;
- keep ranking deterministic and mostly non-personalized until signal models exist;
- align mobile Discover and web Market on the shared section contract.

Outcome:
- backend now exposes `GET /market/sections` and `GET /market/sections/:key`.
- `collections/market` category passthrough is wired controller-to-service.
- web Market home uses backend section previews first and falls back to one capped 24-product request.
- mobile has typed market section API methods but still renders local sections.
- no personalization, signal engine, admin config, ML ranking, or suggestion engine was implemented in Phase 1.
- Phase 2 must not start until the Phase 1 repo commits are pushed to `origin/main`.

## Phase 2 - Signal, seen, suppression, and cache safety foundation

Status: completed on 2026-05-24 after Phase 2 commits are pushed, with ranking personalization still deferred.

- add feed/market/suggestion signal models;
- add seen-content tracking;
- add suppression models;
- add batched signal emission on web;
- add typed mobile signal/suppression API methods;
- add personalized response cache-control policy;
- add section/suggestion analytics foundation.

Outcome:
- backend can collect bounded feed/market/suggestion signals;
- backend can persist seen items, suppressions, and reset markers;
- market sections exclude active suppressions where safe;
- web emits batched section/item/open/not-interested signals for the Phase 1 Market section surface;
- mobile has the shared API contract but no runtime queue yet.

Deferred from Phase 2:
- mobile offline queue/AppState flush behavior;
- strict batch idempotency;
- Redis/BullMQ signal ingestion;
- aggregate jobs;
- ranking personalization;
- admin ranking/signal governance UI.

## Former Phase 3 - Ranking profiles, formula versions, and personalization

Superseded sequencing note on 2026-05-24: Phase 3 was re-scoped to durable signal queue/idempotency, aggregation foundation, and mobile runtime instrumentation before ranking. Ranking profiles and personalized ordering remain deferred.

## Phase 3 - Durable signal queue, aggregation foundation, and mobile runtime instrumentation

Status: completed on 2026-05-24 after Phase 3 commits are pushed, with ranking personalization still deferred.

- re-audit Phase 2 signal, suppression, reset, cache, web, mobile, and docs implementation;
- add optional client event IDs and durable duplicate batch receipts;
- add daily aggregate counter foundation without changing ranking;
- keep `/market/sections` and feed ordering deterministic/non-personalized;
- add mobile runtime queue, AppState flush, section/item/open instrumentation, and bounded retry;
- align web signal events to backend idempotency;
- document Redis/BullMQ decision.

Outcome:
- backend skips duplicate `batchId` replays for the same user/session;
- backend skips duplicate client event IDs inside a batch and recently persisted client event IDs;
- backend writes `MarketSignalAggregateDaily` counter buckets for future ranking work;
- web emits client event IDs through the existing bounded queue;
- mobile MarketScreen now emits bounded runtime signals and flushes on AppState background/inactive;
- reset returns explicit soft-reset policy and does not delete raw analytics, seen history, suppressions, or global aggregates;
- Redis/BullMQ market signal queue remains deferred until a safe queue/worker gate is added.

Deferred from Phase 3:
- signal-driven feed/market ranking;
- Redis/BullMQ market signal producer/consumer;
- persisted mobile offline queue;
- admin ranking governance;
- full hide/not-interested mobile UI.

## Phase 4 - Ranking design gate, aggregate QA, and safe personalization readiness

Status: completed on 2026-05-24 after Phase 4 commit is pushed. Ranking personalization remains deferred.

- re-audit Phase 3 signal ingestion, idempotency, aggregation, suppression, reset, web signal IDs, and mobile runtime queue;
- confirm migration readiness without destructive database reset;
- strengthen aggregate/idempotency/reset tests;
- document conservative ranking rules before implementation;
- create aggregate QA/UAT checklist;
- keep `/market/sections`, `/market/sections/:key`, feed output, and market ordering deterministic/non-personalized.

Outcome:
- `docs/market-ranking-design-gate.md` defines ranking goals, non-goals, hard filters, cold-start behavior, guest behavior, freshness, repetition control, suppression/reset behavior, diversity/fairness, scoring proposal, rollout, metrics, fallback, QA acceptance, and open decisions;
- `docs/market-signal-aggregation-qa-checklist.md` defines migration, ingestion, idempotency, aggregation, suppression, reset, mobile queue, web queue, ranking-readiness, and release-blocker checks;
- aggregate tests now cover View All clicks, seen timestamps, anonymous/user bucket isolation, fingerprint dedupe without client IDs, and widened aggregate-key budget;
- `MarketSignalAggregateDaily.aggregateKey` is widened to `VARCHAR(512)` to avoid max-length aggregate-key failures;
- local migration status may still show pending aggregate migrations until the target database advisory lock clears or deployment migration flow applies them.

Deferred from Phase 4:
- signal-driven market/feed ranking;
- Redis/BullMQ market signal worker;
- ranking profile/formula version tables;
- admin ranking governance UI;
- non-personalized toggle UI;
- durable mobile offline queue.

## Phase 5 - Migration QA, feature flag/rollback plan, and ranking gate acceptance

Status: Phase 5 gate documentation added on 2026-05-24. Ranking remains disabled.

- re-audit Phase 4 artifacts and confirm aggregate tables are not used for feed or market ordering;
- harden migration QA instructions for the Phase 3 and Phase 4 aggregate migrations;
- define disabled-by-default ranking feature flags and deterministic fallback behavior;
- define rollback triggers, owner placeholders, and kill-switch behavior;
- define backend, product, and infrastructure monitoring requirements;
- define the Redis/BullMQ decision gate before high-volume ranking;
- keep `/market/sections`, `/market/sections/:key`, feed output, and market ordering deterministic/non-personalized.

Outcome:
- `docs/market-ranking-release-plan.md` defines the release gate, feature flags, rollout stages, rollback behavior, owner placeholders, monitoring requirements, kill switch, and Redis/BullMQ decision gate;
- `docs/market-signal-aggregation-qa-checklist.md` now includes exact aggregate migration order, backup requirements, `migrate deploy` guidance, post-migration SQL checks, rollback notes, advisory-lock guidance, and a destructive-reset warning;
- local validation still reports the two aggregate migrations as pending until they are applied through the normal development or QA/UAT deploy path;
- ranking implementation remains blocked until aggregate migrations are applied in QA/UAT, feature flags are implemented and tested, owner placeholders are replaced, monitoring is ready, and rollback is rehearsed.

Deferred from Phase 5:
- signal-driven market/feed ranking;
- context-aware product/detail suggestion blocks;
- Redis/BullMQ market signal worker;
- admin ranking governance UI;
- durable mobile offline queue.

## Phase 6 - Ranking flag foundation and deterministic fallback tests

Status: completed on 2026-05-24 after Phase 6 commit is pushed. Ranking remains disabled.

- add backend ranking flag parsing with safe defaults;
- wire ranking config into market sections as a no-op fallback guard;
- prove deterministic market section ordering remains served when ranking flags are absent, disabled, or enabled before implementation exists;
- prove aggregate tables are not read for ordering;
- keep `/market/sections`, `/market/sections/:key`, feed output, and market ordering deterministic/non-personalized.

Outcome:
- `MarketRankingConfigService` reads `MARKET_RANKING_*` env values with safe defaults, clamping, and section-key normalization;
- market section service consumes the config without changing served output;
- focused tests cover config defaults, invalid/clamped values, section-key bounds, deterministic fallback, suppression preservation, and cache headers.

Deferred from Phase 6:
- signal-driven market/feed ranking;
- shadow-ranked response generation;
- Redis/BullMQ market signal worker;
- admin ranking governance UI;
- durable mobile offline queue.

## Future phase - Context-aware market suggestion blocks

- product detail suggestions;
- collection detail suggestions;
- brand/store suggestions;
- search-empty suggestions;
- new-brand reserved slots;
- suggestion suppression;
- suggestion analytics.

## Future phase - User controls and admin governance

- user feed settings;
- hidden/muted management;
- reset preferences;
- admin screens for categories, sections, suggestions, ranking profiles;
- feed/ranking-specific permissions;
- admin audit integrity for every config/version change;
- formula versioning and audit.

Outcome:
- production governance and user control.

## Phase 7 - Optimization and fairness

- aggregate jobs;
- velocity scoring;
- new-brand exposure monitor;
- brand quality scoring;
- duplicate/counterfeit detection V1;
- performance tuning.

Outcome:
- more scalable, fair, high-quality recommendation system.

## V2

- cart suggestions;
- checkout success suggestions;
- visual similarity;
- embeddings;
- collaborative filtering;
- advanced seasonal/event curation;
- live shopping integrations.
