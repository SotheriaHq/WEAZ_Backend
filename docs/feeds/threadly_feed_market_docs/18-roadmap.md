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

## Corrected phase map - 2026-05-25

Phase names are normalized here so future feed/market work continues with normal phase numbers instead of temporary `R` labels.

| Phase | Meaning | Status |
|---|---|---|
| Phase 0 | Ground-truth audit and docs alignment | Completed |
| Phase 0B | Canonical docs ownership | Completed |
| Phase 1 | Backend market section foundation and web load reduction | Completed |
| Phase 2 | Signal, seen, suppression, reset, and cache-safety foundation | Completed |
| Phase 3 | Signal idempotency and aggregation foundation | Implemented |
| Phase 4 | Aggregate schema/key hardening | Implemented as part of aggregate QA/design-gate work |
| Phase 5 | Aggregation QA and ranking release checklist | Docs/release-gate only |
| Phase 6 | Ranking flag and deterministic fallback foundation | Implemented |
| Phase 7 | Local MVP ranking readiness simulation | Completed locally |
| Phase 8 | Backend aggregate ranking behind safety flags | Implemented; formerly Phase R1 |
| Phase 8B | Workspace safety gate after backend ranking | Completed; formerly Phase R1C |
| Phase 9 | Web/mobile ranking metadata contract integration | Completed; formerly Phase R2 |
| Phase 10 | Market section View All and pagination hardening | Completed |
| Phase 11A | Context-aware market suggestion engine contract gate | Completed; runtime deferred |
| Phase 11B | Context-aware market suggestion engine implementation | Completed for backend runtime, web core surfaces, and mobile API contract |
| Phase 11C | Deferred suggestion UI completion and runtime polish | Completed for web brand/store and mobile product/collection/search-empty UI |
| Phase 12 | User market/feed controls | Completed for web settings, mobile settings, and backend coverage |
| Phase 13A | Admin governance contract gate | Completed as docs/contract; runtime implementation deferred |
| Phase 13B | Backend admin governance runtime | Completed for backend runtime; web UI deferred |
| Phase 13C | Web admin governance UI | Completed for web admin UI |
| Phase 14 | Final hardening, independent audit, MVP blocker fixes, and controlled MVP checklist | Phase 14D checklist prepared; production readiness deferred |

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

## Phase 7 - QA/UAT migration, monitoring, and rollback rehearsal

Status: Phase 7 gate documentation added on 2026-05-24. Ranking remains disabled.

- re-audit aggregate migration readiness;
- document monitoring dashboard, alert, and logging requirements;
- document rollback rehearsal sequence and pass/fail criteria;
- keep `/market/sections`, `/market/sections/:key`, feed output, and market ordering deterministic/non-personalized;
- keep Redis/BullMQ deferred for the market signal path.

Outcome:
- `docs/market-ranking-monitoring-plan.md` defines required metrics, dashboard filters, alert thresholds, log fields, fallback activation tracking, suppression violation monitoring, empty-section monitoring, repeated-item monitoring, brand concentration monitoring, aggregate read monitoring, signal ingest/dedupe monitoring, and owner placeholders;
- `docs/market-ranking-rollback-rehearsal.md` defines QA/UAT prerequisites, baseline flags, enable/disable sequence, deterministic fallback expectations, aggregate read failure simulation, suppression verification, empty-section fallback verification, cache checks, pass/fail criteria, and rehearsal record template;
- `docs/market-ranking-release-plan.md` and `docs/market-signal-aggregation-qa-checklist.md` now reflect Phase 7 operational blockers.

Deferred from Phase 7:
- signal-driven market/feed ranking;
- aggregate reads for served ordering;
- monitoring dashboard implementation;
- Redis/BullMQ market signal worker;
- admin ranking governance UI.

## Phase 7 operational readiness verification

Status: readiness verification added on 2026-05-24. Ranking remains disabled and not ready for implementation.

- verify Prisma schema and migration status;
- verify ranking flags still default to deterministic fallback;
- verify market section routes do not read aggregate tables for served ordering;
- verify web and mobile clients do not assume personalized/ranked market output;
- formalize monitoring implementability and owner placeholders;
- make rollback rehearsal checklist executable for QA/UAT.

Outcome:
- backend validation confirms schema/generate pass and the two aggregate migrations remain pending locally;
- focused backend tests now cover market home deterministic fallback with ranking enabled-before-implementation and no aggregate read for served ordering;
- monitoring docs now distinguish existing logging foundations from missing dashboard/alert infrastructure;
- rollback docs now include a concrete QA/UAT execution checklist;
- ranking remains blocked until QA/UAT migrations, monitoring/alerts or an approved manual substitute, owner assignment, and rollback rehearsal are complete.

Deferred from Phase 7 operational verification:
- signal-driven market/feed ranking;
- aggregate reads for served ordering;
- suggestion engine implementation;
- production monitoring dashboard implementation;
- Redis/BullMQ market signal worker.

## Phase 7 - Local MVP ranking readiness simulation

Status: completed locally on 2026-05-25 after validation and backend docs commit. Ranking remains disabled and not live.

- replace external QA/UAT assumptions with local/single-environment MVP simulation;
- create a local database restore point without committing dumps;
- apply pending aggregate migrations locally without destructive reset;
- verify deterministic fallback with ranking disabled;
- verify ranking enable-before-implementation still serves deterministic fallback;
- verify suppression filtering and private/no-store cache headers;
- document local owner simulation and monitoring substitute.

Outcome:
- local database target `localhost:5432/threadly/public` is up to date after applying:
  - `20260524150000_add_market_signal_idempotency_aggregation`;
  - `20260524170000_widen_market_signal_aggregate_key`;
- `docs/market-ranking-local-simulation.md` records the local backup, migration, monitoring substitute, owner simulation, and rollback rehearsal evidence;
- Shawn is recorded as engineering/product/QA owner only for local MVP simulation;
- external QA/UAT approval, production monitoring, and enterprise governance remain separate future rollout concerns.

Ready for ranking implementation locally: **Yes**.

Deferred from Phase 7:
- signal-driven market/feed ranking implementation;
- aggregate reads for served ordering;
- production monitoring dashboard implementation;
- production owner governance;
- Redis/BullMQ market signal worker.

## Phase 8 - Backend aggregate-driven market ranking behind safety flags

Status: completed on 2026-05-25 after backend validation and commit. Ranking remains disabled by default and is not a production rollout.

- add aggregate reader for bounded `MarketSignalAggregateDaily` reads;
- add formula scorer using freshness, aggregate interaction, commerce signals, section relevance, exploration, and brand diversity cap;
- integrate ranking into `/market/sections` and `/market/sections/:key` only when ranking is enabled, the section key is allowlisted, deterministic fallback is enabled, and shadow mode is off;
- preserve deterministic fallback when ranking is disabled, section is not allowlisted, aggregate reads fail, aggregate reads time out, aggregate tables are empty, or shadow mode is on;
- preserve suppression filtering and private/no-store cache headers;
- add section metadata for ranking state, personalization mode, fallback state, ranking version, shadow mode, and ranking-enabled state;
- keep ML, suggestions, admin governance UI, web/mobile ranking UI, and Redis/BullMQ deferred.

Outcome:
- backend can serve aggregate-contextual section ordering in a controlled local/MVP configuration;
- default environment still serves deterministic V1 output;
- no production readiness is claimed.

Deferred from Phase 8:
- production ranking rollout;
- hosted monitoring dashboard and alerts;
- admin ranking governance;
- web/mobile ranking-specific UI;
- suggestion engine;
- Redis/BullMQ ranking worker.

## Phase 8B - Workspace safety gate after backend ranking

Status: completed on 2026-05-25 with no repo commit.

- preserve unrelated web auth/design/QR work in `stash@{0}: On main: pre-r2-unrelated-web-auth-design-qr-wip`;
- confirm backend, web, and mobile are clean on `main`;
- validate backend market ranking/section tests and build, web TypeScript/build, and mobile TypeScript/signal queue contract;
- do not modify backend ranking code or start client integration.

Outcome:
- workspace was clean and safe for Phase 9 client contract work.

## Phase 9 - Web/mobile ranking contract integration

Status: completed on 2026-05-25 after client type/build validation and commits. Ranking remains disabled by default and no UI redesign is included.

- update web and mobile market API contracts to understand Phase 8 section metadata;
- normalize old/missing metadata safely so pre-Phase 8 responses still render;
- keep web MarketPlace neutral and avoid visible personalization claims unless backend metadata says aggregate ranking is actually served;
- preserve web signal batching, `clientEventId`, and bounded queue behavior;
- preserve mobile runtime signal queue and local section-first MarketScreen rendering;
- document that mobile backend-section migration, suggestions, admin governance UI, and new ranking formulas remain deferred.

Outcome:
- clients can consume deterministic, shadow, fallback, and aggregate metadata safely;
- backend ranking remains behind disabled-by-default flags;
- no production readiness, ML, or full personalization claim is made.

Deferred from Phase 9:
- View All pagination hardening;
- suggestion engine;
- admin ranking governance;
- mobile full backend-section migration;
- ranking-specific visible UI.

## Phase 10 - Market section View All and pagination hardening

Status: completed on 2026-05-25 after backend/web validation and commits. Ranking remains disabled by default.

- harden backend `GET /market/sections/:key` cursor handling for web View All pages;
- keep section detail limit bounded and clamp oversized client limits;
- preserve ranking metadata, private/no-store cache headers, and suppression filtering;
- add web `/market/sections/:sectionKey` route that loads detail pages from the backend section contract;
- add bounded Load More pagination without reintroducing the old multi-thousand-row client aggregation pattern;
- preserve web signal batching and record View All/detail impressions and opens;
- keep mobile API/type support as-is and defer a dedicated mobile detail screen.

Outcome:
- malformed cursors are rejected before Prisma is queried;
- stale Prisma cursor errors are returned as controlled bad requests;
- web View All uses `getMarketSectionDetail` with `limit=24`, aborts stale requests, de-duplicates appended items, and stops at `hasNextPage=false`;
- no suggestions, admin governance, new ranking formula, or production rollout claim is included.

Deferred from Phase 10:
- mobile dedicated section detail screen;
- web scroll restoration after deep product navigation;
- long-grid virtualization if future page sizes grow;
- context-aware market suggestions.

## Phase 11A - Context-aware market suggestion engine contract gate

Status: completed on 2026-05-25 as a documentation/contract gate only. Runtime suggestion endpoints and UI blocks were pending until the Phase 11B implementation.

- audited backend, web, and mobile product detail, collection detail, brand/store, search-empty, and market section detail surfaces;
- selected additive backend contract `GET /market/suggestions`;
- defined supported contexts:
  - `PRODUCT_DETAIL`;
  - `COLLECTION_DETAIL`;
  - `BRAND_DETAIL`;
  - `SEARCH_EMPTY`;
  - `MARKET_SECTION_DETAIL`;
- defined target types:
  - `PRODUCT`;
  - `COLLECTION`;
  - `BRAND`;
  - `CATEGORY`;
  - `SECTION`;
  - `QUERY`;
- aligned response shape with the existing `MarketSectionItemDto` card contract;
- documented deterministic V1 strategy matrix, fallback rules, suppression behavior, signal requirements, and Phase 11B implementation file map.

Outcome:
- Phase 11B can implement the runtime suggestion endpoint and first UI blocks from a stable contract;
- no suggestion runtime, suggestion UI, ranking formula change, admin governance UI, ML, or production rollout was added;
- ranking remains disabled by default and suggestions must not claim full personalization unless future backend metadata truly supports it.

## Phase 11B - Context-aware market suggestion implementation

Status: completed on 2026-05-25 after backend, web, and mobile validation and commits. Suggestions are deterministic V1 blocks only.

Implemented:
- backend `GET /market/suggestions` in the market module;
- backend DTOs, controller, service, and tests for deterministic suggestion blocks;
- product detail suggestions:
  - More Like This;
  - More From This Brand;
  - Fresh Alternatives;
- collection detail suggestions:
  - Pieces From This Edit;
  - More From This Brand;
  - Similar Collections;
- brand detail suggestions in the backend:
  - Best From This Brand;
  - Latest Collections;
  - Designers to Watch fallback;
- search-empty suggestions:
  - Try These Instead;
  - Fresh Market Picks;
  - Latest Collections;
- active suppression filtering for item, brand, category, section, and suggestion-block suppressions where metadata supports it;
- private/no-store cache headers;
- web suggestion API contract and reusable `MarketSuggestionBlocks`;
- web integration on product detail, inline product detail, collection detail, and search-empty states;
- web suggestion block/item view, click, and hide events through the existing batched signal queue;
- mobile suggestion API contract only.

Deferred:
- market section detail suggestions, which currently return a safe deferred response;
- brand/store web UI integration;
- mobile runtime suggestion UI;
- suggestion block View All/detail pages;
- admin suggestion governance;
- ML, embeddings, collaborative filtering, and visual similarity;
- production suggestion monitoring dashboard.

Deferred beyond Phase 11B:
- admin suggestion block configuration;
- ML, embeddings, collaborative filtering, and visual similarity;
- cart and checkout-success suggestions;
- production suggestion monitoring dashboard;
- full mobile backend-section migration.

## Phase 11C - Deferred suggestion UI completion and runtime polish

Status: completed on 2026-05-25 after backend, web, and mobile validation and commits. Phase 11C does not change backend suggestion runtime behavior beyond documentation, does not enable ranking, does not add ML/embeddings, and does not add admin governance.

Implemented:
- web brand/store suggestion UI:
  - `CatalogShopTab.tsx` renders `MarketSuggestionBlocks` with `context=BRAND_DETAIL`, `targetType=BRAND`, and the existing Store tab `brandId`;
  - the block appears below visitor Store products/collections when the store is not explicitly closed;
  - owner catalog management views are left untouched;
- mobile suggestion UI:
  - `MobileMarketSuggestionBlocks.tsx` provides a reusable bounded rail with request aborts, empty/error hiding, block-view and item-click signals, and existing signal runtime startup;
  - `MarketCommerceViewer.tsx` renders product-detail suggestions for product sources;
  - `CollectionCommerceViewer.tsx` renders collection-detail suggestions in the list footer;
  - `app/search.tsx` renders search-empty suggestions for non-empty failed searches.

Still deferred:
- `MARKET_SECTION_DETAIL` suggestion runtime beyond the safe deferred response;
- suggestion block View All/detail pages;
- mobile brand/store suggestion UI;
- mobile Not interested controls for suggestion cards;
- admin suggestion governance/configuration;
- ML/embedding recommendations;
- cart/checkout-success suggestions;
- production suggestion monitoring dashboard.

Phase 12 can start after the Phase 11C validation/commit gate is clean. Phase 12 must keep ranking disabled by default and must not claim suggestions are fully personalized unless future backend metadata actually supports that.

## Phase 12 - User market/feed controls

Status: completed on 2026-05-25 after backend, web, and mobile validation and commits.

Implemented:
- backend suppression owner scoping is tightened so authenticated list/scope queries use the server-derived user ID and guest queries use `anonymousSessionId`;
- backend tests cover authenticated suppression list scope, guest suppression list scope, missing scope rejection, and restore/delete isolation;
- web `Settings -> Market & Feed` lists hidden/not-interested market suppressions, restores individual entries, refreshes the list, and resets market/feed/suggestion learning with confirmation;
- mobile `Settings -> Market preferences` adds the same low-risk hidden content restore and reset controls using existing UI primitives;
- mobile market API contract includes `getMarketSuppressions`;
- reset remains a soft `PersonalizationReset` marker and does not delete account data, orders, saved items, products, collections, raw signals, seen history, suppressions, or global aggregate counters.

Still deferred:
- non-personalized mode toggle;
- bulk restore for all suppressions;
- grouped muted-brand management;
- mobile suggestion-card Not interested UI;
- location-based recommendation controls;
- admin governance and configuration;
- ML/embedding recommendations.

Ranking remains disabled by default. Phase 12 does not change ranking formulas or claim full personalization.

## Phase 13A - Admin governance contract gate

Status: completed on 2026-05-26 as a docs-only contract gate.

Implemented:
- audited existing backend roles, guards, admin permission grants, admin audit
  logging, feature flags, and system config support;
- audited existing web admin route, sidebar, route protection, admin API, and
  permission patterns;
- defined market governance targets for market sections, ranking profiles,
  formula versions, suggestion blocks, release controls, and audit logs;
- defined Phase 13B backend model, admin API, web UI, safety, fallback, and
  rollback contracts;
- confirmed Phase 13A does not add migrations, runtime APIs, admin UI, formula
  changes, ranking enablement, or suggestion runtime changes.

Still deferred:
- Prisma models and migrations for market governance config;
- admin API runtime under `/admin/market-governance`;
- web admin governance UI;
- market-governance-specific permissions and audit actions;
- production release signoff and final hardening.

## Phase 13B - Backend admin governance runtime

Status: completed on 2026-05-26 after backend validation and commit.

Implemented:
- additive Prisma config models:
  - `MarketSectionConfig`;
  - `MarketRankingProfile`;
  - `MarketRankingFormulaVersion`;
  - `MarketSuggestionBlockConfig`;
- migration `20260526042133_add_market_governance_config`;
- explicit market governance permission codes;
- market-governance-specific admin audit actions;
- guarded admin APIs under `/admin/market-governance`;
- release-status, formula rollback, and non-mutating rollback rehearsal
  endpoints;
- config read service with code-default fallback;
- focused tests for permissions, validation, audit transactions, config
  fallback, rollback, and existing market/auth regressions.

Still deferred:
- production release approval and hardening, still Phase 14;
- mobile admin governance;
- ML/embedding controls.

Ranking remains disabled by default. Deterministic fallback remains mandatory,
and Phase 13B does not claim production readiness.

## Phase 13C - Web admin governance UI

Status: completed on 2026-05-26 for web admin UI. Phase 13C consumes the
Phase 13B backend runtime without adding migrations, changing public market
behavior, enabling ranking by default, adding mobile admin UI, or claiming final
release clearance.

Implemented:
- web admin API client types and methods for `/admin/market-governance`;
- guarded `/admin/market-governance` route and sidebar entry;
- Overview tab with release status, Phase 14 requirement, rollback rehearsal,
  and rollback action;
- Market Sections tab for section title/subtitle, enabled state, display order,
  preview/detail limits, minimum items, View All state, and fallback mode;
- Ranking Profiles tab for profile create/edit, section allowlist, formula
  selection, shadow mode, bounded exploration/brand-share/timeout controls,
  locked deterministic fallback, and locked `rolloutPercent=0`;
- Formulas tab for bounded allowlisted formula weight creation and activation
  through the backend create endpoint;
- Suggestion Blocks tab for context, target type, title/subtitle, source,
  fallback source, item limit, and enabled state;
- Audit Log tab with cursor loading and collapsed before/after state;
- existing admin user permission management now includes market governance
  permission grants.

Still deferred:
- mobile admin governance;
- production rollout approval and hosted monitoring;
- ML/embedding controls.

## Phase 14A - Final hardening audit and MVP release gate

Status: audit gate recorded on 2026-05-26. Phase 14A validates the backend,
web, and mobile MVP readiness posture after Phase 13C without adding new
features, enabling ranking by default, changing formulas, adding ML, or
starting mobile admin governance.

Validated scope:
- clean backend, web, and mobile worktrees on `main`;
- backend Prisma validation, generation, migration status, targeted regression,
  full Jest suite, build, and diff check;
- web typecheck, build, lint, and diff check;
- mobile typecheck, market signal queue contract, and diff check;
- public market routes, section detail pagination, suppressions, suggestions,
  preference reset, admin governance routes, release status, rollback, and
  rollback rehearsal;
- ranking remains disabled by default and deterministic fallback remains
  mandatory;
- docs and UI copy avoid false production readiness, ML, full-personalization,
  and ranking-live claims.

Outcome:
- MVP release gate may pass when the Phase 14A report shows no critical
  validation, security, permission, or performance blockers.
- Production rollout approval, hosted monitoring/alerting, and multi-user
  operational governance remain outside this local MVP gate.

## Phase 14C - MVP blocker fixes

Status: completed on 2026-05-26 for the controlled MVP blocker cleanup after
the independent Phase 14B audit synthesis.

Fixed:
- brand suggestion navigation now uses a valid profile Store-tab route instead
  of sending brand IDs through the slug storefront alias path;
- web and mobile reset-market-preference copy now says the action records a
  fresh preference baseline and that visible suggestions may adjust as new
  activity is collected;
- mobile notification/settings copy now uses patch language instead of
  follow/follower relationship wording.

Still blocked for production readiness:
- hosted monitoring and alerting;
- production deploy, migration, backup/restore, and rollback rehearsal;
- signal abuse hardening, async aggregation, and retention cleanup;
- reset-marker consumption by ranking/suggestion reads;
- deeper fashion metadata, patch/social-commerce, conversion, fairness, and
  content-quality intelligence.

Ranking remains disabled by default. Live personalization, ML/embeddings, and
production-ready claims remain prohibited until the later production and
ranking-readiness gates pass.

## Phase 14D - Controlled MVP release operational checklist

Status: checklist prepared on 2026-05-26 after final validation. This is not
production rollout approval and does not enable ranking, ML, or live
personalization.

Phase 14D created `20-controlled-mvp-release-checklist.md` with:

- backend, web, mobile, and database/migration deployment readiness checks;
- manual web, mobile, and admin smoke checklists;
- claims/copy policy for the controlled MVP candidate;
- rollback checklist for backend, migration, web, mobile, suggestions, and
  admin governance risks;
- post-release watch checklist for market endpoints, suggestions, signals,
  frontend runtime errors, mobile queue behavior, admin access errors, and
  database growth;
- production blockers that must remain open after the controlled MVP candidate;
- live ranking and personalization blockers that must remain open until the
  ranking rollout gate.

Phase 14D validation passed locally across backend Prisma validate/generate,
Prisma migrate status, targeted feed/market/admin/auth regression, full backend
Jest, backend build, web TypeScript/build/lint, mobile TypeScript, mobile signal
queue contract, and diff checks.

After Phase 14D, the next work is controlled MVP release execution and manual
smoke against the intended hosted/mobile targets. Production readiness remains
blocked by Phase 16+/17 operational, security, scalability, monitoring,
fashion-intelligence, and live-ranking gates.

## Future phase - Optimization and fairness

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
