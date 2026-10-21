# WIEZ Runway v2 — business requirements

Revision: 21 October 2026. Implementation is complete locally; deployment, device acceptance and relevance/capacity validation must be recorded separately. This amendment supersedes older Runway category, scoring and exposure requirements where they differ. Market commerce section/suggestion algorithms remain separate.

## User outcomes

As a shopper, I want WIEZ to recognize my changing fashion interests and introduce relevant unfamiliar brands, so that my feed helps me discover clothes I like. As an African fashion brand, I want accurately classified everyday work to reach interested shoppers globally, so that discovery extends beyond my existing followers.

## Requirements and implementation trace

| ID | Required behavior | Implementation / verification |
|---|---|---|
| RF01 | Discover and Explore work for guests; For You requires authentication. | Shared built-in category contract and category service tests. Guest defaults to Explore; authenticated defaults to Discover. |
| RF02 | All default chips exist without an environment-specific switch, including SIT. | Default merge fills partial seeds; migration activates historical built-ins. Explicit later administrative pauses remain valid. |
| RF03 | African Style becomes African Casual on both clients. | Shared categories and legacy input alias. Category UUIDs are preserved where possible. |
| RF04 | African Casual requires casual content plus African heritage or declared African brand provenance. | Active style/heritage filter values or recognized tags; brand country provides provenance. Real SQL lane tests. Formal heritage clothing alone does not qualify. |
| RF05 | Personalization reads actual likes/THREAD, comments, saves, patches, paid purchases and qualified exposure/feedback. | Bounded source queries and affinity cache. Cancelled/fully refunded purchases excluded. Repeated identical event kinds per design capped. |
| RF06 | Fashion preferences transfer across brands through declared fit, fabric, style, occasion and other active fashion features. | EntityFilter/FilterValue affinity, not only matching brand IDs or hashtags. No inferred ethnicity or body attributes. |
| RF07 | Recent interests adapt without erasing longer-term taste. | Initial 65% seven-day plus 35% 45-day decay within a bounded 90-day read window. Strong negative features survive cache trimming. |
| RF08 | Lanes have different ranking purposes. | For You prioritizes relevance; Discover balances quality and novelty; Explore gives novelty more room. Exact formulas in the linked specification. |
| RF09 | Avoid a closed loop and repeated brands. | One in five For You positions reserves exploration within the pool; avoid adjacent same-brand cards when alternatives exist. No promise of equal exposure across all creators. |
| RF10 | Do not count an avatar or hidden slide as viewed content. | Loaded content, foreground/focus, visibility and dwell gates. Impression at one second; medium/long dwell at three/eight seconds. Timers and observers clean up on exit. |
| RF11 | Retrieval and memory remain bounded as the catalogue grows. | At most 480 deduplicated candidates, source quotas, indexed facet probes, bounded shared public caches. No full-catalogue sort per shopper. |
| RF12 | Paging is stable and private. | Viewer/lane/query-bound 30-minute snapshots, strict cursors, reset invalidation, suppression/public eligibility rechecks. RLS and account-deletion cascades. |
| RF13 | Cold users and sparse metadata have usable fallbacks. | Broad quality/discovery sources. Missing casual classification stays outside casual lanes; no fabricated backfill. Empty/error states remain usable. |
| RF14 | Clients render server rank consistently. | Web/native preserve ordering; native can paint a cached feed while refreshing. A cached response is not proof of current ranking freshness. |
| RF15 | Search shares repeated work and uses existing indexes. | Direct FTS vector predicates and at most 16 distinct concurrent searches per process. Busy response is retryable. Existing search capabilities retained. |
| RF16 | Claims of scale and relevance require evidence. | Reproducible local benchmark with source hashes; sustained HTTP/media/device and holdout/experiment gates remain mandatory. |

## Decisions, safeguards and scope

The initial signal and ranking weights are documented policy, not trained coefficients. Long views and comments can reflect disagreement; explicit negative feedback and suppression are essential. No microphone access, private conversation analysis, image classifier, embedding service or trained deep recommender is introduced. Natural-language interests, surveys and neural retrieval are future options requiring explicit product design, cost/privacy controls, representative data and evaluation.

African Casual is a content lane, not a viewer ethnicity filter. Classification supports modern global fashion as well as heritage materials. Free-text country variants and historical content classification should be checked against real brand data; the implementation supports its documented country/tag vocabulary rather than silently guessing identity.

## Acceptance and rollout

1. Run ranking, source quotas, private pagination/reset, suppression, default-category and raw SQL tests; deploy the three migrations before the API and clients.
2. Verify all chips on SIT, guest/new/active accounts, sparse facets, pending/ready media, muted brands, account changes and rapid navigation.
3. Measure first usable cards on Android/iOS, native Studio WebViews and slow networks; compare full endpoint latency, database pool saturation, errors and memory under sustained distinct-viewer load.
4. Measure relevance with chronological holdouts and experiments: recall/NDCG@20, saves/paid outcomes, negative feedback, repeated designs, brand coverage and new-creator exposure. Segment cold users and content metadata coverage.
5. Commit and push all application changes before the GitHub APK build. Build the exact pushed mobile commit and identify it in the download. Do not label a local query benchmark as production capacity or a passing suite as proof of zero bugs.

[Implementation, exact weights and primary research](RUNWAY_V2_FASHION_AND_SCALE_2026-10-21.md) · [Measured query evidence](../performance/runway-local-benchmark.json)
