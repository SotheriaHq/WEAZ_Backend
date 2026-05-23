# Feed Category Architecture

## Decision

Feed categories must be database/config driven. Hardcoded labels such as `All`, `African`, `Casual`, `For You`, `Explore` should be replaced by seeded default records that can be expanded safely.

## Default category decision

Do not use `All`.

| User type | Default |
|---|---|
| Guest | Explore |
| Authenticated new user | Discover |
| Authenticated active user | Discover, with For You available |
| High-signal returning user | Discover default; For You promoted if eligible |

## Category model

```text
FeedCategory
- id
- key
- label
- description
- categoryType
- rankingProfileId
- eligibilityRules
- fallbackCategoryKey
- displayOrder
- isDefaultForGuest
- isDefaultForNewUser
- isDefaultForReturningUser
- requiresAuthentication
- requiresPersonalization
- status: DRAFT | ACTIVE | PAUSED | ARCHIVED
- createdBy
- updatedBy
- createdAt
- updatedAt
```

## Default seeded categories

| Key | Label | Purpose |
|---|---|---|
| `discover` | Discover | default authenticated feed |
| `explore` | Explore | guest/new discovery |
| `for-you` | For You | full personalization |
| `african` | African Style | African/cultural fashion |
| `casual` | Everyday Style | casual/universal wear |

## Category lifecycle

| Status | Meaning |
|---|---|
| Draft | editable, not visible |
| Active | visible and renderable |
| Paused | hidden temporarily |
| Archived | no longer visible; old links fallback |

## Category fallback rules

- Archived category deep link -> fallback to Discover/Explore.
- Category with too few items -> mix fallback items but keep context.
- Missing formula -> use safe default ranking profile.
- Admin cannot archive active default unless replacement default is selected.
- Category edits create audit log and formula version reference.

## For You eligibility

For You is visible only when:

```text
user has >= 15 signals
OR user patched at least 1 brand

## Phase 0 alignment note - 2026-05-23

- Threadly relationship semantics are patch-based. Do not introduce follow/following terminology in new category logic.
- Backend `collections/market` currently accepts `tag` from the controller but not `category`; the service has a `category` parameter that is not wired end to end.
- Mobile feed filter chips come from `/categories/filters` when available and fall back to hardcoded chips.
- Web design market filters are currently hardcoded and can pass category to the API even though backend ignores category for `collections/market`.

Phase 1 must decide whether feed categories remain tag-based for design feed V1 or whether a new ranked feed endpoint owns category semantics.
OR user completed at least 1 purchase
```

For guests, For You is hidden. For new users, For You is hidden or disabled with explanation.

## Expansion requirement

Adding/removing categories must not require code changes to scoring logic. New categories inherit a default ranking profile and define eligibility rules.
