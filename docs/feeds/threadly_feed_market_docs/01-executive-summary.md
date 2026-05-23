# Executive Summary

## Current problem

Threadly currently has social-fashion and commerce surfaces, but the market/design rendering logic is not yet aligned with the target product direction.

The target is not a static catalogue and not a simple chronological feed. The target is a social-commerce discovery system where users see relevant, emotionally attractive, fair, diverse, and commerce-ready content.

## Core requirements

1. Design feeds must stop being globally identical.
2. Market screen must be section-first, not a single flat product grid.
3. Market sections must be configurable, measurable, and expandable.
4. Categories must be database/config driven, not hardcoded only.
5. Suggestions must exist across market-related screens, but must be context-aware.
6. New brands must receive controlled fair exposure.
7. Users must be able to control/reset feed and suggestion preferences.
8. Super admins must manage categories, sections, formulas, and suggestion blocks.
9. Signals must be captured without blocking UI or increasing page latency.
10. The architecture must be low-cost and avoid paid dependencies where possible.

## Final product architecture

```text
Design Feed Engine
  ├── Feed categories
  ├── Candidate generation
  ├── User scoring
  ├── Diversity / suppression
  └── Seen-content tracking

Market Section Engine
  ├── Market home sections
  ├── View All section pages
  ├── Section visibility and ordering
  ├── Product/collection/brand ranking
  └── Section analytics

Market Suggestion Engine
  ├── Product detail suggestions
  ├── Collection detail suggestions
  ├── Brand/store suggestions
  ├── Search/empty-state suggestions
  ├── Wishlist-related suggestions
  └── V2 cart suggestions

User Preference Engine
  ├── Hide / show less
  ├── Mute brand
  ├── Reset personalization
  ├── Manage hidden content
  └── Notification/location preferences

Admin Governance Engine
  ├── Category management
  ├── Market section management
  ├── Suggestion block management
  ├── Ranking profiles
  ├── Formula versioning
  └── Audit logs
```

## Final market decision

Market home should be:

```text
Section-first, category-supported, socially ranked, commerce-aware, fairness-balanced.
```

Categories should exist as a `Shop by Style` section, filter/category pages, ranking inputs inside other sections, and admin-managed taxonomy rules. Categories should not own the entire Market home layout.

## Final suggestion decision

Use a **Context-Aware Market Suggestion Engine**, not a generic global suggestion widget.

Scope:
- Market-related screens only.
- Product detail: two suggestion blocks — similar items and complete the look.
- Cart suggestions: V2.
- Guest users: generic trending/fresh suggestions.
- Auth users: context-aware and preference-aware suggestions.
- New brands: reserved suggestion exposure.
- Super admin: can manage suggestion blocks.
- Performance: lazy-load suggestions.
