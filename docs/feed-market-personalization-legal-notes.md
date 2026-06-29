# Feed And Market Personalization Legal Notes

Date: 2026-06-12

## Scope

This note documents the current Phase 2/3 foundation for Threadly feed categories, market sections, and suggestion surfaces.

## Current Behavior

- Feed categories are configuration-driven through `GET /feed/categories`.
- Market sections are configuration-driven through market governance section config.
- Admin-created market sections inherit the platform's standard section behavior automatically.
- Suggestions are deterministic foundation suggestions for product, collection, brand, search-empty, market-section detail, and wishlist contexts.
- Ranking metadata must continue to disclose `personalization: disabled` until true personalized ranking is implemented and approved.
- The current system may use deterministic freshness, market readiness, section source type, category/tag affinity, suppression state, and aggregate fallback signals where explicitly enabled.

## Admin Governance

- Admins configure section key, title, subtitle, source type, status, limits, View All labels, auth visibility, fallback section, and new-brand reserved ratio.
- Admins do not configure custom per-section algorithms.
- Custom section keys should be treated as durable public API identifiers once published.
- Disabling, pausing, or archiving sections should preserve at least one active market section.

## Fairness Foundation

- `newBrandReservedRatio` reserves deterministic slots for eligible newer brands when configured.
- Eligibility is based on brand creation age and existing market-ready item qualification.
- The fairness step must not bypass media readiness, stock/custom-order readiness, suppression, section status, or guest/auth visibility checks.
- This is a discovery fairness guard, not paid placement.

## User Transparency Constraints

- Do not describe the current system as fully personalized.
- Do not describe ranking as AI/ML-driven unless a later implementation introduces and approves that behavior.
- Do not imply paid boosts, sponsored ranking, or guaranteed placement from `newBrandReservedRatio`.
- Keep user-facing copy framed as market sections, categories, recommendations, or suggestions.

## Data And Privacy Notes

- Suggestion responses remain private no-store.
- Suppression signals are preference/safety controls and should not expose raw score internals.
- Guest behavior should continue to use anonymous-session scoped controls where available.
- Auth-required sections must not be served to guests.

## Open Legal/Product Gates

- Full personalization copy review remains pending.
- Sponsored placement policy remains pending.
- Production monitoring and appeal/recovery paths for hidden/suppressed content remain pending.
