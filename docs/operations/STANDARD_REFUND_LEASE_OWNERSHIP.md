# Standard and custom refund worker ownership

Updated 28 October 2026. Both refund workers now use the shared protocol in
`src/finance/refund-lease-query.ts`. Earlier standard-only verification below is
historical; use the evidence file's `checkedAt` and case list for the latest run.

Current local verification: 44 actual PostgreSQL/provider-simulator scenarios
pass on both PostgreSQL 17 and an isolated PostgreSQL 15 container, with 34
submissions/34 provider refund objects, zero unauthorized requests and complete
database/container cleanup. Six focused Jest suites pass 53 tests. The seven
separate provider HTTP contract tests cover exact identities and bounded,
complete Paystack pagination. See
`docs/performance-reviews/refund-integrity-postgres15-2026-10-28.json` for the
PostgreSQL 15 proof. No live gateway transfer or foreign-currency settlement
certification is claimed by these local checks.

## Cross-family identity and reconciliation

`ProviderRefundIdentity` reserves each `(provider, providerRefundId)` for exactly
one standard or custom refund and its original payment capture. Database
triggers also protect direct writes. Identity history remains reserved when a
current link is cleared, so another refund cannot later reuse it. The worker
records an identity collision as manual attention with durable provider-result
evidence rather than submitting another refund.

Admin reconciliation first claims a unique owner and moves a due failed refund
to `NEEDS_ATTENTION`, **before** its external provider GET. Automatic workers
cannot submit it while the admin verifies the provider record. Failed lookup or
identity validation leaves manual attention; another reconciliation may retry
the lookup after ownership is released. An interrupted admin lookup remains on
manual hold and may be claimed again after the ten-minute lease expires.

Result handling locks capture → order → optional escrow hold → refund, then
checks the current owner using a fresh database-clock statement. Custom refund
completion also revises its order once: full/cancelled-order refunds close it
and set payment status to `REFUNDED`; a post-active partial refund preserves the
order status and payment status. A unified parent capture remains paid because
its other lines or retained deductions can remain valid.

## Migration and deployment boundary

Drain old refund workers, refund webhook processing and reconciliation requests
before applying `20261027210000_custom_refund_owner_fencing` and
`20261028093000_provider_refund_identity`. The first migration refuses existing
custom refunds that are submitting or still locked. The second refuses duplicate
provider identities during backfill; it never chooses a winner or invents an
owner. Investigate any such row using the provider record before retrying.
Deploy API and workers from the same revision before reopening these paths.

These migrations were applied only to disposable verification databases. They
have not been applied to SIT or the application's local database by this work.

## Why identity registration uses two statements

Under PostgreSQL Read Committed, `INSERT ... ON CONFLICT DO NOTHING` can wait
for a transaction whose result is absent from that statement's snapshot. A
separate SELECT sees its committed identity before the worker links it. See
[PostgreSQL transaction isolation](https://www.postgresql.org/docs/16/transaction-iso.html).
Explicit source locks preserve current facts while applying each result; see
[PostgreSQL consistency checks](https://www.postgresql.org/docs/current/applevel-consistency.html).

## Earlier standard-only checkpoint

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
