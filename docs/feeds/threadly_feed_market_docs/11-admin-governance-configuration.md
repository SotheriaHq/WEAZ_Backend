# Admin Governance and Configuration

## Phase 13B Backend Runtime Status

Status: backend runtime implemented after validation. Web admin UI remains
deferred to Phase 13C, and production readiness remains deferred to Phase 14.

Phase 13B adds additive backend governance storage and guarded APIs only:

- Prisma migration `20260526042133_add_market_governance_config`;
- `MarketSectionConfig`;
- `MarketRankingProfile`;
- `MarketRankingFormulaVersion`;
- `MarketSuggestionBlockConfig`;
- market-governance-specific `AdminAuditAction` values;
- explicit market governance permission codes;
- guarded `/admin/market-governance` endpoints;
- `MarketGovernanceConfigService` with code-default fallback when config tables
  are empty or unavailable;
- release-status, rollback, and non-mutating rollback rehearsal endpoints.

Every governance mutation is scoped to `SuperAdmin` or `Admin` with explicit
permissions, derives the actor from the authenticated request, and writes an
`AdminAuditLog` record in the same transaction. If the audit write fails, the
mutation fails.

Runtime safety rules that remain enforced:

- ranking is disabled by default;
- deterministic fallback cannot be disabled by admin config;
- `rolloutPercent` is bounded to `0` until Phase 14 release gates pass;
- config read failure uses code defaults instead of breaking public market
  routes;
- formula rollback preserves history and fails safely when no prior formula
  exists;
- rollback rehearsal is non-mutating.

Phase 13B does not add web admin screens, mobile admin screens, ML controls,
production approval, or public market behavior changes beyond safe config
read fallback services.

## Phase 13A Contract Gate Status

Status: contract gate complete after docs validation.

Phase 13A defines the admin governance contract for market sections, ranking
profiles, formula versions, suggestion blocks, release controls, and audit
logging. It does not implement runtime admin APIs, database migrations, admin UI,
or any user-facing market behavior changes.

Phase 13A did not implement runtime behavior. Phase 13B now implements backend
runtime only. Ranking remains disabled by default, deterministic fallback
remains mandatory, and no admin configuration may remove the safe code-default
path.

## Existing Admin And Permission Audit

Backend roles currently available:

- `SuperAdmin`
- `Admin`
- `User`

The backend also has `UserType.BRAND` and `UserType.REGULAR`, plus
`BrandMemberRole` for brand/store staff workflows. These are not equivalent to
platform admin governance roles.

Existing backend controls:

- `JwtAuthGuard` authenticates the request.
- `RolesGuard` enforces role metadata from `@Roles(...)`.
- `AdminPermissionGuard` enforces permission metadata from
  `@RequirePermissions(...)`.
- `SuperAdmin` bypasses granular permission checks.
- `Admin` requires explicit permission grants from `AdminPermissionGrant`.
- `AdminAuditLog` and `AdminAuditService` already exist and should be reused.
- Existing feature flag and system configuration services are available, but
  they are not sufficient by themselves for structured ranking formulas, section
  limits, and suggestion block governance.

Existing web admin controls:

- `RequireAdmin` restricts admin routes to `SuperAdmin` and `Admin`.
- `RequireAdminPermission` and `useAdminPermissions` gate route access.
- `AdminSidebar` and the `/admin` route tree already exist.
- `AdminApi.ts` and `src/types/admin.ts` provide the existing admin API/type
  patterns.

Allowed governance roles for Phase 13B:

- `SuperAdmin` can read, write, publish, roll back, and manage formulas.
- `Admin` can read or write only when explicitly granted market governance
  permissions.

Disallowed roles:

- `User`
- regular buyers
- brand users
- brand/store staff roles
- any unauthenticated requester

Phase 13B should add explicit permissions instead of reusing broad system
settings permissions:

- `MARKET_GOVERNANCE_READ`
- `MARKET_GOVERNANCE_WRITE`
- `MARKET_GOVERNANCE_RELEASE`
- `MARKET_RANKING_FORMULA_WRITE`
- `MARKET_RANKING_ROLLBACK`
- `MARKET_SUGGESTIONS_WRITE`

Release, rollback, and formula activation should be limited to `SuperAdmin` or
admins with the explicit release/formula permission.

## Governance Targets

Market sections should eventually allow admins to control:

- enabled or disabled state
- title and subtitle
- preview item limit
- detail page limit
- minimum item count
- display order
- View All enabled state
- fallback mode
- safe eligibility metadata

Ranking profiles should eventually allow admins to control:

- profile name and description
- enabled or disabled state
- shadow mode
- section allowlist
- formula version
- exploration percent
- brand max share
- aggregate timeout
- rollout percent
- deterministic fallback requirement

Formula versions should eventually allow admins to control:

- version labels
- draft, active, deprecated, or rolled-back status
- bounded weights
- safety bounds
- activation notes
- rollback target

Suggestion blocks should eventually allow admins to control:

- block enabled or disabled state
- context
- target type
- title and subtitle
- display order
- source strategy
- fallback source
- item limit
- metadata for safe presentation

Release controls should eventually allow admins to view or control:

- ranking enabled state
- shadow mode
- rollout stage
- deterministic fallback state
- last rollback reason
- monitoring checklist status
- local or production readiness status

## Backend Model Design For Phase 13B

Phase 13B should add additive Prisma models. The exact names can use repo
conventions, but the contract should stay close to this shape.

### MarketSectionConfig

- `id`
- `sectionKey` unique
- `title`
- `subtitle`
- `enabled`
- `displayOrder`
- `previewItemLimit`
- `detailPageLimit`
- `minimumItems`
- `viewAllEnabled`
- `fallbackMode`
- `metadata Json`
- `createdById`
- `updatedById`
- `createdAt`
- `updatedAt`

Validation requirements:

- section keys must match known code-supported section keys unless the runtime
  explicitly supports dynamic sections
- preview and detail limits must be clamped to safe bounds
- at least one primary market section must remain enabled
- invalid config falls back to code defaults

### MarketRankingProfile

- `id`
- `profileKey` unique
- `name`
- `description`
- `enabled`
- `shadowMode`
- `sectionKeys Json`
- `formulaVersionId`
- `explorationPercent`
- `brandMaxShare`
- `aggregateTimeoutMs`
- `rolloutPercent`
- `fallbackDeterministic`
- `metadata Json`
- `createdById`
- `updatedById`
- `createdAt`
- `updatedAt`

Validation requirements:

- `fallbackDeterministic` cannot be disabled
- `rolloutPercent` must be 0 until release gates pass
- `sectionKeys` must be a bounded allowlist of supported section keys
- `explorationPercent`, `brandMaxShare`, and `aggregateTimeoutMs` must stay
  inside the existing ranking config safety bounds

### MarketRankingFormulaVersion

- `id`
- `versionKey` unique
- `name`
- `status`
- `weights Json`
- `bounds Json`
- `notes`
- `createdById`
- `createdAt`
- `activatedAt`
- `deprecatedAt`

Validation requirements:

- only one active formula may be active for a given profile scope
- weights must be bounded and normalized before activation
- activation must write an audit log with the previous and new formula versions
- rollback must restore a prior active version without deleting history

### MarketSuggestionBlockConfig

- `id`
- `blockKey` unique
- `context`
- `targetType`
- `title`
- `subtitle`
- `enabled`
- `displayOrder`
- `sourceType`
- `fallbackSourceType`
- `itemLimit`
- `metadata Json`
- `createdById`
- `updatedById`
- `createdAt`
- `updatedAt`

Validation requirements:

- block keys must be bounded and stable
- contexts must match the implemented suggestion contexts
- disabled blocks cannot break parent screens
- item limits must be bounded
- source and fallback source values must be allowlisted

### MarketGovernanceAuditLog

Reuse `AdminAuditLog` instead of adding a duplicate audit table unless Phase 13B
finds a hard limitation. Add market-governance-specific audit actions to
`AdminAuditAction`:

- `ADMIN_MARKET_SECTION_CONFIG_UPDATE`
- `ADMIN_MARKET_RANKING_PROFILE_CREATE`
- `ADMIN_MARKET_RANKING_PROFILE_UPDATE`
- `ADMIN_MARKET_RANKING_FORMULA_CREATE`
- `ADMIN_MARKET_RANKING_FORMULA_ACTIVATE`
- `ADMIN_MARKET_RANKING_ROLLBACK`
- `ADMIN_MARKET_SUGGESTION_BLOCK_CREATE`
- `ADMIN_MARKET_SUGGESTION_BLOCK_UPDATE`
- `ADMIN_MARKET_RELEASE_CONTROL_UPDATE`

Every write must include actor, target, action, previous state, new state,
reason when provided, request ID when available, IP, and user agent. Audit data
must not include secrets, tokens, payment data, or raw user metadata.

## Admin API Contract For Phase 13B

Route prefix:

- `/admin/market-governance`

Read endpoints:

- `GET /admin/market-governance/sections`
- `GET /admin/market-governance/ranking/profiles`
- `GET /admin/market-governance/ranking/formulas`
- `GET /admin/market-governance/suggestions/blocks`
- `GET /admin/market-governance/audit-logs`
- `GET /admin/market-governance/release-status`

Write endpoints:

- `PATCH /admin/market-governance/sections/:sectionKey`
- `POST /admin/market-governance/ranking/profiles`
- `PATCH /admin/market-governance/ranking/profiles/:profileKey`
- `POST /admin/market-governance/ranking/formulas`
- `POST /admin/market-governance/suggestions/blocks`
- `PATCH /admin/market-governance/suggestions/blocks/:blockKey`

Rollback and rehearsal endpoints:

- `POST /admin/market-governance/ranking/rollback`
- `POST /admin/market-governance/rehearse-rollback`

The rollback rehearsal endpoint must be non-mutating unless a later phase
explicitly approves safe QA-only mutation behavior.

Permission rules:

- all endpoints require `JwtAuthGuard`, `RolesGuard`, and
  `AdminPermissionGuard`
- all endpoints require `Role.SuperAdmin` or `Role.Admin`
- read endpoints require `MARKET_GOVERNANCE_READ`
- section and suggestion writes require `MARKET_GOVERNANCE_WRITE` or the more
  specific suggestion permission
- formula writes require `MARKET_RANKING_FORMULA_WRITE`
- rollback and release controls require `MARKET_GOVERNANCE_RELEASE` or
  `MARKET_RANKING_ROLLBACK`
- no endpoint may trust a client-supplied actor user ID

Validation rules:

- invalid section keys, profile keys, formula versions, source types, and
  contexts return controlled 400 responses
- unauthorized users receive 403
- every write runs inside a transaction that also creates the audit log
- audit failure should fail the governance write instead of silently applying
  unaudited configuration
- no admin configuration can remove deterministic fallback
- no admin configuration can enable ranking globally without the safe release
  flow
- malformed or missing config must not break public market routes

## Web Admin UI Contract For Phase 13B

Proposed route:

- `/admin/market-governance`

The route should be protected by `RequireAdmin` and a market governance
permission check.

Screens or tabs:

1. Overview
   - release status
   - ranking enabled or disabled
   - shadow mode
   - fallback status
   - last config update
   - monitoring readiness warning

2. Market sections
   - list section configs
   - enable or disable
   - edit title and subtitle
   - reorder
   - edit preview and detail limits
   - View All toggle

3. Ranking profiles
   - list profiles
   - enabled and shadow-mode status
   - formula version
   - allowlisted sections
   - safe weight controls
   - timeout, exploration, and brand-share controls
   - rollback action

4. Suggestion blocks
   - list blocks by context
   - enable or disable
   - edit title and subtitle
   - item limit
   - source and fallback source

5. Audit log
   - actor
   - action
   - target
   - timestamp
   - reason
   - before and after summary

UX rules:

- never show raw JSON as the primary UI
- advanced JSON details may be shown in a collapsible detail panel
- dangerous actions require confirmation
- ranking must not be described as live unless the release status says it is
  actually serving ranked output
- no ML, embedding, or full-personalization claim
- no relationship-language copy

## Safety, Fallback, And Rollback Rules

Phase 13B must preserve these rules:

- ranking remains disabled by default
- deterministic fallback remains mandatory
- config read failure uses code defaults
- malformed config is rejected on write and ignored on read with safe fallback
- section config cannot disable every primary market section
- suggestion config cannot block parent screens from rendering
- formula weights must be bounded and normalized
- every mutation is audited
- public market routes must still render if admin config is unavailable
- production readiness is not claimed until Phase 14

Rollback paths:

- disable ranking profile
- restore prior active formula version
- disable a specific suggestion block
- restore market section code defaults
- force deterministic fallback when aggregate reads or config reads fail

## Phase 13B Backend Runtime Outcome

Backend implementation added:

- Prisma models and enums for config storage
- market governance permission constants
- market-specific audit actions
- admin DTOs with safe validation
- `MarketGovernanceModule`, controller, and service
- config read service with code-default fallback
- transactional writes with audit logs
- focused tests for permissions, validation, audit writes, fallback, and rollback

Phase 13C web implementation should add:

- admin API client types and methods
- admin route and sidebar entry
- overview, market sections, ranking profiles, suggestion blocks, and audit tabs
- guarded dangerous actions with confirmation
- no raw JSON primary editing surface

Deferred beyond Phase 13B:

- web admin governance UI;
- mobile admin governance
- ML or embedding controls
- suggestion View All governance
- production release approval
- final production readiness signoff

## QA Acceptance For Phase 13B

Phase 13B cannot pass unless:

- non-admin users receive 403 from every governance endpoint
- admins without explicit permissions receive 403
- every mutation creates an audit log
- invalid config is rejected with controlled 400 responses
- public market routes fall back to code defaults if config reads fail
- deterministic fallback cannot be disabled
- formula rollback works without deleting history
- web admin screens hide or disable controls when permissions are missing
- docs still state that production readiness requires Phase 14

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
