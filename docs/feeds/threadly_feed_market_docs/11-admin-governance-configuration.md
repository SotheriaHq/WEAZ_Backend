# Admin Governance and Configuration

## Phase 0 alignment note - 2026-05-23

- Backend has generic admin roles, permission guards, `AdminAuditLog`, feature flags, system config, product moderation, collection moderation, and featured content management.
- No feed category manager, market section manager, suggestion block manager, ranking profile manager, formula version history, or ranking-specific admin permission exists today.
- Generic `SYSTEM_SETTINGS_WRITE` is not enough for production ranking governance. Ranking and market config need narrower permissions and explicit audit records.
- Admin audit integrity requirements should include actor, before/after config snapshot, formula/version identifiers, publish state, rollback target, and reason.

Phase 5 should build admin governance after the backend contracts and signal models exist, unless Phase 1 introduces any admin-editable config. If Phase 1 writes config models, audit logging must ship with those writes.

## Roles

| Role | Capability |
|---|---|
| Super admin | full category/section/suggestion/formula management |
| Admin with permission | limited management based on assigned permissions |
| Brand admin | no system formula control |
| User | preference controls only |

## Admin-managed systems

- Feed categories.
- Market sections.
- Suggestion blocks.
- Ranking profiles.
- Formula versions.
- Default/fallback categories.
- New-brand exposure settings.
- Section View All labels.
- User-facing section labels.
- Admin/editorial featured picks.

## Ranking profile model

```text
RankingProfile
- id
- key
- name
- description
- weights
- safeBounds
- version
- status
- createdBy
- updatedBy
```

## Formula versioning

Every formula/profile change creates:

```text
FormulaVersion
- id
- rankingProfileId
- versionNumber
- previousWeights
- nextWeights
- reason
- changedBy
- createdAt
```

## Audit log

```text
AdminConfigAuditLog
- id
- actorId
- entityType
- entityId
- action
- before
- after
- reason
- createdAt
```

## Required admin screens

| Screen | Purpose |
|---|---|
| Feed Category Manager | create/edit/pause/archive categories |
| Market Section Manager | configure sections and View All |
| Suggestion Block Manager | configure suggestion blocks per screen |
| Ranking Profile Manager | configure weights within safe bounds |
| Formula Version History | compare changes |
| Audit Log | trace config history |
| Taxonomy Manager | tags/categories/styles |
| New Brand Exposure Monitor | fairness controls |
| Analytics Dashboard | section/suggestion performance |

## Admin hover descriptions

Every configurable parameter must have hover/help copy:
- what it controls;
- safe range;
- risk of increasing it;
- where it affects rendering;
- whether it impacts guests/auth users.

Example:

```text
Freshness Weight
Controls how strongly new uploads are promoted. Higher values make sections feel newer but may reduce quality if set too high.
Safe range: 0.05–0.40.
```

## Safe bounds

Admins must not be able to save formulas that:
- total weights exceed safe allowed limits without normalization;
- set fairness above cap;
- set suppression below required thresholds;
- remove all fallback categories;
- archive all active sections;
- create category with no eligibility or fallback.

## Publishing workflow

1. Create/edit draft.
2. Validate rules.
3. Preview expected output.
4. Publish.
5. Audit log written.
6. New sessions use new version.
7. Existing sessions remain stable.
