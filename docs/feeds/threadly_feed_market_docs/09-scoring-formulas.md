# Scoring Formulas

All scores normalize to `0.0 - 1.0` before weighting.

## Design feed score

```text
feed_score =
  (0.30 × affinity_score)
+ (0.20 × engagement_quality_score)
+ (0.15 × commerce_intent_score)
+ (0.15 × velocity_score)
+ (0.10 × recency_score)
+ (0.10 × diversity_score)
- suppression_penalty
- repetition_penalty
```

## Affinity score

```text
affinity_score =
  (0.35 × tag_match_score)
+ (0.25 × brand_relationship_score)
+ (0.20 × category_preference_score)
+ (0.10 × gender_audience_match_score)
+ (0.10 × location_relevance_score)
```

## Engagement quality

```text
engagement_quality_score =
  normalize(
    likes × 1
  + saves/wishlist × 2
  + comments × 2
  + threads × 2
  + shares/sends × 3
  + profile_taps × 1.5
  )
```

## Commerce intent

```text
commerce_intent_score =
  normalize(
    product_view × 1
  + size_selected × 2
  + wishlist × 2.5
  + add_to_cart × 3
  + checkout_started × 4
  + purchase × 5
  )
```

## Market section visibility

```text
section_visibility_score =
  (0.25 × user_relevance)
+ (0.20 × available_inventory_strength)
+ (0.20 × freshness_strength)
+ (0.15 × social_heat)
+ (0.10 × commerce_intent_match)
+ (0.10 × fairness_need)
```

## Market item score

```text
market_item_score =
  (0.22 × commerce_intent_score)
+ (0.18 × user_affinity_score)
+ (0.16 × social_proof_score)
+ (0.14 × freshness_score)
+ (0.12 × inventory_score)
+ (0.10 × brand_quality_score)
+ (0.08 × fairness_boost)
+ (0.05 × category_variety_bonus)
- suppression_penalty
- sold_out_penalty
- repetition_penalty
```

## Hot Right Now

```text
hot_score =
  (0.30 × recent_purchase_velocity)
+ (0.25 × wishlist_velocity)
+ (0.20 × view_velocity)
+ (0.15 × share_comment_velocity)
+ (0.10 × cart_velocity)
- sold_out_penalty
- complaint_penalty
```

## Fresh Drops

```text
fresh_drop_score =
  (0.50 × recency_score)
+ (0.20 × brand_quality_score)
+ (0.15 × inventory_score)
+ (0.10 × early_engagement_score)
+ (0.05 × new_brand_boost)
```

## New Designers to Watch

```text
new_brand_score =
  (0.30 × freshness)
+ (0.25 × brand_profile_quality)
+ (0.20 × early_engagement)
+ (0.15 × inventory_readiness)
+ (0.10 × underexposure_boost)
```

## New brand fairness

```text
fairness_boost =
  underexposure_score × quality_gate × freshness_gate
```

```text
underexposure_score =
  1 - min(brand_impressions_last_7d / target_brand_impressions, 1)
```

Cap:

```text
fairness_boost <= 0.15
```

## Suggestion score

```text
suggestion_score =
  (0.25 × context_match)
+ (0.20 × commerce_readiness)
+ (0.15 × social_proof)
+ (0.15 × user_affinity)
+ (0.10 × freshness)
+ (0.10 × brand_quality)
+ (0.05 × new_brand_fairness)
- duplication_penalty
- suppression_penalty
- unavailable_penalty
```

## Recency score

```text
recency_score = 1 / (1 + days_since_upload × 0.15)
```

## Dwell classification

```text
< 1.5s      = SCROLL_SKIP
1.5s–3s    = DWELL_SHORT
3s–6s      = DWELL_MEDIUM
6s+        = DWELL_LONG
```

## View thresholds

| Platform | Visibility threshold |
|---|---|
| Web | 50% of card visible |
| Mobile | 90% of card visible |

## Cold start

```text
Phase 0: no signals
  -> newest published + Explore/Discover + seeded shuffle

Phase 1: onboarding preference or 1+ signal
  -> tag/category/gender preference + newest/trending

Phase 2: 5–14 signals
  -> partial personalization

Phase 3: 15+ signals OR 1 patch OR 1 purchase

## Phase 0 alignment note - 2026-05-23

- No `RankingProfile`, `FormulaVersion`, or feed-specific admin ranking config model exists in Prisma today.
- Existing backend market sorting is chronological, price-based, or view-count-based depending on endpoint/sort mode.
- Mobile moodboard scoring is local and useful as a UX prototype, but it is not a production ranking source because its signals are derived only from already-loaded client data.
- Product view counts exist through `ProductViewCounterService`; they should become one scoring input, not the scoring system.

Formula implementation should start with deterministic, versioned server-side formulas and a stable tie-breaker cursor. Any personalized profile must include a non-personalized fallback path.
  -> full personalization; For You enabled
```

## Suppression

```text
hidden design/product = permanent until reset

brand suppression:
  first action  = 30 days
  second action = 60 days
  third action  = permanent/long-term block

skipped content:
  reduced/suppressed for 3 days
```

## Diversity caps

```text
No more than 3 consecutive items from same brand.
No more than 3 consecutive items from same category.
Same product/design cannot appear twice on same screen.
```

## Phase 8 implemented aggregate scoring

Phase 8 implements a conservative deterministic formula service, not ML.

Implemented service:
- `src/market/market-ranking-scorer.service.ts`

Inputs:
- deterministic candidate order from the existing section query;
- `MarketSignalAggregateDaily` counters read for candidate item IDs only;
- section key;
- safe ranking config values from `MarketRankingConfigService`.

V1 score components:
- freshness score from `createdAt`;
- aggregate interaction score using `log1p` on item impressions, item/product opens, clicks, and View All clicks;
- commerce signal score from product opens, item opens, and clicks;
- section relevance score, for example freshness for `fresh-drops`, aggregate interaction for `hot-right-now`, and custom-order eligibility for `custom-ready`;
- light exploration score from the existing deterministic slot;
- stable deterministic tie-breaker.

Safety constraints:
- scores are clamped to bounded ranges;
- large counts use `log1p` so one item cannot dominate solely through raw count size;
- suppressions remain hard filters before scoring;
- missing aggregate rows do not exclude an item;
- brand diversity cap limits repeated brand concentration when enough alternatives exist;
- ties fall back to deterministic order and then item ID.

Served ranking conditions:
- `MARKET_RANKING_ENABLED=true`;
- section key is explicitly allowlisted;
- deterministic fallback is enabled;
- aggregate reader succeeds and returns at least one aggregate row;
- `MARKET_RANKING_SHADOW_MODE=false`.

Default behavior remains deterministic because ranking is disabled by default and no section keys are allowlisted by default.
