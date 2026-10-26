# Refund and compensation query policy

Refund attention first wins its conditional state transition. It then reads only
the current custom-order ID, payment ID and shopper ID through one refund/order
JOIN, within the same transaction. It does not hydrate the payment payload or
the complete order. Alert, payment event, timeline and notification outbox writes
remain atomic with that transition. A refused claim performs no context read or
duplicate side effects; the sweep reports only successful transitions.

Subscription compensation retains a fresh capture read after its claim and a fresh
context read inside an attention transaction. Both now use one scalar JOIN across
capture, invoice and agreement. Money remains native Decimal; saved authorization
data is not loaded. Financial inbox/email receipts still use the existing current
brand-owner/email JOIN and stable idempotency keys inside the financial transaction.
Receipt recipients are not cached across independent capture transactions.

The actual PostgreSQL fixtures cover26 stale refunds, shopper isolation, refused
claims and real durable-event failure rollback, plus26 interrupted subscription
refunds that require attention without resubmission. They verify unchanged paid
periods, exact Decimal context, no repeated receipts and zero provider actions on
these guarded paths. No callback/provider request is simulated by these DB checks.

This closes only the scoped query reviews. Provider submission and polling,
signature/identity validation, uncertain-outcome recovery, lease/fencing races,
currency/debt isolation and device delivery remain separate release gates.
Subscription tier definitions and access policy are unchanged.

These shared backend paths serve desktop, tablet, browser-mobile and native records.
No client layout, notification-permission UI or device behavior changed here.

## Standard-order timeout context

Standard refunds now read current order status and capture identity/amount in one
scalar LATERAL JOIN. Canonical payment references use their own branch; the existing
empty-reference/array fallback is separate. Native Decimal amounts are retained.
Missing order and missing capture remain distinct failures. Current paid/refunded
and conditional capture-claim checks still precede independent financial commands.

Actual PostgreSQL runs the SLA cron with26 independent test-mode captures and the
real escrow/ledger services:26context JOINs,26refunded holds/journals and52recipient
event handoffs. Cron/direct replay add no duplicate refund. Notification delivery
is not exercised. Test mode bypasses the provider in the existing implementation;
these cases are not a live or simulated-provider standard-refund completion test.

The live implementation still contacts its provider within the database transaction
and refunds the whole parent capture. Canonical refund completion, provider/database
atomicity and mixed-checkout accounting remain separate unresolved release gates.
The old array lookup is retained by this query pass and will retire with the wider
single-flow contraction; this does not certify that legacy retirement is finished.

## Queue refund and callback context

Submission, reservation, polling and completion now use a narrow native refund/capture/order JOIN. Each refund retains its independent authoritative claim and financial transaction; no batch cache crosses those boundaries. A reference-only callback reads at most20 matching PROCESSING siblings in one JOIN, scoped to gateway; a provider-ID callback reads its own identity. Decimal and date fields remain native.

Actual PostgreSQL19cases pass with cleanup:26internal-simulation refunds use78JOINs and zero eager payment/order hydration, preserve parent PAID status and correct shopper notices, and replay safely. Equal-priced sibling callback, wrong gateway/missing ID, current poll lease, provider-ID replay and wrong amount attention are verified.17unit tests and full backend types/lint pass. This proves database behavior and trusted callback handling, not incoming signature transport, live provider acceptance or lease fencing.
