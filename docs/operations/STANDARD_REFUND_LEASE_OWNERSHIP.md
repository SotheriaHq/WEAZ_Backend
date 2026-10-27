# Standard refund worker ownership

Submission, unknown-outcome lookup, polling, admin reconciliation and explicit
test simulation now use a unique UUID owner. Successful submission retains that
lease while moving to `PROCESSING`; it is released only after applying the
verified result. Claims use `SKIP LOCKED`, so a busy row cannot hold up another
due refund. Candidate selection, ten-minute lease expiry and retry/poll scheduling
use the UTC database clock, independently of application clock differences.

Every pending, failed, attention and settlement write verifies the same current
owner and unexpired lease. Ownership is checked in a separate statement after
the actual row lock; settlement performs this check after order/hold/refund
locks. An earlier provider response cannot clear a replacement claim, create a
false attention event or settle money after losing ownership.

An uncertain submission is claimed by one new resolver and looked up, never
blindly submitted again. A late successful submission keeps its provider id in
an idempotent payment event and operational alert without changing another
owner's state. Normal verified settlement resolves the alert. Network requests
remain outside database transactions. Original charge amounts, currencies,
settlement conversion, fee calculation and accounting policy are unchanged.

Verification: `node scripts/verify-standard-refund-integrity.cjs` creates and
removes a disposable loopback PostgreSQL database and uses a local HTTP provider
simulator with synthetic keys. The prior source failed the added late-error
test because it cleared the replacement claim. The updated suite passes 25
scenarios, including five late response variants, a real order-lock wait,
32 competing sweeps, locked-head progress, both directions of a two-hour
application-clock difference, and the existing reserve/release/debt/ledger
checks. Its proof records 19 provider submissions, 19 provider refund objects,
zero unauthorized simulator requests and successful database cleanup.

Evidence: `docs/performance-reviews/standard-refund-integrity-postgres-2026-10-26.json`.
The filename is historical; use `checkedAt` to identify the current run.
This is local ownership/accounting evidence, not certification of live gateway
contracts, foreign-currency behavior, SIT rollout or the custom-order worker.
In particular, the existing provider lookup's filter/pagination contract still
requires the separate integration audit. See the
[operator runbook](STANDARD_ORDER_REFUND_RUNBOOK.md).
