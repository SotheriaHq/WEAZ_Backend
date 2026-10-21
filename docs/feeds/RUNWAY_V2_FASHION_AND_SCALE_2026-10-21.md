# Runway v2: fashion relevance and scale

Status: implemented locally; migrations and environment/device acceptance remain before release. This document extends the existing feed requirements, category architecture and scoring documents under `threadly_feed_market_docs/`. Runway is the design feed; Market remains commerce discovery.

## Product behavior

As a shopper, I want feeds that learn my fashion interests and introduce relevant unfamiliar brands, so that I can discover styles I would actually wear or buy.

| Lane | Conditions and purpose |
|---|---|
| For You | Signed-in chip. Strongest use of personal brand, category, tag and structured fashion affinities. Cold users receive discovery ranking. One position in five reserves exploration before brand diversification. |
| Discover | Public, quality-led fashion discovery with personal relevance, fresh unseen content and controlled variation. |
| Explore | Public, broader discovery: less reliance on popularity, more unseen content and variation, while retaining fashion relevance. |
| African Casual | Explicit casual classification **and** African heritage classification or declared African brand provenance. Relevant everyday African fashion can reach shoppers globally. |
| Casual Style | Explicit everyday/casual/streetwear classification, with global provenance allowed. |

All five built-ins are enabled by code defaults, including partially seeded environments. The migration activates existing built-ins, including SIT. Later explicit administrative PAUSED/ARCHIVED states remain effective. Existing custom categories remain available. `african-style` is accepted as a legacy alias; both clients display **African Casual**.

## Research and engineering decisions

Meta describes a staged recommendation funnel with multiple retrieval sources, increasingly selective ranking and cached/precomputed representations. WIEZ adopts that staged architecture with bounded database retrieval and sparse interaction/fashion profiles. A neural two-tower system is a potential later retrieval replacement when representative training data and evaluation exist. This implementation does not claim to have Meta's models or accuracy. [Meta: Explore architecture, 2023](https://engineering.fb.com/2023/08/09/ml-applications/scaling-instagram-explore-recommendations-system/).

Meta's more recent account emphasizes model health, evaluation and controlled launches. WIEZ therefore versions the ranker and records query timings; tuning should be evaluated against a baseline before wider release. [Meta: recommendation operations, 2025](https://engineering.fb.com/2025/05/21/production-engineering/journey-to-1000-models-scaling-instagrams-recommendation-system/).

TikTok identifies behavioral interactions and content information among recommendation inputs. WIEZ uses observable in-app events, with loaded/visible media checks for viewing signals. A loaded avatar or an inactive prerendered reel must not create a design impression. [TikTok: recommendation inputs](https://support.tiktok.com/en/using-tiktok/exploring-videos/how-tiktok-recommends-content).

UNESCO describes diverse African fashion ecosystems, ready-to-wear opportunities, digital distribution and international exposure. Our inference is that “African” and “casual” should be separate content facets: heritage alone does not mean everyday wear, and an everyday outfit does not have to use a traditional print. This is a product interpretation, not a statistical claim about WIEZ shoppers or a 2026 market-size forecast. [UNESCO: African fashion report](https://www.unesco.org/en/articles/unesco-report-africa-new-global-fashion-leader), [full report](https://www.unesco.org/sites/default/files/medias/fichiers/2024/03/387230eng.pdf?hub=378).

## Actual inputs and initial policy values

Only existing records are used: design/media THREAD reactions, comments, saved designs/media, accepted brand patches, paid design custom orders, paid standard-order brand relationships, and recorded dwell/share/profile/skip/negative/impression signals. Cancelled and fully refunded purchases do not contribute. In-flight refunds remain paid until the payment state changes, unless cancelled.

| Input | Initial contribution |
|---|---|
| THREAD reaction | 2 |
| Comment / share | 3 |
| Save | 4 |
| Paid design purchase | 5 |
| Paid standard order | Brand affinity, 5 with 45-day decay |
| Accepted patch | Brand affinity, 8 |
| Qualified medium/long dwell or profile tap | 1 |
| Scroll skip | -0.5, decaying; an individual quick skip is a weak signal |
| Explicit not interested | -4 plus an exact-design penalty; existing hard suppressions also apply |

Repeated identical event kinds on the same design are capped during profile construction. Design events blend short-term and longer-term decay: 65% at seven days and 35% at 45 days, within a maximum 90-day window. These are **initial versioned policy weights**, not learned coefficients or proven conversion improvements.

User taste is matched against the content's brand, category, normalized tags and active `EntityFilter` / `FilterValue` identifiers. This lets interest in a fit, fabric or other saved fashion attribute transfer across brands. No viewer ethnicity, gender, body measurements or audio is inferred. There is no image classifier or silent metadata backfill. Existing content without a casual indicator stays in broad feeds and needs accurate classification to enter a casual lane.

Personal relevance combines brand 35%, tags 20%, category 15% and structured fashion 30%, with bounded positive/negative affinity. For You combines relevance 65%, existing quality 25%, novelty 5% and seeded variation 5%. Discover uses quality 50%, relevance 20%, novelty 15% and variation 15%. Explore uses relevance 20%, quality 30%, novelty 30% and variation 20%. Existing quality considers recency, engagement and ready media richness. Editing a design does not reset its age in this ranker. Brand diversification avoids adjacent repeats when alternatives exist.

## Retrieval, caching and pagination

Fresh source: at most 160 designs. Quality source: 80. Personal sources: brand 40, tags 32, category 24 and structured fashion 24 (120 total). Casual-lane source: 120. Deduplicate before ranking: at most 480 candidates, without downloading the complete catalogue. The facet source can retrieve older correctly classified content rather than relying only on the global newest rows. It probes at most 12 positive feature IDs with a bounded indexed lateral lookup, at most 160 entity IDs overall. Independent personal-source quotas prevent a common tag from consuming the favorite-brand budget.

Equivalent public candidate and candidate-metadata reads share in-flight work and a 10-second cache: two independent maps, each capped at 32 keys per process. Public rows can be shared; viewer affinities and final scores cannot. Personal profiles use a 30-second database cache, capped to the strongest 64 features by absolute magnitude per affinity dimension, retaining strong negative preferences. Profile reads are bounded (150 records per reaction/comment/save source, 400 recent signals and 100 purchase rows); the time window is not a promise to read every historical event. Database snapshots preserve ordered IDs for 30 minutes across API instances; later pages use the stored order instead of rescoring the catalogue. Cursors bind viewer, lane and query, validate syntax and offsets, and cannot carry one viewer's personal snapshot to another. User deletion cascades through both new tables; row-level security keeps these backend-owned tables out of direct client access. Backend database credentials must own the tables or have the appropriate RLS bypass.

Suppression, public visibility, owner eligibility and ready-media checks are applied to served content. A personalization reset invalidates old profiles and cursors. Expired cache/session rows are cleaned hourly. Web and native preserve the server's order; native retains immediate cache paint and background refresh.

## Evaluation before increasing traffic

Evaluate chronological holdouts with recall/NDCG at 20, save and paid-order outcomes, negative-feedback rate, brand coverage, repeated-design rate and new-creator exposure. Segment by cold users, established users, sparse casual metadata and network/device class. Do not treat a long view or a comment as proof of purchase intent; dissatisfaction can also generate engagement.

Load tests must include cold/warm caches, many distinct shoppers, broad/rare/missing facets, suppression changes and concurrent publishing. Local database benchmarks do not establish production user capacity, HTTP latency or native rendering speed. The delivery report contains measured results and release limitations.

## Search changes and next scale boundary

Full-text predicates now reference indexed vectors directly, allowing the existing GIN indexes to participate. Identical concurrent searches share work; at most 16 distinct searches run per process, with a retryable busy response beyond that budget. Existing shared caching remains. This budget is an operational guard, not a measured production capacity.

Remaining search work should be driven by full query plans: fuzzy `similarity()` branches and deep OFFSET pagination can still become expensive. Moving the full search service to a separate index or deploying vector retrieval requires a measured need, synchronization/rebuild procedures and evaluation; adding infrastructure alone does not establish relevance or scale.


## Research update checked on 21 October 2026

Meta's January 2026 engineering report explains that engagement can be an imperfect proxy for satisfaction and discusses direct relevance surveys. WIEZ therefore treats view time as weak evidence, retains explicit negative feedback, and requires relevance evaluation beyond clicks. Surveys and a learned satisfaction model are future experiments, not shipped features. [Meta, January 2026](https://engineering.fb.com/2026/01/14/ml-applications/adapting-the-facebook-reels-recsys-ai-model-based-on-user-feedback/).

Meta's 13 October 2026 product announcement describes explicit text interests as another input to ranking. This is relevant to the owner's request for a more aware feed, but it does not establish how any platform uses ambient conversations. WIEZ's implementation reads the documented in-app signals only; natural-language interest entry and LLM inference are not implemented. [Meta, October 2026](https://about.fb.com/news/2026/10/introducing-your-algorithm-facebook/).

A July 2025 King's College London pilot describes makers spanning bespoke and ready-to-wear production and local through international markets. Its interviews focus on Kenya and South Africa; it cannot establish continent-wide consumer demand. Together with UNESCO, this supports keeping casual use, fashion attributes and provenance distinct instead of treating African fashion as one print or occasion. [England, 2025, report](https://kclpure.kcl.ac.uk/ws/portalfiles/portal/344026719/Report_2025_final.pdf).

The controlling business requirements are in [Runway v2 BRD](RUNWAY_V2_BRD_2026-10-21.md). Algorithm weights are versioned engineering policy; no lift in revenue or relevance is asserted without an experiment. Brand diversity applies within the retrieved candidate pool; equal platform-wide creator exposure is not guaranteed by a greedy adjacent-brand pass.


## Advancement roadmap driven by measured limits

At higher measured traffic, evaluate incremental per-user aggregates and a feature store before increasing synchronous history reads; use shared distributed public caches/snapshot storage if per-process misses or database write/cleanup volume become the bottleneck. Evaluate creator-stratified retrieval against a dominant-brand publishing fixture, because diversification cannot recover creators absent from the candidate pool. Measure web long-scroll memory/media fan-out as well as API latency. Neural/multimodal retrieval can replace a retrieval stage later, but requires training data, moderation/privacy decisions, offline recall and online satisfaction/cost gates. These are explicit next-stage options, not implemented capabilities.
