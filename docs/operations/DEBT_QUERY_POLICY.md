# Debt summary and grouped recovery queries

Since 26 October, what a brand owes is the negative part of one number: its
position in the settlement currency, NGN (`loadBrandPosition`). The position
is released standard escrow plus eligible or paid custom earnings, minus
reserved and paid payouts, minus manual debits and chargebacks, plus manual
credits. Refunded or refund-pending holds no longer count. Payout availability,
the debt snapshot and recovery all read this same aggregate, so a refund,
payout or adjustment is counted once.

The debt snapshot and owner come from one Brand/debt JOIN plus the position
read. Adjustment rows are an immutable statement. Each system-raised row has a
unique `sourceKey` (one clawback per refund), and the database refuses
non-positive amounts, malformed currencies and recoveries in another currency
than their debt. Recovery runs under the Brand row lock. It marks open debts
paid oldest-first, in exact Decimal, until the recorded debt equals what the
position says is owed. Owner notices are sent after commit, once per row
(`announcedAt`, every-minute sweep).

Admin payout release groups allocations by brand and currency. Non-NGN groups
are reported in `awaitingSettlementCurrency` and are not paid at face value
(item 6 converts them). An NGN group is capped by the position: debt comes off
the top. The PostgreSQL fixture runs 26 eligible allocations through the real
release method. It makes three bounded debt reads (position, ordered debt lock,
position), recovers two manual debits totalling 15 oldest-first, and creates a
single 219 payout from 234. Repeating the release pays and recovers nothing
twice. Snapshot, missing-brand and post-commit notice cases pass
(`verify-custom-order-issue-race.cjs`). A refund after payout, FIFO recovery
across later releases, same-key concurrency, rollback and currency guards are
verified in `verify-standard-refund-integrity.cjs`. Refund operations:
[STANDARD_ORDER_REFUND_RUNBOOK.md](STANDARD_ORDER_REFUND_RUNBOOK.md).
