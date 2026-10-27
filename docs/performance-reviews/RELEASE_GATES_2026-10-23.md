# Release gates — 23 October 2026

## Current release direction — 26 October 2026

The owner now authorizes committing, pushing, branch integration and SIT deployment of verified work, while remaining item-1 follow-up work stays held. This supersedes the earlier deployment pause recorded below. Only SIT and local are in use. Actual database resets and reference/admin seeding completed earlier; do not repeat them for this release.

The N+1 inventory is locally reviewed, while the wider race audit remains incomplete. Current notification/conversation/extension handoff checks pass 78 combined PostgreSQL/Redis cases (including 12 channel cases), 96 focused unit tests, types and affected-source lint. These results do not close financial/debt, product/order, indexing or semantic-deduplication risks. Normalization and canonical refunds were implemented on 26–27 October (items 4/5, below). A successful SIT deployment is not production-readiness approval or proof of provider/device delivery.

GitHub web history checked on 26 October shows subscription/client PR7 already merged into SIT on 25 October, followed by additional design merges. Preserve that existing history; further item-1 work remains held. Historical statuses below must not be used to undo other contributors' merges or infer current deployment state.

Release validation and actual deployed revisions must be recorded after the integration gates finish; an integration commit alone is not deployment evidence.

| Gate | Verified progress | Remaining blocker |
| --- | --- | --- |
| Subscription database cutover | Actual SIT/local reset, migrations, reference/admin seeding and backend/native cutover verified earlier. Four current tiers and customer aggregation retained. Web PR7 subsequently merged externally on25October. | Further item-1 follow-up remains on hold; accepted temporary Runway/Market rendering budget5seconds. Preserve existing remote history. |
| N+1 queries | LOCAL COMPLETE:178frozen candidates individually reviewed,105FIXED_AFTER_CAPTURE; no unreviewed policy/stateful entries.98tests/7suites and full backend types PASS; actual PostgreSQL ledger35/issue25/bulk18cases PASS with cleanup, including local provider HTTP. | Final release CI/telemetry still required; a static inventory cannot certify universal runtime query absence or production capacity. Broader races/currency/provider correctness remain independent gates. |
| Race conditions | Ordered collection/tag locks, post-lock price/count reads, conditional expiry claims and conflict-safe custom-order creation tested. Current paid admission still runs inside capture finalization. | Tag reindex against concurrent writes, stale source/index update ordering, product lifecycle/order-cancellation synchronization and remaining financial/outbox/worker entry points require closure. Product deletion now cancels unshipped paid orders through the canonical refund and escrow flow, and blocks shipped orders and in-flight checkouts (items 4/5). |
| Normalization/integrity | Read-only audit covers 190 models and selected relational invariants. Added guarded one-primary-membership unique index and an appended migration repairing verified physical-verification schema drift. 26 October (items 4/5): ledger accounts are (code, currency) with entry/balance triggers; debt rows have source keys, foreign keys and currency guards; tag bindings have a STORE_COLLECTION type and generated typed foreign keys; the primary-membership projection is enforced at commit; reference seeds insert only. | Apply the seven new migrations on SIT through the normal release. JSON-versus-relational order sources retire in item 7. Custom-order NGN settlement conversion is item 6. |

### Items 4 and 5 — 26–27 October

Standard-order refunds are now canonical: one durable refund per order, reserved
inside the business transaction without network calls. Provider submission,
polling and webhooks run outside locks, and uncertain outcomes are never resent.
Returns, SLA timeout, admin cancellation and product deletion all use this path.
Operator procedures:
[../operations/STANDARD_ORDER_REFUND_RUNBOOK.md](../operations/STANDARD_ORDER_REFUND_RUNBOOK.md).
Audit and decisions:
[../operations/DATA_INTEGRITY_AND_REFUNDS_AUDIT_2026-10-26.md](../operations/DATA_INTEGRITY_AND_REFUNDS_AUDIT_2026-10-26.md).

Evidence on the isolated item 4/5 commit (only its own files; disposable
PostgreSQL 17; loopback provider simulator):
- `verify-standard-refund-integrity` passes 15 cases; ledger passes 26,
  complaint/debt 33, tag sync 7, file deletion 14 and checkout/media 77, all
  with cleanup.
- Fresh schema passes: 155 migrations and both seed runs.
- Backend types are clean. Module cycles are unchanged. API and worker
  dependency graphs resolve (preview mode, with a negative control).
- The refund/debt/integrity and upload unit steps pass.

Failures found that predate items 4/5 (identical on base `67bf6b8`):
- `paid-capture-admission.spec.ts`: 6 cases.
- `verify-bulk-import-postgres.cjs` line 623: content-review notices, 0 of 26.

`verify-reset-bootstrap` could not run from the agent session, because Prisma
refuses `migrate reset` without the owner's explicit consent; CI runs it. The
PostgreSQL 15 (SIT version) run is pending.

Remaining product work: refund status on the order screens (web and native), the
custom-order refund engine moving onto the shared provider client, and an
admin-payouts lock-order review.

## Historical pre-reset database findings —23October

These23October audits were read-only. The subsequently authorized actual SIT/local reset and reseeding completed; this table is historical and does not request another reset. Current post-change integrity verification remains its own normalization gate.

| Finding | Local | SIT |
| --- | ---: | ---: |
| Products with multiple primary memberships | 1 | 0 |
| Stored primary pointer differs from selected membership | 9 | 0 |
| Tag bindings without any matching supported target | 0 | 14 |
| Store collections bound with the design COLLECTION tag discriminator | 0 | 13 |
| Tag usage count differs from binding count | 0 | 0 |
| Orders with item snapshots but no relational lines | 0 | 0 |
| Missing physical-verification reminder columns | 0 | 3 |

The three missing SIT columns are reminderDayBeforeAt, reminderHourBeforeAt and awaitingReplyNudgedAt. The new repair migration adds them without editing applied migration history. Migration ledger health alone did not expose this drift.

Snapshots, caches, arrays and unbound IDs are review candidates, not automatically normalization defects. Purchase-time financial snapshots must retain their historical meaning. Sample counts of zero do not prove every writer preserves an invariant.

Foreign-key candidates now come from PostgreSQL pg_constraint/pg_attribute. Prisma 7 runtime DMMF omits relationFromFields and mapped-column details; using it for this purpose incorrectly listed existing foreign keys as unbound. Both reports were rerun with the catalog query. An absent constraint may already be supplied by an unapplied release migration, such as cart/wishlist ownership; compare the migration history before proposing another constraint.

## Changes and evidence

The combined focused regression run passed 14 suites / 103 tests, and the backend semantic TypeScript check passed. These checks are local; live API cutover and physical-device regression are pending.

- Collection prices use bounded joined aggregation and consistent post-lock time; empty, future, inactive, archived/deleted, positive-variant, base-price and sale-window cases pass real PostgreSQL checks. Duplicate-product memberships append after MAX(orderIndex), preserve a single primary and use sorted destination locks.
- Featured expiry hydrates metrics and owner once per bounded page; a conditional update permits only the winning scheduler to notify. Deleted targets retain their last known metrics. Notification delivery durability is a separate concern.
- Custom checkout bags hydrate product/design sources with JOIN/LATERAL queries. Missing sources preserve existing bag lines; store collections cannot impersonate design sources.
- Queue permission pages use the existing canonical owner/active-role/explicit-grant predicate in a scoped query. Buyer isolation, mixed-brand failure and suspended membership are verified.
- Intake preview uses bounded latest-subscription/tier/owner joins. Real PostgreSQL cases cover free, active, expired, cancelled, blocked, unverified and suspended-owner states. This preview grants no payment entitlement; admission rechecks under its existing transaction locks.
- Unified finalization batches missing order inserts with ON CONFLICT and hydrates winning orders afterwards. It explicitly uses READ COMMITTED. Conflict winners continue; unrelated uniqueness conflicts and failed admission refuse completion and roll back. Provider money movement is not asserted by these local fixtures.
- Tag template changes batch shared-tag hydration, binding writes/deletes and grouped counts. Sync and merge take ordered tag locks; moderation is rechecked after locking. Generated Prisma against a disposable fully migrated PostgreSQL database verifies ten-product additions/removals, simultaneous additions, moderation rollback and merge counts.
- Bulk unpublish loads update contexts and brand permissions once, then preserves the shared product mutation pipeline and partial-result contract. A concurrent archive/delete cannot silently pass the guarded product update.
- Queue promotion reads the incumbent once and lazily loads two bounded FIFO candidate groups under the existing brand lock. It reuses the owner from capacity context for timeline/outbox recipients. Twenty-five queue tests pass, including a forty-order batch, priority fairness, protected Up Next, unpaid/expired exclusion, retain boundaries and refund reservation guards. Per-order settlement and durable effects remain separate guarded operations; this is not a certificate for their entire query graph.
- Complaint submission and automatic acceptance completion now serialize on the order row and recheck current eligibility in a separate post-lock statement. Delay complaints recheck open disputes/cooldown against current state. The completion cron rechecks the acceptance deadline, issues and open disputes; a skipped order produces no completion notice or release. Lifecycle history still records completed orders under a financial safety hold while money remains held. Forty focused service/cron tests pass. A generated-Prisma disposable PostgreSQL fixture verifies both transaction orders: complaint wins while cron waits, and completion wins while complaint waits.
- Ledger posting now claims a unique event with ON CONFLICT, verifies duplicate financial payloads, bulk-creates missing accounts, locks accounts in code order and batches balances/entries. Decimal arithmetic preserves large balances and each intermediate repeated-account snapshot. Eight real PostgreSQL scenarios pass, including thirty cold competing writers with opposite line orders, duplicate-key waiting, rollback, precision and forty lines using three account reads. Four focused financial suites pass 41 tests. Both CI workflows now run the actual PostgreSQL ledger and complaint fixtures against disposable databases. This closes one frozen read site, not the remaining financial graph: multiple postings inside one transaction still need lock-order review. Account currency is currently hardcoded NGN and account code is globally unique despite multi-currency transactions; currency isolation and wallet aggregation remain normalization blockers.
- Deployment jobs for main/SIT now share one GitHub concurrency group and one host flock covering checkout mutation through health verification. Manual deploys use the same host lock; --close prevents detached PM2 descendants from holding it indefinitely. A real Linux fixture verifies competing-command serialization and lock release with detached children, without opening the actual deployment lock or executing deployment. Shell scripts require LF endings so Windows file copies remain valid on Linux. Feature-branch validation cannot deploy.

Reproduction tools:

- scripts/verify-collection-price-ranges.cjs
- scripts/verify-bag-permission-batching.cjs
- scripts/verify-tag-usage-concurrency.cjs
- scripts/verify-tag-sync-batching.cjs
- scripts/verify-custom-order-issue-race.cjs
- scripts/verify-ledger-concurrency.cjs
- scripts/verify-fresh-schema.cjs --seed
- scripts/audit-db-integrity.cjs --output <local-report-path>

Evidence: db-integrity-local-2026-10-23.json, db-integrity-sit-2026-10-23.json, tag-sync-postgres-2026-10-23.json, ../storage/evidence/fresh-schema.json and query-loop-classification-2026-10-22.json.

## Concurrency references

PostgreSQL recommends consistent object lock ordering and documents that a subsequent READ COMMITTED statement observes newly committed rows. ON CONFLICT DO NOTHING may wait for a competing insert without returning that row in its own statement snapshot; the follow-up read is intentional.

- [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)
- [PostgreSQL explicit locks and deadlocks](https://www.postgresql.org/docs/current/explicit-locking.html)

These backend changes serve desktop, tablet, mobile web and native API consumers. No new UI or physical-device delivery claim is included in this tranche.

The first e93eebf GitHub validation passed ledger and complaint scenarios but failed when the complaint fixture terminated leftover pool connections during cleanup (57P01). The fixtures now let PrismaPg own and dispose its pool from connection options, removing external-pool lifetime ambiguity. Both fixtures were rerun locally and passed with successful cleanup. Subsequent backend validation 99eee27 passed, with deployment skipped: https://github.com/SotheriaHq/WEAZ_Backend/actions/runs/39987749862. Later uncommitted work has local evidence only; workflow dispatch is paused under the current owner instruction.

Bulk import migration144/checkpoint/lease is locally verified in seven real PostgreSQL cases. Mixed scheduled events now have eight real PostgreSQL batching/privacy scenarios overall (fanout9 SELECTs, 26 mixed events5 SELECTs, 25 actor privacy8 SELECTs, including assertion reads). These do not clear the remaining 22 policy/49 stateful inventory entries or provider/device/reset gates.
