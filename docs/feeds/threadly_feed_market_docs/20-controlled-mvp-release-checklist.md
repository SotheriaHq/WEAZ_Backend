# Controlled MVP Release Checklist

**Status:** Phase 14D checklist gate prepared on 2026-05-26; Phase 14E local
execution evidence recorded on 2026-05-26.
**Scope:** Feed, market sections, context-aware market suggestions, user market/feed controls, and admin market governance.
**Release level:** Controlled MVP candidate only.

This checklist does not approve broad production rollout, live ranking, ML, full
personalization, or deep fashion-intelligent recommendation claims. Ranking
must remain disabled by default, deterministic fallback must remain available,
and production readiness stays blocked until the later operational hardening
gates are complete.

## 1. Release Preconditions

| Area | Required state | Phase 14D status |
| --- | --- | --- |
| Backend commit | `f2146fa` or later on `main` | Verified locally |
| Web commit | `ca40207` or later on `main` | Verified locally |
| Mobile commit | `11fac46` or later on `main` | Verified locally |
| Backend workspace | Clean before release docs | Verified locally |
| Web workspace | Clean before release docs | Verified locally |
| Mobile workspace | Clean | Verified locally |
| Ranking | Disabled by default | Required |
| ML/full personalization | Not enabled | Required |
| Production readiness claim | Not allowed | Required |
| Stashes | Preserved; do not apply/pop/drop | Verified locally |

## 2. Backend Deployment Readiness

| Item | Status | Notes |
| --- | --- | --- |
| Latest backend commit confirmed | Complete | `f2146fa` or later must be deployed. |
| Backend build | Complete locally | `npm run build` passed in Phase 14D. |
| Targeted backend regression | Complete locally | Auth, market suggestion, ranking, section, suppression, user preferences, and admin governance tests passed. |
| Full backend Jest suite | Complete locally | `npm test -- --runInBand` passed in Phase 14D. |
| Environment variables | Manual deploy check required | Confirm required hosted variables exist without exposing values in logs or docs. |
| Database target | Manual deploy check required | Confirm hosted database and schema target before migration. |
| Migration command | Required | Use `npx prisma migrate deploy` in hosted deployment. |
| Destructive commands | Blocked | Do not run `prisma migrate reset`, `db push --force-reset`, truncation, or destructive SQL. |
| Backup before migration | Required | Take and verify a hosted database backup before deploy. |
| Rollback path | Required | Confirm restore owner, backup artifact, and app rollback command before deploy. |

## 3. Web Deployment Readiness

| Item | Status | Notes |
| --- | --- | --- |
| Latest web commit confirmed | Complete | `ca40207` or later must be deployed. |
| Typecheck | Complete locally | `npm exec tsc -- -b --pretty false` passed. |
| Build | Complete locally | `npm run build` passed; existing Vite chunk-size warning remains a production-hardening item. |
| Lint | Complete locally | `npm run lint` passed with existing warnings only. |
| Environment variables | Manual deploy check required | Confirm deployed API base URL and auth/client variables without exposing values. |
| Market routes | Manual smoke required | Confirm `/market` and `/market/sections/:sectionKey`. |
| Suggestion routes | Manual smoke required | Confirm product, collection, brand, and search-empty suggestion navigation. |
| Settings route | Manual smoke required | Confirm Settings > Market & Feed. |
| Admin governance route | Manual smoke required | Confirm `/admin/market-governance` permission behavior. |
| Auth routes | Manual smoke required | Confirm login, signup, and current-user session behavior. |

## 4. Mobile Release Readiness

| Item | Status | Notes |
| --- | --- | --- |
| Latest mobile commit confirmed | Complete | `11fac46` or later must be built. |
| Typecheck | Complete locally | `npm exec tsc -- --noEmit` passed. |
| Market signal queue contract | Complete locally | `npm run test:market-signal-queue-contract` passed. |
| API target | Manual build check required | Confirm mobile API target without exposing secrets. |
| Expo/build process | Manual release check required | Use the approved Expo/EAS or local build process for the MVP channel. |
| Device smoke | Required before release | Run at least one Android and one iOS/simulator smoke where available. |
| Mobile admin governance | Out of scope | Do not add or claim mobile admin governance in this release. |

## 5. Database and Migration Checklist

| Item | Status | Notes |
| --- | --- | --- |
| Local migration status | Complete | `npx prisma migrate status` reported database schema up to date. |
| Hosted backup | Required before deploy | Backup must be created and restorable before hosted migration. |
| Hosted migration command | Required | Run `npx prisma migrate deploy`; do not use reset. |
| Post-migration status | Required after deploy | Run hosted migration status or platform equivalent. |
| Rollback restore contact | Required | Assign a person and document access path before deployment. |
| Data-destruction review | Required | Confirm migration contains no drop/reset/truncate operations for this track. |

## 6. Manual Web Smoke Checklist

| Flow | Expected result |
| --- | --- |
| Login | User can authenticate and reach the app. |
| Market home | Backend-owned market sections load without excessive client-side loading. |
| View All | `/market/sections/:sectionKey` opens, paginates, and stops at the end. |
| Product detail suggestions | Suggestion blocks lazy-load after primary product content. |
| Collection suggestions | Suggestion blocks lazy-load after primary collection content. |
| Brand suggestion navigation | Brand suggestion opens the profile Store tab or another valid store route, not a missing slug page. |
| Search empty suggestions | Suggestions appear only for non-empty queries with empty results. |
| Not Interested | Hiding a suggestion calls suppression flow and removes the item locally. |
| Settings hidden content | Hidden content loads from the server and restore works. |
| Reset market preferences | Copy says fresh baseline and non-destructive behavior; no immediate rebuild claim. |
| Admin governance route | Missing permission blocks access; permitted admin can open the route. |
| Admin release status | Release status loads and still marks production readiness as false. |
| Rollback rehearsal | Rehearsal is clearly non-mutating. |

## 7. Manual Mobile Smoke Checklist

| Flow | Expected result |
| --- | --- |
| App launch | App opens and reaches the authenticated or guest starting surface. |
| Market screen | Market screen loads without obvious repeated network churn. |
| Product suggestions | Product detail suggestion blocks load only when a product id exists. |
| Collection suggestions | Collection suggestion blocks load only when a collection id exists. |
| Search empty suggestions | Suggestions show only for non-empty searches with empty results. |
| Market preferences | Settings > Market preferences loads. |
| Hidden content restore | Hidden content restore is optimistic and rolls back on failure. |
| Reset copy | Reset copy says fresh baseline and non-destructive behavior. |
| Patch terminology | Notification/settings copy uses patch language, not follow/follower wording. |
| Signal queue | Queue remains bounded and does not spam repeated calls in obvious navigation loops. |

## 8. Admin Smoke Checklist

| Flow | Expected result |
| --- | --- |
| Admin route permission | `/admin/market-governance` requires admin governance read permission. |
| Overview tab | Release status loads; ranking default-disabled and deterministic fallback remain visible. |
| Market sections tab | Config list loads; dangerous disables require confirmation. |
| Ranking profiles tab | Fallback deterministic cannot be set false from UI. |
| Formulas tab | Weight entry is bounded and backend validation errors display. |
| Suggestion blocks tab | Config list loads and item limits remain bounded. |
| Audit log tab | Audit rows load with before/after details collapsed by default. |
| Rollback rehearsal | Non-mutating rehearsal result displays safely. |
| Rollback action | Requires permission, confirmation, and reason. |

## 9. Claims and Copy Policy

Blocked claims:

- production readiness or broad production rollout approval;
- ranking is live;
- ML is enabled;
- full personalization is live;
- deep fashion-intelligent recommendations are live;
- hosted monitoring or production rollback has been proven;
- mobile admin governance exists.

Allowed wording:

- controlled MVP candidate;
- deterministic market sections;
- contextual suggestions;
- market preference controls;
- admin governance foundation;
- ranking remains disabled;
- production readiness remains a later operational gate.

## 10. Rollback Checklist

| Scenario | Required action |
| --- | --- |
| Backend deploy fails before migration | Roll back application artifact; do not run migration. |
| Migration deploy fails | Stop release, capture logs, do not retry with reset, restore from backup only if data integrity is at risk. |
| Backend runtime errors after deploy | Roll back backend artifact, preserve logs, verify migrations remain compatible. |
| Web release breaks navigation | Roll back web artifact to previous stable build. |
| Mobile release has critical smoke failure | Stop promotion to wider testers and rebuild from the last passing commit. |
| Market suggestions fail | Keep ranking disabled, use deterministic fallbacks, and disable impacted release path if needed. |
| Admin governance mutation risk | Stop admin changes, use audit log to identify mutation, and use backend rollback controls only when validated. |

## 11. Post-Release Watch Checklist

For controlled MVP only, monitor manually or through available hosting logs:

- backend 4xx/5xx rates for `/market/sections`, `/market/suggestions`,
  `/market/signals/batch`, `/market/suppressions`, and
  `/admin/market-governance`;
- endpoint latency for market sections, suggestions, and admin governance;
- signal batch failures and duplicate/idempotency errors;
- suggestion empty/failure rates;
- frontend runtime errors around Market, View All, suggestions, Settings >
  Market & Feed, and admin governance;
- mobile signal queue errors and repeated-send behavior;
- admin governance 401/403 access errors;
- database growth for signal, suppression, aggregate, and audit tables;
- any user report of confusing reset behavior or hidden-content restore failure.

## 12. Production Blockers Kept Open

| Blocker | Why it matters | Suggested phase |
| --- | --- | --- |
| Hosted monitoring and alerting | Required for broad operational ownership. | Phase 16C |
| Production deploy/migration rehearsal | Needed before broad rollout. | Phase 14D/16C |
| Backup/restore rehearsal | Required to prove recovery. | Phase 16C |
| Production rollback rehearsal | Required before production readiness. | Phase 16C |
| Signal abuse hardening | Prevents fake signal poisoning and spam. | Phase 16A |
| Async aggregation queue/worker | Removes synchronous aggregation pressure at traffic. | Phase 16B |
| Retention cleanup | Controls signal and audit table growth. | Phase 16B |
| Reset marker downstream consumption | Makes reset materially affect future suggestions/ranking. | Phase 16A/17 |
| Validation error redaction | Reduces sensitive rejected-value leakage risk. | Phase 16A |
| Admin config public-route integration | Completes governance runtime usefulness. | Phase 16A |
| Frontend UI/E2E coverage | Catches route, settings, suggestion, and admin regressions. | Phase 16C |
| Mobile market backend parity | Aligns mobile market home with backend-governed sections. | Phase 15/16 |
| Fashion metadata intelligence | Improves fashion-specific relevance. | Phase 15A |
| Patch/social-commerce intelligence | Connects social graph to commerce discovery. | Phase 15B |
| Conversion signals | Separates commercial intent from vanity signals. | Phase 15C/17 |
| Fairness/cold-start controls | Protects new designers and marketplace diversity. | Phase 15D/17 |
| Live ranking rollout | Requires shadow, monitoring, fairness, reset, and rollback gates. | Phase 17 |

## 13. Live Ranking and Personalization Blockers

Ranking and personalization must remain disabled until at least these items are
complete:

- reset marker consumed by ranking/suggestion reads;
- target validation and signal abuse protection hardened;
- signal aggregation moved off the hot request path;
- retention cleanup policy implemented;
- hosted monitoring/alerts and fallback metrics available;
- production rollback rehearsal completed;
- stable ranked pagination verified;
- stronger fashion metadata, patch/social affinity, conversion signals, and
  fairness/cold-start controls added;
- shadow-to-live rollout plan executed and approved.

## 14. Release Notes Draft

Threadly controlled MVP candidate now includes:

- backend-owned deterministic Market sections and bounded View All pagination;
- context-aware product, collection, brand, and search-empty market suggestions;
- Not Interested and hidden-content restore controls;
- fresh-baseline market preference reset copy that does not claim immediate
  recommendation rebuild;
- web Settings > Market & Feed controls;
- mobile Market preferences controls and patch-aligned notification copy;
- admin market governance foundation with guarded web UI, audit-backed backend
  mutations, release status, rollback, and non-mutating rollback rehearsal;
- ranking still disabled by default;
- production readiness and live personalization still deferred.

## 15. Phase 14E Execution Status

Phase 14E executed the controlled MVP release checklist as far as the local
workspace and available non-secret configuration allowed.

| Area | Phase 14E result | Notes |
| --- | --- | --- |
| Backend local validation | Passed | Prisma validate/generate/migrate status, targeted market/auth/admin tests, full Jest suite, build, and diff check passed locally. |
| Web local validation | Passed | TypeScript build, Vite build, lint, and diff check passed locally. The existing Vite chunk-size warning remains a production-hardening item. |
| Mobile local validation | Passed | TypeScript no-emit, market signal queue contract, and diff check passed locally. |
| Backend hosted target | Not verified | No backend deployment platform config was present in the repo, and hosted credentials/target details were not available in the workspace. |
| Web hosted target | Not verified | No web deployment platform config was present in the repo, and deployed API target verification requires the hosting environment. |
| Mobile build target | Not verified | Expo app config is present, but the intended release channel/device build target was not available for execution in this workspace. |
| Hosted migration | Not run | Hosted database target and backup confirmation were not available. The required hosted command remains `npx prisma migrate deploy`; destructive commands remain blocked. |
| Manual web smoke | Not verified | Requires the intended hosted or local browser target plus test accounts. |
| Manual mobile smoke | Not verified | Requires a device/emulator build against the intended API target. |
| Manual admin smoke | Not verified | Requires an authorized admin account on the intended target. |

Controlled MVP exposure should wait until the hosted target, backup, migration,
and manual smoke checks are completed and recorded. Production readiness remains
blocked. Live ranking, ML, full personalization, and deep fashion-intelligent
recommendation claims remain blocked.

## 16. Phase 14F Hosted and Manual Smoke Status

Phase 14F rechecked the release workspace after Phase 14E-V and attempted to
close hosted deployment and manual smoke status as far as available targets
allowed.

| Area | Phase 14F result | Notes |
| --- | --- | --- |
| Backend local confirmation | Passed | Prisma validate, local migrate status, build, and diff check passed. |
| Web local confirmation | Passed | Verified TypeScript command `npm exec -- tsc -b --pretty false`, build, and diff check passed. |
| Mobile local confirmation | Passed | TypeScript no-emit, market signal queue contract, and diff check passed. |
| Backend hosted target | Not verified | No hosted backend target was available from the non-secret process environment or repo metadata. |
| Hosted database environment | Not verified | A local `.env` file exists but was not inspected. Process-level hosted `DATABASE_URL` was not present. |
| Backup confirmation | Not verified | No hosted backup confirmation or restore owner was available in the workspace. |
| Hosted migration | Not run | The required command remains `npx prisma migrate deploy`; it must not run until the hosted target and backup confirmation are available. |
| Hosted web target | Not verified | Web deployment config exists, but hosted URL and deployed API base URL were not available in the process environment. |
| Mobile build/device target | Not verified | Expo app config exists, but no release channel, device, emulator, or build target was available for smoke execution. |
| Manual web smoke | Not verified | Requires the intended hosted/browser target and test user account. |
| Manual admin smoke | Not verified | Requires an authorized admin account on the intended hosted target. |
| Manual mobile smoke | Not verified | Requires a device or emulator build pointed at the intended API target. |

Controlled MVP exposure remains blocked until hosted target ownership, backup
confirmation, hosted migration status, and web/admin/mobile smoke are verified.
Production readiness remains blocked. Live ranking, ML, full personalization,
and deep fashion-intelligent recommendation claims remain blocked.

## 17. Final Phase 14D/14E/14F Decision

The controlled MVP release checklist exists and local Phase 14E/14F validation
passed. Controlled MVP exposure to intended test users should proceed only after
the hosted deployment target, backup, hosted migration, manual web/mobile/admin
smoke, rollback, and watch checks above are completed and recorded.

Production readiness remains blocked. Live ranking, ML, full personalization,
and deep fashion-intelligent recommendation claims remain blocked.
