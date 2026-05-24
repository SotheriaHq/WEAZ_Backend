# Market Ranking Design Gate

Status: Phase 4 design gate, not a ranking implementation.
Date: 2026-05-24

## 1. Purpose

Define the minimum safe rules Threadly must accept before any market/feed endpoint uses signal aggregates for ordering. This document is a gate: implementation must not begin until these rules are reviewed against production data volume, migration readiness, and product fairness goals.

## 2. Current state

- `/market/sections` and `/market/sections/:key` remain deterministic and non-personalized.
- Phase 6 adds code-level ranking flags, but the flags do not change served ordering.
- Raw signals, seen items, suppressions, reset markers, batch receipts, and daily aggregates exist in backend schema.
- Web sends market section signal batches with client event IDs.
- Mobile has an in-memory runtime signal queue and light MarketScreen instrumentation.
- Redis/BullMQ is not wired into the market signal path.

## 3. Data available from Phase 2/3

- Raw events in `UserFeedSignal`.
- Seen rows in `UserSeenItem`.
- Section-level rows in `MarketSectionSignal`.
- Suggestion rows in `SuggestionSignal`.
- Active controls in `UserContentSuppression`.
- Soft reset markers in `PersonalizationReset`.
- Duplicate batch receipts in `MarketSignalBatchReceipt`.
- Daily counters in `MarketSignalAggregateDaily`.

## 4. Data not yet available

- Durable mobile offline queue.
- Dwell threshold events from mobile/web.
- Server-side anonymous-to-user merge policy.
- Ranking profile/formula version tables.
- Admin config/audit UI for ranking changes.
- Queue lag/dead-letter metrics for async aggregation.

## 5. Ranking goals

- Improve relevance without making the market repetitive.
- Keep fresh fashion content visible.
- Respect suppressions immediately.
- Preserve patch-based relationship semantics.
- Keep feed requests bounded and cache-safe.

## 6. Non-goals

- No ML/AI recommendations in MVP ranking.
- No paid placement logic.
- No raw-event scans on hot feed paths.
- No anonymous data carryover after login without an explicit merge design.
- No global feed reordering until rollback and QA are ready.

## 7. Safety constraints

- Hard filters must run before scoring: deleted, archived, unavailable, invisible, blocked, or suppressed content is ineligible.
- Personalized responses must remain `Cache-Control: private, no-store`.
- One user action must have capped impact.
- Ranking must have a deterministic fallback.
- Aggregate reads must be bounded by date window and indexed keys.

## 8. Cold-start behavior

New and anonymous users should see baseline deterministic sections:
- fresh products;
- market-ready collections;
- active categories;
- newer brands with usable media;
- bounded exploration slots.

Cold start must not pretend to be personalized.

## 9. Guest behavior

Guest ranking may use only the current anonymous session. It must not attach anonymous signals to a logged-in account unless a future explicit merge policy is accepted. Guest suppressions can hide current-session content when `anonymousSessionId` is present.

## 10. Freshness rules

- Blend relevance with recent publish/update time.
- Cap stale content exposure even if it has old positive signals.
- Reserve a small exploration percentage for recent eligible content.
- Keep stable cursor tie-breakers such as score, createdAt, and id.

## 11. Repetition control

- Penalize items repeatedly seen in recent windows.
- Do not remove all seen content permanently.
- Avoid repeating one item across multiple sections in the same response where practical.
- Use seen history as a light penalty, not a hard global ban.

## 12. Suppression handling

Suppressions are hard controls:
- item suppressions remove matching targets;
- brand suppressions remove brand content;
- category suppressions remove matching category content;
- section suppressions hide the section;
- suggestion block suppressions hide matching blocks.

Deleting a suppression restores eligibility but does not guarantee immediate ranking.

## 13. Reset behavior

Current reset is a soft marker. It does not delete raw signals, seen rows, suppressions, or global aggregates. Future ranking must ignore or strongly downweight user-level personalization signals before the latest applicable `PersonalizationReset.resetAt`. Global aggregate counters remain intact.

## 14. Diversity/fairness rules

- Limit repeated brand/vendor exposure per response.
- Preserve room for new brands and lower-volume stores.
- Avoid locking users into one style after one click.
- Keep category breadth unless the user explicitly narrows filters.

## 15. Brand/vendor fairness

MVP ranking should include exposure caps and exploration slots:
- no single brand should dominate a section;
- new qualified brands should have reserved opportunity;
- quality and availability filters still apply;
- paid or manual boosting is out of scope.

## 16. Section-level ranking rules

Section order should remain mostly deterministic at first. Future ranking may adjust within safe bands using:
- recent section interactions;
- suppressions and section dismissals;
- freshness and section inventory health.

Do not hide core market sections solely because a user has low historical interaction.

## 17. Item-level ranking rules

Rank only eligible candidates. Candidate fetch must stay bounded. Proposed first pass:
1. fetch a bounded pool per section;
2. apply hard filters and suppressions;
3. compute score from aggregate counters and freshness;
4. apply diversity caps;
5. return stable cursor metadata.

## 18. Signals-to-score proposal

Positive inputs:
- product opens;
- item impressions only when paired with dwell in a future phase;
- section interactions;
- View All clicks;
- save/thread/bag signals if deliberately added later.

Negative inputs:
- suppressions/not interested;
- repeated recent seen items;
- stale repeated content;
- section dismissals.

Neutral inputs:
- raw impression alone should not strongly boost.

## 19. Minimum viable ranking formula

Proposed MVP formula:

```text
score =
  freshness_score * 0.30
  + product_open_score * 0.25
  + section_interest_score * 0.15
  + view_all_score * 0.10
  + exploration_bonus * 0.10
  - repeated_seen_penalty * 0.20
  - suppression_related_penalty
```

All components must be capped. Hard suppressions remain filters, not penalties.

## 20. Rollout strategy

1. Shadow score in logs/tests without changing ordering.
2. Compare deterministic vs ranked output offline.
3. Enable ranked detail endpoint behind a server feature flag.
4. Enable one low-risk section.
5. Monitor diversity, repeats, empty sections, latency, and suppression respect.
6. Keep deterministic fallback available.

## 21. Metrics to monitor

- section request latency;
- candidate fetch count;
- aggregate read count;
- empty section rate;
- repeated item rate;
- brand concentration;
- suppression reappearance rate;
- signal ingest/dedupe counts;
- aggregate update failures;
- user reset volume.

## 22. Failure fallback

If aggregate reads fail, return deterministic Phase 1 section ordering with active suppressions applied. Ranking failure must not block market rendering.

## 23. QA acceptance criteria

- No suppressed content appears in ranked output.
- Reset markers reduce personalization influence.
- Anonymous session data does not attach to authenticated ranking.
- One brand cannot dominate a section.
- Stable cursor pagination does not duplicate or skip obvious items.
- Cache headers stay private/no-store.
- Ranking can be disabled without deploy rollback.
- Ranking flags default disabled and deterministic fallback is covered by automated tests.

## 24. Open decisions before implementation

- Exact aggregate lookback window.
- Anonymous-to-user merge policy.
- Whether reset clears any local client queue state.
- Feature flag mechanism and owner.
- Exposure cap thresholds per section.
- Whether to add hourly aggregate rollups before ranking.
- Admin audit model for formula/version changes.

## 25. Phase 6 flag foundation

Phase 6 implements the release-gate flag reader only:
- `MarketRankingConfigService` reads `MARKET_RANKING_*` env values with safe defaults, normalization, and clamping;
- `MarketSectionService` consumes the config in a no-op path;
- deterministic V1 output remains served whether ranking flags are absent, disabled, or enabled before ranking implementation exists;
- aggregate tables are not queried for ordering.

This does not satisfy the ranking implementation gate by itself. QA/UAT migrations, owner assignment, monitoring, rollback rehearsal, and actual ranking design acceptance remain required.
