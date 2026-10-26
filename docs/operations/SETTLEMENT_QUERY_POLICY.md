# Settlement query and snapshot policy

Standard-order settlement resolves policy and commission through the shared batch
queries, then inserts immutable snapshots in groups of at most100. New snapshots
return directly from the insert; duplicate targets use one shared follow-up read
per group. PostgreSQL uniqueness conflicts do not abort the transaction. Results
retain the input order. A retry keeps the original snapshot even when commission
or release policy has since changed. Invalid business targets are rejected before
any insert. The existing single-calculation method delegates to this shared path.

The upfront-release path reuses the hold returned by its own transaction and the
saved snapshot. It retains the release-mode, positive amount, frozen/refunded and
already-released guards. Payment and release journals remain independent per
order, with their own idempotency keys and current locked ledger balances.

The delivery-timeout scan joins holds, orders and immutable snapshots in one
bounded200-row query, ordered by delivery time/id. It uses each order's saved
release days and delay. Existing missing-snapshot configuration fallback is read
once per page. Each candidate still has a separate transaction/current-hold check.
General transition-locking and eligibility races remain separate release gates.

Finance sync shares order and paid-attempt scans, groups orders by payment
reference, and preserves one financial transaction and buyer receipt per payment.
It must not merge distinct payment references merely to reduce query counts.

The operator-only snapshot audit writer uses100-row conflict-safe inserts for
already-approved safe records. Its dry-run, unsafe-record exclusions and immutable
existing snapshots remain unchanged. It does not post ledger entries or payouts.
Each insert group is atomic; an invalid group fails rather than partially writing
that group. No operator backfill is scheduled or activated by this change.

## Evidence and limits

The actual PostgreSQL fixture verifies26 split settlements with one snapshot
insert and no immediate snapshot/hold reloads, immutable replay after policy
changes, one joined scan for26 delivery timeouts,26 final releases, and26 custom
final-release journal commands with no brand/user metadata lookup. It exercises
real conflicting snapshot inserts, rollback, shared finance sync for two payments
and two buyer receipts, and102 operator records in two inserts/zero SELECTs.

An end-to-end run caught the existing batched policy query referring to
`SettlementPolicy`; the persisted table is `settlement_policy`. The corrected
mapping is now exercised against the complete migration chain.

These checks use disposable local databases and synthetic NGN settlements. They
do not establish live payment/refund delivery, other-currency correctness, debt
recovery isolation, document-creation race freedom or production capacity. Those
remain separate gates. All four clients consume this shared backend; no client UI,
permission flow or device behavior changed in this query pass.

Run `node scripts/verify-ledger-concurrency.cjs` from the backend with a loopback
PostgreSQL connection configured. It creates/migrates/drops a random disposable
database and does not reset the configured application database.
