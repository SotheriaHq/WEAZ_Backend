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

- add feed/market/suggestion signal models;
- add seen-content tracking;
- add suppression models;
- add batched signal emission web/mobile;
- add mobile offline queue/AppState flush behavior;
- add personalized response cache-control policy;
- add section/suggestion analytics.

Outcome:
- system begins collecting usable ranking data.

## Phase 3 - Ranking profiles, formula versions, and personalization

- implement deterministic scoring formulas with stable cursor tie-breakers;
- add user affinity aggregates;
- add brand/category affinity;
- add cold-start phases;
- add For You eligibility;
- add market item ranking;
- expose non-personalized fallback mode.

Outcome:
- feeds and market sections become personalized.

## Phase 4 - Context-aware market suggestion blocks

- product detail suggestions;
- collection detail suggestions;
- brand/store suggestions;
- search-empty suggestions;
- new-brand reserved slots;
- suggestion suppression;
- suggestion analytics.

Outcome:
- market-related screens have context-aware suggestions.

## Phase 5 - User controls and admin governance

- user feed settings;
- hidden/muted management;
- reset preferences;
- admin screens for categories, sections, suggestions, ranking profiles;
- feed/ranking-specific permissions;
- admin audit integrity for every config/version change;
- formula versioning and audit.

Outcome:
- production governance and user control.

## Phase 6 - Optimization and fairness

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
