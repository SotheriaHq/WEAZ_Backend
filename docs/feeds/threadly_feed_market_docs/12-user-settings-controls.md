# User Settings and Controls

## Phase 0 alignment note - 2026-05-23

- Web has local hidden content settings backed by localStorage, not a backend suppression system.
- Mobile notification settings include legacy `Follows` copy/keys alongside `Patches`; this should be treated as legacy compatibility drift.
- No cross-device feed preference, non-personalized feed toggle, muted brand list, reset-personalization endpoint, or suggestion suppression endpoint was found.
- Location settings exist as a surface, but location-based recommendation behavior and disclosures are not implemented as part of feed/market ranking.

User controls must include patch-based terminology, a usable non-personalized fallback, clear reset behavior, and cross-device suppression persistence.

## Purpose

Users must be able to influence and reset the system that recommends content to them. This is required for trust, user control, and cleaner feedback signals.

## Required user controls

| Control | Effect |
|---|---|
| Hide this design/product | suppress target |
| Show less like this | reduce tag/category/brand weight |
| Don't show this brand | brand suppression |
| Hide suggestion block | suppress block/context |
| Reset feed preferences | soft reset ranking history |
| Update style interests | update taste profile |
| Manage hidden content | undo hidden items |
| Manage muted brands | undo brand suppression |
| Location personalization | enable/disable/manual location |
| Notification preferences | choose alert types |
| Device/session management | security controls |

## Soft reset model

Do not hard-delete all historical analytics by default.

Use:

```text
PersonalizationReset
- userId
- resetAt
- resetType
- reason
```

Ranking should ignore older personalization signals after `resetAt`, while retaining analytics/audit data where legally allowed.

## Required screens

| Screen | Purpose |
|---|---|
| Feed Preferences | reset and personalize |
| Style Interests | categories/styles/gender/audience |
| Hidden Content | unhide designs/products |
| Muted Brands | manage brand suppression |
| Suggestion Preferences | hidden suggestion blocks/items |
| Location Preferences | approximate/manual/none |
| Notification Preferences | price/restock/drop/recommendation |
| Device & Security | devices, locations, revoke sessions |

## User-facing configuration boundaries

Users should not edit formula weights. They should express preferences.

Examples:
- Show me more like this.
- Show me less like this.
- Don't show this brand.
- Reset my feed.
- Use my location for local trends.
- Do not use my location for recommendations.

## Confirmation flows

Potentially destructive actions need confirmation:
- reset feed;
- unmute all brands;
- disable personalization;
- clear hidden list.

## Undo flows

After hiding an item/block:
- show short undo toast/snackbar;
- allow later restore in settings.

## Phase 2 implemented controls - 2026-05-24

Implemented now:
- backend suppression creation, listing, and delete/restore endpoints;
- backend feed preference reset marker endpoint;
- web Market section cards expose a minimal `Not interested` action on touched market section previews;
- web removes suppressed section items locally and offers an undo action;
- guest suppressions use `anonymousSessionId`;
- authenticated suppressions use the server-derived user ID.

Deferred:
- full Feed Preferences screen;
- Hidden Content management screen;
- muted brand management;
- location personalization controls;
- non-personalized toggle UI;
- mobile hide/not-interested runtime controls;
- hard deletion of signal history after reset.

Reset behavior remains a soft reset: `PersonalizationReset` records a marker for future ranking to ignore older personalization signals, while analytics rows are retained unless a later privacy/legal requirement changes that policy.

## Phase 3 reset and suppression consistency - 2026-05-24

Implemented now:
- reset response includes an explicit `resetPolicy` summary;
- feed/market reset does not delete raw signal rows, seen rows, suppression rows, or global aggregate counters;
- global aggregate counters are retained because one user's reset must not destroy platform analytics;
- suppressions remain separate controls and continue to hide matching market section items until deleted/restored;
- suppression creation also contributes to the daily aggregate foundation without changing ranking.

Deferred:
- mobile hide/not-interested UI;
- full hidden content management;
- user-facing reset/feed preference screen;
- hard deletion/privacy export workflow if legal requirements later require it.
