# Release gates — 23 October 2026

Deployment remains blocked. Notification work remains last. This report does not certify a bug-free system or production capacity.

| Gate | Verified progress | Remaining blocker |
| --- | --- | --- |
| Subscription database cutover | Four paid tiers retained; grandfather tier/flag contraction and strict financial preconditions tested; all 143 migrations and reference/admin seeds pass twice in a disposable database. | Real SIT/local reset and cutover have not run. One SIT paid order lacks a lane; the approved fresh reset must precede contraction. Match running code, schema and process configuration during the controlled cutover. |
| N+1 queries | All 15 explicitly open entries in the frozen 178-candidate inventory now have batched implementations and focused evidence. Four additional queue-promotion read sites and per-line ledger account reads from the stateful category are fixed. | The remaining 46 recipient-policy and 59 stateful-command entries still require semantic review. Stateful product mutation can still carry incidental taxonomy/media/index reads; a zero open count in one category is not an all-codebase clearance. |
| Race conditions | Ordered collection/tag locks, post-lock price/count reads, conditional expiry claims and conflict-safe custom-order creation tested. Current paid admission still runs inside capture finalization. | Tag reindex against concurrent writes, stale source/index update ordering, product lifecycle/order-cancellation synchronization and remaining financial/outbox/worker entry points require closure. Product deletion currently writes REFUNDED directly; it must be reconciled with the canonical refund/escrow flow before release. |
| Normalization/integrity | Read-only audit covers 190 models and selected relational invariants. Added guarded one-primary-membership unique index and an appended migration repairing verified physical-verification schema drift. | Existing data inconsistencies, polymorphic tag targets/design-store distinction, primary-membership projection discipline and JSON-versus-relational order read/write sources need closure and post-reset verification. |

## Actual database findings

The audits ran read-only, with aggregate counts only. No existing database was reset or repaired.

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
